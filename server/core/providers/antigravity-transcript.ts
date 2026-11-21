/**
 * Antigravity transcript replay.
 *
 * `agy` keeps each conversation in a SQLite database of protobuf steps
 * (`<data>/conversations/<id>.db`) and mirrors it, step by step, as JSONL:
 * `<data>/brain/<id>/.system_generated/logs/transcript_full.jsonl`. Relay
 * replays the JSONL — it is plain text, timestamped, carries per-step token
 * usage and the full tool arguments (`transcript.jsonl` beside it holds the
 * same steps with each argument JSON-encoded as a string).
 *
 * One line per step:
 *   { step_index, source: USER_EXPLICIT|MODEL|SYSTEM, type, status,
 *     created_at, content?, thinking?, model?, input_tokens?,
 *     cache_read_tokens?, output_tokens?, tool_calls?: [{ name, args }], error? }
 *
 * A PLANNER_RESPONSE is one model reply; its tool calls are answered by the
 * following MODEL steps (GENERIC, VIEW_FILE, LIST_DIRECTORY, …) in order. The
 * transcript carries no tool-call ids, so replay derives stable ones from the
 * step index. A reply without tool calls ends the turn.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "fs";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";
import { readTranscriptLines, TranscriptHistory } from "#core/transcript-reader.js";
import { isInternalInjectedUserText, stripInjectedWrapper } from "#core/internal-user-messages.js";
import type {
  ActivityMessage,
  AgentInfo,
  AgentUpdateMessage,
  FileChange,
  HistoryEntry,
  OutputMessage,
  SessionStats,
  TaskItem,
  UserMessage,
} from "#core/types.js";
import { antigravityDataDir } from "#core/providers/antigravity-cli.js";
import { splitAntigravityModelId } from "#core/providers/antigravity-models.js";
import {
  antigravityExitCode,
  antigravityToolUseActivity,
  antigravityWorkspacePath,
  applyAntigravityArtifactEdits,
  cleanAntigravityToolOutput,
  parseAntigravityChecklist,
  describeAntigravityTool,
  type AntigravityToolView,
} from "#core/providers/antigravity-tools.js";

const MAX_HISTORY = 1000;
const MAX_TOOL_DETAIL = 16_000;

/** `<data>/brain/<id>` — a conversation's artifact folder. */
export function antigravityBrainDir(home: string, sessionId: string): string {
  return join(antigravityDataDir(home), "brain", sessionId);
}

/** The JSONL Relay replays for a conversation. */
export function antigravityTranscriptPath(home: string, sessionId: string): string {
  return join(
    antigravityBrainDir(home, sessionId),
    ".system_generated",
    "logs",
    "transcript_full.jsonl",
  );
}

/** Conversation id from a transcript path (`…/brain/<id>/.system_generated/logs/…`). */
export function antigravitySessionIdFromTranscriptPath(path: string): string | undefined {
  const match = /\/brain\/([^/]+)\/\.system_generated\/logs\/transcript(?:_full)?\.jsonl$/.exec(
    path,
  );
  return match?.[1];
}

/** Brain dir from a transcript path (plan artifacts live there). */
export function antigravityBrainDirFromTranscriptPath(path: string): string | undefined {
  const match = /^(.*\/brain\/[^/]+)\/\.system_generated\/logs\/[^/]+$/.exec(path);
  return match?.[1];
}

export interface AntigravityTranscriptStep {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  model?: string;
  input_tokens?: number;
  cache_read_tokens?: number;
  output_tokens?: number;
  tool_calls?: Array<{ name?: string; args?: unknown }>;
  error?: unknown;
}

interface PendingCall {
  id: string;
  view: AntigravityToolView;
}

export interface AntigravityReplayContext {
  /** Conversation id; prefixes derived tool-call ids. */
  sessionId?: string;
  cwd?: string;
  brainDir?: string;
  /** Calls of the last reply still waiting for their result steps. */
  pendingCalls: PendingCall[];
  tasks: Map<string, TaskItem>;
  files: Map<string, FileChange>;
  stats: SessionStats;
  /** Subagents launched in this conversation: child conversation id → Relay agent key. */
  childAgents: Map<string, string>;
  /** First human message (titles). */
  firstUserPrompt?: string;
  /** Last known text of each artifact (todo list), to replay its edits. */
  artifacts?: Map<string, string>;
}

export function createAntigravityReplayContext(
  init: Partial<AntigravityReplayContext> = {},
): AntigravityReplayContext {
  return {
    pendingCalls: [],
    tasks: new Map(),
    files: new Map(),
    stats: createZeroStats(),
    childAgents: new Map(),
    ...init,
  };
}

export function createZeroStats(): SessionStats {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

function stepTimestamp(step: AntigravityTranscriptStep): number {
  const parsed = step.created_at ? Date.parse(step.created_at) : NaN;
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/**
 * The user's own words from a USER_INPUT step. agy wraps them as
 * `<USER_REQUEST>…</USER_REQUEST>` followed by its own metadata blocks.
 */
export function extractAntigravityUserText(content: string): string {
  const match = /<USER_REQUEST(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(content);
  return (match ? match[1] : content).trim();
}

/**
 * A message from another conversation (a subagent reporting to its parent, or
 * a parent tasking its child), injected as a SYSTEM_MESSAGE:
 * `[Message] timestamp=… sender=<conversationId> priority=… content=<text>`.
 */
export function parseAntigravityAgentMessage(
  content: string,
): { sender: string; text: string } | undefined {
  const match = /\[Message\][^\n]*?\bsender=([0-9a-f-]{8,})\b[^\n]*?\bcontent=([\s\S]*)$/.exec(
    content,
  );
  if (!match) return undefined;
  const text = match[2].replace(/\n?<\/SYSTEM_MESSAGE>\s*$/, "").trim();
  return { sender: match[1], text };
}

/** `Created the following subagent: { "conversationId": "…" }` → the child's id. */
export function parseAntigravitySubagentCreated(content: string): string | undefined {
  const match = /Created the following subagent:[\s\S]*?"conversationId":\s*"([^"]+)"/.exec(
    content,
  );
  return match?.[1];
}

function trackFile(ctx: AntigravityReplayContext, path: string, type: FileChange["type"]): void {
  if (ctx.cwd) {
    const inWorkspace = antigravityWorkspacePath(ctx.cwd, path);
    if (!inWorkspace) return;
    path = inWorkspace;
  }
  const existing = ctx.files.get(path);
  if (existing) {
    existing.editCount++;
    if (existing.type !== "added") existing.type = type;
    return;
  }
  ctx.files.set(path, { path, editCount: 1, type });
}

function fileListActivity(ctx: AntigravityReplayContext): ActivityMessage {
  return {
    type: "activity",
    activity: "file_list",
    description: "Files changed",
    files: Array.from(ctx.files.values()).map((file) => ({ ...file })),
  };
}

function truncate(text: string, max = MAX_TOOL_DETAIL): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

function errorText(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["message", "userErrorMessage", "shortError", "error"]) {
      if (typeof record[key] === "string" && record[key]) return record[key] as string;
    }
    return JSON.stringify(error);
  }
  return String(error);
}

function agentEntry(timestamp: number, agent: AgentInfo): HistoryEntry {
  return { timestamp, message: { type: "agent_update", agent } as AgentUpdateMessage };
}

/** Convert one transcript step into history entries (shared by replay and the live watcher). */
export function convertAntigravityTranscriptEntry(
  step: AntigravityTranscriptStep,
  ctx: AntigravityReplayContext,
): HistoryEntry[] {
  const timestamp = stepTimestamp(step);
  const results: HistoryEntry[] = [];
  const source = step.source ?? "";
  const type = step.type ?? "";

  if (type === "USER_INPUT") {
    // A new user turn: any calls of the previous reply that never got a
    // result step (interrupted) are left as they are.
    ctx.pendingCalls = [];
    const text = stripInjectedWrapper(extractAntigravityUserText(step.content ?? ""));
    if (!text) return results;
    if (ctx.firstUserPrompt === undefined && !isInternalInjectedUserText(text)) {
      ctx.firstUserPrompt = text;
    }
    results.push({
      timestamp,
      message: {
        type: "user",
        text,
        internal: isInternalInjectedUserText(text) || undefined,
      } as UserMessage,
    });
    return results;
  }

  if (type === "SYSTEM_MESSAGE" || source === "SYSTEM") {
    const message = step.content ? parseAntigravityAgentMessage(step.content) : undefined;
    if (!message) return results;
    const agentId = ctx.childAgents.get(message.sender);
    if (agentId) {
      // A subagent's report back to this conversation finishes its card.
      results.push(
        agentEntry(timestamp, {
          agentId,
          providerAgentId: message.sender,
          status: "completed",
          result: message.text,
          endedAt: timestamp,
        }),
      );
    }
    return results;
  }

  if (type === "PLANNER_RESPONSE") {
    // Steps record the variant (`gemini-4-neon-low`); Relay's model is the family.
    if (step.model) ctx.stats.model = splitAntigravityModelId(step.model).model;
    ctx.stats.inputTokens += step.input_tokens ?? 0;
    ctx.stats.cacheReadTokens += step.cache_read_tokens ?? 0;
    ctx.stats.outputTokens += step.output_tokens ?? 0;
    if (step.input_tokens || step.cache_read_tokens) {
      ctx.stats.contextTokens =
        (step.input_tokens ?? 0) + (step.cache_read_tokens ?? 0) + (step.output_tokens ?? 0);
    }

    if (step.thinking?.trim()) {
      results.push({
        timestamp,
        message: {
          type: "activity",
          activity: "thinking",
          description: "Reasoning...",
          detail: step.thinking.trim(),
        } as ActivityMessage,
      });
    }
    if (step.content?.trim()) {
      results.push({
        timestamp,
        message: { type: "output", text: step.content, isWaiting: false } as OutputMessage,
      });
    }

    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    ctx.pendingCalls = [];
    calls.forEach((call, index) => {
      const name = typeof call?.name === "string" ? call.name : "tool";
      const id = `${ctx.sessionId ?? "agy"}:${step.step_index ?? "x"}:${index}`;
      const view = describeAntigravityTool(name, call?.args, {
        cwd: ctx.cwd,
        brainDir: ctx.brainDir,
      });
      ctx.pendingCalls.push({ id, view });
      results.push({ timestamp, message: antigravityToolUseActivity(view, id) });
      if (view.subagent) {
        results.push(
          agentEntry(timestamp, {
            agentId: id,
            origin: "provider",
            originToolUseId: id,
            status: "running",
            ...(view.subagent.role ? { name: view.subagent.role } : {}),
            ...(view.subagent.typeName ? { role: view.subagent.typeName } : {}),
            ...(view.subagent.prompt
              ? { assignment: view.subagent.prompt, description: view.subagent.role }
              : {}),
            startedAt: timestamp,
          }),
        );
      }
    });

    if (calls.length === 0) {
      results.push({
        timestamp,
        message: { type: "output", text: "", isWaiting: true } as OutputMessage,
      });
    }
    return results;
  }

  if (type === "ERROR_MESSAGE") {
    const text = errorText(step.error) ?? step.content;
    if (text) {
      results.push({
        timestamp,
        message: { type: "output", text: `Error: ${text}`, isWaiting: false } as OutputMessage,
      });
    }
    results.push({
      timestamp,
      message: { type: "output", text: "", isWaiting: true } as OutputMessage,
    });
    return results;
  }

  // Any other MODEL step answers the oldest pending tool call.
  if (source === "MODEL") {
    const call = ctx.pendingCalls.shift();
    if (!call) return results;
    const failure = errorText(step.error);
    const output = cleanAntigravityToolOutput(step.content ?? "");
    const view = call.view;
    const failed = !!failure || step.status === "ERROR" || step.status === "CANCELED";
    // A plan written for review stays pending until the user answers it (the
    // next user turn); agy logs the artifact write's result at once, and
    // replaying it would close the review.
    if (view.plan !== undefined && !failed) return results;

    if (!failed && view.changedFile) {
      trackFile(ctx, view.changedFile.path, view.changedFile.kind);
      results.push({ timestamp, message: fileListActivity(ctx) });
    }

    const exitCode = view.tool === "Bash" ? antigravityExitCode(step.content) : undefined;
    const activity: ActivityMessage = {
      type: "activity",
      activity: "tool_result",
      toolUseId: call.id,
      tool: view.tool,
      description: failed
        ? "Tool error"
        : exitCode !== undefined && exitCode !== 0
          ? "Command failed"
          : `${view.tool} completed`,
      detail: truncate(failure ?? output) || undefined,
      ...(view.tool === "Bash" && exitCode !== undefined
        ? { input: { ...view.input, exitCode } }
        : {}),
    };
    results.push({ timestamp, message: activity });

    if (!failed && view.artifact?.path.endsWith(".md")) {
      const artifacts = (ctx.artifacts ??= new Map());
      const { path, content, edits } = view.artifact;
      let text = content;
      if (text === undefined && edits) {
        let previous = artifacts.get(path);
        if (previous === undefined) {
          try {
            previous = readFileSync(path, "utf-8");
          } catch {
            previous = undefined;
          }
        }
        // A file read from disk is already the final state; apply edits only to replayed text.
        text =
          previous !== undefined && artifacts.has(path)
            ? applyAntigravityArtifactEdits(previous, edits)
            : previous;
      }
      if (text !== undefined) {
        artifacts.set(path, text);
        const tasks = parseAntigravityChecklist(text);
        if (tasks.length > 0) {
          ctx.tasks.clear();
          for (const task of tasks) ctx.tasks.set(task.id, { ...task });
          results.push({
            timestamp,
            message: {
              type: "activity",
              activity: "task_list",
              description: "Tasks",
              tasks,
            } as ActivityMessage,
          });
        }
      }
    }

    if (view.subagent) {
      const childId = parseAntigravitySubagentCreated(step.content ?? "");
      if (childId) {
        ctx.childAgents.set(childId, call.id);
        results.push(agentEntry(timestamp, { agentId: call.id, providerAgentId: childId }));
      } else if (failed) {
        results.push(
          agentEntry(timestamp, {
            agentId: call.id,
            status: "failed",
            statusDetail: failure,
            endedAt: timestamp,
          }),
        );
      }
    }
    return results;
  }

  return results;
}

export interface AntigravityTranscriptParseResult {
  cwd: string;
  createdAt?: number;
  firstUserPrompt?: string;
  history: HistoryEntry[];
  tasks: Map<string, TaskItem>;
  files: Map<string, FileChange>;
  stats: SessionStats;
}

/** Parse a whole transcript. `cwd` comes from conversation metadata (the JSONL has none). */
/**
 * Replay state as of just before `beforeStepIndex`, for a watcher that starts
 * at EOF: calls still waiting for results, launched subagents and artifact
 * text carry over, so a result or child report appended later resolves. The
 * replayed entries, token counts, tasks and files are thrown away; history
 * already holds them.
 */
export function seedAntigravityReplayContext(
  filePath: string,
  beforeStepIndex: number | undefined,
  init: Partial<AntigravityReplayContext> = {},
): AntigravityReplayContext {
  const seed = createAntigravityReplayContext({
    sessionId: init.sessionId,
    cwd: init.cwd,
    brainDir: init.brainDir,
  });
  if (beforeStepIndex !== undefined) {
    try {
      for (const line of readTranscriptLines(filePath)) {
        if (!line.trim()) continue;
        try {
          const step = JSON.parse(line) as AntigravityTranscriptStep;
          if (typeof step.step_index !== "number" || step.step_index >= beforeStepIndex) continue;
          convertAntigravityTranscriptEntry(step, seed);
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // unreadable: start empty
    }
  }
  return {
    ...seed,
    ...init,
    pendingCalls: seed.pendingCalls,
    childAgents: seed.childAgents,
    ...(seed.artifacts ? { artifacts: seed.artifacts } : {}),
    ...(seed.firstUserPrompt !== undefined ? { firstUserPrompt: seed.firstUserPrompt } : {}),
  };
}

export function parseAntigravityTranscript(
  filePath: string,
  options: { cwd?: string } = {},
): AntigravityTranscriptParseResult {
  const sessionId = antigravitySessionIdFromTranscriptPath(filePath);
  const cwd = options.cwd ?? (sessionId ? lookupConversationCwd(filePath, sessionId) : undefined);
  const ctx = createAntigravityReplayContext({
    sessionId,
    cwd,
    brainDir: antigravityBrainDirFromTranscriptPath(filePath),
  });
  const history = new TranscriptHistory<HistoryEntry>(MAX_HISTORY);
  let createdAt: number | undefined;
  try {
    for (const line of readTranscriptLines(filePath)) {
      if (!line.trim()) continue;
      try {
        const step = JSON.parse(line) as AntigravityTranscriptStep;
        if (createdAt === undefined && step.created_at) {
          const parsed = Date.parse(step.created_at);
          if (!Number.isNaN(parsed)) createdAt = parsed;
        }
        history.append(convertAntigravityTranscriptEntry(step, ctx));
      } catch {
        // Skip malformed lines (a step still being written).
      }
    }
  } catch {
    return {
      cwd: cwd ?? "",
      history: [],
      tasks: new Map(),
      files: new Map(),
      stats: createZeroStats(),
    };
  }
  return {
    cwd: cwd ?? "",
    createdAt,
    firstUserPrompt: ctx.firstUserPrompt,
    history: history.toArray(),
    tasks: ctx.tasks,
    files: ctx.files,
    stats: ctx.stats,
  };
}

// =============================================================================
// Conversation metadata (cache/conversation_metadata.json)
// =============================================================================

export interface AntigravityConversationMeta {
  id: string;
  title?: string;
  /** Workspace folders (absolute paths, `file://` stripped). The first is the cwd. */
  workspaces: string[];
  updatedAt?: number;
  /** A conversation spawned by another (subagents) or by agy itself. */
  internal: boolean;
  agentName?: string;
}

let metadataCache:
  | { path: string; mtimeMs: number; size: number; byId: Map<string, AntigravityConversationMeta> }
  | undefined;

function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri.slice("file://".length);
  }
}

/**
 * Read `<data>/cache/conversation_metadata.json`: per-conversation title,
 * workspace folders and update time. Cached by mtime/size.
 */
export function readAntigravityConversationMetadata(
  dataDir: string,
): Map<string, AntigravityConversationMeta> {
  const path = join(dataDir, "cache", "conversation_metadata.json");
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return new Map();
  }
  if (
    metadataCache &&
    metadataCache.path === path &&
    metadataCache.mtimeMs === stat.mtimeMs &&
    metadataCache.size === stat.size
  ) {
    return metadataCache.byId;
  }
  const byId = new Map<string, AntigravityConversationMeta>();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      conversations?: Record<string, { summary?: Record<string, unknown> }>;
    };
    for (const [id, entry] of Object.entries(parsed.conversations ?? {})) {
      const summary = entry?.summary ?? {};
      const uris = Array.isArray(summary.WorkspaceURIs) ? (summary.WorkspaceURIs as unknown[]) : [];
      const updated = typeof summary.UpdatedAt === "string" ? Date.parse(summary.UpdatedAt) : NaN;
      byId.set(id, {
        id,
        title: typeof summary.Title === "string" && summary.Title ? summary.Title : undefined,
        workspaces: uris.filter((uri): uri is string => typeof uri === "string").map(fileUriToPath),
        updatedAt: Number.isNaN(updated) || updated <= 0 ? undefined : updated,
        internal: summary.Internal === true,
        agentName:
          typeof summary.AgentName === "string" && summary.AgentName
            ? summary.AgentName
            : undefined,
      });
    }
  } catch {
    // Unreadable or mid-write: report nothing rather than stale guesses.
  }
  metadataCache = { path, mtimeMs: stat.mtimeMs, size: stat.size, byId };
  return byId;
}

/** Reset the metadata cache (tests). */
export function clearAntigravityMetadataCache(): void {
  metadataCache = undefined;
}

/** The data dir holding a transcript (`<data>/brain/<id>/.system_generated/logs/…`). */
function dataDirFromTranscriptPath(path: string): string | undefined {
  const match = /^(.*)\/brain\/[^/]+\/\.system_generated\/logs\/[^/]+$/.exec(path);
  return match?.[1];
}

function lookupConversationCwd(transcriptPath: string, sessionId: string): string | undefined {
  const dataDir = dataDirFromTranscriptPath(transcriptPath);
  if (!dataDir) return undefined;
  return (
    readAntigravityConversationMetadata(dataDir).get(sessionId)?.workspaces[0] ??
    readAntigravityConversationWorkspaces(dataDir, sessionId)[0]
  );
}

/** Read a protobuf varint at `offset`; returns [value, next offset]. */
function readVarint(buffer: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  while (offset < buffer.length) {
    const byte = buffer[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, offset];
    shift += 7;
    if (shift > 49) break;
  }
  return [value, buffer.length];
}

/** Length-delimited fields of one protobuf message, by field number. */
function protobufStrings(buffer: Uint8Array, field: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const [key, afterKey] = readVarint(buffer, offset);
    offset = afterKey;
    const wireType = key & 7;
    const number = Math.floor(key / 8);
    if (wireType === 0) {
      offset = readVarint(buffer, offset)[1];
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else if (wireType === 2) {
      const [length, start] = readVarint(buffer, offset);
      const end = start + length;
      if (end > buffer.length) break;
      if (number === field) out.push(buffer.subarray(start, end));
      offset = end;
    } else {
      break;
    }
  }
  return out;
}

const workspaceCache = new Map<string, { mtimeMs: number; size: number; workspaces: string[] }>();

/**
 * Workspace folders recorded in a conversation's own database
 * (`<data>/conversations/<id>.db`, table `trajectory_metadata_blob`). The
 * metadata cache only lists some conversations, so this is the fallback for
 * the rest. The blob is a protobuf whose repeated field 1 holds one workspace
 * each, with its `file://` URI in field 1. Read-only; cached by mtime/size.
 */
export function readAntigravityConversationWorkspaces(
  dataDir: string,
  sessionId: string,
): string[] {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return [];
  const path = join(dataDir, "conversations", `${sessionId}.db`);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return [];
  }
  const cached = workspaceCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.workspaces;
  }
  const workspaces: string[] = [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare("SELECT data FROM trajectory_metadata_blob LIMIT 1").get() as
      | { data?: Uint8Array }
      | undefined;
    if (row?.data) {
      const decoder = new TextDecoder();
      for (const workspace of protobufStrings(row.data, 1)) {
        const uri = protobufStrings(workspace, 1)[0];
        if (!uri) continue;
        const text = decoder.decode(uri);
        if (text.startsWith("file://")) workspaces.push(fileUriToPath(text));
      }
    }
  } catch {
    // locked, missing table, or a format change: nothing known
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
  if (workspaceCache.size >= 512) workspaceCache.delete(workspaceCache.keys().next().value!);
  workspaceCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, workspaces });
  return workspaces;
}

/** Every conversation id launched as a subagent (each parent's `subagents/<id>.json`). */
export function listAntigravityChildConversationIds(dataDir: string): Set<string> {
  const children = new Set<string>();
  const brain = join(dataDir, "brain");
  let ids: string[];
  try {
    ids = readdirSync(brain);
  } catch {
    return children;
  }
  for (const id of ids) {
    const dir = join(brain, id, ".system_generated", "subagents");
    try {
      for (const name of readdirSync(dir)) {
        if (name.endsWith(".json")) children.add(name.slice(0, -".json".length));
      }
    } catch {
      // no subagents
    }
  }
  return children;
}

/** Ids of subagent conversations launched by `sessionId` (`…/subagents/<childId>.json`). */
export function listAntigravitySubagentIds(home: string, sessionId: string): string[] {
  const dir = join(antigravityBrainDir(home, sessionId), ".system_generated", "subagents");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
  } catch {
    return [];
  }
}

/**
 * Child conversation history for an agent card. Reads the child's own
 * transcript; never starts a process. Every message is attributed to `agentId`.
 */
export function readAntigravityAgentHistory(
  home: string,
  childConversationId: string,
  agentId: string,
): HistoryEntry[] | null {
  if (!/^[A-Za-z0-9-]+$/.test(childConversationId)) return null;
  const path = antigravityTranscriptPath(home, childConversationId);
  if (!existsSync(path)) return null;
  const history = parseAntigravityTranscript(path).history;
  // A child's first step is its parent's message, injected as a system message
  // rather than a user turn; surface it as the child's assignment.
  for (const line of readTranscriptLines(path)) {
    try {
      const step = JSON.parse(line) as AntigravityTranscriptStep;
      const message =
        step.type === "SYSTEM_MESSAGE" && step.content
          ? parseAntigravityAgentMessage(step.content)
          : undefined;
      if (message) {
        history.unshift({
          timestamp: stepTimestamp(step),
          message: { type: "user", text: message.text } as UserMessage,
        });
      }
    } catch {
      // ignore a malformed first line
    }
    break;
  }
  return history.map((entry) => {
    const message = entry.message;
    if (message.type === "output" || message.type === "activity" || message.type === "user") {
      return message.agentId ? entry : { ...entry, message: { ...message, agentId } };
    }
    return entry;
  });
}

// =============================================================================
// Cheap reads for lists (no full replay)
// =============================================================================

/** The conversation title agy recorded (metadata cache), when it has one. */
export function readAntigravityConversationTitle(
  home: string,
  sessionId: string,
): string | undefined {
  return readAntigravityConversationMetadata(antigravityDataDir(home)).get(sessionId)?.title;
}

/** Title for a transcript path, from the metadata beside it. */
export function readAntigravityTranscriptTitle(transcriptPath: string): string | undefined {
  const sessionId = antigravitySessionIdFromTranscriptPath(transcriptPath);
  const dataDir = dataDirFromTranscriptPath(transcriptPath);
  if (!sessionId || !dataDir) return undefined;
  return readAntigravityConversationMetadata(dataDir).get(sessionId)?.title;
}

/** Workspace folder of a transcript's conversation (its cwd), when recorded. */
export function readAntigravityTranscriptCwd(transcriptPath: string): string | undefined {
  const sessionId = antigravitySessionIdFromTranscriptPath(transcriptPath);
  return sessionId ? lookupConversationCwd(transcriptPath, sessionId) : undefined;
}

/** The last user request or model reply, read from the transcript tail. */
export function readLastAntigravityMessage(
  transcriptPath: string,
): { text: string; from: "user" | "assistant"; timestamp: number } | null {
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    const tail = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(tail);
    readSync(fd, buffer, 0, tail, size - tail);
    const lines = buffer.toString("utf-8").split("\n");
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index].trim();
      if (!line) continue;
      let step: AntigravityTranscriptStep;
      try {
        step = JSON.parse(line) as AntigravityTranscriptStep;
      } catch {
        continue;
      }
      if (step.type === "USER_INPUT" && step.content) {
        const text = stripInjectedWrapper(extractAntigravityUserText(step.content)).trim();
        if (text && !isInternalInjectedUserText(text)) {
          return { text, from: "user", timestamp: stepTimestamp(step) };
        }
        continue;
      }
      if (step.type === "PLANNER_RESPONSE" && step.content?.trim()) {
        const text = step.content.trim();
        return {
          text: text.length > 120 ? `${text.slice(0, 120)}…` : text,
          from: "assistant",
          timestamp: stepTimestamp(step),
        };
      }
    }
  } catch {
    // unreadable transcript
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

/** The first thing the user asked, from the transcript head. */
export function readFirstAntigravityUserMessage(transcriptPath: string): string | undefined {
  try {
    for (const line of readTranscriptLines(transcriptPath)) {
      if (!line.includes("USER_INPUT")) continue;
      try {
        const step = JSON.parse(line) as AntigravityTranscriptStep;
        if (step.type !== "USER_INPUT" || !step.content) continue;
        const text = stripInjectedWrapper(extractAntigravityUserText(step.content)).trim();
        if (text && !isInternalInjectedUserText(text)) return text;
      } catch {
        // malformed line
      }
    }
  } catch {
    // unreadable
  }
  return undefined;
}

/**
 * Messages from other conversations in a transcript's tail (subagent reports):
 * `[Message] … sender=<id> … content=…` system messages. Bounded tail read.
 */
export function readAntigravityAgentReports(
  transcriptPath: string,
): Array<{ sender: string; text: string; timestamp: number }> {
  const reports: Array<{ sender: string; text: string; timestamp: number }> = [];
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    const tail = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(tail);
    readSync(fd, buffer, 0, tail, size - tail);
    for (const line of buffer.toString("utf-8").split("\n")) {
      if (!line.includes("SYSTEM_MESSAGE") || !line.includes("sender=")) continue;
      try {
        const step = JSON.parse(line) as AntigravityTranscriptStep;
        const message = step.content ? parseAntigravityAgentMessage(step.content) : undefined;
        if (message) reports.push({ ...message, timestamp: stepTimestamp(step) });
      } catch {
        // a partial first line
      }
    }
  } catch {
    // no transcript yet
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return reports;
}
