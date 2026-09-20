/**
 * Codex multi-agent ("collaboration") items, normalized for Relay's shared
 * agent contract. Shared by the live app-server driver and transcript replay
 * so both produce the same `tool_use` activity + `agent_update` sequence.
 *
 * Wire shapes (CLI 0.154): rollouts record `event_msg item_completed` items
 * `SubAgentActivity` / `CollabAgentToolCall` with snake_case fields; the live
 * app-server delivers the same items as `subAgentActivity` /
 * `collabAgentToolCall` with camelCase fields. One normalizer handles both.
 *
 * Privacy: `spawn_agent.message`, `send_message.message`, and MESSAGE payloads
 * between agents are encrypted (Fernet tokens, `gAAAAA…`) in 0.154 rollouts.
 * Ciphertext is never surfaced — a field is either plaintext or omitted.
 */

import type { ActivityMessage, AgentInfo, AgentLifecycle } from "#core/types.js";

export type CodexCollabTool =
  | "spawn_agent"
  | "send_input"
  | "send_message"
  | "resume_agent"
  | "wait_agent"
  | "close_agent"
  | "followup_task"
  | "list_agents";

export interface CodexCollabAgentState {
  agentThreadId?: string;
  agentPath?: string;
  /** Provider `AgentStatus` variant name (`running`, `completed`, `errored`, `shutdown`, …). */
  status?: string;
  /** Payload of a data-carrying variant (`{"completed": "final text"}`, `{"errored": "reason"}`), plaintext only. */
  statusDetail?: string;
}

/**
 * Codex `AgentStatus` (CLI 0.154 binary, serde snake_case): `pending_init`,
 * `running`, `interrupted` (v2 list), `completed(String)`, `errored(String)`,
 * `shutdown`, `not_found`. Unit variants serialize as a bare string; the two
 * data variants as a single-key object. `not_found` and unknown names map to
 * nothing — Relay never guesses a lifecycle.
 */
export function mapCodexAgentStatus(status: string | undefined): AgentLifecycle | undefined {
  if (!status) return undefined;
  switch (status.toLowerCase().replace(/[-\s]/g, "_")) {
    case "running":
    case "in_progress":
    case "inprogress":
      return "running";
    case "pending":
    case "pending_init":
    case "pendinginit":
    case "queued":
      return "pending";
    case "completed":
    case "complete":
    case "done":
      return "completed";
    case "errored":
    case "error":
    case "failed":
      return "failed";
    case "shutdown":
    case "closed":
    case "interrupted":
    case "cancelled":
    case "canceled":
      return "stopped";
    default:
      return undefined;
  }
}

/**
 * Parse one `agents_states` value into `{ status, statusDetail }`. Accepts the
 * bare-string form, the single-key data-variant object, and the legacy record
 * shape (`{ agent_thread_id, agent_path, status }` — whose `status` may itself
 * be either of the first two).
 */
export function parseCodexAgentStatus(
  value: unknown,
): Pick<CodexCollabAgentState, "status" | "statusDetail"> {
  if (typeof value === "string") return value ? { status: value } : {};
  const record = asRecord(value);
  if (!record) return {};
  const keys = Object.keys(record);
  if (keys.length === 1 && mapCodexAgentStatus(keys[0]) !== undefined) {
    const detail = plaintextOrUndefined(record[keys[0]]);
    return detail ? { status: keys[0], statusDetail: detail } : { status: keys[0] };
  }
  return {};
}

const LEGACY_STATE_KEYS = ["agent_thread_id", "agentThreadId", "agent_path", "agentPath", "status"];

function normalizeCollabAgentState(value: unknown): CodexCollabAgentState {
  const record = asRecord(value);
  if (record && LEGACY_STATE_KEYS.some((key) => key in record)) {
    return {
      agentThreadId: pickString(record, "agent_thread_id", "agentThreadId"),
      agentPath: pickString(record, "agent_path", "agentPath"),
      ...parseCodexAgentStatus(record.status),
    };
  }
  return parseCodexAgentStatus(value);
}

export interface CodexCollabToolCall {
  id: string;
  tool: CodexCollabTool | string;
  status?: string;
  senderThreadId?: string;
  receiverThreadIds: string[];
  /** Plaintext prompt when the provider recorded one; encrypted prompts are dropped. */
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  agentsStates: Record<string, CodexCollabAgentState>;
}

export type CodexSubAgentActivityKind =
  | "started"
  | "interacted"
  | "interrupted"
  | "completed"
  | string;

export interface CodexSubAgentActivity {
  id: string;
  kind: CodexSubAgentActivityKind;
  agentThreadId: string;
  agentPath?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Codex encrypts inter-agent message bodies with Fernet; tokens are base64url
 * starting with the version byte `0x80` → `gAAAAA`. Anything matching is
 * treated as opaque and never displayed.
 */
export function isCodexEncryptedText(text: string): boolean {
  return /^gAAAAA[A-Za-z0-9_-]{20,}={0,2}$/.test(text.trim());
}

function plaintextOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || isCodexEncryptedText(trimmed)) return undefined;
  return value;
}

/** Leaf of an agent path (`/root/jev_research` → `jev_research`). */
export function codexAgentNameFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const leaf = path.split("/").filter(Boolean).pop();
  return leaf || undefined;
}

const COLLAB_TOOL_ALIASES: Record<string, CodexCollabTool> = {
  spawnagent: "spawn_agent",
  spawn_agent: "spawn_agent",
  sendinput: "send_input",
  send_input: "send_input",
  sendmessage: "send_message",
  send_message: "send_message",
  resumeagent: "resume_agent",
  resume_agent: "resume_agent",
  wait: "wait_agent",
  waitagent: "wait_agent",
  wait_agent: "wait_agent",
  closeagent: "close_agent",
  close_agent: "close_agent",
  followuptask: "followup_task",
  followup_task: "followup_task",
  listagents: "list_agents",
  list_agents: "list_agents",
};

/** Normalize `spawnAgent` / `spawn_agent` / `wait` / … onto Relay's canonical tool names. */
export function normalizeCodexCollabToolName(tool: string): CodexCollabTool | string {
  return COLLAB_TOOL_ALIASES[tool.toLowerCase()] ?? tool;
}

/** Function names Codex records under `namespace: "collaboration"`. */
export function isCodexCollabFunctionName(name: string): boolean {
  return normalizeCodexCollabToolName(name) in COLLAB_TOOL_DESCRIPTIONS;
}

const COLLAB_TOOL_DESCRIPTIONS: Record<CodexCollabTool, string> = {
  spawn_agent: "Spawning agent",
  send_input: "Messaging agent",
  send_message: "Messaging agent",
  resume_agent: "Resuming agent",
  wait_agent: "Waiting for agents",
  close_agent: "Stopping agent",
  followup_task: "Following up with agent",
  list_agents: "Listing agents",
};

export function describeCodexCollabTool(tool: string): string {
  const normalized = normalizeCodexCollabToolName(tool);
  return (COLLAB_TOOL_DESCRIPTIONS as Record<string, string>)[normalized] ?? "Coordinating agents";
}

/** `SubAgentActivity` (rollout) / `subAgentActivity` (live) → normalized, or null. */
export function normalizeCodexSubAgentActivity(item: unknown): CodexSubAgentActivity | null {
  const record = asRecord(item);
  if (!record) return null;
  const type = pickString(record, "type");
  if (type !== "SubAgentActivity" && type !== "subAgentActivity") return null;
  const id = pickString(record, "id");
  const kind = pickString(record, "kind");
  const agentThreadId = pickString(record, "agent_thread_id", "agentThreadId");
  if (!id || !kind || !agentThreadId) return null;
  return {
    id,
    kind,
    agentThreadId,
    agentPath: pickString(record, "agent_path", "agentPath"),
  };
}

/** `CollabAgentToolCall` (rollout) / `collabAgentToolCall` (live) → normalized, or null. */
export function normalizeCodexCollabToolCall(item: unknown): CodexCollabToolCall | null {
  const record = asRecord(item);
  if (!record) return null;
  const type = pickString(record, "type");
  if (type !== "CollabAgentToolCall" && type !== "collabAgentToolCall") return null;
  const id = pickString(record, "id");
  const tool = pickString(record, "tool");
  if (!id || !tool) return null;

  const receiverThreadIds = (() => {
    const raw = record.receiver_thread_ids ?? record.receiverThreadIds;
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  })();

  const agentsStates: Record<string, CodexCollabAgentState> = {};
  const rawStates = asRecord(record.agents_states ?? record.agentsStates);
  if (rawStates) {
    for (const [threadId, rawState] of Object.entries(rawStates)) {
      agentsStates[threadId] = normalizeCollabAgentState(rawState);
    }
  }
  // Older shape: `receiver_agents: [{ agent_path, agent_thread_id }]` paired with ids.
  const receiverAgents = record.receiver_agents ?? record.receiverAgents;
  if (Array.isArray(receiverAgents)) {
    for (const rawAgent of receiverAgents) {
      const agent = asRecord(rawAgent);
      const threadId = agent ? pickString(agent, "agent_thread_id", "agentThreadId") : undefined;
      if (!threadId) continue;
      agentsStates[threadId] = {
        ...agentsStates[threadId],
        agentThreadId: threadId,
        agentPath:
          agentsStates[threadId]?.agentPath ?? pickString(agent!, "agent_path", "agentPath"),
      };
    }
  }

  return {
    id,
    tool: normalizeCodexCollabToolName(tool),
    status: pickString(record, "status"),
    senderThreadId: pickString(record, "sender_thread_id", "senderThreadId"),
    receiverThreadIds,
    prompt: plaintextOrUndefined(record.prompt),
    model: pickString(record, "model"),
    reasoningEffort: pickString(record, "reasoning_effort", "reasoningEffort"),
    agentsStates,
  };
}

/**
 * Provenance stub for `agent_update.raw`: which provider item produced the
 * update, without its payload. The full item is never attached — it would
 * duplicate `result`/`assignment` text (and could carry ciphertext).
 */
export function codexAgentUpdateProvenance(item: unknown): Record<string, unknown> | undefined {
  const record = asRecord(item);
  if (!record) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of ["type", "id", "tool", "kind", "status", "method"]) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A copy of a live collaboration item safe to attach as `raw` (debug display):
 * encrypted string fields are replaced with a marker, never carried through.
 */
export function sanitizeCodexCollabRaw(item: unknown): unknown {
  const record = asRecord(item);
  if (!record) return item;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = typeof value === "string" && isCodexEncryptedText(value) ? "[encrypted]" : value;
  }
  return out;
}

/** Sanitized `input` for a collaboration tool_use — never carries encrypted blobs. */
export function sanitizeCodexCollabArguments(args: unknown): Record<string, unknown> {
  let parsed: unknown = args;
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args);
    } catch {
      return {};
    }
  }
  const record = asRecord(parsed);
  if (!record) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      const plain = plaintextOrUndefined(value);
      if (plain !== undefined) out[key] = plain;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      const clean = value.filter((v) => !isCodexEncryptedText(v));
      if (clean.length > 0) out[key] = clean;
    }
  }
  return out;
}

/**
 * The root-thread `tool_use` activity for a collaboration call. `toolUseId` is
 * the provider call id so the UI can anchor the agent card here.
 */
export function buildCodexCollabToolUse(
  tool: string,
  toolUseId: string,
  input: Record<string, unknown>,
  raw?: unknown,
): ActivityMessage {
  const normalized = normalizeCodexCollabToolName(tool);
  const target =
    typeof input.task_name === "string"
      ? input.task_name
      : typeof input.target === "string"
        ? input.target
        : undefined;
  return {
    type: "activity",
    activity: "tool_use",
    tool: normalized,
    toolUseId,
    description: describeCodexCollabTool(normalized),
    detail: target ? (codexAgentNameFromPath(target) ?? target) : undefined,
    input,
    inputDescription: target ? (codexAgentNameFromPath(target) ?? target) : undefined,
    ...(raw !== undefined ? { raw } : {}),
  };
}

/** Root-thread `tool_result` for a completed collaboration item. */
export function buildCodexCollabToolResult(
  call: CodexCollabToolCall,
  raw?: unknown,
): ActivityMessage {
  const failed = call.status === "failed" || call.status === "declined";
  return {
    type: "activity",
    activity: "tool_result",
    tool: call.tool,
    toolUseId: call.id,
    description: failed ? "Tool error" : `${describeCodexCollabTool(call.tool)} completed`,
    ...(raw !== undefined ? { raw } : {}),
  };
}

function collabInputFromCall(call: CodexCollabToolCall): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (call.prompt) input.prompt = call.prompt;
  if (call.model) input.model = call.model;
  if (call.reasoningEffort) input.reasoning_effort = call.reasoningEffort;
  const targets = Object.values(call.agentsStates)
    .map((state) => state.agentPath)
    .filter((p): p is string => typeof p === "string");
  if (targets.length === 1) input.target = targets[0];
  else if (targets.length > 1) input.targets = targets;
  return input;
}

/** Root-thread `tool_use` activity for a normalized `CollabAgentToolCall` item. */
export function buildCodexCollabToolUseFromCall(
  call: CodexCollabToolCall,
  raw?: unknown,
): ActivityMessage {
  return buildCodexCollabToolUse(call.tool, call.id, collabInputFromCall(call), raw);
}

function isFailedCollabCall(call: CodexCollabToolCall): boolean {
  return call.status === "failed" || call.status === "declined";
}

/**
 * Lifecycle for one receiver of a collaboration call. The provider's own
 * `agents_states` entry wins; the tool verb only supplies a start (`spawn_agent`
 * → running) or an end (`close_agent` → stopped) when the provider said
 * nothing. A failed spawn is the one verb failure that is the agent's: it
 * never started. Any other failed call (resume, send, wait) is the *call*
 * failing, not the agent, and leaves the lifecycle alone.
 */
function lifecycleForCollabReceiver(
  call: CodexCollabToolCall,
  state: CodexCollabAgentState | undefined,
): AgentLifecycle | undefined {
  const fromProvider = mapCodexAgentStatus(state?.status);
  if (fromProvider) return fromProvider;
  if (call.tool === "spawn_agent") return isFailedCollabCall(call) ? "failed" : "running";
  if (call.tool === "close_agent" && !isFailedCollabCall(call)) return "stopped";
  return undefined;
}

/**
 * Agent updates implied by a collaboration call: one per receiver / spawned
 * agent. `list_agents` and an empty `wait_agent` describe no agent and yield
 * nothing; a `wait_agent` that returns `agents_states` moves each listed agent
 * onto the provider-reported lifecycle (that is how children leave `running`).
 * `now` is the wall-clock the caller trusts (live: Date.now(); replay: the
 * entry timestamp).
 */
export function buildCodexCollabAgentUpdates(call: CodexCollabToolCall, now: number): AgentInfo[] {
  const threadIds = new Set<string>(call.receiverThreadIds);
  for (const [threadId, state] of Object.entries(call.agentsStates)) {
    threadIds.add(state.agentThreadId ?? threadId);
  }
  if (call.senderThreadId) threadIds.delete(call.senderThreadId);
  if (threadIds.size === 0) return [];

  const updates: AgentInfo[] = [];
  for (const threadId of threadIds) {
    const state =
      call.agentsStates[threadId] ??
      Object.values(call.agentsStates).find((s) => s.agentThreadId === threadId);
    const info: AgentInfo = {
      agentId: threadId,
      providerAgentId: threadId,
      relation: "child",
    };
    const name = codexAgentNameFromPath(state?.agentPath);
    if (name) info.name = name;
    if (call.tool === "spawn_agent") {
      info.originToolUseId = call.id;
      info.startedAt = now;
      if (call.model) info.model = call.model;
      if (call.reasoningEffort) info.reasoningEffort = call.reasoningEffort;
      if (call.prompt) info.assignment = call.prompt;
    }
    if (
      call.tool === "resume_agent" ||
      call.tool === "send_input" ||
      call.tool === "followup_task"
    ) {
      if (call.model) info.model = call.model;
      if (call.reasoningEffort) info.reasoningEffort = call.reasoningEffort;
    }

    const status = lifecycleForCollabReceiver(call, state);
    if (status) {
      info.status = status;
      if (status === "stopped" || status === "failed" || status === "completed") info.endedAt = now;
      if (status === "completed" && state?.statusDetail) info.result = state.statusDetail;
      else if (state?.statusDetail) info.statusDetail = state.statusDetail;
      else if (status === "failed" && call.tool === "spawn_agent" && call.status) {
        info.statusDetail = call.status;
      } else if (status === "stopped" && state?.status) info.statusDetail = state.status;
    } else if (isFailedCollabCall(call)) {
      info.lastActivity = `${describeCodexCollabTool(call.tool)} failed`;
    }
    updates.push(info);
  }
  return updates;
}

/** Agent update for a `SubAgentActivity` item (spawn / interaction / interrupt / completion). */
export function buildCodexSubAgentUpdate(activity: CodexSubAgentActivity, now: number): AgentInfo {
  const info: AgentInfo = {
    agentId: activity.agentThreadId,
    providerAgentId: activity.agentThreadId,
    relation: "child",
  };
  const name = codexAgentNameFromPath(activity.agentPath);
  if (name) info.name = name;
  switch (activity.kind) {
    case "started":
      info.originToolUseId = activity.id;
      info.status = "running";
      info.startedAt = now;
      break;
    case "interacted":
      // Transport activity says nothing about the child's work. Preserve its
      // last useful activity instead of replacing it with a message receipt.
      break;
    case "interrupted":
      info.status = "stopped";
      info.statusDetail = "interrupted";
      info.endedAt = now;
      break;
    case "completed":
      info.status = "completed";
      info.endedAt = now;
      break;
    default:
      info.lastActivity = activity.kind;
      break;
  }
  return info;
}

// -----------------------------------------------------------------------------
// Agent → agent reports
// -----------------------------------------------------------------------------

export type CodexAgentReportType = "MESSAGE" | "FINAL_ANSWER" | "NEW_TASK" | string;

export interface CodexAgentReport {
  /** Sender agent path (`/root/<name>`) as recorded by the provider. */
  author: string;
  recipient?: string;
  messageType: CodexAgentReportType;
  /** Plaintext payload; undefined when the body was encrypted or empty. */
  payload?: string;
  /** True when the message carried an `encrypted_content` part. */
  hasEncryptedContent: boolean;
}

const REPORT_HEADER = /^Message Type:\s*([A-Z_]+)\s*\n/;
const REPORT_PAYLOAD_MARKER = "\nPayload:\n";

/**
 * Parse a `response_item` `agent_message` (child ↔ parent report). Returns
 * null for anything that isn't an authored agent message. The header block is
 * `Message Type: …\nTask name: …\nSender: …\nPayload:\n<body>`; the body is
 * plaintext for FINAL_ANSWER and typically an `encrypted_content` part for
 * MESSAGE / NEW_TASK.
 */
export function parseCodexAgentReport(payload: unknown): CodexAgentReport | null {
  const record = asRecord(payload);
  if (!record || record.type !== "agent_message") return null;
  const author = pickString(record, "author");
  if (!author) return null;
  const recipient = pickString(record, "recipient");

  let text = "";
  let hasEncryptedContent = false;
  const content = record.content;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const rawPart of content) {
      const part = asRecord(rawPart);
      if (!part) continue;
      if (part.type === "encrypted_content" || typeof part.encrypted_content === "string") {
        hasEncryptedContent = true;
        continue;
      }
      if (typeof part.text === "string") text += part.text;
    }
  }

  const header = text.match(REPORT_HEADER);
  const messageType = header ? header[1] : "MESSAGE";
  let body: string | undefined;
  const markerIndex = text.indexOf(REPORT_PAYLOAD_MARKER);
  if (markerIndex >= 0) {
    body = text.slice(markerIndex + REPORT_PAYLOAD_MARKER.length);
  } else if (!header) {
    body = text;
  }
  body = body?.trim();
  if (body && isCodexEncryptedText(body)) {
    hasEncryptedContent = true;
    body = undefined;
  }

  return {
    author,
    recipient,
    messageType,
    payload: body || undefined,
    hasEncryptedContent,
  };
}
