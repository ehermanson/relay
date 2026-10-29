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
  DEFAULT_ACCOUNT_ID,
  type HistoryEntry,
  type InstanceInfo,
  type Project,
  type ProviderKind,
  type ProviderRuntimeMode,
} from "#core/types.js";

/**
 * Relay's cross-chat MCP tools (phase 1: read-only).
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
}

export interface OrchestrationCallContext {
  host: OrchestrationHost;
  callerId: string;
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

export const RELAY_ORCHESTRATION_TOOLS: ReadonlyArray<Tool> = [
  relayCapabilities,
  chatList,
  chatRead,
];

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
