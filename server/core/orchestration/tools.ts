import {
  buildChatView,
  InvalidChatCursorError,
  type ChatViewMode,
} from "#core/orchestration/chat-view.js";
import {
  relayChatLink,
  RELAY_MCP_SERVER_INSTRUCTIONS,
  RELAY_MCP_SERVER_NAME,
} from "#core/orchestration/instructions.js";
import {
  McpToolError,
  type McpServerDefinition,
  type McpToolDefinition,
} from "#core/orchestration/mcp-protocol.js";
import {
  lastAssistantText,
  parseRelayAgentMessage,
  type DelegateTaskRequest,
} from "#core/orchestration/delegation.js";
import {
  DEFAULT_ACCOUNT_ID,
  type DelegatedTaskInfo,
  type HistoryEntry,
  type InstanceInfo,
  type Project,
  type ProviderKind,
  type ProviderRuntimeMode,
} from "#core/types.js";

/**
 * Relay's cross-chat MCP tools: read other chats, and delegate tasks to
 * child chats on any provider the account can run.
 *
 * Handlers only see an `OrchestrationHost`, implemented by InstanceManager,
 * so the policy here (account scoping, bounds, shapes) is testable without a
 * live manager. Every call runs as one chat — the caller the bearer token was
 * issued to — and can only see chats in that chat's account.
 */

export interface OrchestrationProviderModel {
  id: string;
  label: string;
  isDefault?: boolean;
}

export interface OrchestrationProviderInfo {
  provider: ProviderKind;
  label: string;
  /** Can a chat in the caller's account run on this provider right now? */
  available: boolean;
  /** Why not, when `available` is false. */
  unavailableReason?: string;
  models: OrchestrationProviderModel[];
  runtimeModes?: ProviderRuntimeMode[];
}

export interface OrchestrationHost {
  /** The calling chat, or undefined when it no longer exists. */
  getChat(instanceId: string): InstanceInfo | undefined;
  /** Every chat in a project (live and persisted). */
  listProjectChats(projectId: string): InstanceInfo[];
  getProject(projectId: string): Project | undefined;
  /** Full history of a chat; throws when the chat is unknown. */
  getHistory(instanceId: string): HistoryEntry[];
  /** Owning account of a chat, normalized (unknown/absent → the default account). */
  accountIdOf(chat: Pick<InstanceInfo, "accountId">): string;
  /** Providers as seen from `accountId`, with a short model list each. */
  listProviders(accountId: string): Promise<OrchestrationProviderInfo[]>;
  /** Start a child chat for a task. Throws `McpToolError` for expected refusals. */
  delegateTask(parentId: string, request: DelegateTaskRequest): Promise<DelegatedTaskInfo>;
  getDelegatedTask(taskId: string): DelegatedTaskInfo | undefined;
  /**
   * Resolves when the task ends, or with its current state after `timeoutMs`
   * or on `signal` abort. A result returned to a live caller counts as delivered.
   */
  waitForDelegatedTask(
    taskId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DelegatedTaskInfo>;
  cancelDelegatedTask(taskId: string): DelegatedTaskInfo;
  /**
   * Deliver a message from `callerId` into another chat of its account as an
   * agent note. Throws `McpToolError` when the chat can't take it now.
   */
  sendChatMessage(callerId: string, chatId: string, text: string): Promise<void>;
  /**
   * Resolves when the chat's turn settles, or on `timeoutMs` / `signal` abort.
   * On the caller's own delegate it also waits for the task to end.
   */
  waitForChatTurn(
    callerId: string,
    chatId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ChatWaitOutcome>;
}

/**
 * How a `chat_wait` ended: `finished` (no turn running or queued), `error`
 * (likewise, but its last turn failed), `needs_input` (waiting on its user),
 * `timeout`, or `gone` (deleted).
 */
export type ChatWaitOutcome = "finished" | "error" | "needs_input" | "timeout" | "gone";

export interface OrchestrationCallContext {
  host: OrchestrationHost;
  callerId: string;
  /** Aborts when the caller's request goes away (it hung up or timed out). */
  signal?: AbortSignal;
}

const CHAT_LIST_DEFAULT_LIMIT = 30;
const CHAT_LIST_MAX_LIMIT = 100;
/** Models listed per provider; the rest are counted in `omittedModels`. */
const CAPABILITY_MODEL_LIMIT = 12;

type Tool = McpToolDefinition<OrchestrationCallContext>;

const relayCapabilities: Tool = {
  name: "relay_capabilities",
  description:
    "Describe the calling chat (provider, model, modes, project) and the providers and models Relay can run in this account. Call once before relying on provider or model availability.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { title: "Relay capabilities", readOnlyHint: true, openWorldHint: false },
  async handler(_args, ctx) {
    const caller = requireCaller(ctx);
    const accountId = ctx.host.accountIdOf(caller);
    const project = caller.projectId ? ctx.host.getProject(caller.projectId) : undefined;
    const providers = await ctx.host.listProviders(accountId);
    return {
      caller: {
        ...summarizeChat(caller, caller.id),
        runtimeMode: caller.runtimeMode ?? null,
        ...(caller.modelOptions?.reasoningEffort
          ? { reasoningEffort: caller.modelOptions.reasoningEffort }
          : {}),
        workingDirectory: caller.workingDirectory,
      },
      project: project ? { id: project.id, name: project.name } : null,
      providers: providers.map((info) => ({
        provider: info.provider,
        label: info.label,
        available: info.available,
        ...(info.unavailableReason ? { unavailableReason: info.unavailableReason } : {}),
        models: info.models.slice(0, CAPABILITY_MODEL_LIMIT),
        ...(info.models.length > CAPABILITY_MODEL_LIMIT
          ? { omittedModels: info.models.length - CAPABILITY_MODEL_LIMIT }
          : {}),
        ...(info.runtimeModes ? { runtimeModes: info.runtimeModes } : {}),
      })),
    };
  },
};

const CHAT_STATUSES: string[] = ["idle", "processing", "error", "stopped"];

const chatList: Tool = {
  name: "chat_list",
  description:
    "List chats in a Relay project, most recent first: your own project unless projectId is given. Done chats are excluded unless includeDone is true.",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "Project to list. Defaults to the caller's." },
      query: { type: "string", description: "Case-insensitive title filter." },
      status: {
        type: "string",
        enum: CHAT_STATUSES,
        description: "Only chats in this run status.",
      },
      includeDone: { type: "boolean", description: "Include chats marked done." },
      limit: { type: "integer", minimum: 1, maximum: CHAT_LIST_MAX_LIMIT },
      offset: { type: "integer", minimum: 0 },
    },
    additionalProperties: false,
  },
  annotations: { title: "List chats", readOnlyHint: true, openWorldHint: false },
  handler(args, ctx) {
    const caller = requireCaller(ctx);
    const accountId = ctx.host.accountIdOf(caller);
    const projectId = optionalString(args, "projectId") ?? caller.projectId;
    if (!projectId) {
      throw new McpToolError("invalid_request", "The calling chat has no project; pass projectId.");
    }
    const project = ctx.host.getProject(projectId);
    if (!project || !projectInAccount(project, accountId)) {
      throw new McpToolError("project_not_found", `No project ${projectId} in this account.`);
    }
    const query = optionalString(args, "query")?.toLowerCase();
    const status = optionalString(args, "status");
    if (status !== undefined && !CHAT_STATUSES.includes(status)) {
      throw new McpToolError(
        "invalid_request",
        `status must be one of ${CHAT_STATUSES.join(", ")}.`,
      );
    }
    const includeDone = args.includeDone === true;
    const limit = clampInt(args.limit, 1, CHAT_LIST_MAX_LIMIT, CHAT_LIST_DEFAULT_LIMIT);
    const offset = clampInt(args.offset, 0, Number.MAX_SAFE_INTEGER, 0);

    const chats = ctx.host
      .listProjectChats(projectId)
      .filter((chat) => ctx.host.accountIdOf(chat) === accountId)
      .filter((chat) => includeDone || !isDone(chat))
      .filter((chat) => !status || chat.status === status)
      .filter((chat) => !query || (chat.name ?? "").toLowerCase().includes(query))
      .sort((a, b) => recencyOf(b) - recencyOf(a));

    return {
      project: { id: project.id, name: project.name },
      total: chats.length,
      offset,
      chats: chats.slice(offset, offset + limit).map((chat) => summarizeChat(chat, caller.id)),
      hasMore: offset + limit < chats.length,
    };
  },
};

const chatRead: Tool = {
  name: "chat_read",
  description:
    "Read a chat's conversation. Without after, returns the most recent items; pass the returned nextCursor as after to read newer items incrementally. view 'activity' also includes tool calls. Long items are truncated.",
  inputSchema: {
    type: "object",
    properties: {
      chatId: { type: "string", description: "Chat id or relay://chat/<id> link." },
      view: { type: "string", enum: ["messages", "activity"] },
      after: { type: "string", description: "A nextCursor from a previous chat_read." },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    required: ["chatId"],
    additionalProperties: false,
  },
  annotations: { title: "Read chat", readOnlyHint: true, openWorldHint: false },
  handler(args, ctx) {
    const caller = requireCaller(ctx);
    const accountId = ctx.host.accountIdOf(caller);
    const raw = optionalString(args, "chatId");
    if (!raw) throw new McpToolError("invalid_request", "chatId is required.");
    const chatId = parseChatReference(raw);
    const chat = ctx.host.getChat(chatId);
    // Another account's chat reads as missing: its existence is not ours to reveal.
    if (!chat || ctx.host.accountIdOf(chat) !== accountId) {
      throw new McpToolError("chat_not_found", `No chat ${chatId} in this account.`);
    }
    const viewArg = optionalString(args, "view");
    if (viewArg !== undefined && viewArg !== "messages" && viewArg !== "activity") {
      throw new McpToolError("invalid_request", "view must be 'messages' or 'activity'.");
    }
    let history: HistoryEntry[];
    try {
      history = ctx.host.getHistory(chatId);
    } catch {
      throw new McpToolError("chat_not_found", `Chat ${chatId} has no readable history.`);
    }
    const after = optionalString(args, "after");
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    try {
      return {
        chat: summarizeChat(chat, caller.id),
        ...buildChatView(history, {
          view: (viewArg as ChatViewMode | undefined) ?? "messages",
          after,
          limit,
        }),
      };
    } catch (error) {
      if (error instanceof InvalidChatCursorError) {
        throw new McpToolError("invalid_request", "after must be a nextCursor from chat_read.");
      }
      throw error;
    }
  },
};

const PROVIDERS: ProviderKind[] = ["claude", "codex"];
const RUNTIME_MODES: ProviderRuntimeMode[] = [
  "plan",
  "approval-required",
  "writes-only",
  "auto",
  "full-access",
];
const DELEGATE_WAIT_DEFAULT_MS = 300_000;
/** Below Codex's Relay tool timeout (see `buildCodexAppServerArgs`). */
const DELEGATE_WAIT_MAX_MS = 840_000;
const ASYNC_NEXT =
  "Completion wakes this chat with the result, so end your turn now. Do not wait on it, poll it, or sleep.";

const delegateTask: Tool = {
  name: "delegate_task",
  description:
    "Start a delegated child chat that works on `task` and reports back. Use it to run a task on another provider or model, or as background work that outlives this turn. The child gets only `task` (no copy of this conversation), so include every detail it needs. It inherits this chat's checkout, account, and runtime mode (narrower on request, never broader). mode 'async' (default) returns at once; a completion message wakes this chat. mode 'wait' blocks until the child finishes or timeoutMs passes (the child keeps running either way).",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "Complete, self-contained brief for the child." },
      title: {
        type: "string",
        description: "Short chat title. Defaults to the task's first line.",
      },
      role: { type: "string", description: "Optional role label, e.g. 'reviewer'." },
      target: {
        type: "object",
        properties: {
          provider: { type: "string", enum: PROVIDERS },
          model: { type: "string", description: "A model id from relay_capabilities." },
        },
        additionalProperties: false,
      },
      runtimeMode: { type: "string", enum: RUNTIME_MODES },
      mode: { type: "string", enum: ["async", "wait"] },
      timeoutMs: { type: "integer", minimum: 1000, maximum: DELEGATE_WAIT_MAX_MS },
      clientRequestId: {
        type: "string",
        description: "Stable id for this request; a retry with the same id returns the same task.",
      },
    },
    required: ["task"],
    additionalProperties: false,
  },
  annotations: {
    title: "Delegate task",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(args, ctx) {
    const caller = requireCaller(ctx);
    const task = optionalString(args, "task");
    if (!task) throw new McpToolError("invalid_request", "task is required.");
    // The child's first message must read as its task, not as a Relay agent note.
    if (parseRelayAgentMessage(task.trimStart())) {
      throw new McpToolError("invalid_request", "task can't start with a Relay message marker.");
    }
    const target = args.target === undefined || args.target === null ? {} : args.target;
    if (typeof target !== "object" || Array.isArray(target)) {
      throw new McpToolError("invalid_request", "target must be an object.");
    }
    const provider = optionalString(target as Record<string, unknown>, "provider");
    if (provider !== undefined && !PROVIDERS.includes(provider as ProviderKind)) {
      throw new McpToolError("provider_unavailable", `Unknown provider ${provider}.`);
    }
    const runtimeMode = optionalString(args, "runtimeMode");
    if (runtimeMode !== undefined && !RUNTIME_MODES.includes(runtimeMode as ProviderRuntimeMode)) {
      throw new McpToolError("invalid_request", `Unknown runtimeMode ${runtimeMode}.`);
    }
    const mode = optionalString(args, "mode") ?? "async";
    if (mode !== "async" && mode !== "wait") {
      throw new McpToolError("invalid_request", "mode must be 'async' or 'wait'.");
    }
    const started = await ctx.host.delegateTask(caller.id, {
      task,
      title: optionalString(args, "title"),
      role: optionalString(args, "role"),
      provider: provider as ProviderKind | undefined,
      model: optionalString(target as Record<string, unknown>, "model"),
      runtimeMode: runtimeMode as ProviderRuntimeMode | undefined,
      clientRequestId: optionalString(args, "clientRequestId"),
    });
    if (mode === "async" || started.status !== "running") {
      return {
        ...summarizeTask(started, ctx),
        ...(started.status === "running" ? { next: ASYNC_NEXT } : {}),
      };
    }
    const timeoutMs = clampInt(
      args.timeoutMs,
      1000,
      DELEGATE_WAIT_MAX_MS,
      DELEGATE_WAIT_DEFAULT_MS,
    );
    const settled = await ctx.host.waitForDelegatedTask(started.id, timeoutMs, ctx.signal);
    return {
      ...summarizeTask(settled, ctx),
      ...(settled.status === "running"
        ? {
            next: "Still running; the wait timed out but the child continues. Completion wakes this chat, so end your turn.",
          }
        : {}),
    };
  },
};

const taskStatus: Tool = {
  name: "task_status",
  description:
    "Read a delegated task's status and, once it ended, its full result. Don't poll it: completion wakes the delegating chat.",
  inputSchema: {
    type: "object",
    properties: { taskId: { type: "string" } },
    required: ["taskId"],
    additionalProperties: false,
  },
  annotations: { title: "Task status", readOnlyHint: true, openWorldHint: false },
  handler(args, ctx) {
    const caller = requireCaller(ctx);
    const task = requireTaskInAccount(args, ctx, caller);
    return summarizeTask(task, ctx, { fullResult: true });
  },
};

const taskCancel: Tool = {
  name: "task_cancel",
  description:
    "Stop a task this chat delegated, along with anything it delegated in turn. Its chat and any partial result stay readable.",
  inputSchema: {
    type: "object",
    properties: { taskId: { type: "string" } },
    required: ["taskId"],
    additionalProperties: false,
  },
  annotations: {
    title: "Cancel task",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler(args, ctx) {
    const caller = requireCaller(ctx);
    const task = requireTaskInAccount(args, ctx, caller);
    if (task.parentInstanceId !== caller.id) {
      throw new McpToolError(
        "not_task_owner",
        "Only the chat that delegated a task can cancel it.",
      );
    }
    return summarizeTask(ctx.host.cancelDelegatedTask(task.id), ctx);
  },
};

/** A chat in the caller's account other than the caller itself, or a typed refusal. */
function requireOtherChat(
  args: Record<string, unknown>,
  ctx: OrchestrationCallContext,
  caller: InstanceInfo,
): InstanceInfo {
  const raw = optionalString(args, "chatId");
  if (!raw) throw new McpToolError("invalid_request", "chatId is required.");
  const chatId = parseChatReference(raw);
  const chat = ctx.host.getChat(chatId);
  if (!chat || ctx.host.accountIdOf(chat) !== ctx.host.accountIdOf(caller)) {
    throw new McpToolError("chat_not_found", `No chat ${chatId} in this account.`);
  }
  if (chat.id === caller.id) {
    throw new McpToolError("chat_not_sendable", "That is this chat.");
  }
  return chat;
}

const chatSend: Tool = {
  name: "chat_send",
  description:
    "Send a message to another chat in this account; it arrives as a note from this chat and starts a turn there. The chat must be idle and not waiting on its user, and can't run with more access than this chat. Call chat_wait afterwards for its reply.",
  inputSchema: {
    type: "object",
    properties: {
      chatId: { type: "string", description: "Chat id or relay://chat/<id> link." },
      message: { type: "string", description: "Self-contained message for that chat." },
    },
    required: ["chatId", "message"],
    additionalProperties: false,
  },
  annotations: {
    title: "Send to chat",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(args, ctx) {
    const caller = requireCaller(ctx);
    const message = optionalString(args, "message");
    if (!message) throw new McpToolError("invalid_request", "message is required.");
    const chat = requireOtherChat(args, ctx, caller);
    await ctx.host.sendChatMessage(caller.id, chat.id, message);
    const after = ctx.host.getChat(chat.id) ?? chat;
    return {
      chat: summarizeChat(after, caller.id),
      sent: true,
      next: "Call chat_wait on this chat for its reply, unless you don't need one.",
    };
  },
};

const CHAT_WAIT_DEFAULT_MS = DELEGATE_WAIT_DEFAULT_MS;

const chatWait: Tool = {
  name: "chat_wait",
  description:
    "Wait until another chat's turn ends (nothing running or queued), it needs its user's input, or timeoutMs passes, then return its status and latest reply. Returns at once when it is already settled.",
  inputSchema: {
    type: "object",
    properties: {
      chatId: { type: "string", description: "Chat id or relay://chat/<id> link." },
      timeoutMs: { type: "integer", minimum: 1000, maximum: DELEGATE_WAIT_MAX_MS },
    },
    required: ["chatId"],
    additionalProperties: false,
  },
  annotations: { title: "Wait for chat", readOnlyHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const caller = requireCaller(ctx);
    const chat = requireOtherChat(args, ctx, caller);
    const timeoutMs = clampInt(args.timeoutMs, 1000, DELEGATE_WAIT_MAX_MS, CHAT_WAIT_DEFAULT_MS);
    const outcome = await ctx.host.waitForChatTurn(caller.id, chat.id, timeoutMs, ctx.signal);
    const after = ctx.host.getChat(chat.id);
    if (outcome === "gone" || !after) {
      return {
        outcome: "gone",
        chat: { id: chat.id, link: relayChatLink(chat.id), deleted: true },
      };
    }
    let lastReply: string | undefined;
    if (outcome !== "timeout") {
      try {
        lastReply = lastAssistantText(ctx.host.getHistory(chat.id));
      } catch {
        // No readable history: the summary still says how it ended.
      }
    }
    const clipped = lastReply !== undefined && lastReply.length > TASK_RESULT_PREVIEW_CHARS;
    // On its own delegate the caller also learns how the task ended — a
    // cancelled or failed task otherwise reads as an ordinary finished turn.
    const task =
      after.delegation?.parentInstanceId === caller.id
        ? ctx.host.getDelegatedTask(after.delegation.taskId)
        : undefined;
    return {
      outcome,
      chat: summarizeChat(after, caller.id),
      ...(task
        ? {
            task: {
              taskId: task.id,
              status: task.status,
              ...(task.statusDetail ? { statusDetail: task.statusDetail } : {}),
            },
          }
        : {}),
      ...(lastReply !== undefined
        ? { lastReply: clipped ? `${lastReply.slice(0, TASK_RESULT_PREVIEW_CHARS)}…` : lastReply }
        : {}),
      ...(clipped ? { lastReplyTruncated: true, next: "chat_read has the rest." } : {}),
    };
  },
};

export const RELAY_ORCHESTRATION_TOOLS: ReadonlyArray<Tool> = [
  relayCapabilities,
  delegateTask,
  taskStatus,
  taskCancel,
  chatList,
  chatRead,
  chatSend,
  chatWait,
];

/** Inline result size for tool replies other than `task_status`. */
const TASK_RESULT_PREVIEW_CHARS = 16_000;

function requireTaskInAccount(
  args: Record<string, unknown>,
  ctx: OrchestrationCallContext,
  caller: InstanceInfo,
): DelegatedTaskInfo {
  const taskId = optionalString(args, "taskId");
  if (!taskId) throw new McpToolError("invalid_request", "taskId is required.");
  const task = ctx.host.getDelegatedTask(taskId);
  const parent = task ? ctx.host.getChat(task.parentInstanceId) : undefined;
  // Another account's task reads as missing, like its chats.
  if (!task || !parent || ctx.host.accountIdOf(parent) !== ctx.host.accountIdOf(caller)) {
    throw new McpToolError("task_not_found", `No task ${taskId} in this account.`);
  }
  return task;
}

function summarizeTask(
  task: DelegatedTaskInfo,
  ctx: OrchestrationCallContext,
  options: { fullResult?: boolean } = {},
) {
  const child = ctx.host.getChat(task.childInstanceId);
  const result = task.result;
  const clipped =
    result !== undefined && !options.fullResult && result.length > TASK_RESULT_PREVIEW_CHARS;
  return {
    taskId: task.id,
    status: task.status,
    title: task.title,
    chat: child
      ? summarizeChat(child, ctx.callerId)
      : { id: task.childInstanceId, link: relayChatLink(task.childInstanceId), deleted: true },
    ...(task.statusDetail ? { statusDetail: task.statusDetail } : {}),
    ...(result !== undefined
      ? { result: clipped ? `${result.slice(0, TASK_RESULT_PREVIEW_CHARS)}…` : result }
      : {}),
    ...(clipped ? { resultTruncated: true } : {}),
    ...(task.resultIsError ? { resultIsError: true } : {}),
    startedAt: new Date(task.createdAt).toISOString(),
    ...(task.endedAt !== undefined ? { endedAt: new Date(task.endedAt).toISOString() } : {}),
  };
}

export function createRelayMcpServer(
  version: string,
): McpServerDefinition<OrchestrationCallContext> {
  return {
    name: RELAY_MCP_SERVER_NAME,
    version,
    instructions: RELAY_MCP_SERVER_INSTRUCTIONS,
    tools: RELAY_ORCHESTRATION_TOOLS,
  };
}

/** Accepts a bare id or a `relay://chat/<id>` link. */
export function parseChatReference(value: string): string {
  const trimmed = value.trim().replace(/^<|>$/g, "");
  const match = /^relay:\/\/chat\/([^/?#\s]+)/.exec(trimmed);
  return match ? decodeURIComponent(match[1]!) : trimmed;
}

export function summarizeChat(chat: InstanceInfo, callerId: string) {
  const model =
    chat.providerStatus?.effectiveModel ?? chat.stats?.model ?? chat.preferredModel ?? null;
  const needsInput = !!(chat.pendingPermission || chat.pendingTool || chat.pendingPlan);
  return {
    id: chat.id,
    link: relayChatLink(chat.id),
    title: chat.name,
    provider: chat.provider,
    model,
    status: chat.status,
    needsInput,
    done: isDone(chat),
    external: chat.external === true,
    ...(chat.spaceId ? { spaceId: chat.spaceId } : {}),
    ...(chat.gitBranch ? { branch: chat.gitBranch } : {}),
    // 0 = unknown (a just-created chat), not 1970.
    ...(recencyOf(chat) > 0 ? { lastActivityAt: new Date(recencyOf(chat)).toISOString() } : {}),
    ...(chat.delegation ? { delegatedBy: relayChatLink(chat.delegation.parentInstanceId) } : {}),
    ...(chat.id === callerId ? { isCaller: true } : {}),
  };
}

function requireCaller(ctx: OrchestrationCallContext): InstanceInfo {
  const caller = ctx.host.getChat(ctx.callerId);
  if (!caller) throw new McpToolError("caller_not_found", "The calling chat no longer exists.");
  return caller;
}

function projectInAccount(project: Pick<Project, "accountIds">, accountId: string): boolean {
  const ids = project.accountIds?.length ? project.accountIds : [DEFAULT_ACCOUNT_ID];
  return ids.includes(accountId);
}

/** Matches the UI's `getChatRecencyTimestamp`: the later of last message and last activity. */
function recencyOf(chat: InstanceInfo): number {
  return Math.max(chat.lastMessage?.timestamp ?? 0, chat.lastActivityAt ?? 0);
}

/** Matches the UI's `isChatDone`: done while nothing happened after the marker. */
function isDone(chat: InstanceInfo): boolean {
  return chat.doneAt !== undefined && recencyOf(chat) <= chat.doneAt;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string")
    throw new McpToolError("invalid_request", `${key} must be a string.`);
  return value.trim() || undefined;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
