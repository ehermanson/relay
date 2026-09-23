/**
 * Claude Code session titles read from the transcript itself.
 *
 * Claude Code appends title records to the session JSONL as it goes:
 *
 *   {"type":"ai-title","aiTitle":"Sidecar drawer scrolling on mobile","sessionId":"…"}
 *   {"type":"custom-title","customTitle":"my name","sessionId":"…"}
 *
 * `ai-title` is the CLI's own background (Haiku-class) summary of the first
 * prompt, written a few seconds after the prompt — before the assistant's
 * first message — and re-appended when it is re-evaluated later. `custom-title`
 * is a user `/rename`. Last record of each kind wins; a custom title beats an
 * AI one. These records have no `timestamp` and no `message`. The old
 * `sessions-index.json` sidecar this replaced is no longer written by the CLI.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export interface ClaudeTranscriptTitle {
  title: string;
  source: "custom" | "ai";
}

/** Bytes scanned from each end of a large transcript. */
const TITLE_SCAN_WINDOW = 65536;

function cleanTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : null;
}

/** Pure: a title record → title, or null for any other entry. */
export function extractClaudeTitleRecord(entry: unknown): ClaudeTranscriptTitle | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as { type?: unknown; aiTitle?: unknown; customTitle?: unknown };
  if (record.type === "custom-title") {
    const title = cleanTitle(record.customTitle);
    return title ? { title, source: "custom" } : null;
  }
  if (record.type === "ai-title") {
    const title = cleanTitle(record.aiTitle);
    return title ? { title, source: "ai" } : null;
  }
  return null;
}

/** Cheap pre-filter so the common transcript line is never JSON-parsed. */
export function mayBeClaudeTitleLine(line: string): boolean {
  return line.includes('"ai-title"') || line.includes('"custom-title"');
}

/**
 * Fold title records from JSONL text (lines in file order) into the winning
 * title: the last `custom-title` if any, else the last `ai-title`.
 */
export function pickClaudeTitleFromLines(text: string): ClaudeTranscriptTitle | null {
  let custom: ClaudeTranscriptTitle | null = null;
  let ai: ClaudeTranscriptTitle | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || !mayBeClaudeTitleLine(line)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // partial line at a window edge
    }
    const found = extractClaudeTitleRecord(parsed);
    if (!found) continue;
    if (found.source === "custom") custom = found;
    else ai = found;
  }
  return custom ?? ai;
}

/**
 * Read the session title recorded in a Claude transcript. Scans the head and
 * tail windows only (the first title lands right after the first prompt; later
 * re-evaluations and renames are appended), so cost is bounded for
 * multi-megabyte transcripts. Returns null when the file has no title record
 * or cannot be read.
 */
export function readClaudeTranscriptTitle(jsonlPath: string): ClaudeTranscriptTitle | null {
  try {
    const fd = openSync(jsonlPath, "r");
    try {
      const size = fstatSync(fd).size;
      if (size <= 0) return null;
      let text: string;
      if (size <= TITLE_SCAN_WINDOW * 2) {
        const buf = Buffer.alloc(size);
        readSync(fd, buf, 0, size, 0);
        text = buf.toString("utf-8");
      } else {
        const head = Buffer.alloc(TITLE_SCAN_WINDOW);
        readSync(fd, head, 0, TITLE_SCAN_WINDOW, 0);
        const tail = Buffer.alloc(TITLE_SCAN_WINDOW);
        readSync(fd, tail, 0, TITLE_SCAN_WINDOW, size - TITLE_SCAN_WINDOW);
        // Head then tail keeps file order, so "last record wins" still holds.
        text = head.toString("utf-8") + "\n" + tail.toString("utf-8");
      }
      return pickClaudeTitleFromLines(text);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
