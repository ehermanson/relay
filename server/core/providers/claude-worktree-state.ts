/**
 * Claude Code's session worktree, read from the transcript.
 *
 * `EnterWorktree` / `ExitWorktree` switch a running session into (or out of) a
 * git worktree without changing the process cwd Relay spawned it with. The CLI
 * records the switch as a last-wins transcript record, re-appended as the
 * session goes on:
 *
 *   {"type":"worktree-state","worktreeSession":{"worktreePath":"…","worktreeBranch":"…",…},"sessionId":"…"}
 *   {"type":"worktree-state","worktreeSession":null,"sessionId":"…"}   // after exit
 *
 * Both switches also relocate the transcript into the new cwd's project dir
 * (`relocateSessionTranscript`), so a stored transcript path goes stale.
 */

import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

export interface ClaudeWorktreeState {
  worktreePath: string;
  worktreeBranch?: string;
}

/** Bytes scanned from the end of the transcript. The record is re-appended every turn. */
const WORKTREE_SCAN_WINDOW = 262144;

/**
 * Pure: fold `worktree-state` records from JSONL text (file order) into the
 * last one. `undefined` = no record seen; `null` = the session left its worktree.
 */
export function pickClaudeWorktreeStateFromLines(
  text: string,
): ClaudeWorktreeState | null | undefined {
  let state: ClaudeWorktreeState | null | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || !line.includes('"worktree-state"')) continue;
    let parsed: { type?: unknown; worktreeSession?: unknown };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // partial line at the window edge
    }
    if (parsed?.type !== "worktree-state") continue;
    const session = parsed.worktreeSession as
      | { worktreePath?: unknown; worktreeBranch?: unknown }
      | null
      | undefined;
    if (session && typeof session.worktreePath === "string" && session.worktreePath) {
      state = {
        worktreePath: session.worktreePath,
        ...(typeof session.worktreeBranch === "string" && session.worktreeBranch
          ? { worktreeBranch: session.worktreeBranch }
          : {}),
      };
    } else {
      state = null;
    }
  }
  return state;
}

const cache = new Map<
  string,
  { mtimeMs: number; size: number; state: ClaudeWorktreeState | null }
>();

/**
 * The worktree a Claude session is currently working in, or null when it is
 * in its spawn cwd (or the transcript can't be read). Tail-scan only, cached
 * by path + mtime + size, so it is cheap to call on every watcher tick.
 */
export function readClaudeWorktreeState(jsonlPath: string): ClaudeWorktreeState | null {
  let mtimeMs: number;
  let size: number;
  try {
    ({ mtimeMs, size } = statSync(jsonlPath));
  } catch {
    cache.delete(jsonlPath);
    return null;
  }
  const cached = cache.get(jsonlPath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.state;

  let state: ClaudeWorktreeState | null = null;
  try {
    const fd = openSync(jsonlPath, "r");
    try {
      const length = Math.min(fstatSync(fd).size, WORKTREE_SCAN_WINDOW);
      if (length > 0) {
        const buf = Buffer.alloc(length);
        readSync(fd, buf, 0, length, Math.max(0, size - length));
        state = pickClaudeWorktreeStateFromLines(buf.toString("utf-8")) ?? null;
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    state = null;
  }
  if (cache.size >= 500) cache.clear();
  cache.set(jsonlPath, { mtimeMs, size, state });
  return state;
}
