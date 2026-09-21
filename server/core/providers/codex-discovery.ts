import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { RELAY_CODEX_ORIGINATOR } from "#core/providers/codex-cli.js";

/**
 * External Codex session discovery helpers.
 *
 * Codex writes one rollout JSONL per thread under `~/.codex/sessions/YYYY/MM/DD/`
 * whose first line is a `session_meta` record carrying the thread id and cwd.
 * Discovery has two signals:
 *
 * 1. A running `codex` process whose cwd is a registered project (PID-based,
 *    shared with Claude). The N most recently written rollouts for that cwd are
 *    paired with the N processes.
 * 2. A rollout in a registered cwd that is *still being written*. Codex Desktop
 *    hosts threads inside ChatGPT.app, so there is no `codex` process with the
 *    project cwd to find — the transcript's mtime is the only durable liveness
 *    signal. Such sessions are reported without a `pid`. Rollouts Relay itself
 *    originated are excluded here: Relay's threads are managed by definition.
 *
 * Sub-agent rollouts (multi-agent spawns) are excluded from both signals.
 *
 * Signal 2 is deliberately Codex-specific: Claude Code always runs as a
 * `claude` process with the project cwd (CLI, VS Code extension, SDK), and
 * nothing writes `~/.claude/projects` transcripts without a local process, so
 * PID discovery is complete there.
 */

export interface CodexTranscriptCandidate {
  path: string;
  mtime: number;
}

export interface CodexSessionMeta {
  sessionId: string;
  cwd: string;
  /** `session_meta.originator` — the client that created the thread. */
  originator?: string;
  /** Spawned by another thread (multi-agent); never a chat of its own. */
  subagent: boolean;
}

export interface DiscoveredCodexTranscript {
  path: string;
  sessionId: string;
  cwd: string;
  pid?: number;
}

/**
 * Default liveness window for signal 2. Mirrors the instance manager's
 * `DISCOVERY_INTERVAL × STALE_THRESHOLD` (30s × 3), the same mtime window it
 * already trusts when deciding an external session has *not* gone stale.
 */
export const DEFAULT_CODEX_TRANSCRIPT_ACTIVITY_WINDOW_MS = 90_000;

const FIRST_LINE_CHUNK_BYTES = 64 * 1024;
const FIRST_LINE_MAX_BYTES = 1024 * 1024;

/**
 * Read only the first line of a file. `session_meta` embeds the full system
 * prompt (tens of KB) but the rollout itself can be tens of MB, so reading the
 * whole file to reach line one is not an option for a 30s poll.
 */
function readFirstLine(filePath: string): string | null {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(FIRST_LINE_CHUNK_BYTES);
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < FIRST_LINE_MAX_BYTES) {
      const bytesRead = readSync(fd, buf, 0, FIRST_LINE_CHUNK_BYTES, offset);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(Buffer.from(chunk.subarray(0, newline)));
        return Buffer.concat(chunks).toString("utf-8");
      }
      chunks.push(Buffer.from(chunk));
      offset += bytesRead;
    }
    // No newline yet (file still being written, or a single-line file).
    return chunks.length > 0 ? Buffer.concat(chunks).toString("utf-8") : null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Sub-agent threads record their spawn in `session_meta`: newer CLIs set
 * `thread_source: "subagent"`, older ones nest it under `source.subagent`.
 */
export function isSubagentSessionMeta(
  payload: { source?: unknown; thread_source?: string } | undefined,
): boolean {
  if (!payload) return false;
  if (payload.thread_source === "subagent") return true;
  return (
    typeof payload.source === "object" &&
    payload.source !== null &&
    "subagent" in (payload.source as Record<string, unknown>)
  );
}

// Session meta is immutable once written, so successful reads are cached by
// path for the life of the process. Failures (no session_meta yet, unreadable)
// are cached by mtime so a file that is still being created is retried once
// it changes.
const sessionMetaCache = new Map<string, CodexSessionMeta>();
const sessionMetaFailures = new Map<string, number>();

export function readCodexSessionMeta(filePath: string, mtime?: number): CodexSessionMeta | null {
  const cached = sessionMetaCache.get(filePath);
  if (cached) return cached;
  let fileMtime = mtime;
  try {
    if (fileMtime === undefined) fileMtime = statSync(filePath).mtimeMs;
    if (sessionMetaFailures.get(filePath) === fileMtime) return null;
    const firstLine = readFirstLine(filePath);
    if (!firstLine) throw new Error("empty");
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: {
        id?: string;
        cwd?: string;
        originator?: string;
        source?: unknown;
        thread_source?: string;
      };
    };
    const sessionId = parsed.payload?.id;
    const cwd = parsed.payload?.cwd;
    if (parsed.type !== "session_meta" || !sessionId || !cwd) throw new Error("no session_meta");
    const meta: CodexSessionMeta = {
      sessionId,
      cwd,
      originator:
        typeof parsed.payload?.originator === "string" ? parsed.payload.originator : undefined,
      subagent: isSubagentSessionMeta(parsed.payload),
    };
    sessionMetaCache.set(filePath, meta);
    sessionMetaFailures.delete(filePath);
    return meta;
  } catch {
    sessionMetaFailures.set(filePath, fileMtime ?? -1);
    return null;
  }
}

/** Every rollout file under `<codexDir>/sessions`, with its mtime. */
export function listCodexTranscripts(codexDir: string): CodexTranscriptCandidate[] {
  const sessionsDir = join(codexDir, "sessions");
  const results: CodexTranscriptCandidate[] = [];
  if (!existsSync(sessionsDir)) return results;

  const stack = [sessionsDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.endsWith(".jsonl")) continue;
      results.push({ path: fullPath, mtime: stat.mtimeMs });
    }
  }
  return results;
}

/**
 * Pure selection step shared by discovery and its tests: pair process-backed
 * cwds with their most recent rollouts, then add any still-being-written
 * rollout in a registered cwd that no process claimed.
 */
export function selectCodexExternalTranscripts(options: {
  transcripts: CodexTranscriptCandidate[];
  readMeta: (candidate: CodexTranscriptCandidate) => CodexSessionMeta | null;
  processCwds: Map<string, { count: number; pids: number[] }>;
  isRegisteredDirectory: (cwd: string) => boolean;
  /** Rollouts modified at/after this instant count as live without a process. */
  activeSince: number;
}): DiscoveredCodexTranscript[] {
  const byCwd = new Map<string, Array<CodexTranscriptCandidate & CodexSessionMeta>>();
  const withMeta: Array<CodexTranscriptCandidate & CodexSessionMeta> = [];
  // A file's cwd is only known from its meta, so when a process cwd needs
  // ranking every file must be read (cached after the first pass). With no
  // processes only fresh files can matter.
  const needsAllMeta = options.processCwds.size > 0;
  for (const candidate of options.transcripts) {
    if (!needsAllMeta && candidate.mtime < options.activeSince) continue;
    const meta = options.readMeta(candidate);
    // Sub-agent rollouts belong to their parent thread; surfacing them would
    // sprout a chat per spawned agent (and a process cwd could pair with one
    // instead of the parent).
    if (!meta || meta.subagent) continue;
    const entry = { ...candidate, ...meta };
    withMeta.push(entry);
    const list = byCwd.get(meta.cwd) ?? [];
    list.push(entry);
    byCwd.set(meta.cwd, list);
  }

  const selected: DiscoveredCodexTranscript[] = [];
  const seen = new Set<string>();

  for (const [cwd, info] of options.processCwds) {
    if (!options.isRegisteredDirectory(cwd)) continue;
    const matches = (byCwd.get(cwd) ?? []).sort((a, b) => b.mtime - a.mtime).slice(0, info.count);
    matches.forEach((match, index) => {
      if (seen.has(match.path)) return;
      seen.add(match.path);
      selected.push({
        path: match.path,
        sessionId: match.sessionId,
        cwd,
        pid: info.pids[index],
      });
    });
  }

  for (const entry of withMeta) {
    if (seen.has(entry.path) || entry.mtime < options.activeSince) continue;
    // A fresh Relay-originated rollout that no managed session claims is
    // either a thread still binding its id or one the user removed — neither
    // is an external session. (Process-backed pairing above stays permissive:
    // `codex resume` of a Relay thread in a terminal is legitimately external.)
    if (entry.originator === RELAY_CODEX_ORIGINATOR) continue;
    if (!options.isRegisteredDirectory(entry.cwd)) continue;
    seen.add(entry.path);
    selected.push({ path: entry.path, sessionId: entry.sessionId, cwd: entry.cwd });
  }

  return selected;
}
