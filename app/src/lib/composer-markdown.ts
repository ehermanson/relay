/**
 * Markdown support for the chat composer. The composer's value is always the
 * literal markdown string, so nothing here may rewrite a prompt except an
 * explicit user command: `parseComposerMarkdown` only describes how to display
 * the text, and the edit helpers run on a shortcut or Shift+Enter.
 */

export const MARK_BOLD = 1 << 0;
export const MARK_ITALIC = 1 << 1;
export const MARK_STRIKETHROUGH = 1 << 2;
export const MARK_CODE = 1 << 3;
export const MARK_CODE_BLOCK = 1 << 4;
export const MARK_QUOTE = 1 << 5;
/** Markup that stays visible but recedes: `**`, backticks, `#`, code fences. */
export const MARK_SYNTAX = 1 << 6;
export const MARK_LIST_NUMBER = 1 << 7;
/** `- ` / `* ` / `+ `, shown as a bullet. */
export const MARK_BULLET = 1 << 8;
/** `> `, shown as a quote bar. */
export const MARK_QUOTE_MARKER = 1 << 9;

export interface ComposerMarkdownSpan {
  start: number;
  end: number;
  marks: number;
}

export type ComposerFormat = "bold" | "italic" | "code" | "bullet" | "number" | "quote";

export interface ComposerTextEdit {
  value: string;
  start: number;
  end: number;
}

// Styling is cosmetic, so very large pastes just stay plain rather than paying
// for a parse on every keystroke.
const MAX_PARSED_TEXT_LENGTH = 20_000;
const MAX_PARSED_LINE_LENGTH = 2_000;

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const BULLET_RE = /^(\s*)[-*+] /;
const NUMBER_RE = /^(\s*)\d{1,9}[.)] /;
const QUOTE_RE = /^ {0,3}> /;
const HEADING_RE = /^#{1,6} /;

// Emphasis opens before a non-space and closes after one, as in CommonMark, so
// `2 * 3 * 4` stays plain; underscores also need word boundaries, so
// `snake_case_name` does too.
const INLINE_RULES: { re: RegExp; size: number; marks: number }[] = [
  {
    re: /(?<![\\*])\*\*\*(?=[^\s*])(.+?)(?<=[^\s*])\*\*\*(?!\*)/g,
    size: 3,
    marks: MARK_BOLD | MARK_ITALIC,
  },
  { re: /(?<![\\*])\*\*(?=[^\s*])(.+?)(?<=[^\s*])\*\*(?!\*)/g, size: 2, marks: MARK_BOLD },
  { re: /(?<![\\\w_])__(?=[^\s_])(.+?)(?<=[^\s_])__(?![\w_])/g, size: 2, marks: MARK_BOLD },
  { re: /(?<![\\*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?!\*)/g, size: 1, marks: MARK_ITALIC },
  { re: /(?<![\\\w_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\w_])/g, size: 1, marks: MARK_ITALIC },
  { re: /(?<![\\~])~~(?=[^\s~])(.+?)(?<=[^\s~])~~(?!~)/g, size: 2, marks: MARK_STRIKETHROUGH },
];
const INLINE_CODE_RE = /(?<![\\`])(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;

function paint(marks: Uint16Array, start: number, end: number, flag: number): void {
  for (let i = start; i < end; i += 1) marks[i] = (marks[i] ?? 0) | flag;
}

function isClaimed(marks: Uint16Array, start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    if ((marks[i] ?? 0) & (MARK_CODE | MARK_SYNTAX)) return true;
  }
  return false;
}

function paintInline(text: string, from: number, to: number, marks: Uint16Array): void {
  if (to - from > MAX_PARSED_LINE_LENGTH) return;
  const line = text.slice(from, to);

  for (const match of line.matchAll(INLINE_CODE_RE)) {
    const start = from + match.index;
    const end = start + match[0].length;
    const size = match[1]?.length ?? 1;
    paint(marks, start, start + size, MARK_SYNTAX);
    paint(marks, end - size, end, MARK_SYNTAX);
    paint(marks, start + size, end - size, MARK_CODE);
  }

  for (const { re, size, marks: flag } of INLINE_RULES) {
    for (const match of line.matchAll(re)) {
      const start = from + match.index;
      const end = start + match[0].length;
      // Only the markers need to be free; emphasis can contain code or nest.
      if (isClaimed(marks, start, start + size) || isClaimed(marks, end - size, end)) continue;
      paint(marks, start, start + size, MARK_SYNTAX);
      paint(marks, end - size, end, MARK_SYNTAX);
      paint(marks, start + size, end - size, flag);
    }
  }
}

/** Describe how to display `text`. Ranges are offsets into `text`; plain text has no span. */
export function parseComposerMarkdown(text: string): ComposerMarkdownSpan[] {
  if (!text || text.length > MAX_PARSED_TEXT_LENGTH) return [];
  const marks = new Uint16Array(text.length);
  let fence: string | null = null;
  let from = 0;

  for (const line of text.split("\n")) {
    const to = from + line.length;
    const fenceMarker = FENCE_RE.exec(line)?.[1];

    if (fence !== null) {
      if (fenceMarker?.startsWith(fence)) {
        paint(marks, from, to, MARK_SYNTAX);
        fence = null;
      } else {
        paint(marks, from, to, MARK_CODE_BLOCK);
      }
    } else if (fenceMarker) {
      paint(marks, from, to, MARK_SYNTAX);
      fence = fenceMarker.slice(0, 3);
    } else {
      let bodyStart = from;
      const bullet = BULLET_RE.exec(line);
      const number = bullet ? null : NUMBER_RE.exec(line);
      const quote = bullet || number ? null : QUOTE_RE.exec(line);
      const heading = bullet || number || quote ? null : HEADING_RE.exec(line);

      if (bullet) {
        bodyStart = from + bullet[0].length;
        paint(marks, from + (bullet[1]?.length ?? 0), bodyStart, MARK_BULLET);
      } else if (number) {
        bodyStart = from + number[0].length;
        paint(marks, from + (number[1]?.length ?? 0), bodyStart, MARK_LIST_NUMBER);
      } else if (quote) {
        bodyStart = from + quote[0].length;
        paint(marks, bodyStart - 2, bodyStart, MARK_QUOTE_MARKER);
        paint(marks, bodyStart, to, MARK_QUOTE);
      } else if (heading) {
        bodyStart = from + heading[0].length;
        paint(marks, from, bodyStart, MARK_SYNTAX);
        paint(marks, bodyStart, to, MARK_BOLD);
      }
      paintInline(text, bodyStart, to, marks);
    }
    from = to + 1;
  }

  const spans: ComposerMarkdownSpan[] = [];
  for (let i = 0; i < marks.length; ) {
    const value = marks[i] ?? 0;
    let end = i + 1;
    while (end < marks.length && marks[end] === value) end += 1;
    if (value) spans.push({ start: i, end, marks: value });
    i = end;
  }
  return spans;
}

const IS_APPLE =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** The format a key press asks for. Slack's bindings, so they're already familiar. */
export function composerFormatFromKey(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  isApple = IS_APPLE,
): ComposerFormat | null {
  // On macOS, Ctrl+B and Ctrl+E are text-navigation keys, not formatting.
  const modifier = isApple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey) return null;
  if (event.shiftKey) {
    if (event.code === "Digit7") return "number";
    if (event.code === "Digit8") return "bullet";
    if (event.code === "Digit9") return "quote";
    return null;
  }
  const key = event.key.toLowerCase();
  if (key === "b") return "bold";
  if (key === "i") return "italic";
  if (key === "e") return "code";
  return null;
}

function countRun(text: string, index: number, step: 1 | -1, char: string): number {
  let count = 0;
  for (let i = index; text[i] === char; i += step) count += 1;
  return count;
}

function hasStarMarker(run: number, marker: string): boolean {
  // `***` carries both, so bold is two or more stars and italic an odd count.
  return marker === "**" ? run >= 2 : run % 2 === 1;
}

/** Whether `edit`'s selection already sits directly inside `marker`. */
function isWrappedBy(edit: ComposerTextEdit, marker: string): boolean {
  const { value, start, end } = edit;
  const char = marker[0] ?? "";
  if (char === "*") {
    const before = countRun(value, start - 1, -1, char);
    const after = countRun(value, end, 1, char);
    return hasStarMarker(before, marker) && hasStarMarker(after, marker);
  }
  return value.slice(start - marker.length, start) === marker && value.startsWith(marker, end);
}

function isFullyWrapped(line: string, marker: string): boolean {
  return line.length > marker.length * 2 && line.startsWith(marker) && line.endsWith(marker);
}

function wrapLine(line: string, marker: string): string {
  const body = line.trim();
  if (!body) return line;
  const leading = line.length - line.trimStart().length;
  return `${line.slice(0, leading)}${marker}${body}${marker}${line.slice(leading + body.length)}`;
}

function unwrapLine(line: string, marker: string): string {
  const body = line.trim();
  if (!body) return line;
  const leading = line.length - line.trimStart().length;
  const inner = body.slice(marker.length, body.length - marker.length);
  return `${line.slice(0, leading)}${inner}${line.slice(leading + body.length)}`;
}

function toggleInline(edit: ComposerTextEdit, marker: string): ComposerTextEdit {
  const { value } = edit;
  let { start, end } = edit;
  // `**word **` isn't emphasis, and double-clicking a word often takes the space.
  while (start < end && /\s/.test(value[start] ?? "")) start += 1;
  while (end > start && /\s/.test(value[end - 1] ?? "")) end -= 1;
  const size = marker.length;

  if (isWrappedBy({ value, start, end }, marker)) {
    return {
      value: value.slice(0, start - size) + value.slice(start, end) + value.slice(end + size),
      start: start - size,
      end: end - size,
    };
  }

  const selected = value.slice(start, end);
  if (!selected.includes("\n")) {
    if (isFullyWrapped(selected, marker)) {
      return {
        value: value.slice(0, start) + unwrapLine(selected, marker) + value.slice(end),
        start,
        end: end - size * 2,
      };
    }
    return {
      value: value.slice(0, start) + marker + selected + marker + value.slice(end),
      start: start + size,
      end: end + size,
    };
  }

  // Emphasis can't cross a blank line, so each line carries its own markers.
  const lines = selected.split("\n");
  const filled = lines.filter((line) => line.trim());
  const remove = filled.every((line) => isFullyWrapped(line.trim(), marker));
  const next = lines.map((line) => (remove ? unwrapLine(line, marker) : wrapLine(line, marker)));
  const replacement = next.join("\n");
  return {
    value: value.slice(0, start) + replacement + value.slice(end),
    start,
    end: start + replacement.length,
  };
}

const LINE_PREFIX_RE = /^(\s*)(?:[-*+] |\d{1,9}[.)] |> )/;

function prefixMatches(line: string, format: ComposerFormat): boolean {
  if (format === "bullet") return BULLET_RE.test(line);
  if (format === "number") return NUMBER_RE.test(line);
  return QUOTE_RE.test(line);
}

function togglePrefix(edit: ComposerTextEdit, format: ComposerFormat): ComposerTextEdit {
  const { value, start, end } = edit;
  const blockStart = value.lastIndexOf("\n", start - 1) + 1;
  // A selection ending just after a newline doesn't reach into that next line.
  const lastIndex = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const nextBreak = value.indexOf("\n", lastIndex);
  const blockEnd = nextBreak === -1 ? value.length : nextBreak;

  const lines = value.slice(blockStart, blockEnd).split("\n");
  const filled = lines.filter((line) => line.trim());
  const remove = filled.length > 0 && filled.every((line) => prefixMatches(line, format));

  let number = 0;
  const next = lines.map((line) => {
    const stripped = line.replace(LINE_PREFIX_RE, "$1");
    if (remove) return stripped;
    if (!line.trim() && lines.length > 1) return line;
    number += 1;
    const indent = /^\s*/.exec(stripped)?.[0] ?? "";
    const prefix = format === "bullet" ? "- " : format === "number" ? `${number}. ` : "> ";
    return `${indent}${prefix}${stripped.slice(indent.length)}`;
  });
  const replacement = next.join("\n");
  const nextValue = value.slice(0, blockStart) + replacement + value.slice(blockEnd);

  if (start === end && lines.length === 1) {
    const caret = Math.max(blockStart, start + replacement.length - (blockEnd - blockStart));
    return { value: nextValue, start: caret, end: caret };
  }
  return { value: nextValue, start: blockStart, end: blockStart + replacement.length };
}

/** Apply a format command to the selection, or take it off again if it's already there. */
export function applyComposerFormat(
  edit: ComposerTextEdit,
  format: ComposerFormat,
): ComposerTextEdit {
  if (format === "bold") return toggleInline(edit, "**");
  if (format === "italic") return toggleInline(edit, "*");
  if (format === "code") return toggleInline(edit, "`");
  return togglePrefix(edit, format);
}

const CONTINUED_LINE_RE = /^(\s*)(?:([-*+] )(\[[ xX]\] )?|(\d{1,9})([.)]) |> )/;

/**
 * Enter inside a list or quote: start the next item, or end the block when the
 * current item is empty. Null means the key keeps its usual meaning. Goes by the
 * parser, so a `- ` inside a code fence isn't a list.
 */
export function continueComposerList(value: string, caret: number): ComposerTextEdit | null {
  const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
  const nextBreak = value.indexOf("\n", caret);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  const line = value.slice(lineStart, lineEnd);
  const match = CONTINUED_LINE_RE.exec(line);
  if (!match || caret < lineStart + match[0].length) return null;

  const lineEndOfPrefix = lineStart + match[0].length;
  const isPrefix = parseComposerMarkdown(value).some(
    (span) =>
      span.marks & (MARK_BULLET | MARK_LIST_NUMBER | MARK_QUOTE_MARKER) &&
      span.start >= lineStart &&
      span.end <= lineEndOfPrefix,
  );
  if (!isPrefix) return null;

  if (!line.slice(match[0].length).trim()) {
    return {
      value: value.slice(0, lineStart) + value.slice(lineEnd),
      start: lineStart,
      end: lineStart,
    };
  }

  const indent = match[1] ?? "";
  let prefix = `${indent}> `;
  if (match[2]) prefix = `${indent}${match[2]}${match[3] ? "[ ] " : ""}`;
  if (match[4]) prefix = `${indent}${Number(match[4]) + 1}${match[5]} `;
  const insert = `\n${prefix}`;
  const next = caret + insert.length;
  return { value: value.slice(0, caret) + insert + value.slice(caret), start: next, end: next };
}

/** Backspace at the start of a list item or quote takes the whole prefix off. */
export function removeComposerLinePrefix(value: string, caret: number): ComposerTextEdit | null {
  const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
  const match = LINE_PREFIX_RE.exec(value.slice(lineStart, caret));
  if (!match || match[0].length !== caret - lineStart) return null;
  return {
    value: value.slice(0, lineStart) + (match[1] ?? "") + value.slice(caret),
    start: lineStart + (match[1]?.length ?? 0),
    end: lineStart + (match[1]?.length ?? 0),
  };
}
