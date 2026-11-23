/**
 * What a finished Antigravity prompt really did, and whether agy is about to
 * reply again on its own.
 *
 * agy reports an upstream API failure (quota exhausted, rate limit, a 502) as
 * an ordinary chat message and `end_turn`; the only structured evidence is the
 * error step it writes to the conversation's own SQLite log
 * (`<data>/conversations/<id>.db`, table `steps`). A finished prompt reads the
 * steps it added, read-only, and classifies the last one.
 *
 * A subagent's report lands in the parent's inbox
 * (`brain/<id>/.system_generated/messages/<msg>.json`, read receipts in
 * `read.json`) before agy turns it into a reply. While a high-priority message
 * is unread — or already dequeued as the transcript's trailing system step with
 * no reply yet — another reply is coming, so the current turn stays open.
 */

import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";
import { antigravityDataDir } from "#core/providers/antigravity-cli.js";
import {
  antigravityBrainDir,
  antigravityTranscriptPath,
} from "#core/providers/antigravity-transcript.js";

/** CORTEX_STEP_TYPE_ERROR_MESSAGE in agy's trajectory. */
const ERROR_STEP_TYPE = 17;
/** CORTEX_STEP_TYPE_PLANNER_RESPONSE: the model answered within the turn. */
const PLANNER_RESPONSE_STEP_TYPE = 15;
/** The harness error text leads the payload; a Go stack trace follows it. */
const MAX_ERROR_PAYLOAD_BYTES = 16_384;
const SESSION_ID = /^[\w-]+$/;

// The harness's rendering of a Google API error. Status is a gRPC code or an
// HTTP status line ("502 Bad Gateway"); a message stops at the next error.
const API_ERROR =
  /Error (\d{3}), Message: ((?:(?!, Status: |Error \d{3}, Message: ).)+), Status: ([A-Z_]+|\d{3}[^,\n]*)/s;
// agy 1.5 with a Google account writes "STATUS (code NNN): message".
const STATUS_ERROR = /(?<![A-Z_])([A-Z_]+) \(code (\d{3})\): (\P{Cc}+)/u;
const QUOTA_EXHAUSTED = /\breason:QUOTA_EXHAUSTED\b/;
// A saved thinking block without a valid signature: every later prompt to the
// conversation fails the same way.
const INVALID_THINKING_SIGNATURE =
  /\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)/;
const RESET_TIMESTAMP = /\bquotaResetTimeStamp:([^\s\]]+)/;
const GO_DURATION = String.raw`((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])`;
const RESET_DELAY = new RegExp(String.raw`\bquotaResetDelay:${GO_DURATION}`);
/** google.rpc.RetryInfo, which plain rate limits carry instead of a quota reset. */
const RETRY_DELAY = new RegExp(String.raw`\bretryDelay:${GO_DURATION}`);
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g;
const GO_DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

export interface AntigravityTurnFailure {
  kind: "usage_limit" | "provider_error";
  /** What the user reads. */
  message: string;
  code?: string;
  /** When the quota or rate limit resets (epoch ms), when agy says. */
  resetAt?: number;
  /** The conversation can't be sent to the model again; only a new chat continues. */
  broken?: boolean;
}

export interface AntigravityErrorStep {
  /** Payload text of the last step, when that step is an error. */
  errorText?: string;
  /** Whether any step of the turn was a model reply. */
  reachedModel: boolean;
}

function resetAtFrom(text: string, now: number): number | undefined {
  const timestamp = RESET_TIMESTAMP.exec(text)?.[1];
  if (timestamp) {
    const parsed = Date.parse(timestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const delay = RESET_DELAY.exec(text)?.[1] ?? RETRY_DELAY.exec(text)?.[1];
  if (!delay) return undefined;
  let delayMs = 0;
  for (const [, amount, unit] of delay.matchAll(GO_DURATION_PART)) {
    delayMs += Number(amount) * (GO_DURATION_UNIT_MS[unit] ?? 0);
  }
  return delayMs > 0 ? now + Math.round(delayMs) : undefined;
}

/** "in 2h 5m" / "in 40s" — relative, so it reads right on any device's clock. */
export function formatAntigravityResetDelay(resetAt: number, now: number): string {
  const seconds = Math.max(1, Math.round((resetAt - now) / 1000));
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
}

/**
 * Classify a finished prompt. `undefined` = it went fine. A typed `refusal`
 * is agy's mapping of an exhausted quota, so it fails even without a log.
 */
export function classifyAntigravityTurn(
  stopReason: string | undefined,
  step: AntigravityErrorStep | undefined,
  now: number = Date.now(),
): AntigravityTurnFailure | undefined {
  const text = step?.errorText;
  if (text === undefined && stopReason !== "refusal") return undefined;
  const errorText = text ?? "";
  const api = API_ERROR.exec(errorText);
  const status = STATUS_ERROR.exec(errorText);
  // [httpStatus, message, statusName]
  const parsed = api
    ? ([api[1], api[2], api[3]] as const)
    : status
      ? ([status[2], status[3], status[1]] as const)
      : undefined;

  if (stopReason === "refusal" || QUOTA_EXHAUSTED.test(errorText)) {
    const resetAt = resetAtFrom(errorText, now);
    return {
      kind: "usage_limit",
      message: `You've reached your Antigravity quota for this period${
        resetAt ? `. It resets ${formatAntigravityResetDelay(resetAt, now)}` : ""
      }.`,
      code: parsed?.[2] ?? "QUOTA_EXHAUSTED",
      ...(resetAt ? { resetAt } : {}),
    };
  }
  if (INVALID_THINKING_SIGNATURE.test(errorText)) {
    return {
      kind: "provider_error",
      message:
        "Antigravity's saved conversation can no longer be sent to the model (a thinking block in its history lost its signature). Start a new chat to continue.",
      code: "INVALID_THINKING_SIGNATURE",
      broken: true,
    };
  }
  if (!parsed) {
    return {
      kind: "provider_error",
      message: "Antigravity stopped this turn because of an error.",
    };
  }
  const [httpStatus, message, statusName] = parsed;
  const rateLimited = httpStatus === "429" || statusName === "RESOURCE_EXHAUSTED";
  const resetAt = resetAtFrom(errorText, now);
  const detail = message.trim();
  return {
    kind: rateLimited ? "usage_limit" : "provider_error",
    message: rateLimited
      ? `Antigravity is rate limited: ${detail}${resetAt ? ` Retry ${formatAntigravityResetDelay(resetAt, now)}.` : ""}`
      : `Antigravity error (${httpStatus}${statusName ? ` ${statusName.trim()}` : ""}): ${detail}`,
    code: statusName.trim(),
    ...(resetAt ? { resetAt } : {}),
  };
}

function conversationDbPath(home: string, sessionId: string): string {
  return join(antigravityDataDir(home), "conversations", `${sessionId}.db`);
}

function withSteps<T>(
  home: string,
  sessionId: string,
  read: (db: DatabaseSync) => T,
): T | undefined {
  if (!SESSION_ID.test(sessionId)) return undefined;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(conversationDbPath(home, sessionId), { readOnly: true });
    db.exec("PRAGMA busy_timeout = 100");
    const hasSteps =
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'").get() !==
      undefined;
    return hasSteps ? read(db) : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}

/** The conversation's last step index before a prompt; -1 when it has none yet. */
export function readAntigravityLastStepIndex(home: string, sessionId: string): number {
  return (
    withSteps(home, sessionId, (db) => {
      const index = db.prepare("SELECT max(idx) AS idx FROM steps").get()?.idx;
      return typeof index === "number" ? index : -1;
    }) ?? -1
  );
}

/** The last step a prompt added, when it is an error. */
export function readAntigravityTurnErrorStep(
  home: string,
  sessionId: string,
  afterIndex: number,
): AntigravityErrorStep | undefined {
  return withSteps(home, sessionId, (db) => {
    const row = db
      .prepare(
        "SELECT step_type AS type, substr(step_payload, 1, ?) AS payload FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1",
      )
      .get(MAX_ERROR_PAYLOAD_BYTES, afterIndex);
    if (typeof row?.type !== "number") return undefined;
    const reachedModel =
      db
        .prepare("SELECT 1 FROM steps WHERE idx > ? AND step_type = ? LIMIT 1")
        .get(afterIndex, PLANNER_RESPONSE_STEP_TYPE) !== undefined;
    if (row.type !== ERROR_STEP_TYPE) return { reachedModel };
    const payload = row.payload instanceof Uint8Array ? row.payload : new Uint8Array();
    return { errorText: new TextDecoder().decode(payload), reachedModel };
  });
}

const MAX_INBOX_MESSAGES = 200;
const MAX_INBOX_FILE_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;

function hasUnreadWakingMessage(home: string, sessionId: string): boolean {
  const dir = join(antigravityBrainDir(home, sessionId), ".system_generated", "messages");
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json") && name !== "read.json");
  } catch {
    return false;
  }
  if (names.length === 0 || names.length > MAX_INBOX_MESSAGES) return false;
  let receipts: Record<string, unknown> = {};
  try {
    receipts = JSON.parse(readFileSync(join(dir, "read.json"), "utf-8")) as Record<string, unknown>;
  } catch {
    // no receipts yet: every message is unread
  }
  for (const name of names) {
    const id = name.slice(0, -5);
    if (receipts[id] === true) continue;
    try {
      const path = join(dir, name);
      if (statSync(path).size > MAX_INBOX_FILE_BYTES) continue;
      const message = JSON.parse(readFileSync(path, "utf-8")) as {
        id?: unknown;
        priority?: unknown;
      };
      if (typeof message.id === "string" && receipts[message.id] === true) continue;
      if (message.priority === "MESSAGE_PRIORITY_HIGH") return true;
    } catch {
      // mid-write or malformed: not evidence of a wake
    }
  }
  return false;
}

function lastTranscriptStep(path: string): { type?: string; content?: string } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size === 0) return undefined;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf-8", 0, bytesRead).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      // A partial first line of the window isn't a step.
      if (i === 0 && start > 0) return undefined;
      return JSON.parse(line) as { type?: string; content?: string };
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * True when agy is about to reply on its own: a high-priority message (a
 * subagent's report) is unread in the inbox, or already dequeued as the
 * transcript's trailing system step with no reply after it. Fails closed.
 */
export function hasAntigravityPendingReply(home: string, sessionId: string): boolean {
  if (!SESSION_ID.test(sessionId)) return false;
  if (hasUnreadWakingMessage(home, sessionId)) return true;
  const last = lastTranscriptStep(antigravityTranscriptPath(home, sessionId));
  if (!last || last.type !== "SYSTEM_MESSAGE") return false;
  return (last.content ?? "").includes("priority=MESSAGE_PRIORITY_HIGH");
}
