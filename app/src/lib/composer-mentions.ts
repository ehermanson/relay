import type { Task } from "@shared/types";
import { TASK_ID_PATTERN_SOURCE } from "@/lib/task-links";

interface ComposerTextSegment {
  kind: "text";
  text: string;
}

interface ComposerMentionSegment {
  kind: "mention";
  path: string;
}

interface ComposerSlashSegment {
  kind: "slash";
  command: string;
}

export type ComposerSegment = ComposerTextSegment | ComposerMentionSegment | ComposerSlashSegment;

interface MentionTriggerMatch {
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

export interface SlashTriggerMatch {
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

const MENTION_RE = /(^|\s)@([^\s@]+)(?=\s|$)/g;

/** Matches a leading `/command` or `$command` at the start of the prompt. */
const LEADING_SLASH_RE = /^([/$]\S+)(\s[\s\S]*)?$/;

/** Matches inline /skill-name tokens preceded by whitespace (not at string start). */
const INLINE_SLASH_RE = /(?<=\s)\/((?=[a-zA-Z])[\w-]+)(?=\s|$)/g;

interface InlineTokenMatch {
  kind: "mention" | "slash";
  value: string;
  tokenStart: number;
  tokenEnd: number;
}

function collectInlineTokens(text: string): InlineTokenMatch[] {
  const tokens: InlineTokenMatch[] = [];

  for (const match of text.matchAll(MENTION_RE)) {
    const leading = match[1] ?? "";
    const path = match[2] ?? "";
    if (!path) continue;
    const matchIndex = match.index ?? 0;
    const tokenStart = matchIndex + leading.length;
    tokens.push({
      kind: "mention",
      value: path,
      tokenStart,
      tokenEnd: tokenStart + 1 + path.length,
    });
  }

  for (const match of text.matchAll(INLINE_SLASH_RE)) {
    const name = match[1] ?? "";
    if (!name) continue;
    const matchIndex = match.index ?? 0;
    const fullCommand = `/${name}`;
    tokens.push({
      kind: "slash",
      value: fullCommand,
      tokenStart: matchIndex,
      tokenEnd: matchIndex + fullCommand.length,
    });
  }

  tokens.sort((a, b) => a.tokenStart - b.tokenStart);
  return tokens;
}

export function splitPromptIntoComposerSegments(prompt: string): ComposerSegment[] {
  const segments: ComposerSegment[] = [];

  // Detect leading slash/dollar command and split it into its own segment.
  const slashMatch = prompt.match(LEADING_SLASH_RE);
  let remaining = prompt;
  if (slashMatch) {
    segments.push({ kind: "slash", command: slashMatch[1] });
    remaining = slashMatch[2] ?? "";
  }

  const tokens = collectInlineTokens(remaining);
  let cursor = 0;

  for (const token of tokens) {
    if (token.tokenStart > cursor) {
      segments.push({ kind: "text", text: remaining.slice(cursor, token.tokenStart) });
    }
    if (token.kind === "mention") {
      segments.push({ kind: "mention", path: token.value });
    } else {
      segments.push({ kind: "slash", command: token.value });
    }
    cursor = token.tokenEnd;
  }

  if (cursor < remaining.length) {
    segments.push({ kind: "text", text: remaining.slice(cursor) });
  }

  if (segments.length === 0) {
    segments.push({ kind: "text", text: "" });
  }

  return segments;
}

export function detectMentionTrigger(text: string, cursor: number): MentionTriggerMatch | null {
  if (cursor < 0 || cursor > text.length) return null;

  let start = cursor;
  while (start > 0) {
    const char = text[start - 1];
    if (!char || /\s/.test(char)) break;
    start -= 1;
  }

  const token = text.slice(start, cursor);
  if (!token.startsWith("@")) return null;
  if (token.length < 1) return null;

  return {
    query: token.slice(1),
    rangeStart: start,
    rangeEnd: cursor,
  };
}

/**
 * Detects an inline `/skill-name` trigger at the cursor position.
 * Only fires when the slash token is preceded by non-whitespace content
 * (i.e. it's genuinely mid-message, not a leading command).
 */
export function detectInlineSlashTrigger(text: string, cursor: number): SlashTriggerMatch | null {
  if (cursor < 0 || cursor > text.length) return null;

  let start = cursor;
  while (start > 0) {
    const char = text[start - 1];
    if (!char || /\s/.test(char)) break;
    start -= 1;
  }

  const token = text.slice(start, cursor);
  if (!token.startsWith("/")) return null;

  // Only fire mid-message — suppress if no real content precedes the slash
  const precedingText = text.slice(0, start);
  if (!precedingText.trim()) return null;

  return {
    query: token.slice(1).toLowerCase(),
    rangeStart: start,
    rangeEnd: cursor,
  };
}

export function replacePromptRange(
  text: string,
  start: number,
  end: number,
  replacement: string,
): { value: string; cursor: number } {
  const value = text.slice(0, start) + replacement + text.slice(end);
  return {
    value,
    cursor: start + replacement.length,
  };
}

// ─── Task reference expansion ──────────────────────────────────────────────

const TASK_REF_RE = new RegExp(
  `@task:(${TASK_ID_PATTERN_SOURCE})(?![a-f0-9-])(?::[^\\s@]*)?\\b`,
  "gi",
);

export function getTaskReferenceIds(text: string): string[] {
  return [...text.matchAll(TASK_REF_RE)].map((match) => match[1].toLowerCase());
}

/** Escape a string for safe use inside an XML attribute (double-quoted). */
function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape a string for safe use as XML element text content. */
function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Replace `@task:<id>` tokens with `<task_reference>` XML blocks so the model
 * receives structured context about referenced tasks.
 */
export function expandTaskReferences(text: string, tasks: Task[]): string {
  return text.replace(TASK_REF_RE, (match, taskId: string) => {
    const task = tasks.find((candidate) => candidate.id.toLowerCase() === taskId.toLowerCase());
    if (!task) return match;
    const desc = task.description ? `\n${escapeXmlText(task.description)}` : "";
    return `<task_reference id="${escapeXmlAttr(task.id)}" title="${escapeXmlAttr(task.title)}">${desc}\n</task_reference>`;
  });
}
