/**
 * Claude SDK Session Provider
 *
 * Wraps @anthropic-ai/claude-agent-sdk's query() function to implement
 * the ProviderSession interface. Replaces the process-per-message CLI approach
 * with a long-lived session using an async iterable prompt queue.
 *
 * Key differences from CLI provider:
 * - Single query() call per session (multi-turn via prompt queue)
 * - canUseTool callback for permissions (no SIGINT + retry dance)
 * - Typed SDKMessage stream (no JSONL line parsing)
 * - Immediate session ID (no captureSessionId scanning)
 * - Live model/permission switching (no process restart)
 */

import { EventEmitter } from "events";
import { findClaudeBinary } from "#core/providers/claude-cli.js";
import type {
  OutputMessage,
  ExitMessage,
  ActivityMessage,
  EditToolInput,
  TaskItem,
  FileChange,
  SessionStats,
  ProviderRequest,
  ProviderRuntimeBinding,
  ProviderRuntimeMode,
  ProviderSessionBootstrap,
  UserInputQuestion,
  SystemEventMessage,
  ProviderRateLimitStatus,
} from "#core/types.js";
import type { CoreConfig } from "#core/config.js";
import type { ProviderSession } from "#core/provider.js";
import {
  describeToolUse,
  describeToolDetail,
  extractInputDescription,
  capDetail,
  getContextWindow,
  TASK_TOOLS,
  FILE_WRITE_TOOLS,
  buildToolResultActivity,
} from "#core/tools.js";
import { buildSessionInitEvent } from "#core/session-init.js";
import { isPathWithinWorkspace } from "#core/workspace-paths.js";
import { extFromPath } from "#core/paths.js";
import { createPatch } from "diff";

function countPatchLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

// =============================================================================
// SDK Types — imported dynamically to avoid hard dep at module level
// =============================================================================

// Re-declare the subset of SDK types we need. The actual SDK is imported
// dynamically in create() so the module doesn't fail if the SDK isn't installed.
// These mirror @anthropic-ai/claude-agent-sdk's exports.

interface SDKUserMessage {
  type: "user";
  message: { role: "user"; content: Array<{ type: "text"; text: string }> };
  parent_tool_use_id: null;
  session_id: string;
}

interface SDKMessageBase {
  type: string;
  uuid?: string;
  session_id?: string;
}

/** Minimal subset of the Query interface we use */
interface AccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: "firstParty" | "bedrock" | "vertex" | "foundry";
}

/**
 * Minimal subset of the SDK's experimental get_usage response (SDK >= 0.3.169).
 * The shape is explicitly unstable — every field is validated defensively at
 * the access site rather than trusted from this declaration.
 */
interface SdkUsageSnapshot {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: Record<string, unknown> | null;
}

/** Context usage breakdown from getContextUsage() */
interface ContextUsage {
  categories: { name: string; tokens: number; color: string; isDeferred?: boolean }[];
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  model: string;
}

/** Model capability info from supportedModels() */
interface SdkModelInfo {
  value: string;
  /** Canonical model id the alias resolves to (e.g. "sonnet" → "claude-sonnet-5").
   *  Newer CLIs only — always feature-detect. */
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: ("low" | "medium" | "high" | "xhigh" | "max")[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

interface QueryHandle extends AsyncIterable<SDKMessageBase> {
  /** Interrupt the running turn. Pass `cancel_queued: true` when the CLI
   *  advertises `interrupt_cancel_queued_v1` to also cancel queued messages. */
  interrupt(opts?: { cancel_queued?: boolean }): Promise<void>;
  setPermissionMode(
    mode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto",
  ): Promise<void>;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>;
  accountInfo(): Promise<AccountInfo>;
  getContextUsage(): Promise<ContextUsage>;
  supportedModels(): Promise<SdkModelInfo[]>;
  /**
   * Structured /usage snapshot (SDK >= 0.3.169): plan rate-limit utilization
   * windows. Optional — older SDKs lack it; the name will change when the SDK
   * stabilizes the API, so always feature-detect before calling.
   */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(): Promise<SdkUsageSnapshot>;
  close(): void | Promise<void>;
}

/** WarmQuery from startup() — pre-warmed SDK subprocess */
interface WarmQuery {
  query(prompt: string | AsyncIterable<SDKUserMessage>): QueryHandle;
  close(): void;
}

type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: Array<{ type: string; [key: string]: unknown }>;
    toolUseID: string;
    agentID?: string;
    decisionReason?: string;
  },
) => Promise<
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: Array<{ type: string; [key: string]: unknown }>;
    }
  | { behavior: "deny"; message: string; interrupt?: boolean }
>;

interface SDKOptions {
  cwd?: string;
  model?: string;
  resume?: string;
  resumeSessionAt?: string;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  includePartialMessages?: boolean;
  canUseTool?: CanUseTool;
  env?: Record<string, string | undefined>;
  allowedTools?: string[];
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  settings?: Record<string, unknown>;
  systemPrompt?:
    | string
    | {
        type: "preset";
        preset: "claude_code";
        append?: string;
        excludeDynamicSections?: boolean;
      };
  pathToClaudeCodeExecutable?: string;
}

type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: SDKOptions;
}) => QueryHandle;

type StartupFn = (params?: {
  options?: SDKOptions;
  initializeTimeoutMs?: number;
}) => Promise<WarmQuery>;

// =============================================================================
// Prompt Queue
// =============================================================================

/**
 * Simple async iterable backed by an array + resolver queue.
 * push() enqueues a message; terminate() signals end of iteration.
 */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private resolvers: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private done = false;

  push(message: SDKUserMessage): void {
    if (this.done) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ done: false, value: message });
    } else {
      this.queue.push(message);
    }
  }

  terminate(): void {
    if (this.done) return;
    this.done = true;
    for (const resolver of this.resolvers.splice(0)) {
      resolver({ done: true, value: undefined as unknown as SDKUserMessage });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const queued = this.queue.shift();
        if (queued) return Promise.resolve({ done: false as const, value: queued });
        if (this.done)
          return Promise.resolve({
            done: true as const,
            value: undefined as unknown as SDKUserMessage,
          });
        return new Promise((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

// =============================================================================
// Pending Permission
// =============================================================================

interface PendingPermission {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  suggestions?: Array<{ type: string; [key: string]: unknown }>;
  resolve: (
    result:
      | {
          behavior: "allow";
          updatedInput?: Record<string, unknown>;
          updatedPermissions?: Array<{ type: string; [key: string]: unknown }>;
        }
      | { behavior: "deny"; message: string; interrupt?: boolean },
  ) => void;
}

interface PendingStreamMessage {
  textByIndex: Map<number, string>;
  textOrder: number[];
  hasToolUse: boolean;
  hasThinking: boolean;
}

// =============================================================================
// Tool / State Tracking
// =============================================================================

/** Max auto-continue attempts per user message to prevent runaway loops */
const MAX_AUTO_CONTINUES = 25;

// =============================================================================
// ClaudeSdkSession
// =============================================================================

export interface ClaudeSdkSessionOptions {
  /** Working directory for the session */
  cwd: string;
  /** Model to use (e.g. "claude-opus-4-6") */
  model?: string;
  /** Reasoning effort level (low/medium/high/max) */
  reasoningEffort?: string;
  /** Enable fast mode */
  fastMode?: boolean;
  /** Initial runtime mode (defaults to "approval-required") */
  runtimeMode?: ProviderRuntimeMode;
  /** Session ID to resume */
  resumeSessionId?: string;
  /** Logger from CoreConfig */
  logger: CoreConfig["logger"];
  /** Process timeout in ms (0 = no timeout) */
  processTimeout?: number;
  /** Pre-approved tools from a previous session */
  allowedTools?: string[];
  /** Injected query function (for testing) */
  queryFn?: QueryFn;
  /** Structured bootstrap context delivered once when the session is created */
  bootstrapContext?: ProviderSessionBootstrap;
}

export interface ClaudeSdkSession extends ProviderSession {
  /** The session ID assigned by the SDK (available after first message from stream) */
  readonly sessionId: string | undefined;
  /** Return accumulated rate limit data (get_usage snapshot + live events), if any. */
  getRateLimitSnapshot(): import("#core/types.js").ProviderRateLimitStatus[] | undefined;
}

/** Cached SDK functions — resolved once, reused for all sessions. */
let cachedQueryFn: QueryFn | null = null;
let cachedStartupFn: StartupFn | null = null;

/**
 * Resolve the claude CLI executable for SDK spawns (sessions and discovery
 * probes). Prefer the system-installed CLI: it auto-updates (and is covered by
 * Relay's provider-version advisory + update flow), so model discovery tracks
 * the freshest CLI instead of the snapshot bundled inside the SDK package —
 * which only changes when Relay's lockfile pin is bumped. Returns undefined
 * (= SDK bundled CLI) when no system CLI is found or when
 * RELAY_CLAUDE_SDK_USE_BUNDLED_CLI is set as an escape hatch.
 */
function resolveClaudeExecutablePath(): string | undefined {
  if (process.env.RELAY_CLAUDE_SDK_USE_BUNDLED_CLI) return undefined;
  return findClaudeBinary() ?? undefined;
}

/** Module-level cache of SDK-discovered models. Populated eagerly by prewarmSdk(), updated by sessions. */
let sdkDiscoveredModels: SdkModelInfo[] | null = null;

/** When the model list was last probed (prewarm, session discovery, or refresh). */
let sdkModelsProbedAt = 0;

/** In-flight staleness refresh, deduped so concurrent callers share one probe. */
let sdkModelsRefreshInFlight: Promise<void> | null = null;

/** Re-probe the model list this often — new models are published server-side,
 *  so a long-running Relay must not serve a boot-time snapshot forever. */
const SDK_MODELS_REFRESH_INTERVAL_MS = 30 * 60_000;

/**
 * Module-level cache of SDK-discovered account info (plan/email/org).
 * Populated eagerly by prewarmSdk() — refreshed by real sessions via
 * fetchAccountInfo().
 */
let sdkDiscoveredAccountInfo: AccountInfo | null = null;

/**
 * Module-level cache of plan rate-limit utilization from the SDK's
 * experimental get_usage snapshot (SDK >= 0.3.169). Populated eagerly by
 * prewarmSdk() and refreshed by sessions (snapshot fetch + live
 * rate_limit_event), so the UI can show plan utilization at boot without
 * waiting for a mid-session event.
 */
let sdkDiscoveredRateLimits: ProviderRateLimitStatus[] | null = null;

/** One accumulated rate-limit window: utilization as 0-1 fraction, resetsAt as epoch seconds. */
type RateLimitWindowData = {
  utilization: number | undefined;
  resetsAt: number | undefined;
  status: string | undefined;
};

/** Minimum interval between get_usage snapshot probes (per session). */
const USAGE_PROBE_MIN_INTERVAL_MS = 60_000;

/** Known rateLimitType → window duration in minutes. */
const RATE_LIMIT_WINDOW_MINUTES: Record<string, number> = {
  five_hour: 300,
  seven_day: 10080,
  seven_day_opus: 10080,
  seven_day_sonnet: 10080,
  seven_day_oauth_apps: 10080,
  seven_day_overage_included: 10080,
  overage: 10080,
};

/** Window keys in the get_usage response that map onto plan rate-limit windows. */
const USAGE_RATE_LIMIT_WINDOW_KEYS = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_oauth_apps",
] as const;

const MODEL_SCOPED_PREFIX = "model_scoped/";

/** Build the normalized ProviderRateLimitStatus array from accumulated windows. */
function buildRateLimitsFromWindows(
  windows: Map<string, RateLimitWindowData>,
): ProviderRateLimitStatus[] {
  return [...windows.entries()].map(([type, data]) => {
    const usedPercent = typeof data.utilization === "number" ? data.utilization * 100 : undefined;
    const isModelScoped = type.startsWith(MODEL_SCOPED_PREFIX);
    const displayName = isModelScoped ? type.slice(MODEL_SCOPED_PREFIX.length) : undefined;
    return {
      name: displayName ?? type,
      scope: type,
      windows: [
        {
          usedPercent,
          remaining:
            typeof usedPercent === "number"
              ? Math.max(0, Math.round(100 - usedPercent))
              : undefined,
          windowMinutes: isModelScoped ? 10080 : RATE_LIMIT_WINDOW_MINUTES[type],
          resetAt: data.resetsAt ? new Date(data.resetsAt * 1000).toISOString() : undefined,
          status: data.status,
        },
      ],
    };
  });
}

/**
 * Probe the SDK's experimental get_usage control request and normalize the
 * plan rate-limit windows. Returns null when the SDK is too old, plan limits
 * don't apply (API key / Bedrock / Vertex), or the response is unusable —
 * the shape is experimental, so everything is validated defensively.
 */
async function probeUsageRateLimits(
  handle: QueryHandle,
): Promise<Map<string, RateLimitWindowData> | null> {
  const getUsage = handle.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (typeof getUsage !== "function") return null;
  const snapshot = await getUsage.call(handle);
  const limits = snapshot?.rate_limits;
  if (!limits || typeof limits !== "object") return null;

  const windows = new Map<string, RateLimitWindowData>();
  for (const key of USAGE_RATE_LIMIT_WINDOW_KEYS) {
    const entry = (limits as Record<string, unknown>)[key];
    if (!entry || typeof entry !== "object") continue;
    const { utilization, resets_at: resetsAt } = entry as Record<string, unknown>;
    const resetsAtEpoch = typeof resetsAt === "string" ? Date.parse(resetsAt) / 1000 : NaN;
    windows.set(key, {
      // get_usage reports utilization as 0-100; events use 0-1 fractions.
      utilization: typeof utilization === "number" ? utilization / 100 : undefined,
      resetsAt: Number.isFinite(resetsAtEpoch) ? resetsAtEpoch : undefined,
      status: undefined, // snapshot has no allowed/warning/rejected signal
    });
  }

  // Per-model weekly windows: model_scoped is an array of { display_name, utilization, resets_at }
  // where utilization is 0-100 and display_name is a server-assigned label (e.g. "Fable").
  const modelScopedRaw = (limits as Record<string, unknown>).model_scoped;
  if (Array.isArray(modelScopedRaw)) {
    for (const entry of modelScopedRaw) {
      if (!entry || typeof entry !== "object") continue;
      const { display_name, utilization, resets_at: resetsAt } = entry as Record<string, unknown>;
      if (typeof display_name !== "string" || !display_name) continue;
      const resetsAtEpoch = typeof resetsAt === "string" ? Date.parse(resetsAt) / 1000 : NaN;
      windows.set(`${MODEL_SCOPED_PREFIX}${display_name}`, {
        utilization: typeof utilization === "number" ? utilization / 100 : undefined,
        resetsAt: Number.isFinite(resetsAtEpoch) ? resetsAtEpoch : undefined,
        status: undefined,
      });
    }
  }

  return windows.size ? windows : null;
}

/**
 * Resolve the SDK's `query` and `startup` functions via dynamic import.
 * Caches the result so subsequent calls are synchronous.
 * Call this once at startup (e.g. in InstanceManager.restoreInstances())
 * so that session creation can be synchronous.
 */
export async function resolveQueryFn(): Promise<QueryFn> {
  if (cachedQueryFn) return cachedQueryFn;
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    cachedQueryFn = sdk.query as unknown as QueryFn;
    // startup() is exported but not yet typed in the SDK's .d.ts
    const startupFn = (sdk as Record<string, unknown>).startup;
    if (typeof startupFn === "function") {
      cachedStartupFn = startupFn as unknown as StartupFn;
    }
    return cachedQueryFn;
  } catch (err) {
    throw new Error(
      `@anthropic-ai/claude-agent-sdk is not installed. Install it with: npm install @anthropic-ai/claude-agent-sdk\n${err}`,
    );
  }
}

/**
 * Pre-warm the Claude Code subprocess and eagerly discover available models.
 *
 * startup() spawns a subprocess and completes initialization (including the
 * model list) before returning.  We consume the single-use WarmQuery handle
 * to call supportedModels(), populate the module-level sdkDiscoveredModels
 * cache, then close the handle.  This means the /api/provider-models endpoint
 * returns SDK-reported models from the moment the server finishes booting,
 * without waiting for a user to start a managed session.
 *
 * The warm subprocess is closed after probing — session creation still goes
 * through queryFn() as before.  Re-using the warm handle for the first real
 * session is a possible future optimisation but adds complexity around cwd
 * compatibility and canUseTool late-binding.
 */
export async function prewarmSdk(logger: CoreConfig["logger"]): Promise<void> {
  if (sdkDiscoveredModels && sdkDiscoveredAccountInfo) return; // already discovered
  if (!cachedStartupFn) return;
  try {
    const warm = await cachedStartupFn({
      options: { pathToClaudeCodeExecutable: resolveClaudeExecutablePath() },
      initializeTimeoutMs: 30_000,
    });
    logger.info("[SdkSession] Pre-warmed Claude Code subprocess via startup()");

    // Consume the single-use warm handle to probe both models and account info.
    // supportedModels() reads from the already-resolved initialization promise,
    // so it's effectively free. accountInfo() is also a zero-token lookup
    // against the SDK's cached auth state. Running them in parallel keeps the
    // warm subprocess alive for only as long as the slower of the two takes.
    const promptQueue = new PromptQueue();
    const handle = warm.query(promptQueue);
    try {
      const [modelsResult, accountResult, usageResult] = await Promise.allSettled([
        handle.supportedModels(),
        handle.accountInfo(),
        probeUsageRateLimits(handle),
      ]);
      if (modelsResult.status === "fulfilled") {
        sdkDiscoveredModels = modelsResult.value;
        sdkModelsProbedAt = Date.now();
        logger.info(`[SdkSession] Pre-warm discovered ${modelsResult.value.length} models`);
      } else {
        logger.debug(
          `[SdkSession] Pre-warm supportedModels() failed (non-fatal): ${modelsResult.reason}`,
        );
      }
      if (accountResult.status === "fulfilled") {
        sdkDiscoveredAccountInfo = accountResult.value;
        const summary =
          accountResult.value.subscriptionType ||
          accountResult.value.apiProvider ||
          accountResult.value.tokenSource ||
          "account-ok";
        logger.info(`[SdkSession] Pre-warm accountInfo: ${summary}`);
      } else {
        logger.debug(
          `[SdkSession] Pre-warm accountInfo() failed (non-fatal): ${accountResult.reason}`,
        );
      }
      if (usageResult.status === "fulfilled" && usageResult.value) {
        sdkDiscoveredRateLimits = buildRateLimitsFromWindows(usageResult.value);
        logger.info(
          `[SdkSession] Pre-warm usage snapshot: ${usageResult.value.size} rate-limit windows`,
        );
      } else if (usageResult.status === "rejected") {
        logger.debug(`[SdkSession] Pre-warm get_usage failed (non-fatal): ${usageResult.reason}`);
      }
    } finally {
      // Done with the warm subprocess — close it cleanly.
      promptQueue.terminate();
      try {
        await handle.close();
      } catch {
        /* ignore close errors */
      }
    }
  } catch (err) {
    logger.debug(`[SdkSession] startup() pre-warm failed (non-fatal): ${err}`);
  }
}

/**
 * Return SDK-discovered model capabilities if available.
 * Populated eagerly by prewarmSdk() at server startup, and refreshed by sessions.
 */
export function getSdkDiscoveredModels(): SdkModelInfo[] | null {
  return sdkDiscoveredModels;
}

/**
 * Re-probe the SDK model list in the background when the cached snapshot is
 * older than SDK_MODELS_REFRESH_INTERVAL_MS. Fire-and-forget from the provider
 * driver's getModels() — callers get the current cache immediately and the UI's
 * next poll picks up the refreshed list. Anthropic publishes new models
 * server-side (no SDK/CLI update needed), so without this a server running
 * across a release date serves a stale list until restart.
 */
export function refreshSdkDiscoveredModelsIfStale(logger: CoreConfig["logger"]): Promise<void> {
  if (!cachedStartupFn) return Promise.resolve();
  if (Date.now() - sdkModelsProbedAt < SDK_MODELS_REFRESH_INTERVAL_MS) return Promise.resolve();
  if (sdkModelsRefreshInFlight) return sdkModelsRefreshInFlight;
  sdkModelsRefreshInFlight = (async () => {
    try {
      const warm = await cachedStartupFn({
        options: { pathToClaudeCodeExecutable: resolveClaudeExecutablePath() },
        initializeTimeoutMs: 30_000,
      });
      const promptQueue = new PromptQueue();
      const handle = warm.query(promptQueue);
      try {
        const models = await handle.supportedModels();
        sdkDiscoveredModels = models;
        logger.info(`[SdkSession] Refreshed model discovery: ${models.length} models`);
      } finally {
        promptQueue.terminate();
        try {
          await handle.close();
        } catch {
          /* ignore close errors */
        }
      }
    } catch (err) {
      logger.debug(`[SdkSession] model discovery refresh failed (non-fatal): ${err}`);
    } finally {
      // Stamp even on failure so a broken environment retries once per
      // interval instead of spawning a probe on every picker open.
      sdkModelsProbedAt = Date.now();
      sdkModelsRefreshInFlight = null;
    }
  })();
  return sdkModelsRefreshInFlight;
}

/**
 * Return SDK-discovered account info (plan/email/org) if available.
 * Populated eagerly by prewarmSdk() at server startup, and refreshed by sessions.
 */
export function getSdkDiscoveredAccountInfo(): AccountInfo | null {
  return sdkDiscoveredAccountInfo;
}

/**
 * Return plan rate-limit utilization discovered via the experimental
 * get_usage snapshot, if available. Populated eagerly by prewarmSdk() at
 * server startup, and refreshed by sessions.
 */
export function getSdkDiscoveredRateLimits(): ProviderRateLimitStatus[] | null {
  return sdkDiscoveredRateLimits;
}

/**
 * Create a ClaudeSdkSession synchronously using a pre-resolved queryFn.
 * Use `resolveQueryFn()` to obtain the queryFn, or pass one directly for tests.
 */
export function createSdkSessionSync(
  options: ClaudeSdkSessionOptions,
  queryFn: QueryFn,
): ClaudeSdkSession {
  return new ClaudeSdkSessionImpl(options, queryFn);
}

/**
 * Create a ClaudeSdkSession.
 *
 * Uses dynamic import of @anthropic-ai/claude-agent-sdk so the module
 * doesn't fail if the SDK isn't installed. Falls back to provided queryFn
 * for testing.
 */
export async function createSdkSession(
  options: ClaudeSdkSessionOptions,
): Promise<ClaudeSdkSession> {
  const queryFn = options.queryFn ? options.queryFn : await resolveQueryFn();
  return new ClaudeSdkSessionImpl(options, queryFn);
}

class ClaudeSdkSessionImpl extends EventEmitter implements ClaudeSdkSession {
  private _isProcessing = false;
  private _hasStreamedText = false;
  private _lastMessageHadToolUse = false;
  /**
   * True when the last assistant message ended by calling ExitPlanMode. That is
   * a deliberate STOP point awaiting user plan approval
   */
  private _lastMessageWasExitPlanMode = false;
  /** Number of thinking blocks already emitted for the current message turn. */
  private _emittedThinkingCount = 0;
  /** True until the first user message is sent — suppresses replay emissions. */
  private _isResumeReplay = false;
  /** Set from the init event when the CLI advertises interrupt_cancel_queued_v1. */
  private _cancelQueuedSupported = false;
  /** Last emitted fast-mode disabled reason; used to emit a null-clear when it lifts. */
  private _lastFastModeDisabledReason: string | undefined;
  private _sessionId: string | undefined;
  private _stopped = false;
  private _stats: SessionStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  private promptQueue: PromptQueue;
  private query: QueryHandle;
  private pendingPermission: PendingPermission | null = null;
  private allowedToolSet: Set<string>;
  private _runtimeMode: ProviderRuntimeMode = "approval-required";
  private pendingStreamMessage: PendingStreamMessage | null = null;
  private _autoContinueCount = 0;
  /** Late SDK tool_result errors for permission streams we already auto-approved. */
  private ignoredPermissionErrorToolUseIds = new Set<string>();

  // State tracking (mirrors ClaudeProcess)
  private taskMap = new Map<string, TaskItem>();
  private pendingTaskCreates = new Map<string, { subject: string; activeForm?: string }>();
  private fileMap = new Map<string, FileChange>();
  // Map tool_use_id → tool name for tool_result attribution
  private pendingTools = new Map<string, string>();
  // Map tool_use_id → tool_result_meta for non-execution annotation (SDK >= 0.3.216)
  private pendingToolResultMeta = new Map<
    string,
    { nonExecutionKind?: string; userFeedback?: string }
  >();
  /** Raw assistant message for attaching to emitted events */
  private _lastRawAssistantMsg: Record<string, unknown> | null = null;
  /** Unix ms timestamp from the SDK's model-completion event (SDKAssistantMessage.timestamp). */
  private _lastMsgTimestamp: number | undefined;
  /** True when the last assistant message carried aborted:true (interrupt before stream completed). */
  private _lastMsgAborted = false;

  private logger: CoreConfig["logger"];
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private cwd: string;
  private currentModel: string | null;
  readonly bootstrapContext?: ProviderSessionBootstrap;

  constructor(options: ClaudeSdkSessionOptions, queryFn: QueryFn) {
    super();
    this.logger = options.logger;
    this.cwd = options.cwd;
    this.currentModel = options.model ?? null;
    this.bootstrapContext = options.bootstrapContext;
    this._runtimeMode = options.runtimeMode ?? "approval-required";
    this.allowedToolSet = new Set(options.allowedTools || []);
    this.promptQueue = new PromptQueue();

    // Build SDK options
    const sdkOptions: SDKOptions = {
      cwd: options.cwd,
      model: options.model,
      effort: options.reasoningEffort as SDKOptions["effort"],
      includePartialMessages: true,
      env: process.env as Record<string, string | undefined>,
      pathToClaudeCodeExecutable: resolveClaudeExecutablePath(),
    };
    if (options.fastMode) {
      sdkOptions.settings = { fastMode: true };
    }
    const appendedBootstrap = [
      options.bootstrapContext?.baseInstructions,
      options.bootstrapContext?.developerInstructions,
    ]
      .filter((value): value is string => !!value?.trim())
      .join("\n\n");
    if (appendedBootstrap) {
      sdkOptions.systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: appendedBootstrap,
      };
    }

    if (options.resumeSessionId) {
      sdkOptions.resume = options.resumeSessionId;
      this._isResumeReplay = true;
    }

    if (this._runtimeMode === "plan") {
      sdkOptions.permissionMode = "plan";
    } else if (this._runtimeMode === "full-access") {
      sdkOptions.permissionMode = "bypassPermissions";
    } else if (this._runtimeMode === "auto") {
      sdkOptions.permissionMode = "auto";
    }

    // Always set canUseTool so we can toggle bypass at runtime.
    // When bypass is on, the callback auto-approves everything.
    sdkOptions.canUseTool = this.handleCanUseTool.bind(this);

    if (this.allowedToolSet.size > 0) {
      sdkOptions.allowedTools = [...this.allowedToolSet];
    }

    this.logger.info(
      `[SdkSession] Starting session in ${options.cwd}${options.resumeSessionId ? ` (resume: ${options.resumeSessionId})` : ""}`,
    );

    // Start the query — this spawns the Claude Code subprocess
    this.query = queryFn({
      prompt: this.promptQueue,
      options: sdkOptions,
    });

    // Fetch account info (plan, email, org) and emit as provider status
    this.fetchAccountInfo();

    // Discover model capabilities and populate module-level cache
    this.discoverModels();

    // Seed context usage eagerly (useful for resumed sessions that already have context state)
    this.refreshContextUsage();

    // Start consuming the message stream
    this.consumeStream();
  }

  // ===========================================================================
  // ProviderSession interface
  // ===========================================================================

  get isProcessing(): boolean {
    return this._isProcessing;
  }

  get provider(): "claude" {
    return "claude";
  }

  get pid(): number | undefined {
    // SDK manages the subprocess internally — we don't have direct PID access.
    // Discovery exclusion will need to match by other means (CWD, timing).
    return undefined;
  }

  get stats(): SessionStats {
    return { ...this._stats };
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  getRuntimeBinding(): ProviderRuntimeBinding {
    return {
      provider: "claude",
      providerSessionId: this._sessionId,
      resumeCursor: this._sessionId ? { sessionId: this._sessionId } : undefined,
      runtimePayload: {
        cwd: this.cwd,
        model: this.currentModel ?? undefined,
        sessionContext: this.bootstrapContext ? { bootstrap: this.bootstrapContext } : undefined,
      },
      runtimeMode: this._runtimeMode,
    };
  }

  send(message: string): void {
    if (this._stopped) {
      this.logger.warn("[SdkSession] Cannot send — session is stopped");
      return;
    }
    if (this._isProcessing) {
      this.logger.warn("[SdkSession] Already processing, ignoring message");
      return;
    }

    this._isProcessing = true;
    this._hasStreamedText = false;
    this._lastMessageHadToolUse = false;
    this._lastMessageWasExitPlanMode = false;
    this._emittedThinkingCount = 0;
    this._isResumeReplay = false;
    this._autoContinueCount = 0;
    this.logger.info(`[SdkSession] Sending: "${message.slice(0, 50)}..."`);

    const userMessage: SDKUserMessage = {
      type: "user",
      parent_tool_use_id: null,
      session_id: this._sessionId || "",
      message: {
        role: "user",
        content: [{ type: "text", text: message }],
      },
    };

    this.promptQueue.push(userMessage);

    // Reset timeout for this turn
    this.resetTimeout();
  }

  interrupt(): void {
    if (this._stopped) return;
    this.logger.info(`[SdkSession] Interrupting... (cancel_queued=${this._cancelQueuedSupported})`);
    this.query
      .interrupt(this._cancelQueuedSupported ? { cancel_queued: true } : undefined)
      .catch((err) => {
        this.logger.debug(`[SdkSession] Interrupt error (expected): ${err}`);
      });
  }

  close(): void {
    if (this._stopped) return;
    this._stopped = true;
    this.clearTimeout();
    this.promptQueue.terminate();

    // Reject any pending permission
    if (this.pendingPermission) {
      this.pendingPermission.resolve({ behavior: "deny", message: "Session closed" });
      this.pendingPermission = null;
    }

    try {
      this.query.close();
    } catch {
      // ignore — may already be closed
    }
    this.logger.info("[SdkSession] Closed");
  }

  setModel(model: string | null): void {
    if (this._stopped) return;
    this.currentModel = model;
    if (model) {
      this.query.setModel(model).catch((err) => {
        this.logger.warn(`[SdkSession] setModel error: ${err}`);
      });
    } else {
      this.query.setModel(undefined).catch((err) => {
        this.logger.warn(`[SdkSession] setModel(clear) error: ${err}`);
      });
    }
  }

  setModelOptions(modelOptions: import("#core/types.js").ProviderModelOptions): void {
    if (this._stopped) return;
    // Apply effort and fastMode via applyFlagSettings (runtime SDK control).
    // Use "in" checks so cleared fields (set to undefined by instance-manager) are
    // forwarded to the SDK as resets, not silently skipped.
    const flagUpdates: Record<string, unknown> = {};
    if ("reasoningEffort" in modelOptions) {
      flagUpdates.effortLevel = modelOptions.reasoningEffort || undefined;
    }
    if ("fastMode" in modelOptions) {
      flagUpdates.fastMode = modelOptions.fastMode ?? false;
    }
    if (Object.keys(flagUpdates).length > 0) {
      this.query.applyFlagSettings(flagUpdates).catch((err) => {
        this.logger.warn(`[SdkSession] applyFlagSettings error: ${err}`);
      });
    }
  }

  addAllowedTool(tool: string): void {
    this.allowedToolSet.add(tool);
    // Note: SDK manages allowed tools via canUseTool callback + updatedPermissions.
  }

  setRuntimeMode(mode: ProviderRuntimeMode): void {
    if (this._stopped) return;
    if (
      mode !== "approval-required" &&
      mode !== "full-access" &&
      mode !== "plan" &&
      mode !== "auto"
    ) {
      this.logger.warn(`[SdkSession] Unknown runtime mode: ${mode}`);
      return;
    }
    this._runtimeMode = mode;
    this.logger.info(`[SdkSession] Runtime mode: ${mode}`);
    const permissionMode =
      mode === "plan"
        ? "plan"
        : mode === "full-access"
          ? "bypassPermissions"
          : mode === "auto"
            ? "auto"
            : "default";
    this.query.setPermissionMode(permissionMode).catch((err) => {
      this.logger.warn(`[SdkSession] setPermissionMode error: ${err}`);
    });
    // When switching to full-access, auto-approve any pending permission so the
    // session doesn't stay blocked waiting on a prompt the user already
    // resolved by escalating.
    if (mode === "full-access" && this.pendingPermission) {
      this.logger.info(
        `[SdkSession] Auto-approving pending permission for ${this.pendingPermission.toolName}`,
      );
      this.ignoredPermissionErrorToolUseIds.add(this.pendingPermission.toolUseId);
      this.pendingPermission.resolve({
        behavior: "allow",
        updatedInput: this.pendingPermission.input,
        updatedPermissions: this.pendingPermission.suggestions,
      });
      this.pendingPermission = null;
    }
  }

  respondToRequest(
    requestId: string,
    decision: "accept" | "decline",
    response?: import("#core/types.js").ProviderRequestResponse,
  ): boolean {
    if (!this.pendingPermission || this.pendingPermission.toolUseId !== requestId) return false;
    if (decision !== "accept") {
      this.pendingPermission.resolve({ behavior: "deny", message: "Request declined" });
      this.pendingPermission = null;
      return true;
    }

    const toolName = this.pendingPermission.toolName;
    this.logger.info(`[SdkSession] Approving permission for ${toolName}`);

    let updatedInput = this.pendingPermission.input;

    if (toolName === "AskUserQuestion") {
      // The SDK's built-in AskUserQuestion handler keys answers by the question
      // TEXT ("question text -> answer string", see AskUserQuestionOutput in
      // sdk-tools.d.ts) — NOT by the synthetic q_<index> ids Relay generates
      // (the tool input has no question ids). Translate Relay's
      // { questionId: { answers: string[] } } format into { questionText: string }
      // by mapping each answer back to its question via index/id.
      const inputQuestions = Array.isArray(
        (updatedInput as { questions?: unknown } | undefined)?.questions,
      )
        ? ((updatedInput as { questions: Record<string, unknown>[] }).questions ?? [])
        : [];
      const flatAnswers: Record<string, string> = {};
      inputQuestions.forEach((question, index) => {
        const questionText = question?.question;
        if (typeof questionText !== "string") return;
        const answerKey = typeof question?.id === "string" ? question.id : `q_${index}`;
        const answer = response?.answers?.[answerKey] ?? response?.answers?.[`q_${index}`];
        const values = answer?.answers?.filter((v) => typeof v === "string" && v.trim());
        if (values?.length) flatAnswers[questionText] = values.join(", ");
      });
      // The user declined the offered options and authored a free-text reply instead
      // (no structured answers). Deliver their message to the model as the answer to
      // the first question so their words actually reach the model, rather than an
      // empty tool result.
      const authored = response?.text?.trim();
      if (Object.keys(flatAnswers).length === 0 && authored) {
        const firstQuestionText = inputQuestions.find(
          (question) => typeof question?.question === "string",
        )?.question as string | undefined;
        if (firstQuestionText) flatAnswers[firstQuestionText] = authored;
      }
      updatedInput = { ...updatedInput, answers: flatAnswers };
    } else {
      // Only add non-interactive tools to the pre-approved set.
      // AskUserQuestion must always prompt for user input.
      this.allowedToolSet.add(toolName);
    }

    this.pendingPermission.resolve({
      behavior: "allow",
      updatedInput,
      updatedPermissions: this.pendingPermission.suggestions,
    });
    this.pendingPermission = null;
    return true;
  }

  approvePermission(tool: string): boolean {
    if (!this.pendingPermission || this.pendingPermission.toolName !== tool) return false;
    return this.respondToRequest(this.pendingPermission.toolUseId, "accept");
  }

  // ===========================================================================
  // canUseTool callback
  // ===========================================================================

  private handleCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    callbackOptions: {
      signal: AbortSignal;
      suggestions?: Array<{ type: string; [key: string]: unknown }>;
      toolUseID: string;
      agentID?: string;
      decisionReason?: string;
    },
  ): Promise<
    | {
        behavior: "allow";
        updatedInput?: Record<string, unknown>;
        updatedPermissions?: Array<{ type: string; [key: string]: unknown }>;
      }
    | { behavior: "deny"; message: string; interrupt?: boolean }
  > {
    // AskUserQuestion always blocks — it needs user interaction regardless of
    // bypass/allowed status. We emit a "user_input" request (with questions)
    // so the UI renders the question panel instead of a permission banner.
    if (toolName === "AskUserQuestion") {
      const questions = Array.isArray(input?.questions)
        ? (input.questions as Record<string, unknown>[])
            .filter(
              (question) =>
                typeof question === "object" &&
                question !== null &&
                typeof question.question === "string",
            )
            .map(
              (question, index) =>
                ({
                  ...question,
                  // AskUserQuestion tool input doesn't include `id` — generate one
                  id: typeof question.id === "string" ? question.id : `q_${index}`,
                  // Preserve the tool's multiSelect flag so the UI can offer
                  // multiple selections; normalize to a boolean rather than
                  // relying on the raw spread carrying it through.
                  multiSelect: question.multiSelect === true,
                  // The Claude Code harness always lets the user write their own
                  // answer ("Other") regardless of the offered options. The tool
                  // input carries no flag for this, so mark it here to enable the
                  // freeform composer (matches the Codex driver's explicit isOther).
                  isOther: true,
                }) as UserInputQuestion,
            )
        : [];

      this.logger.info(
        `[SdkSession] AskUserQuestion: waiting for user input (${questions.length} questions)`,
      );
      const request: ProviderRequest = {
        requestId: callbackOptions.toolUseID,
        kind: "user_input",
        tool: "AskUserQuestion",
        description: questions[0]?.question,
        questions,
      };
      this.emit("permissionRequest", request);

      return new Promise((resolve) => {
        this.pendingPermission = {
          toolName,
          toolUseId: callbackOptions.toolUseID,
          input,
          suggestions: callbackOptions.suggestions,
          resolve,
        };

        callbackOptions.signal.addEventListener(
          "abort",
          () => {
            if (this.pendingPermission?.toolUseId === callbackOptions.toolUseID) {
              this.pendingPermission = null;
              resolve({ behavior: "deny", message: "Operation cancelled" });
            }
          },
          { once: true },
        );
      });
    }

    // If full-access mode is on, allow everything
    if (this._runtimeMode === "full-access") {
      return Promise.resolve({ behavior: "allow" as const, updatedInput: input });
    }

    // If tool is pre-approved, allow immediately
    if (this.allowedToolSet.has(toolName)) {
      return Promise.resolve({ behavior: "allow" as const, updatedInput: input });
    }

    // File-write group: if any file-write tool is approved, allow all
    if (
      FILE_WRITE_TOOLS.has(toolName) &&
      [...FILE_WRITE_TOOLS].some((t) => this.allowedToolSet.has(t))
    ) {
      this.allowedToolSet.add(toolName);
      return Promise.resolve({ behavior: "allow" as const, updatedInput: input });
    }

    this.logger.info(`[SdkSession] Permission requested for ${toolName}`);

    // Emit a permission request event (not an activity — doesn't appear in chat).
    // InstanceManager wires this to set pendingPermission on the instance info.
    const request: ProviderRequest = {
      requestId: callbackOptions.toolUseID,
      kind: "approval",
      tool: toolName,
      description: describeToolUse(toolName, input),
      agentId: callbackOptions.agentID,
    };
    this.emit("permissionRequest", request);

    // Create a deferred promise that will be resolved by approvePermission()
    return new Promise((resolve) => {
      this.pendingPermission = {
        toolName,
        toolUseId: callbackOptions.toolUseID,
        input,
        suggestions: callbackOptions.suggestions,
        resolve,
      };

      // If the signal is aborted (e.g. session closed), deny
      callbackOptions.signal.addEventListener(
        "abort",
        () => {
          if (this.pendingPermission?.toolUseId === callbackOptions.toolUseID) {
            this.pendingPermission = null;
            resolve({ behavior: "deny", message: "Operation cancelled" });
          }
        },
        { once: true },
      );
    });
  }

  // ===========================================================================
  // Stream Consumer
  // ===========================================================================

  private async consumeStream(): Promise<void> {
    try {
      for await (const message of this.query) {
        if (this._stopped) break;
        this.handleMessage(message as unknown as Record<string, unknown>);
      }
    } catch (err) {
      if (!this._stopped) {
        this.logger.error(`[SdkSession] Stream error: ${err}`);
        const exit: ExitMessage = {
          type: "exit",
          code: 1,
          stderr: String(err),
        };
        this.emit("exit", exit);
      }
    } finally {
      if (!this._stopped) {
        this._stopped = true;
        this.clearTimeout();
        this.finishTurn();
        // Signal to InstanceManager that this session is no longer usable.
        // Without this, the instance stays "idle" but send() silently drops
        // messages, leaving the UI stuck on "working..." forever.
        const exit: ExitMessage = { type: "exit", code: 0 };
        this.emit("exit", exit);
      }
    }
  }

  // ===========================================================================
  // Message Handlers
  // ===========================================================================

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;

    // Capture session ID from any message that has one
    if (!this._sessionId && typeof msg.session_id === "string" && msg.session_id) {
      this._sessionId = msg.session_id;
      this.logger.debug(`[SdkSession] Captured session ID: ${this._sessionId}`);
    }

    switch (type) {
      case "system":
        this.handleSystem(msg);
        break;
      case "assistant":
        this.handleAssistant(msg);
        break;
      case "stream_event":
        this.handleStreamEvent(msg);
        break;
      case "result":
        this.handleResult(msg);
        break;
      case "user":
        this.handleUserMessage(msg);
        break;
      case "tool_progress":
        this.handleToolProgress(msg);
        break;
      case "tool_use_summary":
        // Informational — skip for now
        break;
      case "auth_status":
      case "prompt_suggestion":
        // Telemetry / informational — skip
        break;
      case "rate_limit_event":
        this.handleRateLimitEvent(msg);
        break;
      default:
        this.logger.debug(`[SdkSession] Unhandled message type: ${type}`);
    }
  }

  private handleSystem(msg: Record<string, unknown>): void {
    const subtype = msg.subtype as string;

    switch (subtype) {
      case "init": {
        const capabilities = Array.isArray(msg.capabilities) ? (msg.capabilities as string[]) : [];
        this._cancelQueuedSupported = capabilities.includes("interrupt_cancel_queued_v1");
        this.logger.debug(
          `[SdkSession] Init: model=${msg.model}, cwd=${msg.cwd}, tools=${(msg.tools as string[])?.length}, capabilities=${capabilities.join(",")}`,
        );
        this.emit("systemEvent", buildSessionInitEvent(msg));
        this.syncFastModeDisabledReason(msg.fast_mode_disabled_reason);
        break;
      }
      case "hook_started":
      case "hook_progress":
      case "hook_response":
        // Hook lifecycle — skip
        break;
      case "compact_boundary":
        this.emit("systemEvent", {
          type: "system_event",
          event: "compact_boundary",
          payload: {
            sessionId: this._sessionId,
          },
          raw: msg,
        } satisfies SystemEventMessage);
        break;
      case "status":
      case "elicitation_complete":
      case "local_command_output":
        // Lifecycle — skip
        break;
      default:
        this.logger.debug(`[SdkSession] Unhandled system subtype: ${subtype}`);
    }
  }

  private handleAssistant(msg: Record<string, unknown>): void {
    // During resume replay, the SDK re-sends all previous assistant messages.
    // The JSONL parser already built the history from these — skip to avoid duplicates.
    if (this._isResumeReplay) return;

    this._lastRawAssistantMsg = msg;
    const ts = typeof msg.timestamp === "string" ? msg.timestamp : undefined;
    this._lastMsgTimestamp = ts ? new Date(ts).getTime() : undefined;
    this._lastMsgAborted = msg.aborted === true;
    const message = msg.message as
      | {
          content?: Array<{
            type: string;
            text?: string;
            thinking?: string;
            name?: string;
            id?: string;
            input?: Record<string, unknown>;
          }>;
          model?: string;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
        }
      | undefined;

    if (!message?.content) return;

    // Accumulate usage
    if (message.usage && message.model) {
      this.accumulateUsage(message.model, message.usage);
    }

    // Track whether this message contained tool_use for auto-continue fallback
    this._lastMessageHadToolUse = message.content.some((block) => block.type === "tool_use");
    // Track on ExitPlanMode terminal tool_use so auto-continue can skip it - the
    // turn must go idle and wait for the user to approve the plan.
    this._lastMessageWasExitPlanMode = message.content.some(
      (block) => block.type === "tool_use" && block.name === "ExitPlanMode",
    );

    // Count thinking blocks in this partial message so we only emit new ones.
    // With includePartialMessages the SDK re-sends the full content array on
    // every partial update, so we skip blocks we already emitted.
    let thinkingIndex = 0;
    for (const block of message.content) {
      if (block.type === "thinking" && block.thinking) {
        if (thinkingIndex++ < this._emittedThinkingCount) continue;
        this._emittedThinkingCount = thinkingIndex;
        const activity: ActivityMessage = {
          type: "activity",
          activity: "thinking",
          description: "Reasoning...",
          detail: capDetail(block.thinking),
        };
        this.emit("activity", activity);
      } else if (block.type === "tool_use" && block.name) {
        // Reset auto-continue counter on productive progress — the limit should
        // only fire on consecutive empty turns, not during active tool loops.
        this._autoContinueCount = 0;
        if (block.id) this.pendingTools.set(block.id, block.name);
        this.handleToolUse(block.name, block.input, block.id);
      } else if (block.type === "tool_result") {
        this.handleToolResult(block as unknown as Record<string, unknown>);
      } else if (block.type === "text" && block.text) {
        // Emit text only as a fallback when no streaming occurred.
        // With includePartialMessages, the SDK sends partial assistant messages
        // interleaved with stream_event deltas. If we emit text here while
        // streaming is active (pendingStreamMessage exists), flushPendingStreamText()
        // will also emit the accumulated text on message_stop → duplicate.
        if (!this._hasStreamedText && !this.pendingStreamMessage) {
          this._hasStreamedText = true;
          const output: OutputMessage = {
            type: "output",
            text: block.text,
            isWaiting: false,
            raw: msg,
          };
          this.emit("output", output);
        }
      }
    }
  }

  private handleStreamEvent(msg: Record<string, unknown>): void {
    // stream_event contains partial/streaming content via event.delta
    const event = msg.event as Record<string, unknown> | undefined;
    if (!event) return;

    const eventType = event.type as string;

    if (eventType === "content_block_start") {
      const index = typeof event.index === "number" ? event.index : 0;
      const block = event.content_block as { type?: string } | undefined;
      const state = this.ensurePendingStreamMessage();
      if (block?.type === "text") {
        if (!state.textByIndex.has(index)) {
          state.textByIndex.set(index, "");
          state.textOrder.push(index);
        }
      } else if (block?.type === "tool_use") {
        state.hasToolUse = true;
      } else if (block?.type === "thinking") {
        state.hasThinking = true;
      }
    } else if (eventType === "content_block_delta") {
      const index = typeof event.index === "number" ? event.index : 0;
      const delta = event.delta as { type?: string; text?: string; thinking?: string } | undefined;
      if (!delta) return;

      if (delta.type === "text_delta" && delta.text) {
        const state = this.ensurePendingStreamMessage();
        if (!state.textByIndex.has(index)) {
          state.textByIndex.set(index, "");
          state.textOrder.push(index);
        }
        state.textByIndex.set(index, (state.textByIndex.get(index) || "") + delta.text);
      }
      if (delta.type === "thinking_delta" || delta.type === "signature_delta") {
        this.ensurePendingStreamMessage().hasThinking = true;
      }
      if (delta.type === "input_json_delta") {
        this.ensurePendingStreamMessage().hasToolUse = true;
      }
    } else if (eventType === "message_start") {
      // Message started — ensure we're in processing state and reset stream flag
      this._hasStreamedText = false;
      this._emittedThinkingCount = 0;
      this.pendingStreamMessage = null;
      if (!this._isProcessing) {
        this._isProcessing = true;
      }
    } else if (eventType === "message_stop") {
      this.flushPendingStreamText();
    }
  }

  private handleResult(msg: Record<string, unknown>): void {
    const stopReason = msg.stop_reason as string | null;
    const numTurns = msg.num_turns as number | undefined;
    this.logger.info(
      `[SdkSession] Result: subtype=${msg.subtype}, stop_reason=${stopReason}, num_turns=${numTurns}, is_error=${msg.is_error}`,
    );

    // Extract usage from result
    const modelUsage = msg.modelUsage as
      | Record<
          string,
          {
            inputTokens: number;
            outputTokens: number;
            cacheReadInputTokens: number;
            cacheCreationInputTokens: number;
            /** Canonical model id used for pricing (SDK >= 0.3.218); may differ from the map key alias. */
            canonicalModel?: string;
            /** API provider that served this model (SDK >= 0.3.218). */
            provider?: string;
          }
        >
      | undefined;

    if (modelUsage) {
      for (const [model, usage] of Object.entries(modelUsage)) {
        this._stats.inputTokens += usage.inputTokens || 0;
        this._stats.outputTokens += usage.outputTokens || 0;
        this._stats.cacheReadTokens += usage.cacheReadInputTokens || 0;
        this._stats.cacheCreationTokens += usage.cacheCreationInputTokens || 0;
        if (!this._stats.model) {
          // Prefer canonicalModel (the billing-level id) over the map key, which
          // may be a provider-specific alias that differs from the canonical id.
          this._stats.model = usage.canonicalModel ?? model;
        }
        this.emit("stats", { ...this._stats });
      }
    }

    // Surface fast mode availability from the turn result (SDK >= 0.3.219)
    this.syncFastModeDisabledReason(msg.fast_mode_disabled_reason);

    // Handle error results
    if (msg.subtype !== "success") {
      const errors = msg.errors as string[] | undefined;
      const stderr = errors?.join("\n") || undefined;
      if (stderr) {
        const exit: ExitMessage = {
          type: "exit",
          code: 1,
          stderr,
        };
        this.emit("exit", exit);
      }
      this.finishTurn();
      return;
    }

    // Auto-continue: if the turn ended with stop_reason "tool_use", it means
    // Claude was mid-agent-loop but the CLI subprocess ended the turn prematurely.
    // Push a continuation prompt to keep the work going.
    // Also continue when stop_reason is missing but the last message had tool_use
    // blocks — the SDK sometimes omits stop_reason when the subprocess exits.
    const shouldContinue =
      (stopReason === "tool_use" || (stopReason == null && this._lastMessageHadToolUse)) &&
      // ExitPlanMode is a deliberate stop awaiting user approval, not a turn the
      // CLI cut off mid-loop. Auto-continuing here would execute the plan before
      // the user approves it.
      !this._lastMessageWasExitPlanMode;
    if (shouldContinue && this._autoContinueCount < MAX_AUTO_CONTINUES && !this._stopped) {
      this._autoContinueCount++;
      this.logger.info(
        `[SdkSession] Turn ended mid-tool-loop (stop_reason=${stopReason}) — auto-continuing (${this._autoContinueCount}/${MAX_AUTO_CONTINUES})`,
      );
      this.promptQueue.push({
        type: "user",
        parent_tool_use_id: null,
        session_id: this._sessionId || "",
        message: {
          role: "user",
          content: [{ type: "text", text: "Continue." }],
        },
      });
      return;
    }

    // Turn is complete — go idle
    if (shouldContinue) {
      this.logger.warn(
        `[SdkSession] Turn ended mid-tool-loop but auto-continue blocked (stop_reason=${stopReason}, count=${this._autoContinueCount}/${MAX_AUTO_CONTINUES}, stopped=${this._stopped})`,
      );
    }
    this.finishTurn();
  }

  private ensurePendingStreamMessage(): PendingStreamMessage {
    if (!this.pendingStreamMessage) {
      this.pendingStreamMessage = {
        textByIndex: new Map(),
        textOrder: [],
        hasToolUse: false,
        hasThinking: false,
      };
    }
    return this.pendingStreamMessage;
  }

  private flushPendingStreamText(): void {
    const pending = this.pendingStreamMessage;
    this.pendingStreamMessage = null;
    if (!pending) return;

    const text = pending.textOrder
      .sort((a, b) => a - b)
      .map((index) => pending.textByIndex.get(index) || "")
      .join("");
    if (!text) return;

    const output: OutputMessage = {
      type: "output",
      text,
      isWaiting: false,
    };
    this._hasStreamedText = true;
    this.emit("output", output);
  }

  private handleToolProgress(msg: Record<string, unknown>): void {
    const toolName = msg.tool_name as string;
    const elapsed = msg.elapsed_time_seconds as number;

    if (toolName === "Bash" || toolName === "bash") {
      const activity: ActivityMessage = {
        type: "activity",
        activity: "tool_use",
        tool: "Bash",
        description: `Running... ${Math.round(elapsed)}s`,
      };
      this.emit("activity", activity);
    }
  }

  // ===========================================================================
  // Account Info
  // ===========================================================================

  private accountInfoFetched = false;

  /**
   * Fetch account info from the SDK (plan, email, org) and emit as a
   * provider_status system event. Called once after session init.
   */
  private fetchAccountInfo(): void {
    if (this.accountInfoFetched) return;
    this.accountInfoFetched = true;

    void this.query
      .accountInfo()
      .then((info) => {
        // Always refresh the module-level cache so the pre-warmed copy
        // doesn't go stale (e.g. if plan tier changes mid-day).
        sdkDiscoveredAccountInfo = info;

        const account: Record<string, unknown> = {};
        if (info.subscriptionType) account.plan = info.subscriptionType;
        if (info.email) account.email = info.email;
        if (info.organization) account.label = info.organization;

        if (Object.keys(account).length === 0) return;

        this.emit("systemEvent", {
          type: "system_event",
          event: "provider_status",
          payload: { account },
        } as SystemEventMessage);
      })
      .catch((err) => {
        this.logger.debug(`[SdkSession] accountInfo() unavailable: ${err}`);
      });

    // Plan rate-limit utilization via the experimental get_usage snapshot
    // (SDK >= 0.3.169) — surfaces the windows at session start instead of
    // waiting for a mid-session rate_limit_event.
    this.refreshUsageRateLimits();
  }

  // ===========================================================================
  // Model Capability Discovery
  // ===========================================================================

  private _cachedModelCapabilities: SdkModelInfo[] | null = null;

  /**
   * Fetch model capabilities from the SDK's supportedModels() API.
   * Returns SDK-reported models with capability flags (effort levels,
   * adaptive thinking, fast mode, etc.). Cached after first successful fetch.
   */
  private async fetchModelCapabilities(): Promise<SdkModelInfo[] | null> {
    if (this._cachedModelCapabilities) return this._cachedModelCapabilities;
    try {
      const models = await this.query.supportedModels();
      this._cachedModelCapabilities = models;
      // Always update module-level cache so the provider driver serves fresh data
      sdkDiscoveredModels = models;
      sdkModelsProbedAt = Date.now();
      this.logger.info(`[SdkSession] Discovered ${models.length} models with capabilities`);
      return models;
    } catch (err) {
      this.logger.debug(`[SdkSession] supportedModels() unavailable: ${err}`);
      return null;
    }
  }

  /**
   * Kick off model capability discovery to populate the module-level cache.
   * Called once after session init alongside account info.
   */
  private discoverModels(): void {
    void this.fetchModelCapabilities();
  }

  // ===========================================================================
  // Rate Limit Events
  // ===========================================================================

  /**
   * Map from rateLimitType → { utilization, resetsAt, status }. We accumulate
   * across events because each event reports only one window at a time.
   * `utilization` may be undefined for `allowed` status — Claude only sends it
   * for `allowed_warning` or `rejected`.
   */
  private rateLimitWindows = new Map<string, RateLimitWindowData>();

  /**
   * Handle `rate_limit_event` from the Claude SDK stream. Converts the
   * SDK-specific payload into the same ProviderAccountStatus/rateLimits
   * shape used by Codex, then emits a `provider_status` system event.
   */
  private handleRateLimitEvent(msg: Record<string, unknown>): void {
    const info = msg.rate_limit_info as Record<string, unknown> | undefined;
    if (!info) return;

    const rateLimitType = info.rateLimitType as string | undefined;
    this.logger.debug(
      `[SdkSession] rate_limit_event: type=${rateLimitType} utilization=${info.utilization} status=${info.status} resetsAt=${info.resetsAt}`,
    );
    if (!rateLimitType) return;

    // utilization is 0-1 fraction; only present for `allowed_warning` or
    // `rejected` status. For `allowed`, we still store the window so we can
    // show the reset time even without a percentage.
    const utilization = typeof info.utilization === "number" ? info.utilization : undefined;
    const resetsAt = typeof info.resetsAt === "number" ? info.resetsAt : undefined;
    const status = typeof info.status === "string" ? info.status : "allowed";

    // Field-level merge: an `allowed` event carries no utilization, and must
    // not erase a percentage we already know from the get_usage snapshot or
    // an earlier warning/rejected event. Status always reflects the latest
    // event — it's the live signal.
    const prev = this.rateLimitWindows.get(rateLimitType);
    this.rateLimitWindows.set(rateLimitType, {
      utilization: utilization ?? prev?.utilization,
      resetsAt: resetsAt ?? prev?.resetsAt,
      status,
    });

    this.emitRateLimitsStatus();
  }

  /**
   * Merge get_usage snapshot windows into the accumulated map. The snapshot
   * is fetched now, so its utilization is at least as fresh as any earlier
   * event data — snapshot fields win, while live event `status` is preserved
   * (the snapshot carries none). Exception: a stale `rejected` is cleared
   * when the snapshot proves the window is below 100% — it cannot still be
   * exhausted.
   */
  private seedUsageWindows(windows: Map<string, RateLimitWindowData>): void {
    for (const [type, data] of windows) {
      const existing = this.rateLimitWindows.get(type);
      if (!existing) {
        this.rateLimitWindows.set(type, { ...data });
        continue;
      }
      const utilization = data.utilization ?? existing.utilization;
      // utilization is a 0-1 fraction here (probeUsageRateLimits normalizes
      // the snapshot's 0-100 values on ingest).
      const status =
        existing.status === "rejected" && typeof utilization === "number" && utilization < 1
          ? undefined
          : existing.status;
      this.rateLimitWindows.set(type, {
        utilization,
        resetsAt: data.resetsAt ?? existing.resetsAt,
        status,
      });
    }
  }

  private _usageProbeInflight = false;
  private _lastUsageProbeAt = 0;

  /**
   * Probe the get_usage snapshot and fold it into the accumulated windows.
   * Called at session start and after each completed turn (throttled) so the
   * 5h window keeps a percentage even though live events rarely carry one,
   * and so a stale `rejected` self-corrects instead of latching until reset.
   */
  private refreshUsageRateLimits(): void {
    if (this._stopped || this._usageProbeInflight) return;
    if (Date.now() - this._lastUsageProbeAt < USAGE_PROBE_MIN_INTERVAL_MS) return;
    this._usageProbeInflight = true;
    void probeUsageRateLimits(this.query)
      .then((windows) => {
        this._lastUsageProbeAt = Date.now();
        if (!windows) return;
        this.seedUsageWindows(windows);
        this.emitRateLimitsStatus();
      })
      .catch((err) => {
        this.logger.debug(`[SdkSession] get_usage snapshot unavailable: ${err}`);
      })
      .finally(() => {
        this._usageProbeInflight = false;
      });
  }

  /** Emit the accumulated rate-limit windows as a provider_status event. */
  private emitRateLimitsStatus(): void {
    const rateLimits = this.buildRateLimitsSnapshot();
    if (!rateLimits.length) return;

    // Keep the module-level snapshot fresh so the boot-time fallback in
    // instance-manager reflects the latest data.
    sdkDiscoveredRateLimits = rateLimits;

    this.emit("systemEvent", {
      type: "system_event",
      event: "provider_status",
      payload: {
        account: { rateLimits },
      },
    } as SystemEventMessage);
  }

  /** Build the normalized rate limits array from accumulated windows. */
  private buildRateLimitsSnapshot(): import("#core/types.js").ProviderRateLimitStatus[] {
    return buildRateLimitsFromWindows(this.rateLimitWindows);
  }

  /**
   * Public accessor so the instance manager can harvest accumulated rate limit
   * data from active sessions (e.g. to hydrate provider global state on
   * client reconnect without waiting for a new turn).
   */
  getRateLimitSnapshot(): import("#core/types.js").ProviderRateLimitStatus[] | undefined {
    const snapshot = this.buildRateLimitsSnapshot();
    return snapshot.length ? snapshot : undefined;
  }

  // ===========================================================================
  // Tool Handling (mirrors ClaudeProcess logic)
  // ===========================================================================

  private handleToolUse(
    toolName: string,
    input: Record<string, unknown> | undefined,
    toolUseId: string | undefined,
  ): void {
    // Task tools
    if (TASK_TOOLS.has(toolName)) {
      if (toolName === "TodoWrite" && input) {
        this.applyTodoWrite(input);
      } else if (toolName === "TaskCreate" && input && toolUseId) {
        this.pendingTaskCreates.set(toolUseId, {
          subject: (input.subject as string) || "Untitled task",
          activeForm: input.activeForm as string | undefined,
        });
      } else if (toolName === "TaskUpdate" && input) {
        const taskId = input.taskId as string;
        const status = input.status as string | undefined;
        if (taskId && status === "deleted") {
          this.taskMap.delete(taskId);
          this.emitTaskList();
        } else if (taskId && status && this.taskMap.has(taskId)) {
          const task = this.taskMap.get(taskId)!;
          task.status = status as TaskItem["status"];
          if (input.subject) task.subject = input.subject as string;
          if (input.activeForm) task.activeForm = input.activeForm as string;
          this.emitTaskList();
        }
      }
      // TaskList/TaskGet: suppress
      return;
    }

    // File change tracking
    this.trackFileChange(toolName, input);

    // Normalize Edit input into the same EditToolInput shape as Codex:
    // generate a patch diff from old/new strings so the UI has one rendering path.
    let activityInput: Record<string, unknown> | undefined = input;
    if (toolName === "Edit" && input) {
      const filePath = (input.file_path ?? input.path) as string | undefined;
      const oldStr = input.old_string as string | undefined;
      const newStr = input.new_string as string | undefined;
      if (filePath && typeof oldStr === "string" && typeof newStr === "string") {
        // Generate a patch diff string, stripping the Index/=== header lines
        const raw = createPatch(filePath, oldStr, newStr, undefined, undefined, { context: 3 });
        const diff = raw.split("\n").slice(4).join("\n"); // skip Index, ===, ---, +++
        const { additions, deletions } = countPatchLines(diff);
        const editInput: EditToolInput = {
          file_path: filePath,
          extension: extFromPath(filePath),
          diff,
          additions,
          deletions,
        };
        activityInput = editInput as unknown as Record<string, unknown>;
      }
    } else if (toolName === "AskUserQuestion" && toolUseId) {
      activityInput = { ...input, requestId: toolUseId };
    }

    // Note: AskUserQuestion user_input permissionRequest is emitted from
    // handleCanUseTool (which always blocks for this tool). No duplicate here.

    // Regular tool use activity
    const activity: ActivityMessage = {
      type: "activity",
      activity: "tool_use",
      tool: toolName,
      description: describeToolUse(toolName, input),
      detail: describeToolDetail(toolName, input),
      input: activityInput,
      inputDescription: extractInputDescription(toolName, input),
      raw: { tool: toolName, toolUseId, input: activityInput },
    };
    this.emit("activity", activity);
  }

  /** Emit a provider_status update when the fast-mode disabled reason changes.
   *  The SDK signals "available again" by omitting the field, so absence after a
   *  known reason emits an explicit null to clear it — a reason must never latch. */
  private syncFastModeDisabledReason(raw: unknown): void {
    const reason = typeof raw === "string" ? raw : undefined;
    if (reason === this._lastFastModeDisabledReason) return;
    this._lastFastModeDisabledReason = reason;
    this.emit("systemEvent", {
      type: "system_event",
      event: "provider_status",
      payload: { fastModeDisabledReason: reason ?? null },
    } as SystemEventMessage);
  }

  private handleUserMessage(msg: Record<string, unknown>): void {
    const message = (msg as Record<string, unknown>).message;
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_result") continue;
      const toolUseId = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined;
      if (!toolUseId) continue;
      const meta = (b as Record<string, unknown>).tool_result_meta;
      if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
      const m = meta as Record<string, unknown>;
      const nonExecutionKind =
        typeof m.non_execution_kind === "string" ? m.non_execution_kind : undefined;
      const userFeedback = typeof m.user_feedback === "string" ? m.user_feedback : undefined;
      if (nonExecutionKind !== undefined || userFeedback !== undefined) {
        this.pendingToolResultMeta.set(toolUseId, { nonExecutionKind, userFeedback });
      }
    }
  }

  private handleToolResult(block: Record<string, unknown>): void {
    const toolUseId = block.tool_use_id as string;
    const toolName = this.pendingTools.get(toolUseId);
    const isError = block.is_error as boolean | undefined;
    const content = typeof block.content === "string" ? block.content : "";

    if (
      isError &&
      this.ignoredPermissionErrorToolUseIds.has(toolUseId) &&
      content.includes("Tool permission request failed") &&
      content.includes("Stream closed")
    ) {
      this.ignoredPermissionErrorToolUseIds.delete(toolUseId);
      return;
    }
    this.ignoredPermissionErrorToolUseIds.delete(toolUseId);

    if (TASK_TOOLS.has(toolName || "")) {
      if (toolName === "TaskCreate") {
        const idMatch = content.match(/Task #(\d+)/);
        const pending = this.pendingTaskCreates.get(toolUseId);
        if (idMatch && pending) {
          this.taskMap.set(idMatch[1], {
            id: idMatch[1],
            subject: pending.subject,
            status: "pending",
            activeForm: pending.activeForm,
          });
          this.pendingTaskCreates.delete(toolUseId);
          this.emitTaskList();
        }
      }
      return;
    }

    // For non-task tools, emit a tool_result activity
    const meta = this.pendingToolResultMeta.get(toolUseId);
    this.pendingToolResultMeta.delete(toolUseId);
    const activity = buildToolResultActivity(isError, toolName, content, meta);
    this.emit("activity", activity);
  }

  // ===========================================================================
  // State tracking helpers (mirrors ClaudeProcess)
  // ===========================================================================

  private applyTodoWrite(input: Record<string, unknown>): void {
    const todos = input.todos as
      | Array<{ content?: string; status?: string; activeForm?: string }>
      | undefined;
    if (!Array.isArray(todos)) return;
    this.taskMap.clear();
    for (let i = 0; i < todos.length; i++) {
      const t = todos[i];
      if (!t.content) continue;
      const id = `todo-${i}`;
      this.taskMap.set(id, {
        id,
        subject: t.content,
        status: (t.status as TaskItem["status"]) || "pending",
        activeForm: t.activeForm,
      });
    }
    this.emitTaskList();
  }

  private emitTaskList(): void {
    const activity: ActivityMessage = {
      type: "activity",
      activity: "task_list",
      description: "Tasks",
      tasks: Array.from(this.taskMap.values()).map((t) => ({ ...t })),
    };
    this.emit("activity", activity);
  }

  private trackFileChange(toolName: string, input: Record<string, unknown> | undefined): void {
    if (!input || !FILE_WRITE_TOOLS.has(toolName)) return;
    const filePath = (input.file_path || input.path || input.notebook_path) as string | undefined;
    if (!filePath) return;
    if (!isPathWithinWorkspace(this.cwd, filePath)) return;
    const existing = this.fileMap.get(filePath);
    if (existing) {
      existing.editCount++;
    } else {
      this.fileMap.set(filePath, {
        path: filePath,
        editCount: 1,
        type: toolName === "Write" ? "added" : "edited",
      });
    }
    this.emitFileList();
  }

  private emitFileList(): void {
    const activity: ActivityMessage = {
      type: "activity",
      activity: "file_list",
      description: "Files changed",
      files: Array.from(this.fileMap.values()).map((f) => ({ ...f })),
    };
    this.emit("activity", activity);
  }

  private accumulateUsage(
    model: string,
    usage: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    },
  ): void {
    if (!usage.input_tokens && !usage.output_tokens) return;
    const u = {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
    };
    this._stats.inputTokens += u.input_tokens;
    this._stats.outputTokens += u.output_tokens;
    this._stats.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
    this._stats.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    if (!this._stats.model) {
      this._stats.model = model;
    }
    this.emit("stats", { ...this._stats });

    // Fetch accurate context usage from the SDK (async, non-blocking).
    // This replaces the old manual estimate (input + cached tokens).
    this.refreshContextUsage();
  }

  /**
   * Fetch context window usage from the SDK's getContextUsage() API.
   * Updates stats with accurate per-category token counts and context window size.
   * Non-blocking — errors are silently logged.
   */
  private _contextUsageInflight = false;
  private refreshContextUsage(): void {
    if (this._contextUsageInflight || this._stopped) return;
    this._contextUsageInflight = true;
    this.query
      .getContextUsage()
      .then((ctx) => {
        this._stats.contextTokens = ctx.totalTokens;
        // SDK maxTokens/rawMaxTokens may report the effective limit (200k), not the
        // full model context window (1M for Opus 4.6 / Sonnet 4.6). Use the known
        // model mapping as the authoritative source when available.
        const knownWindow =
          getContextWindow(ctx.model) ||
          (this._stats.model ? getContextWindow(this._stats.model) : undefined);
        this._stats.contextWindow = knownWindow || ctx.rawMaxTokens || ctx.maxTokens;
        this._stats.contextCategories = ctx.categories;
        this.emit("stats", { ...this._stats });
      })
      .catch((err) => {
        this.logger.debug(`[SdkSession] getContextUsage() failed: ${err}`);
      })
      .finally(() => {
        this._contextUsageInflight = false;
      });
  }

  // ===========================================================================
  // Lifecycle helpers
  // ===========================================================================

  private finishTurn(): void {
    this.clearTimeout();
    this._isProcessing = false;
    // Refresh plan rate-limit utilization after each completed turn
    // (throttled) — live events rarely carry a percentage for the 5h window.
    this.refreshUsageRateLimits();
    const modelTimestamp = this._lastMsgTimestamp;
    this._lastMsgTimestamp = undefined;
    const aborted = this._lastMsgAborted || undefined;
    this._lastMsgAborted = false;
    const done: OutputMessage = {
      type: "output",
      text: "",
      isWaiting: true,
      modelTimestamp,
      aborted,
      raw: this._lastRawAssistantMsg ?? undefined,
    };
    this._lastRawAssistantMsg = null;
    this.emit("output", done);
  }

  private resetTimeout(): void {
    // Note: processTimeout only applies to the CLI fallback.
    // The SDK has its own timeout handling. We keep a generous safety net.
    // Not implemented for SDK sessions — the SDK handles timeouts internally.
  }

  private clearTimeout(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
}
