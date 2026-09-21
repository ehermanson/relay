/**
 * Claude delegated-agent envelope and `Agent`/`Task` tool parsing.
 *
 * This module is **Claude-specific** (core, no server imports). It is used by
 * the Claude SDK driver (`providers/claude-sdk.ts`) and by the Claude JSONL
 * replay path in `instance-manager.ts` (`parseJsonl` → `convertUserEntry`,
 * which only ever runs on Claude transcripts — Codex rollouts go through
 * `providers/codex-transcript.ts`). Codex has its own equivalents in
 * `providers/codex-agent-activity.ts`. The provider-neutral pieces (merging
 * sparse `AgentInfo` patches, folding history) live in `agent-info.ts`.
 *
 * Claude delivers agent-to-agent traffic inside *user-role* envelopes: a peer
 * or teammate report arrives as
 *   "Another Claude session sent a message:\n<agent-message from="x">BODY</agent-message>\n\n<instruction paragraph>"
 * and a background subagent's completion arrives as `<task-notification>` XML.
 * The transport role must never decide displayed authorship, so both the live
 * SDK stream and transcript replay classify user text through
 * `classifyUserEnvelope` before deciding whether it is a human message, an
 * agent note, or an agent lifecycle update.
 *
 * The same module owns the `AgentInfo` builders for `Agent`/`Task` tool calls,
 * their results, and task notifications so live and replay emit identical
 * `agent_update`s.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { AgentInfo, AgentLifecycle } from "#core/types.js";
import { extractToolResultText } from "#core/tools.js";

// =============================================================================
// Envelope classification
// =============================================================================

/** Subset of the SDK's `SDKMessageOrigin` we read. Transcript entries carry the same object. */
export interface UserMessageOrigin {
  kind: string;
  from?: string;
  name?: string;
  body?: string;
  senderTaskId?: string;
}

export type UserEnvelopeClassification =
  | { kind: "human" }
  | {
      kind: "agent";
      /** Sender display name as reported by the provider (reported speech, not authority). */
      name?: string;
      /** Provider task id of the sending in-process agent, when stamped by the harness. */
      senderTaskId?: string;
      /** Message body with the envelope and instruction wrapper stripped. */
      body: string;
    }
  | {
      kind: "task-notification";
      taskId?: string;
      toolUseId?: string;
      status: AgentLifecycle;
      summary?: string;
      result?: string;
      outputFile?: string;
    }
  | { kind: "internal" };

const AGENT_MESSAGE_ENVELOPE_RE =
  /^\s*(?:Another Claude session sent a message:\s*)?<agent-message\b([^>]*)>\s*([\s\S]*?)\s*<\/agent-message>\s*([\s\S]*)$/;

const TASK_NOTIFICATION_RE = /<task-notification>([\s\S]*?)<\/task-notification>/;

const COORDINATOR_REMINDER_RE =
  /^\s*<system-reminder>\s*The coordinator sent a message[^\n]*\n?([\s\S]*?)\s*<\/system-reminder>\s*$/;

function readAttribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return match ? decodeXmlEntities(match[1]) : undefined;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function readXmlElement(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!match) return undefined;
  const value = match[1].trim();
  return value ? value : undefined;
}

/**
 * Strip the `<agent-message from="…">` envelope (with or without the
 * "Another Claude session sent a message:" preface and the trailing
 * instruction paragraph). Returns null when the text is not an envelope.
 */
export function stripAgentMessageEnvelope(text: string): { name?: string; body: string } | null {
  const match = AGENT_MESSAGE_ENVELOPE_RE.exec(text);
  if (!match) return null;
  const attrs = match[1] ?? "";
  const name = readAttribute(attrs, "name") ?? readAttribute(attrs, "from");
  return { name: name || undefined, body: match[2].trim() };
}

/** Map a provider task status string onto Relay's lifecycle vocabulary. */
export function mapTaskStatus(status: string | undefined): AgentLifecycle {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "paused":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
    case "killed":
      return "stopped";
    default:
      return "unknown";
  }
}

/** Parse `<task-notification>` XML. Returns null when the text holds none. */
export function parseTaskNotification(
  text: string,
): Extract<UserEnvelopeClassification, { kind: "task-notification" }> | null {
  const match = TASK_NOTIFICATION_RE.exec(text);
  if (!match) return null;
  const xml = match[1];
  const result = readXmlElement(xml, "result");
  return {
    kind: "task-notification",
    taskId: readXmlElement(xml, "task-id"),
    toolUseId: readXmlElement(xml, "tool-use-id"),
    status: mapTaskStatus(readXmlElement(xml, "status")),
    summary: readXmlElement(xml, "summary"),
    result: result ? decodeXmlEntities(result) : undefined,
    outputFile: readXmlElement(xml, "output-file"),
  };
}

/**
 * Decide who authored a user-role message. `origin` (SDK `SDKMessageOrigin`,
 * also persisted on transcript entries) is authoritative when present; the
 * text-shape fallbacks cover older transcripts that lack it.
 */
export function classifyUserEnvelope(
  text: string,
  origin?: UserMessageOrigin | null,
): UserEnvelopeClassification {
  const kind = origin?.kind;

  if (kind === "task-notification") {
    return parseTaskNotification(text) ?? { kind: "internal" };
  }

  if (kind === "peer" || kind === "observer") {
    const stripped = stripAgentMessageEnvelope(text);
    return {
      kind: "agent",
      name: origin?.name ?? origin?.from ?? stripped?.name,
      senderTaskId: origin?.senderTaskId,
      body: origin?.body ?? stripped?.body ?? text.trim(),
    };
  }

  if (kind === "coordinator") {
    const reminder = COORDINATOR_REMINDER_RE.exec(text);
    const stripped = stripAgentMessageEnvelope(text);
    return {
      kind: "agent",
      name: "Coordinator",
      body: origin?.body ?? reminder?.[1]?.trim() ?? stripped?.body ?? text.trim(),
    };
  }

  if (kind === "auto-continuation" || kind === "observer-activity") {
    return { kind: "internal" };
  }

  // No (or human/channel) origin: fall back to the text shape. Older CLIs and
  // pre-origin transcripts still carry the envelope wrappers.
  const notification = parseTaskNotification(text);
  if (notification) return notification;

  const stripped = stripAgentMessageEnvelope(text);
  if (stripped) {
    return { kind: "agent", name: stripped.name, body: stripped.body };
  }

  return { kind: "human" };
}

// =============================================================================
// AgentInfo builders (shared by live + replay)
// =============================================================================

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Build the initial `AgentInfo` for an `Agent`/`Task` tool call. The Relay
 * key is the spawning tool_use id — it is known before the provider assigns
 * its own agent id and equals `parent_tool_use_id` on live child frames.
 * `model` is copied verbatim (an alias like "sonnet" stays an alias); the
 * result's `resolvedModel` overrides it later.
 */
export function buildAgentSpawnInfo(
  toolUseId: string,
  input: Record<string, unknown> | undefined,
  options: { parentAgentId?: string; startedAt?: number } = {},
): AgentInfo {
  const info: AgentInfo = {
    agentId: toolUseId,
    originToolUseId: toolUseId,
    relation: "child",
    status: "pending",
  };
  if (options.parentAgentId) info.parentAgentId = options.parentAgentId;
  if (options.startedAt !== undefined) info.startedAt = options.startedAt;
  const name = asString(input?.name);
  const role = asString(input?.subagent_type);
  const description = asString(input?.description);
  const assignment = asString(input?.prompt);
  const model = asString(input?.model);
  if (name) info.name = name;
  if (role) info.role = role;
  if (description) info.description = description;
  if (assignment) info.assignment = assignment;
  if (model) info.model = model;
  return info;
}

/** Text of the subagent's final report from a tool result / message `content` (string or block array). */
function extractReportText(content: unknown): string | undefined {
  const text = extractToolResultText(content).trim();
  return text || undefined;
}

const ASYNC_LAUNCH_TEXT_RE = /^Async agent launched successfully/;
const ASYNC_LAUNCH_AGENT_ID_RE = /\bagentId:\s*([A-Za-z0-9_-]+)/;

/**
 * Build the `AgentInfo` patch for an `Agent`/`Task` tool result. Prefers the
 * structured `toolUseResult` (SDK `tool_use_result` / transcript
 * `toolUseResult`); falls back to the tool_result text when it is absent.
 */
export function buildAgentResultInfo(
  agentKey: string,
  toolUseResult: unknown,
  fallback: { isError?: boolean; contentText?: string; endedAt?: number } = {},
): AgentInfo {
  const info: AgentInfo = { agentId: agentKey };
  const structured =
    toolUseResult && typeof toolUseResult === "object" && !Array.isArray(toolUseResult)
      ? (toolUseResult as Record<string, unknown>)
      : undefined;

  const asyncLaunched =
    structured?.status === "async_launched" ||
    structured?.isAsync === true ||
    (!structured && !!fallback.contentText && ASYNC_LAUNCH_TEXT_RE.test(fallback.contentText));

  if (asyncLaunched) {
    info.status = "running";
    const providerAgentId =
      asString(structured?.agentId) ??
      (fallback.contentText ? ASYNC_LAUNCH_AGENT_ID_RE.exec(fallback.contentText)?.[1] : undefined);
    if (providerAgentId) info.providerAgentId = providerAgentId;
    const model = asString(structured?.resolvedModel);
    if (model) info.model = model;
    const description = asString(structured?.description);
    if (description) info.description = description;
    return info;
  }

  const providerStatus = asString(structured?.status);
  info.status =
    fallback.isError || providerStatus === "failed"
      ? "failed"
      : providerStatus === "stopped" || providerStatus === "killed"
        ? "stopped"
        : "completed";
  if (fallback.isError) info.resultIsError = true;
  const providerAgentId = asString(structured?.agentId);
  if (providerAgentId) info.providerAgentId = providerAgentId;
  const role = asString(structured?.agentType);
  if (role) info.role = role;
  const model = asString(structured?.resolvedModel);
  if (model) info.model = model;
  const result = extractReportText(structured?.content) ?? fallback.contentText?.trim();
  if (result) info.result = result;
  const totalTokens = asNumber(structured?.totalTokens);
  const toolUses = asNumber(structured?.totalToolUseCount);
  const durationMs = asNumber(structured?.totalDurationMs);
  if (totalTokens !== undefined || toolUses !== undefined || durationMs !== undefined) {
    info.usage = {};
    if (totalTokens !== undefined) info.usage.totalTokens = totalTokens;
    if (toolUses !== undefined) info.usage.toolUses = toolUses;
    if (durationMs !== undefined) info.usage.durationMs = durationMs;
  }
  if (fallback.endedAt !== undefined) info.endedAt = fallback.endedAt;
  return info;
}

/** The parsed fields of a task notification (system `task_notification` event or `<task-notification>` XML). */
export interface TaskNotificationFields {
  taskId?: string;
  toolUseId?: string;
  status: AgentLifecycle;
  summary?: string;
  /** Inline result text when the notification carries one (the XML `<result>`). */
  result?: string;
  /** Background output transcript; read for the final report when `result` is absent. */
  outputFile?: string;
  usage?: AgentInfo["usage"];
}

/**
 * Build the terminal `AgentInfo` patch for a task notification. Shared by the
 * live SDK system event, the live user-envelope XML, and transcript replay so
 * all three produce the same update: the notification's one-line summary is
 * only `lastActivity` when a fuller report (inline or from the output file)
 * is available, otherwise it doubles as the result.
 */
export function buildTaskNotificationInfo(
  agentKey: string,
  notification: TaskNotificationFields,
  options: { endedAt?: number } = {},
): AgentInfo {
  const info: AgentInfo = { agentId: agentKey, status: notification.status };
  if (options.endedAt !== undefined) info.endedAt = options.endedAt;
  if (notification.taskId) info.providerAgentId = notification.taskId;
  if (notification.toolUseId) info.originToolUseId = notification.toolUseId;
  const report = notification.result ?? readAgentOutputResult(notification.outputFile) ?? undefined;
  if (report ?? notification.summary) info.result = report ?? notification.summary;
  if (notification.summary && report) info.lastActivity = notification.summary;
  if (notification.status === "failed") info.resultIsError = true;
  if (notification.usage) info.usage = notification.usage;
  return info;
}

// The pure merge/fold helpers live in the fs-free `agent-info.ts` so the UI can
// share them via `@shared/agent-info`; re-exported here for existing importers.
export { mergeAgentInfo, collectAgentsFromHistory, findAgentKeyByProviderId } from "#core/agent-info.js";

// =============================================================================
// Output-file result extraction
// =============================================================================

/** Never scan more than this far back into a background output file. */
const MAX_AGENT_OUTPUT_SCAN_BYTES = 8 * 1024 * 1024;
/** First tail window; grows geometrically when the report isn't in it. */
const AGENT_OUTPUT_TAIL_BYTES = 64 * 1024;
const MAX_AGENT_OUTPUT_CACHE_ENTRIES = 64;

interface AgentOutputCacheEntry {
  mtimeMs: number;
  size: number;
  result: string | null;
}

/** Memo keyed by path, validated by (mtime, size): parent re-parses hit the same files repeatedly. */
const agentOutputResultCache = new Map<string, AgentOutputCacheEntry>();

/** Last assistant text among the complete lines of a chunk, or null. */
function lastAssistantTextInChunk(chunk: string): string | null {
  const lines = chunk.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"assistant"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
      if (entry.type !== "assistant") continue;
      const text = extractReportText(entry.message?.content);
      if (text) return text;
    } catch {
      // partial or malformed line
    }
  }
  return null;
}

/**
 * Cheaply read the last assistant text from a subagent's output/transcript
 * JSONL. Reads the file from the end in growing windows (64KB, 256KB, …) so
 * multi-megabyte transcripts cost one small read in the common case, and
 * memoizes by (path, mtime, size). Returns null when the file is missing or
 * no assistant text is found within the scan cap.
 */
export function readAgentOutputResult(filePath: string | undefined): string | null {
  if (!filePath) return null;
  let stat: { mtimeMs: number; size: number };
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }
  if (stat.size === 0) return null;

  const cached = agentOutputResultCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.result;
  }

  const result = scanAgentOutputTail(filePath, stat.size);
  agentOutputResultCache.delete(filePath);
  agentOutputResultCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, result });
  if (agentOutputResultCache.size > MAX_AGENT_OUTPUT_CACHE_ENTRIES) {
    const oldest = agentOutputResultCache.keys().next().value;
    if (oldest !== undefined) agentOutputResultCache.delete(oldest);
  }
  return result;
}

function scanAgentOutputTail(filePath: string, size: number): string | null {
  const limit = Math.min(size, MAX_AGENT_OUTPUT_SCAN_BYTES);
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    let window = Math.min(AGENT_OUTPUT_TAIL_BYTES, limit);
    for (;;) {
      const start = size - window;
      const buffer = Buffer.alloc(window);
      const read = readSync(fd, buffer, 0, window, start);
      let chunk = buffer.toString("utf-8", 0, read);
      // Drop the leading partial line unless the window starts at the file head.
      if (start > 0) {
        const newline = chunk.indexOf("\n");
        chunk = newline === -1 ? "" : chunk.slice(newline + 1);
      }
      const text = lastAssistantTextInChunk(chunk);
      if (text) return text;
      if (window >= limit) return null;
      window = Math.min(window * 4, limit);
    }
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
