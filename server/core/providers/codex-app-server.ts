/**
 * Codex App-Server Session Provider
 *
 * Wraps `codex app-server --listen stdio://` via a persistent JSON-RPC 2.0
 * connection. Replaces the process-per-message CLI approach with a long-lived
 * session using thread/start, thread/resume, and turn/start RPC methods.
 *
 * Key differences from CLI provider:
 * - Single long-lived process (no process churn per message)
 * - Streaming text via item/agentMessage/delta notifications
 * - Permission approval flow via requestApproval server requests
 * - Bidirectional RPC: thread/start, turn/start, turn/interrupt
 * - Token usage via thread/tokenUsage/updated notifications
 */

import { EventEmitter } from "events";
import { spawn, type ChildProcess } from "child_process";
import type { Readable } from "stream";
import type {
  OutputMessage,
  ExitMessage,
  ActivityMessage,
  EditToolInput,
  FileChange,
  ProviderAccountStatus,
  ProviderDiffStatus,
  ProviderMcpServerStatus,
  ProviderNotice,
  ProviderRateLimitStatus,
  ProviderSkill,
  ProviderSessionBootstrap,
  SessionStats,
  SystemEventMessage,
  ProviderModelOptions,
  ProviderRequest,
  ProviderRequestResponse,
  ProviderRuntimeBinding,
  ProviderRuntimeMode,
  UserInputQuestion,
} from "#core/types.js";
import type { CoreConfig } from "#core/config.js";
import type { ProviderSession } from "#core/provider.js";
import { buildSessionInitEvent } from "#core/session-init.js";
import { buildTaskListActivityFromPlan } from "#core/tools.js";
import { ProposedPlanStreamParser } from "#core/proposed-plan.js";
import { isPathWithinWorkspace } from "#core/workspace-paths.js";
import {
  findCodexBinary,
  buildCodexSpawnEnv,
  RELAY_CODEX_ORIGINATOR,
} from "#core/providers/codex-cli.js";
import { resolveProviderDefaultModelOption } from "#core/provider-catalog.js";
import { getCachedCodexModels } from "#core/providers/codex-models.js";
import { extFromPath } from "#core/paths.js";
import { mcpServerId, normalizeMcpAuthentication, normalizeMcpConnectionState } from "#core/mcp.js";

type SpawnFn = typeof spawn;

// =============================================================================
// JSON-RPC Types
// =============================================================================

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params: unknown;
}

interface JsonRpcServerRequest {
  jsonrpc?: "2.0";
  id: number | string;
  method: string;
  params: unknown;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;

// =============================================================================
// App-Server Protocol Types (subset we care about)
// =============================================================================

interface ThreadInfo {
  id: string;
  cwd: string;
  name?: string | null;
  path?: string | null;
}

interface TurnInfo {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
}

interface FileUpdateChange {
  path: string;
  kind: { type: "add" } | { type: "delete" } | { type: "update"; move_path?: string | null };
  diff: string;
}

interface ThreadItemBase {
  type: string;
  id: string;
}

interface CommandExecutionItem extends ThreadItemBase {
  type: "commandExecution";
  command: string;
  cwd: string;
  status: "inProgress" | "completed" | "failed" | "declined";
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
}

interface FileChangeItem extends ThreadItemBase {
  type: "fileChange";
  changes: FileUpdateChange[];
  status: "inProgress" | "completed" | "failed" | "declined";
}

interface AgentMessageItem extends ThreadItemBase {
  type: "agentMessage";
  text: string;
}

interface ReasoningItem extends ThreadItemBase {
  type: "reasoning";
  summary: string[];
  content: string[];
}

interface McpToolCallItem extends ThreadItemBase {
  type: "mcpToolCall";
  server: string;
  tool: string;
  status: string;
  durationMs?: number | null;
}

interface DynamicToolCallItem extends ThreadItemBase {
  type: "dynamicToolCall";
  tool: string;
  status: string;
  durationMs?: number | null;
  arguments?: unknown;
  success?: boolean | null;
  contentItems?: Array<{ text?: string; [key: string]: unknown }> | null;
}

interface ImageGenerationItem extends ThreadItemBase {
  type: "imageGeneration";
  saved_path?: string | null;
  savedPath?: string | null;
  revised_prompt?: string | null;
}

interface ContextCompactionItem {
  type: "compaction";
  encrypted_content: string;
}

interface RequestUserInputParams {
  itemId: string;
  questions: UserInputQuestion[];
  threadId: string;
  turnId: string;
}

interface TerminalInteractionParams {
  itemId?: string;
  command?: string;
  cwd?: string;
  prompt?: string;
  text?: string;
  isSecret?: boolean;
  [key: string]: unknown;
}

type ThreadItem =
  | CommandExecutionItem
  | FileChangeItem
  | AgentMessageItem
  | ReasoningItem
  | McpToolCallItem
  | DynamicToolCallItem
  | ImageGenerationItem
  | (ThreadItemBase & Record<string, unknown>);

// =============================================================================
// Session Options
// =============================================================================

export interface CodexAppServerSessionOptions {
  cwd: string;
  model?: string;
  /** Initial runtime mode (defaults to "approval-required") */
  runtimeMode?: ProviderRuntimeMode;
  resumeSessionId?: string;
  logger: CoreConfig["logger"];
  processTimeout?: number;
  spawnProcess?: SpawnFn;
  codexPath?: string;
  modelOptions?: ProviderModelOptions;
  bootstrapContext?: ProviderSessionBootstrap;
}

export interface CodexProviderGlobalStateSnapshotOptions {
  cwd: string;
  logger: CoreConfig["logger"];
  processTimeout?: number;
  spawnProcess?: SpawnFn;
  codexPath?: string;
}

// =============================================================================
// Helpers
// =============================================================================

function trackFileChange(
  files: Map<string, FileChange>,
  root: string,
  path: string,
  type: "added" | "edited",
): void {
  if (!isPathWithinWorkspace(root, path)) return;
  const existing = files.get(path);
  if (existing) {
    existing.editCount++;
    if (existing.type !== "added") existing.type = type;
    return;
  }
  files.set(path, { path, editCount: 1, type });
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return strings.length > 0 ? strings : undefined;
}

function countDiffLines(diff: string): { additions: number; deletions: number } {
  const lines = diff.split("\n");
  const looksLikePatch = lines.some(
    (line) =>
      line.startsWith("@@") ||
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("+") ||
      line.startsWith("-"),
  );
  if (!looksLikePatch) {
    const additions = diff.length === 0 ? 0 : lines.filter((line) => line.length > 0).length;
    return { additions, deletions: 0 };
  }
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/** Pull a file path out of `view_image` tool arguments, which may be an object or a JSON string. */
function extractViewImagePath(args: unknown): string | undefined {
  if (!args) return undefined;
  let parsed: unknown = args;
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args);
    } catch {
      return undefined;
    }
  }
  if (parsed && typeof parsed === "object") {
    const path = (parsed as Record<string, unknown>).path;
    if (typeof path === "string" && path.trim()) return path;
    const filePath = (parsed as Record<string, unknown>).file_path;
    if (typeof filePath === "string" && filePath.trim()) return filePath;
  }
  return undefined;
}

/**
 * Pull the on-disk path of a generated image out of an `imageGeneration` item.
 * Codex writes the PNG to `~/.codex/generated_images/...` and reports its path;
 * field naming varies, so check the known variants defensively.
 */
function extractGeneratedImagePath(item: ThreadItem): string | undefined {
  const rec = item as Record<string, unknown>;
  for (const value of [rec.saved_path, rec.savedPath, rec.path]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function extractAddedFileContent(diff: string): string {
  const lines = diff.split("\n");
  const hasPatchMarkers = lines.some(
    (line) => line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@"),
  );
  if (!hasPatchMarkers && lines.every((line) => !line.startsWith("+") && !line.startsWith("-"))) {
    return diff;
  }
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

function buildRequestDescription(params: Record<string, unknown>): string | undefined {
  return (
    getString(params.reason) ??
    getString(params.prompt) ??
    getString(params.command) ??
    getString(params.description)
  );
}

function buildProviderNotice(
  level: ProviderNotice["level"],
  scope: ProviderNotice["scope"],
  source: string,
  params: Record<string, unknown>,
): ProviderNotice | null {
  const message =
    getString(params.message) ??
    getString((params.warning as Record<string, unknown> | undefined)?.message) ??
    getString((params.notice as Record<string, unknown> | undefined)?.message);
  if (!message) return null;
  return {
    level,
    scope,
    source,
    code:
      getString(params.code) ??
      getString((params.warning as Record<string, unknown> | undefined)?.code) ??
      getString((params.notice as Record<string, unknown> | undefined)?.code),
    message,
    detail:
      getString(params.detail) ??
      getString((params.warning as Record<string, unknown> | undefined)?.detail) ??
      getString((params.notice as Record<string, unknown> | undefined)?.detail),
  };
}

function buildMcpServerStatusList(value: unknown): ProviderMcpServerStatus[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const servers: ProviderMcpServerStatus[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const name = getString(row.name) ?? getString(row.server);
    if (!name) continue;
    const tools = Array.isArray(row.tools) ? row.tools.length : undefined;
    const status = getString(row.status);
    const authStatus = getString(row.authStatus) ?? getString(row.auth_status);
    const connected =
      typeof row.connected === "boolean"
        ? row.connected
        : asRecord(row.serverInfo ?? row.server_info)
          ? true
          : undefined;
    let connectionState = normalizeMcpConnectionState(status, authStatus, connected);
    if (
      connectionState === "unknown" &&
      connected !== true &&
      authStatus
        ?.toLowerCase()
        .replace(/[^a-z]/g, "")
        .includes("oauth")
    ) {
      connectionState = "needs_auth";
    }
    servers.push({
      id: mcpServerId("codex", name),
      name,
      provider: "codex",
      scope: "global",
      source: "provider",
      configured: true,
      connectionState,
      authentication: normalizeMcpAuthentication(authStatus, connectionState),
      tools: Array.isArray(row.tools)
        ? row.tools.flatMap((tool) => {
            if (typeof tool === "string" && tool.trim()) return [{ name: tool.trim() }];
            const record = asRecord(tool);
            const toolName = getString(record?.name);
            return toolName
              ? [{ name: toolName, description: getString(record?.description) }]
              : [];
          })
        : undefined,
      status,
      authStatus,
      connected,
      toolCount: tools,
      detail: getString(row.detail) ?? getString(row.message),
    });
  }
  return servers;
}

function normalizeMcpServerStatusSnapshot(value: unknown): ProviderMcpServerStatus[] | undefined {
  const payload = asRecord(value);
  return buildMcpServerStatusList(payload?.data ?? payload?.servers ?? payload?.items ?? value);
}

function buildAccountStatus(params: Record<string, unknown>): ProviderAccountStatus | undefined {
  const account = getRecord(params.account) ?? params;
  const rateLimits =
    buildAccountRateLimits(account) ??
    normalizeCodexRateLimitsSnapshot(params) ??
    normalizeCodexRateLimitsSnapshot(account);
  const result: ProviderAccountStatus = {
    plan: getString(account.plan) ?? getString(account.planType),
    label: getString(account.label) ?? getString(account.name),
    email: getString(account.email),
    status: getString(account.status),
    rateLimits,
  };
  return result.plan || result.label || result.email || result.status || result.rateLimits
    ? result
    : undefined;
}

function buildDiffStatus(params: Record<string, unknown>): ProviderDiffStatus | undefined {
  const changedFiles =
    typeof params.changedFiles === "number"
      ? params.changedFiles
      : typeof params.changed_files === "number"
        ? params.changed_files
        : undefined;
  const result: ProviderDiffStatus = {
    status: getString(params.status),
    changedFiles,
    summary:
      getString(params.summary) ??
      (typeof changedFiles === "number"
        ? `${changedFiles} file${changedFiles === 1 ? "" : "s"} changed`
        : undefined),
  };
  return result.status || result.summary || typeof result.changedFiles === "number"
    ? result
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function normalizeCodexAccountSnapshot(result: unknown): ProviderAccountStatus | undefined {
  const payload = asRecord(result);
  const account = asRecord(payload?.account);
  const accountType = getString(account?.type);
  const planType = getString(account?.planType);
  const email = getString(account?.email);
  const requiresOpenaiAuth =
    typeof payload?.requiresOpenaiAuth === "boolean" ? payload.requiresOpenaiAuth : false;

  const status =
    getString(payload?.status) ??
    (requiresOpenaiAuth ? "auth_required" : accountType === "apiKey" ? "api_key" : undefined);

  const label =
    getString(payload?.label) ??
    (accountType === "chatgpt"
      ? "ChatGPT account"
      : accountType === "apiKey"
        ? "API key"
        : undefined);

  const normalized: ProviderAccountStatus = {
    plan: planType,
    label,
    email,
    status,
  };

  return normalized.plan || normalized.label || normalized.email || normalized.status
    ? normalized
    : undefined;
}

function normalizeCodexRateLimitsSnapshot(
  result: unknown,
): ProviderAccountStatus["rateLimits"] | undefined {
  const payload = asRecord(result);
  const primary = payload?.rateLimits ?? payload?.rate_limits;
  const byLimitId =
    asRecord(payload?.rateLimitsByLimitId) ?? asRecord(payload?.rate_limits_by_limit_id);
  const snapshots: unknown[] = [];
  if (primary) snapshots.push(primary);
  if (byLimitId) {
    for (const value of Object.values(byLimitId)) {
      if (value) snapshots.push(value);
    }
  }

  const seen = new Set<string>();
  const limits: NonNullable<ProviderAccountStatus["rateLimits"]> = [];
  for (const snapshotValue of snapshots) {
    const snapshot = asRecord(snapshotValue);
    if (!snapshot) continue;
    const primaryWindow = asRecord(snapshot.primary);
    const secondaryWindow = asRecord(snapshot.secondary);
    const name =
      getString(snapshot.limitName) ??
      getString(snapshot.limit_name) ??
      getString(snapshot.limitId) ??
      getString(snapshot.limit_id);
    const scope = getString(snapshot.limitId) ?? getString(snapshot.limit_id);
    const dedupeKey = `${scope ?? ""}|${name ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const windows: NonNullable<ProviderRateLimitStatus["windows"]> = [];
    if (primaryWindow) {
      const usedPercent =
        getNumber(primaryWindow.usedPercent) ?? getNumber(primaryWindow.used_percent);
      windows.push({
        label: "Primary",
        usedPercent,
        remaining:
          typeof usedPercent === "number" ? Math.max(0, Math.round(100 - usedPercent)) : undefined,
        windowMinutes:
          getNumber(primaryWindow.windowMinutes) ??
          getNumber(primaryWindow.window_minutes) ??
          getNumber(primaryWindow.windowDurationMins) ??
          getNumber(primaryWindow.window_duration_mins),
        resetAt:
          typeof (getNumber(primaryWindow.resetsAt) ?? getNumber(primaryWindow.resets_at)) ===
          "number"
            ? new Date(
                (getNumber(primaryWindow.resetsAt) ?? getNumber(primaryWindow.resets_at) ?? 0) *
                  1000,
              ).toISOString()
            : undefined,
      });
    }
    if (secondaryWindow) {
      const usedPercent =
        getNumber(secondaryWindow.usedPercent) ?? getNumber(secondaryWindow.used_percent);
      windows.push({
        label: "Secondary",
        usedPercent,
        remaining:
          typeof usedPercent === "number" ? Math.max(0, Math.round(100 - usedPercent)) : undefined,
        windowMinutes:
          getNumber(secondaryWindow.windowMinutes) ??
          getNumber(secondaryWindow.window_minutes) ??
          getNumber(secondaryWindow.windowDurationMins) ??
          getNumber(secondaryWindow.window_duration_mins),
        resetAt:
          typeof (getNumber(secondaryWindow.resetsAt) ?? getNumber(secondaryWindow.resets_at)) ===
          "number"
            ? new Date(
                (getNumber(secondaryWindow.resetsAt) ?? getNumber(secondaryWindow.resets_at) ?? 0) *
                  1000,
              ).toISOString()
            : undefined,
      });
    }
    limits.push({
      name,
      scope,
      plan: getString(snapshot.planType) ?? getString(snapshot.plan_type),
      windows: windows.length ? windows : undefined,
    });
  }

  return limits.length ? limits : undefined;
}

function buildAccountRateLimits(
  account: Record<string, unknown>,
): ProviderAccountStatus["rateLimits"] | undefined {
  const rawRateLimits = account.rateLimits ?? account.rate_limits;
  if (!Array.isArray(rawRateLimits)) return undefined;

  const rateLimits: NonNullable<ProviderAccountStatus["rateLimits"]> = [];
  for (const entry of rawRateLimits) {
    const row = getRecord(entry);
    if (!row) continue;
    const explicitWindows = Array.isArray(row.windows)
      ? row.windows
          .map((window) => buildRateLimitWindow(getRecord(window)))
          .filter((window): window is NonNullable<ProviderRateLimitStatus["windows"]>[number] =>
            Boolean(window),
          )
      : undefined;
    const snapshotWindows = buildSnapshotWindows(row);
    const singleWindow = buildRateLimitWindow(row);
    const windows = explicitWindows?.length
      ? explicitWindows
      : snapshotWindows?.length
        ? snapshotWindows
        : singleWindow
          ? [singleWindow]
          : undefined;
    rateLimits.push({
      name: getString(row.name),
      scope: getString(row.scope),
      plan: getString(row.plan) ?? getString(row.planType) ?? getString(row.plan_type),
      windows,
    });
  }
  return rateLimits.length ? rateLimits : undefined;
}

function buildSnapshotWindows(
  snapshot: Record<string, unknown>,
): NonNullable<ProviderRateLimitStatus["windows"]> | undefined {
  const windows: NonNullable<ProviderRateLimitStatus["windows"]> = [];
  const primary = buildRateLimitWindow(getRecord(snapshot.primary), "Primary");
  if (primary) windows.push(primary);
  const secondary = buildRateLimitWindow(getRecord(snapshot.secondary), "Secondary");
  if (secondary) windows.push(secondary);
  return windows.length ? windows : undefined;
}

function buildRateLimitWindow(
  row: Record<string, unknown> | undefined,
  defaultLabel?: string,
): NonNullable<ProviderRateLimitStatus["windows"]>[number] | undefined {
  if (!row) return undefined;
  const usedPercent = getNumber(row.usedPercent) ?? getNumber(row.used_percent);
  const limit = getNumber(row.limit);
  const remaining = getNumber(row.remaining);
  const windowMinutes =
    getNumber(row.windowMinutes) ??
    getNumber(row.window_minutes) ??
    getNumber(row.windowDurationMins) ??
    getNumber(row.window_duration_mins);
  const resetAtEpoch = getNumber(row.resetsAt) ?? getNumber(row.resets_at);
  const resetAt = getString(row.resetAt) ?? getString(row.reset_at);
  const window = {
    label: getString(row.label) ?? defaultLabel,
    limit,
    remaining,
    usedPercent,
    windowMinutes,
    resetAt:
      resetAt ??
      (typeof resetAtEpoch === "number" ? new Date(resetAtEpoch * 1000).toISOString() : undefined),
  };
  return window.label ||
    window.limit !== undefined ||
    window.remaining !== undefined ||
    window.usedPercent !== undefined ||
    window.windowMinutes !== undefined ||
    window.resetAt !== undefined
    ? window
    : undefined;
}

export function normalizeCodexSkillsSnapshot(
  result: unknown,
  cwd: string,
): ProviderSkill[] | undefined {
  const payload = asRecord(result);
  const buckets = Array.isArray(payload?.data) ? payload.data : [];
  const matchingBucket = buckets.find((value) => asRecord(value)?.cwd === cwd);
  const bucket = asRecord(matchingBucket);
  const rawSkills =
    (Array.isArray(bucket?.skills) ? bucket.skills : null) ??
    (Array.isArray(payload?.skills) ? payload.skills : null) ??
    [];

  const skills = rawSkills.flatMap((value) => {
    const skill = asRecord(value);
    if (!skill) return [];
    const iface = asRecord(skill.interface);
    const name = getString(skill.name);
    if (!name) return [];

    return [
      {
        name,
        ...(getString(iface?.displayName) ? { displayName: getString(iface?.displayName) } : {}),
        ...(getString(skill.description) ? { description: getString(skill.description) } : {}),
        ...((getString(skill.shortDescription) ?? getString(iface?.shortDescription))
          ? {
              shortDescription:
                getString(skill.shortDescription) ?? getString(iface?.shortDescription),
            }
          : {}),
        enabled: typeof skill.enabled === "boolean" ? skill.enabled : true,
        ...(getString(skill.scope) ? { scope: getString(skill.scope) } : {}),
        ...(getString(skill.path) ? { path: getString(skill.path) } : {}),
        invocationPrefix: "$",
      } satisfies ProviderSkill,
    ];
  });

  return skills.length ? skills : undefined;
}

// =============================================================================
// CodexAppServerSession
// =============================================================================

export class CodexAppServerSession extends EventEmitter implements ProviderSession {
  private process: ChildProcess | null = null;
  private readonly logger: CoreConfig["logger"];
  private readonly cwd: string;
  private readonly processTimeout: number;
  private readonly spawnProcess: SpawnFn;
  private readonly codexPath: string;

  private _isProcessing = false;
  private _pendingMessage: string | null = null;
  private _planDeltaBuffer = "";
  private _lastEmittedPlan = "";
  private _sessionId: string | undefined;
  private _transcriptPath: string | undefined;
  private _preferredModel: string | null;
  private _runtimeMode: ProviderRuntimeMode;
  private _modelOptions: ProviderModelOptions;
  readonly bootstrapContext?: ProviderSessionBootstrap;
  private _stats: SessionStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  private readonly fileMap = new Map<string, FileChange>();
  private readonly pendingRpcResponses = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  /** Pending user-action requests from the server, keyed by stringified request id. */
  private readonly pendingRequests = new Map<
    string,
    {
      kind: "approval" | "user_input" | "terminal_input";
      method: string;
      params: Record<string, unknown> | RequestUserInputParams | TerminalInteractionParams;
      rpcId?: number | string;
    }
  >();

  private nextRpcId = 1;
  private lineBuffer = "";
  private stderrBuffer = "";
  private initialized = false;
  private _currentTurnId: string | null = null;
  private _lastCompactionTurnId: string | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private readonly proposedPlanParser = new ProposedPlanStreamParser();

  // Track whether we initiated close, to suppress spurious exit events
  private _closingIntentionally = false;

  constructor(options: CodexAppServerSessionOptions) {
    super();
    this.logger = options.logger;
    this.cwd = options.cwd;
    this.processTimeout = options.processTimeout ?? 0;
    this.spawnProcess = options.spawnProcess ?? spawn;

    const resolved = options.codexPath ?? findCodexBinary();
    if (!resolved) {
      throw new Error(
        "Codex CLI not found. Install it with: npm install -g @openai/codex" +
          "\nSee https://github.com/openai/codex for details.",
      );
    }
    this.codexPath = resolved;

    this._sessionId = options.resumeSessionId;
    this._preferredModel = options.model ?? null;
    this._runtimeMode = options.runtimeMode ?? "approval-required";
    this._modelOptions = options.modelOptions ?? {};
    this.bootstrapContext = options.bootstrapContext;
    if (this._preferredModel) {
      this._stats.model = this._preferredModel;
    }
  }

  // ===========================================================================
  // ProviderSession interface
  // ===========================================================================

  get isProcessing(): boolean {
    return this._isProcessing;
  }

  get provider(): "codex" {
    return "codex";
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  get stats(): SessionStats {
    return { ...this._stats };
  }

  getRuntimeBinding(): ProviderRuntimeBinding {
    return {
      provider: "codex",
      providerSessionId: this._sessionId,
      resumeCursor: this._sessionId ? { sessionId: this._sessionId } : undefined,
      transcriptPath: this._transcriptPath,
      runtimePayload: {
        cwd: this.cwd,
        model: this._preferredModel ?? undefined,
        sessionContext: this.bootstrapContext ? { bootstrap: this.bootstrapContext } : undefined,
      },
      runtimeMode: this._runtimeMode,
    };
  }

  send(message: string): void {
    if (this._isProcessing) {
      this._pendingMessage = message;
      return;
    }

    this._isProcessing = true;
    this._planDeltaBuffer = "";
    this.resetTimeout();

    if (!this.process || !this.initialized) {
      this.spawnAndInit(message);
    } else {
      this.startTurn(message);
    }
  }

  interrupt(): void {
    if (!this._currentTurnId || !this._sessionId) return;
    this.logger.info("[CodexAppServer] Interrupting turn...");
    this.sendRpc("turn/interrupt", {
      threadId: this._sessionId,
      turnId: this._currentTurnId,
    }).catch((err) => {
      this.logger.warn(`[CodexAppServer] Interrupt failed: ${err}`);
    });
  }

  compactThread(): void {
    if (!this._sessionId) {
      this.emit("providerError", "Cannot compact before the Codex thread has started.");
      return;
    }
    if (this._isProcessing) {
      this.emit("providerError", "Cannot compact while another Codex turn is still running.");
      return;
    }

    this._isProcessing = true;
    this._planDeltaBuffer = "";
    this.resetTimeout();
    if (!this.hasWritableTransport() || !this.initialized) {
      this.spawnAndCompact();
      return;
    }

    this.startCompaction();
  }

  close(): Promise<void> {
    this.clearTimeout();
    this._closingIntentionally = true;
    const child = this.process;
    this._isProcessing = false;
    this._pendingMessage = null;
    this._planDeltaBuffer = "";
    this.initialized = false;
    // Reject any pending RPC calls
    for (const [, pending] of this.pendingRpcResponses) {
      pending.reject(new Error("Session closed"));
    }
    this.pendingRpcResponses.clear();
    this.pendingRequests.clear();
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener("exit", onExit);
        child.removeListener("error", onExit);
        if (this.process === child) {
          this.process = null;
        }
        resolve();
      };
      const onExit = () => finish();
      const timer = setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          child.kill("SIGKILL");
        }
        finish();
      }, 2000);
      timer.unref?.();
      child.once("exit", onExit);
      child.once("error", onExit);
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
      } else {
        finish();
      }
    });
  }

  addAllowedTool(_tool: string): void {
    // App-server uses requestApproval flow — individual tool allow-listing
    // is handled by responding to specific approval requests. We keep track
    // of approved tools via the pendingRequests map + respondToRequest.
  }

  setModel(model: string | null): void {
    this._preferredModel = model;
    this._stats.model = model ?? undefined;
    this.emit("stats", { ...this._stats });
  }

  setModelOptions(modelOptions: ProviderModelOptions): void {
    this._modelOptions = { ...this._modelOptions, ...modelOptions };
  }

  setRuntimeMode(mode: ProviderRuntimeMode): void {
    if (
      mode !== "approval-required" &&
      mode !== "full-access" &&
      mode !== "plan" &&
      mode !== "writes-only"
    ) {
      this.logger.warn(`[CodexAppServer] Unknown runtime mode: ${mode}`);
      return;
    }
    this._runtimeMode = mode;
    // When switching to full-access, auto-accept any pending approval prompts
    // so the session doesn't stay blocked. Plan mode is handled at turn boundaries.
    if (mode === "full-access") {
      for (const [requestId, pending] of this.pendingRequests) {
        if (pending.kind !== "approval") continue;
        this.pendingRequests.delete(requestId);
        if (pending.rpcId !== undefined) {
          this.sendRpcResponse(pending.rpcId, { decision: "accept" });
        }
      }
    }
  }

  respondToRequest(
    requestId: string,
    decision: "accept" | "decline",
    response?: ProviderRequestResponse,
  ): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;

    this.pendingRequests.delete(requestId);

    if (pending.kind === "user_input") {
      const answers = decision === "accept" ? { ...(response?.answers ?? {}) } : {};
      const authored = decision === "accept" ? response?.text?.trim() : undefined;
      if (Object.keys(answers).length === 0 && authored) {
        const questions = Array.isArray((pending.params as RequestUserInputParams).questions)
          ? (pending.params as RequestUserInputParams).questions
          : [];
        const firstQuestionId = questions.find((question) => typeof question.id === "string")?.id;
        if (firstQuestionId) answers[firstQuestionId] = { answers: [authored] };
      }
      const hasAnswers = Object.keys(answers).length > 0;
      if (pending.rpcId !== undefined) {
        this.sendRpcResponse(pending.rpcId, { answers });
      }
      this.emit("activity", {
        type: "activity",
        activity: "tool_result",
        tool: "AskUserQuestion",
        description: "Tool completed",
        resolution: hasAnswers ? "approved" : "dismissed",
        input: {
          requestId,
        },
      } as ActivityMessage);
      return true;
    }

    if (pending.kind === "terminal_input") {
      const text = decision === "accept" ? (response?.text?.trim() ?? "") : "";
      if (pending.rpcId !== undefined) {
        this.sendRpcResponse(pending.rpcId, { text });
      } else if (decision === "accept" && text) {
        const itemId = getString((pending.params as TerminalInteractionParams).itemId);
        this.emit("activity", {
          type: "activity",
          activity: "tool_result",
          tool: "Bash",
          description: "Terminal input sent",
          detail: text,
          input: {
            requestId,
            itemId,
            text,
          },
        } as ActivityMessage);
      }
      return true;
    }

    const responseResult = { decision: decision === "accept" ? "accept" : "decline" };
    if (pending.rpcId !== undefined) {
      this.sendRpcResponse(pending.rpcId, responseResult);
    }
    return true;
  }

  // ===========================================================================
  // Process lifecycle
  // ===========================================================================

  private spawnAndInit(firstMessage: string): void {
    this._closingIntentionally = false;
    this.process = this.spawnProcess(this.codexPath, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      env: buildCodexSpawnEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.wireStdout(this.process.stdout);
    this.wireStderr(this.process.stderr);
    this.wireLifecycle(this.process);

    // Initialize, then start/resume thread, then start first turn
    this.initializeAndStartThread(firstMessage).catch((err) => {
      this.logger.error(`[CodexAppServer] Init failed: ${err}`);
      this.finishTurn();
      this.emitExit(1, String(err));
    });
  }

  private spawnAndCompact(): void {
    this._closingIntentionally = false;
    this.process = this.spawnProcess(this.codexPath, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      env: buildCodexSpawnEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.wireStdout(this.process.stdout);
    this.wireStderr(this.process.stderr);
    this.wireLifecycle(this.process);

    this.initializeAndCompactThread().catch((err) => {
      this.logger.error(`[CodexAppServer] Compact init failed: ${err}`);
      this.clearTimeout();
      this._isProcessing = false;
      this.emit("providerError", `Failed to compact context: ${err}`);
      this.emitExit(1, String(err));
    });
  }

  private async initializeAndStartThread(message: string): Promise<void> {
    // Step 1: Initialize
    await this.sendRpc("initialize", {
      clientInfo: { name: RELAY_CODEX_ORIGINATOR, version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.initialized = true;

    // Send "initialized" notification
    this.sendNotification("initialized");

    // Step 2: Start or resume thread
    if (this._sessionId) {
      this.logger.info(`[CodexAppServer] Resuming thread ${this._sessionId}`);
      const result = (await this.sendRpc("thread/resume", {
        threadId: this._sessionId,
        model: this._preferredModel ?? undefined,
        cwd: this.cwd,
        approvalPolicy: this.resolveApprovalPolicy(),
        sandbox: this.resolveSandboxMode(),
        persistExtendedHistory: true,
        ...this.resolveCodexModelParams(),
      })) as { thread?: ThreadInfo };
      if (result?.thread?.id) {
        this._sessionId = result.thread.id;
      }
      if (result?.thread?.path) {
        this._transcriptPath = result.thread.path;
      }
      this.emitSessionInitEvent(result);
    } else {
      const result = (await this.sendRpc("thread/start", {
        model: this._preferredModel ?? undefined,
        cwd: this.cwd,
        baseInstructions: this.bootstrapContext?.baseInstructions ?? undefined,
        developerInstructions: this.bootstrapContext?.developerInstructions ?? undefined,
        approvalPolicy: this.resolveApprovalPolicy(),
        sandbox: this.resolveSandboxMode(),
        experimentalRawEvents: false,
        persistExtendedHistory: true,
        ...this.resolveCodexModelParams(),
      })) as { thread?: ThreadInfo };
      if (result?.thread?.id) {
        this._sessionId = result.thread.id;
      }
      if (result?.thread?.path) {
        this._transcriptPath = result.thread.path;
      }
      this.emitSessionInitEvent(result);
    }

    this.requestStartupSnapshots();

    // Step 3: Start first turn
    this.startTurn(message);
  }

  private async initializeAndCompactThread(): Promise<void> {
    await this.sendRpc("initialize", {
      clientInfo: { name: RELAY_CODEX_ORIGINATOR, version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.initialized = true;

    this.sendNotification("initialized");

    if (this._sessionId) {
      this.logger.info(`[CodexAppServer] Resuming thread ${this._sessionId} for compaction`);
      const result = (await this.sendRpc("thread/resume", {
        threadId: this._sessionId,
        model: this._preferredModel ?? undefined,
        cwd: this.cwd,
        approvalPolicy: this.resolveApprovalPolicy(),
        sandbox: this.resolveSandboxMode(),
        persistExtendedHistory: true,
        ...this.resolveCodexModelParams(),
      })) as { thread?: ThreadInfo };
      if (result?.thread?.id) {
        this._sessionId = result.thread.id;
      }
      if (result?.thread?.path) {
        this._transcriptPath = result.thread.path;
      }
    }

    this.requestStartupSnapshots();

    this.startCompaction();
  }

  private requestStartupSnapshots(): void {
    void this.sendRpc("mcpServerStatus/list", {})
      .then((result) => {
        const mcpServers = normalizeMcpServerStatusSnapshot(result);
        if (!mcpServers) return;
        this.emit("systemEvent", {
          type: "system_event",
          event: "provider_status",
          payload: { mcpServers },
        } as SystemEventMessage);
      })
      .catch((err) => {
        this.logger.debug(`[CodexAppServer] mcpServerStatus/list snapshot unavailable: ${err}`);
      });

    void this.sendRpc("app/list", {})
      .then((result) => {
        const payload = asRecord(result);
        const apps = getStringArray(payload?.apps ?? payload?.items ?? result);
        if (!apps?.length) return;
        this.emit("systemEvent", {
          type: "system_event",
          event: "provider_status",
          payload: { apps },
        } as SystemEventMessage);
      })
      .catch((err) => {
        this.logger.debug(`[CodexAppServer] app/list snapshot unavailable: ${err}`);
      });

    void this.sendRpc("skills/list", { cwds: [this.cwd] })
      .then((result) => {
        const skills = normalizeCodexSkillsSnapshot(result, this.cwd);
        if (!skills?.length) return;
        this.emit("systemEvent", {
          type: "system_event",
          event: "provider_status",
          payload: { skills },
        } as SystemEventMessage);
      })
      .catch((err) => {
        this.logger.debug(`[CodexAppServer] skills/list snapshot unavailable: ${err}`);
      });

    void this.sendRpc("account/read", { refreshToken: false })
      .then((result) => {
        const account = normalizeCodexAccountSnapshot(result);
        if (account) {
          this.emit("systemEvent", {
            type: "system_event",
            event: "provider_status",
            payload: { account },
          } as SystemEventMessage);
        }
      })
      .catch((err) => {
        this.logger.debug(`[CodexAppServer] account/read snapshot unavailable: ${err}`);
      });

    void this.sendRpc("account/rateLimits/read", undefined)
      .then((result) => {
        const rateLimits = normalizeCodexRateLimitsSnapshot(result);
        if (!rateLimits?.length) return;
        this.emit("systemEvent", {
          type: "system_event",
          event: "provider_status",
          payload: {
            account: {
              rateLimits,
            },
          },
        } as SystemEventMessage);
      })
      .catch((err) => {
        this.logger.debug(`[CodexAppServer] account/rateLimits/read snapshot unavailable: ${err}`);
      });
  }

  private startTurn(message: string): void {
    if (!this._sessionId) {
      this.logger.error("[CodexAppServer] No thread ID, can't start turn");
      this.finishTurn();
      return;
    }

    this.sendRpc("turn/start", {
      threadId: this._sessionId,
      input: [{ type: "text", text: message, text_elements: [] }],
      model: this._preferredModel ?? undefined,
      approvalPolicy: this.resolveApprovalPolicy(),
      collaborationMode: {
        mode: this._runtimeMode === "plan" ? "plan" : "default",
        settings: {
          model: this.resolveCollaborationModel(),
        },
      },
      ...this.resolveCodexModelParams(),
    }).catch((err) => {
      this.logger.error(`[CodexAppServer] turn/start failed: ${err}`);
      this.finishTurn();
    });
  }

  private startCompaction(): void {
    if (!this._sessionId) {
      this.clearTimeout();
      this._isProcessing = false;
      this.emit("providerError", "Cannot compact before the Codex thread has started.");
      return;
    }

    this.sendRpc("thread/compact/start", {
      threadId: this._sessionId,
    }).catch((err) => {
      this.clearTimeout();
      this._isProcessing = false;
      this.logger.warn(`[CodexAppServer] thread/compact/start failed: ${err}`);
      this.emit("providerError", `Failed to compact context: ${err}`);
    });
  }

  private resolveCollaborationModel(): string {
    return (
      this._preferredModel ??
      resolveProviderDefaultModelOption("codex", getCachedCodexModels() ?? undefined)?.id ??
      "gpt-5.4"
    );
  }

  /** Map canonical ReasoningEffort to Codex-native effort string. */
  private resolveCodexEffort(): string | undefined {
    const effort = this._modelOptions.reasoningEffort;
    if (!effort) return undefined;
    // Canonical Relay values → Codex-native
    const mapping: Record<string, string> = {
      low: "low",
      medium: "medium",
      high: "high",
      max: "xhigh",
    };
    // Known canonical mapping first, then pass through as-is (handles restored
    // Codex-native values like "xhigh" that survived round-trip via persistence).
    return mapping[effort] ?? effort;
  }

  /** Build Codex-specific model option params for thread/start and turn/start RPC. */
  private resolveCodexModelParams(): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    const effort = this.resolveCodexEffort();
    if (effort) params.reasoning_effort = effort;
    if (this._modelOptions.fastMode != null)
      params.service_tier = this._modelOptions.fastMode ? "flex" : "default";
    return params;
  }

  // ===========================================================================
  // JSON-RPC transport
  // ===========================================================================

  private sendRpc(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const stdin = this.process?.stdin;
      if (!stdin?.writable) {
        reject(new Error("Process stdin not writable"));
        return;
      }

      const id = this.nextRpcId++;
      this.pendingRpcResponses.set(id, { resolve, reject });

      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      stdin.write(JSON.stringify(request) + "\n");
    });
  }

  private sendRpcResponse(id: number | string, result: unknown): void {
    const stdin = this.process?.stdin;
    if (!stdin?.writable) return;
    const response = { jsonrpc: "2.0", id, result };
    stdin.write(JSON.stringify(response) + "\n");
  }

  private sendNotification(method: string, params?: unknown): void {
    const stdin = this.process?.stdin;
    if (!stdin?.writable) return;
    const notification: { jsonrpc: "2.0"; method: string; params?: unknown } = {
      jsonrpc: "2.0",
      method,
    };
    if (params !== undefined) notification.params = params;
    stdin.write(JSON.stringify(notification) + "\n");
  }

  // ===========================================================================
  // Stream parsing
  // ===========================================================================

  private wireStdout(stream: Readable | null): void {
    if (!stream) return;
    stream.on("data", (chunk: Buffer | string) => {
      this.noteProcessActivity();
      this.lineBuffer += chunk.toString();
      let idx = this.lineBuffer.indexOf("\n");
      while (idx !== -1) {
        const line = this.lineBuffer.slice(0, idx).trim();
        this.lineBuffer = this.lineBuffer.slice(idx + 1);
        if (line) this.handleLine(line);
        idx = this.lineBuffer.indexOf("\n");
      }
    });
  }

  private wireStderr(stream: Readable | null): void {
    if (!stream) return;
    stream.on("data", (chunk: Buffer | string) => {
      this.noteProcessActivity();
      const text = chunk.toString();
      this.stderrBuffer += text;
      if (this.stderrBuffer.length > 4000) {
        this.stderrBuffer = this.stderrBuffer.slice(-4000);
      }
      this.logger.debug(`[CodexAppServer] stderr: ${text.trim()}`);
    });
  }

  private wireLifecycle(child: ChildProcess): void {
    child.on("close", (code, signal) => {
      this.clearTimeout();
      const wasProcessing = this._isProcessing;
      this.process = null;
      this.initialized = false;

      if (wasProcessing) {
        this.finishTurn();
      }

      // Reject pending RPCs
      for (const [, pending] of this.pendingRpcResponses) {
        pending.reject(new Error(`Process exited (${code ?? signal})`));
      }
      this.pendingRpcResponses.clear();
      this.pendingRequests.clear();

      if (!this._closingIntentionally) {
        this.emitExit(code ?? 1, signal ?? undefined);
      }
    });

    child.on("error", (err) => {
      this.clearTimeout();
      this.process = null;
      this._isProcessing = false;
      this.initialized = false;
      this.emitExit(1, String(err));
    });

    // Swallow stdin EPIPE: if the app-server dies mid-write the writable stream
    // emits 'error', which would otherwise crash the process as an
    // uncaughtException. The 'close' handler above drives the real lifecycle.
    child.stdin?.on("error", (err) => {
      this.logger.debug?.(`[CodexAppServer] stdin error (non-fatal): ${err}`);
    });
  }

  private handleLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.logger.debug(`[CodexAppServer] Non-JSON line: ${line}`);
      return;
    }

    // Response to our request
    if ("id" in msg && msg.id !== undefined && !("method" in msg)) {
      this.handleRpcResponse(msg as JsonRpcResponse);
      return;
    }

    // Server request (has both id and method — needs a response from us)
    if ("id" in msg && msg.id !== undefined && "method" in msg) {
      this.handleServerRequest(msg as JsonRpcServerRequest);
      return;
    }

    // Notification (no id, has method)
    if ("method" in msg) {
      this.handleNotification(msg as JsonRpcNotification);
    }
  }

  private handleRpcResponse(msg: JsonRpcResponse): void {
    const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
    const pending = this.pendingRpcResponses.get(id);
    if (!pending) return;
    this.pendingRpcResponses.delete(id);

    if (msg.error) {
      pending.reject(new Error(msg.error.message ?? `RPC error ${msg.error.code ?? "unknown"}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  // ===========================================================================
  // Server requests (approval flow)
  // ===========================================================================

  private handleServerRequest(msg: JsonRpcServerRequest): void {
    const params = msg.params as Record<string, unknown>;

    switch (msg.method) {
      case "item/commandExecution/requestApproval": {
        const requestId = `codex-approval-${msg.id}`;
        this.pendingRequests.set(requestId, {
          kind: "approval",
          method: msg.method,
          params,
          rpcId: msg.id,
        });

        // If bypass mode, auto-approve
        if (this._runtimeMode === "full-access") {
          this.respondToRequest(requestId, "accept");
          return;
        }

        const command = (params.command as string) ?? "unknown command";
        const request: ProviderRequest = {
          requestId,
          kind: "approval",
          category: "command",
          source: "command",
          tool: "Bash",
          description: command,
          command,
          cwd: getString(params.cwd),
          raw: params,
        };
        this.emit("permissionRequest", request);

        // Also emit as activity so the UI knows an approval is needed
        this.emit("activity", {
          type: "activity",
          activity: "tool_use",
          tool: "Bash",
          description: `Requesting approval: ${command}`,
          detail: command,
          input: { command },
          inputDescription: command,
        } as ActivityMessage);
        break;
      }

      case "item/fileChange/requestApproval": {
        const requestId = `codex-approval-${msg.id}`;
        this.pendingRequests.set(requestId, {
          kind: "approval",
          method: msg.method,
          params,
          rpcId: msg.id,
        });

        if (this._runtimeMode === "full-access") {
          this.respondToRequest(requestId, "accept");
          return;
        }

        const reason = (params.reason as string) ?? "File change";
        const request: ProviderRequest = {
          requestId,
          kind: "approval",
          category: "file_change",
          source: "agent",
          tool: "Edit",
          description: reason,
          reason,
          files: getStringArray(params.files),
          raw: params,
        };
        this.emit("permissionRequest", request);
        break;
      }

      case "item/permissions/requestApproval": {
        const requestId = `codex-approval-${msg.id}`;
        this.pendingRequests.set(requestId, {
          kind: "approval",
          method: msg.method,
          params,
          rpcId: msg.id,
        });

        if (this._runtimeMode === "full-access") {
          this.respondToRequest(requestId, "accept");
          return;
        }

        this.emit("permissionRequest", {
          requestId,
          kind: "approval",
          category: "generic",
          source: "provider",
          tool: getString(params.tool) ?? getString(params.permission) ?? "Permissions",
          description: buildRequestDescription(params) ?? "Permission request",
          command: getString(params.command),
          cwd: getString(params.cwd),
          reason: getString(params.reason),
          files: getStringArray(params.files),
          raw: params,
        } satisfies ProviderRequest);
        break;
      }

      // Legacy approval methods
      case "applyPatchApproval": {
        const requestId = `codex-approval-${msg.id}`;
        this.pendingRequests.set(requestId, {
          kind: "approval",
          method: msg.method,
          params,
          rpcId: msg.id,
        });

        if (this._runtimeMode === "full-access") {
          this.respondToRequest(requestId, "accept");
          return;
        }

        const request: ProviderRequest = {
          requestId,
          kind: "approval",
          category: "file_change",
          source: "provider",
          tool: "Edit",
          description: "Apply patch",
          raw: params,
        };
        this.emit("permissionRequest", request);
        break;
      }

      case "execCommandApproval": {
        const requestId = `codex-approval-${msg.id}`;
        this.pendingRequests.set(requestId, {
          kind: "approval",
          method: msg.method,
          params,
          rpcId: msg.id,
        });

        if (this._runtimeMode === "full-access") {
          this.respondToRequest(requestId, "accept");
          return;
        }

        const cmd = (params.command as string) ?? "unknown";
        const request: ProviderRequest = {
          requestId,
          kind: "approval",
          category: "command",
          source: "command",
          tool: "Bash",
          description: cmd,
          command: cmd,
          cwd: getString(params.cwd),
          raw: params,
        };
        this.emit("permissionRequest", request);
        break;
      }

      case "item/tool/requestUserInput": {
        const requestParams = msg.params as unknown as RequestUserInputParams;
        const questions = Array.isArray(requestParams.questions) ? requestParams.questions : [];
        const requestId = `codex-input-${requestParams.itemId || msg.id}`;

        this.pendingRequests.set(requestId, {
          kind: "user_input",
          method: msg.method,
          params: requestParams,
          rpcId: msg.id,
        });

        this.emit("permissionRequest", {
          requestId,
          kind: "user_input",
          source: "agent",
          tool: "AskUserQuestion",
          description: questions[0]?.question,
          questions,
          raw: requestParams as unknown as Record<string, unknown>,
        } as ProviderRequest);
        this.emit("activity", {
          type: "activity",
          activity: "tool_use",
          tool: "AskUserQuestion",
          description: "Question",
          input: {
            requestId,
            questions,
          },
          inputDescription: questions[0]?.question,
        } as ActivityMessage);
        break;
      }

      case "mcpServer/elicitation/request": {
        const requestId = `codex-input-${msg.id}`;
        const prompt = getString(params.prompt) ?? buildRequestDescription(params);
        const providedQuestions = Array.isArray(params.questions)
          ? (params.questions as UserInputQuestion[])
          : undefined;
        const questions =
          providedQuestions && providedQuestions.length > 0
            ? providedQuestions
            : prompt
              ? ([
                  {
                    id: "response",
                    header: "Input",
                    question: prompt,
                    isOther: true,
                    isSecret: Boolean(params.secret ?? params.isSecret),
                  },
                ] satisfies UserInputQuestion[])
              : undefined;

        this.pendingRequests.set(requestId, {
          kind: "user_input",
          method: msg.method,
          params,
          rpcId: msg.id,
        });

        this.emit("permissionRequest", {
          requestId,
          kind: "user_input",
          category: "generic",
          source: "mcp",
          tool: "MCP",
          server: getString(params.server),
          description: prompt ?? "MCP server needs input",
          prompt,
          questions,
          raw: params,
        } satisfies ProviderRequest);
        break;
      }

      default:
        // Unknown server request — respond with error
        this.logger.warn(`[CodexAppServer] Unknown server request: ${msg.method}`);
        this.sendRpcResponse(msg.id, null);
        break;
    }
  }

  // ===========================================================================
  // Notifications
  // ===========================================================================

  private handleNotification(msg: JsonRpcNotification): void {
    const params = msg.params as Record<string, unknown>;

    switch (msg.method) {
      // -----------------------------------------------------------------------
      // Thread lifecycle
      // -----------------------------------------------------------------------
      case "thread/started": {
        const thread = params.thread as ThreadInfo | undefined;
        if (thread?.id) {
          this._sessionId = thread.id;
        }
        if (thread?.path) {
          this._transcriptPath = thread.path;
        }
        break;
      }

      case "thread/closed":
        if (this._isProcessing) this.finishTurn();
        this.emitExit(0);
        break;

      case "thread/status/changed":
        this.emit("systemEvent", {
          type: "system_event",
          event: "provider_status",
          payload: {
            threadStatus: getString(params.status),
            threadId: this._sessionId,
          },
          raw: msg,
        } as SystemEventMessage);
        break;

      case "thread/name/updated": {
        const name = typeof params.name === "string" ? params.name.trim() : "";
        if (name) {
          this.emit("titleUpdate", name);
        }
        break;
      }

      // -----------------------------------------------------------------------
      // Turn lifecycle
      // -----------------------------------------------------------------------
      case "turn/started": {
        const turn = params.turn as TurnInfo | undefined;
        if (turn?.id) {
          this._currentTurnId = turn.id;
        }
        this.emit("systemEvent", {
          type: "system_event",
          event: "provider_status",
          payload: {
            turnStatus: turn?.status ?? "inProgress",
            turnId: turn?.id,
          },
          raw: msg,
        } as SystemEventMessage);
        break;
      }

      case "turn/completed": {
        const turn = params.turn as TurnInfo | undefined;
        this._currentTurnId = null;
        this.emit("systemEvent", {
          type: "system_event",
          event: "provider_status",
          payload: {
            turnStatus: turn?.status ?? "completed",
            turnId: turn?.id,
          },
          raw: msg,
        } as SystemEventMessage);
        this.finishTurn(params);
        break;
      }

      case "turn/plan/updated": {
        const activity = buildTaskListActivityFromPlan({
          explanation: typeof params.explanation === "string" ? params.explanation : undefined,
          plan: Array.isArray(params.plan) ? params.plan : [],
        });
        if (activity) {
          this.emit("activity", activity);
        }
        break;
      }

      // -----------------------------------------------------------------------
      // Streaming text
      // -----------------------------------------------------------------------
      case "item/agentMessage/delta": {
        const delta = params.delta as string;
        if (delta) {
          for (const message of this.proposedPlanParser.push(delta, params)) {
            if (message.type === "output") {
              this.emit("output", message as OutputMessage);
            } else {
              this.emit("activity", message as ActivityMessage);
            }
          }
        }
        break;
      }

      case "item/plan/delta": {
        // Codex plan-mode streams plan content here instead of agentMessage/delta.
        // Accumulate silently — finishTurn wraps the buffer in <proposed_plan> tags
        // which triggers the plan-review UI via ExitPlanMode activity.
        const delta = (params.delta ?? params.text ?? "") as string;
        if (delta) {
          this._planDeltaBuffer += delta;
        }
        break;
      }

      // -----------------------------------------------------------------------
      // Item lifecycle (tool use / results)
      // -----------------------------------------------------------------------
      case "item/started": {
        const item = params.item as ThreadItem;
        this.handleItemStarted(item);
        break;
      }

      case "item/completed": {
        const item = params.item as ThreadItem;
        this.handleItemCompleted(item);
        break;
      }

      // -----------------------------------------------------------------------
      // Streaming tool output
      // -----------------------------------------------------------------------
      case "item/commandExecution/outputDelta": {
        // We could emit incremental Bash output here if we wanted to show
        // live command output. For now we rely on item/completed for the
        // aggregated output.
        break;
      }

      case "item/commandExecution/terminalInteraction": {
        const terminal = params as TerminalInteractionParams;
        const itemId = getString(terminal.itemId) ?? `${this._currentTurnId ?? "turn"}-terminal`;
        const prompt = getString(terminal.prompt) ?? getString(terminal.text);
        if (!prompt) break;
        const requestId = `codex-terminal-${itemId}`;
        this.pendingRequests.set(requestId, {
          kind: "terminal_input",
          method: msg.method,
          params: terminal,
        });
        this.emit("permissionRequest", {
          requestId,
          kind: "terminal_input",
          category: "command",
          source: "command",
          tool: "Bash",
          description: prompt,
          prompt,
          command: getString(terminal.command),
          cwd: getString(terminal.cwd),
          raw: terminal,
        } satisfies ProviderRequest);
        this.emit("activity", {
          type: "activity",
          activity: "tool_use",
          tool: "Bash",
          description: "Terminal interaction required",
          detail: prompt,
          input: {
            requestId,
            prompt,
            command: getString(terminal.command),
            cwd: getString(terminal.cwd),
          },
          raw: terminal,
        } as ActivityMessage);
        break;
      }

      case "item/fileChange/outputDelta": {
        // Similarly, patch output deltas — we track completed file changes
        break;
      }

      case "item/mcpToolCall/progress": {
        const server = getString(params.server) ?? getString(params.mcpServer) ?? "MCP";
        const tool = getString(params.tool) ?? "tool";
        const progress =
          getString(params.message) ?? getString(params.status) ?? getString(params.detail);
        this.emit("activity", {
          type: "activity",
          activity: "tool_use",
          tool,
          description: `${server}/${tool}${progress ? `: ${progress}` : ""}`,
          detail: progress,
          raw: msg,
        } as ActivityMessage);
        break;
      }

      // -----------------------------------------------------------------------
      // Reasoning
      // -----------------------------------------------------------------------
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/summaryPartAdded":
        // Extended thinking — we could emit these as activity if desired
        break;

      case "rawResponseItem/completed": {
        const turnId =
          (typeof params.turnId === "string" ? params.turnId : undefined) ?? this._currentTurnId;
        const item = params.item as ContextCompactionItem | undefined;
        if (turnId && item?.type === "compaction") {
          this.emitCompactionEvent(turnId, params);
        }
        break;
      }

      case "thread/compacted": {
        const turnId =
          (typeof params.turnId === "string" ? params.turnId : undefined) ?? this._currentTurnId;
        if (turnId) {
          this.emitCompactionEvent(turnId, params);
        }
        break;
      }

      // -----------------------------------------------------------------------
      // Token usage
      // -----------------------------------------------------------------------
      case "thread/tokenUsage/updated": {
        const usage = getRecord(params.tokenUsage) ?? getRecord(params.token_usage);
        const total = getRecord(usage?.total) ?? getRecord(usage?.total_token_usage);
        const last = getRecord(usage?.last) ?? getRecord(usage?.last_token_usage);
        let updated = false;

        if (total) {
          const inputTokens = getNumber(total.inputTokens) ?? getNumber(total.input_tokens);
          const cachedInputTokens =
            getNumber(total.cachedInputTokens) ?? getNumber(total.cached_input_tokens);
          const outputTokens = getNumber(total.outputTokens) ?? getNumber(total.output_tokens);
          const reasoningTokens =
            getNumber(total.reasoningOutputTokens) ?? getNumber(total.reasoning_output_tokens);

          if (inputTokens !== undefined) {
            this._stats.inputTokens = inputTokens;
            updated = true;
          }
          if (cachedInputTokens !== undefined) {
            this._stats.cacheReadTokens = cachedInputTokens;
            updated = true;
          }
          if (outputTokens !== undefined) {
            this._stats.outputTokens = outputTokens;
            updated = true;
          }
          if (reasoningTokens !== undefined) {
            this._stats.reasoningTokens = reasoningTokens;
            updated = true;
          }
        }

        if (last) {
          const totalTokens = getNumber(last.totalTokens) ?? getNumber(last.total_tokens);
          const inputTokens = getNumber(last.inputTokens) ?? getNumber(last.input_tokens);
          const cachedInputTokens =
            getNumber(last.cachedInputTokens) ?? getNumber(last.cached_input_tokens);
          const contextTokens =
            totalTokens ??
            (inputTokens !== undefined ? inputTokens + (cachedInputTokens ?? 0) : undefined);
          if (contextTokens !== undefined) {
            this._stats.contextTokens = contextTokens;
            updated = true;
          }
        }

        const contextWindow =
          getNumber(usage?.modelContextWindow) ?? getNumber(usage?.model_context_window);
        if (contextWindow !== undefined) {
          this._stats.contextWindow = contextWindow;
          updated = true;
        }

        if (updated) {
          this.emit("stats", { ...this._stats });
        }
        break;
      }

      case "turn/diff/updated": {
        this.emit("systemEvent", {
          type: "system_event",
          event: "provider_status",
          payload: {
            diff: buildDiffStatus(params),
          },
          raw: msg,
        } as SystemEventMessage);
        break;
      }

      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed": {
        this.emit("systemEvent", {
          type: "system_event",
          event: "provider_status",
          payload: {
            source: msg.method,
            ...params,
          },
          raw: msg,
        } as SystemEventMessage);
        break;
      }

      case "mcpServerStatus/list": {
        this.emit("systemEvent", {
          type: "system_event",
          event: "provider_status",
          payload: {
            mcpServers: normalizeMcpServerStatusSnapshot(params),
          },
          raw: msg,
        } as SystemEventMessage);
        break;
      }

      case "mcpServer/oauthLogin/completed": {
        const notice = buildProviderNotice("info", "global", msg.method, params) ?? {
          level: "info",
          scope: "global",
          source: msg.method,
          message: `MCP login completed for ${getString(params.server) ?? "server"}`,
        };
        this.emit("systemEvent", {
          type: "system_event",
          event: "provider_notice",
          payload: notice as unknown as Record<string, unknown>,
          raw: msg,
        } as SystemEventMessage);
        break;
      }

      case "account/updated":
      case "account/rateLimits/updated": {
        const account = buildAccountStatus(params);
        if (!account) break;
        this.emit("systemEvent", {
          type: "system_event",
          event: "provider_status",
          payload: {
            account,
          },
          raw: msg,
        } as SystemEventMessage);
        break;
      }

      case "app/list/updated": {
        const apps = getStringArray(params.apps ?? params.items);
        this.emit("systemEvent", {
          type: "system_event",
          event: "provider_status",
          payload: {
            apps,
          },
          raw: msg,
        } as SystemEventMessage);
        break;
      }

      // -----------------------------------------------------------------------
      // Errors
      // -----------------------------------------------------------------------
      case "error": {
        const error = params.error as { message?: string } | undefined;
        const willRetry = params.willRetry as boolean | undefined;
        const errorMessage = error?.message ?? "unknown";
        if (!willRetry) {
          this.logger.error(`[CodexAppServer] Error: ${errorMessage}`);
          this.emit("providerError", errorMessage);
        }
        break;
      }

      // -----------------------------------------------------------------------
      // Approval resolved (server tells us an approval was auto-resolved)
      // -----------------------------------------------------------------------
      case "serverRequest/resolved": {
        const resolvedId = params.requestId as string | number | undefined;
        if (resolvedId !== undefined) {
          this.pendingRequests.delete(`codex-approval-${resolvedId}`);
          this.pendingRequests.delete(`codex-input-${resolvedId}`);
          this.pendingRequests.delete(`codex-terminal-${resolvedId}`);
        }
        break;
      }

      case "model/rerouted": {
        this.emit("systemEvent", {
          type: "system_event",
          event: "model_rerouted",
          payload: {
            requestedModel: getString(params.requestedModel) ?? this._preferredModel ?? undefined,
            effectiveModel: getString(params.effectiveModel) ?? getString(params.model),
            reroutedFromModel:
              getString(params.reroutedFromModel) ?? getString(params.requestedModel),
            message: getString(params.message),
          },
          raw: msg,
        } as SystemEventMessage);
        break;
      }

      case "configWarning":
      case "deprecationNotice": {
        const notice = buildProviderNotice("warning", "global", msg.method, params);
        if (!notice) break;
        this.emit("systemEvent", {
          type: "system_event",
          event: "provider_notice",
          payload: notice as unknown as Record<string, unknown>,
          raw: msg,
        } as SystemEventMessage);
        break;
      }

      default:
        this.logger.debug(`[CodexAppServer] Notification: ${msg.method}`);
        break;
    }
  }

  // ===========================================================================
  // Item handling
  // ===========================================================================

  private handleItemStarted(item: ThreadItem): void {
    if (!item) return;

    switch (item.type) {
      case "commandExecution": {
        const cmd = (item as CommandExecutionItem).command;
        this.emit("activity", {
          type: "activity",
          activity: "tool_use",
          tool: "Bash",
          description: `Running command: ${cmd}`,
          detail: cmd,
          input: { command: cmd },
          inputDescription: cmd,
          raw: item,
        } as ActivityMessage);
        break;
      }

      case "fileChange": {
        // Emit one activity per file so the shape matches Claude's Edit tool:
        // flat input with file_path, additions, deletions, extension, etc.
        const changes = (item as FileChangeItem).changes;
        for (const change of changes) {
          const fileName = change.path.split("/").pop() || change.path;
          const tool = change.kind.type === "add" ? "Write" : "Edit";
          const commonInput = {
            file_path: change.path,
            extension: extFromPath(change.path),
            kind: change.kind.type,
            movePath:
              change.kind.type === "update" && change.kind.move_path
                ? change.kind.move_path
                : undefined,
            ...countDiffLines(change.diff),
          };
          const activityInput =
            tool === "Write"
              ? {
                  ...commonInput,
                  content: extractAddedFileContent(change.diff),
                }
              : ({
                  ...commonInput,
                  diff: change.diff,
                } satisfies EditToolInput);
          this.emit("activity", {
            type: "activity",
            activity: "tool_use",
            tool,
            description: tool === "Write" ? "Writing file" : "Editing file",
            detail: change.path,
            input: activityInput as Record<string, unknown>,
            inputDescription: fileName,
            raw: item,
          } as ActivityMessage);
        }
        break;
      }

      case "mcpToolCall": {
        const mcp = item as McpToolCallItem;
        this.emit("activity", {
          type: "activity",
          activity: "tool_use",
          tool: mcp.tool,
          description: `Using ${mcp.server}/${mcp.tool}`,
          mcp: {
            serverId: mcpServerId("codex", mcp.server),
            serverName: mcp.server,
            toolName: mcp.tool,
            callId: mcp.id,
            durationMs: mcp.durationMs ?? undefined,
          },
          raw: item,
        } as ActivityMessage);
        break;
      }

      case "dynamicToolCall": {
        const dyn = item as DynamicToolCallItem;
        if (dyn.tool === "request_user_input") break;
        if (dyn.tool === "view_image") {
          const path = extractViewImagePath(dyn.arguments);
          const fileName = path ? path.split("/").pop() || path : undefined;
          this.emit("activity", {
            type: "activity",
            activity: "tool_use",
            tool: "ViewImage",
            description: "Viewing image",
            detail: path,
            input: path ? { file_path: path } : undefined,
            inputDescription: fileName,
            raw: item,
          } as ActivityMessage);
          break;
        }
        this.emit("activity", {
          type: "activity",
          activity: "tool_use",
          tool: dyn.tool,
          description: `Using ${dyn.tool}`,
          raw: item,
        } as ActivityMessage);
        break;
      }

      default:
        break;
    }
  }

  private handleItemCompleted(item: ThreadItem): void {
    if (!item) return;

    switch (item.type) {
      case "agentMessage": {
        // Full message on completion (delta already streamed it incrementally).
        // No need to re-emit — the deltas already provided the text.
        break;
      }

      case "commandExecution": {
        const cmd = item as CommandExecutionItem;
        const outputText = cmd.aggregatedOutput?.trim();
        const status =
          cmd.exitCode === 0 || cmd.status === "completed" ? "Command completed" : "Command failed";

        this.emit("activity", {
          type: "activity",
          activity: "tool_result",
          tool: "Bash",
          description: status,
          detail: outputText || cmd.command,
          input: { command: cmd.command, exitCode: cmd.exitCode ?? undefined },
          inputDescription: cmd.command,
          raw: item,
        } as ActivityMessage);
        break;
      }

      case "fileChange": {
        const fc = item as FileChangeItem;
        for (const change of fc.changes) {
          const changeType = change.kind.type === "add" ? "added" : "edited";
          trackFileChange(this.fileMap, this.cwd, change.path, changeType);
        }

        if (this.fileMap.size > 0) {
          this.emit("activity", {
            type: "activity",
            activity: "file_list",
            description: "Files changed",
            files: Array.from(this.fileMap.values()).map((f) => ({ ...f })),
          } as ActivityMessage);
        }

        const detail = fc.status === "completed" ? "Patch applied" : `Patch ${fc.status}`;
        this.emit("activity", {
          type: "activity",
          activity: "tool_result",
          tool: "Edit",
          description: "Tool completed",
          detail,
          raw: item,
        } as ActivityMessage);
        break;
      }

      case "imageGeneration": {
        // Codex saves the generated PNG under ~/.codex/generated_images and reports
        // its path. Surface it as a GenerateImage tool activity (rendered as its own
        // card with a thumbnail) — matches transcript replay.
        const path = extractGeneratedImagePath(item);
        if (path) {
          const fileName = path.split("/").pop() || path;
          this.emit("activity", {
            type: "activity",
            activity: "tool_use",
            tool: "GenerateImage",
            description: "Generated image",
            detail: path,
            input: { file_path: path },
            inputDescription: fileName,
            raw: item,
          } as ActivityMessage);
        }
        break;
      }

      case "mcpToolCall": {
        const mcp = item as McpToolCallItem;
        this.emit("activity", {
          type: "activity",
          activity: "tool_result",
          tool: mcp.tool,
          description: `${mcp.server}/${mcp.tool} completed`,
          mcp: {
            serverId: mcpServerId("codex", mcp.server),
            serverName: mcp.server,
            toolName: mcp.tool,
            callId: mcp.id,
            durationMs: mcp.durationMs ?? undefined,
          },
          raw: item,
        } as ActivityMessage);
        break;
      }

      case "dynamicToolCall": {
        const dyn = item as DynamicToolCallItem;
        if (dyn.tool === "request_user_input") break;
        if (dyn.tool === "view_image") {
          const path = extractViewImagePath(dyn.arguments);
          this.emit("activity", {
            type: "activity",
            activity: "tool_result",
            tool: "ViewImage",
            description: "Image loaded",
            detail: path,
            input: path ? { file_path: path } : undefined,
            raw: item,
          } as ActivityMessage);
          break;
        }
        this.emit("activity", {
          type: "activity",
          activity: "tool_result",
          tool: dyn.tool,
          description: `${dyn.tool} completed`,
          raw: item,
        } as ActivityMessage);
        break;
      }

      default:
        break;
    }
  }

  // ===========================================================================
  // Turn lifecycle
  // ===========================================================================

  private finishTurn(raw?: unknown): void {
    if (!this._isProcessing) return;
    this.clearTimeout();
    this._isProcessing = false;
    this._currentTurnId = null;

    // If plan deltas were accumulated, feed them as a <proposed_plan> block
    // so the parser emits an ExitPlanMode activity for the plan-review flow.
    const prePlanMessages: Array<OutputMessage | ActivityMessage> = [];
    if (this._planDeltaBuffer) {
      const planContent = this._planDeltaBuffer.trim();
      this._planDeltaBuffer = "";
      if (planContent && planContent !== this._lastEmittedPlan) {
        this.logger.info(
          `[CodexAppServer] finishTurn: wrapping ${planContent.length} chars of plan deltas as <proposed_plan>`,
        );
        this._lastEmittedPlan = planContent;
        prePlanMessages.push(
          ...this.proposedPlanParser.push(`<proposed_plan>${planContent}</proposed_plan>`, raw),
        );
      }
    }

    const planMessages = [...prePlanMessages, ...this.proposedPlanParser.finish(raw)];
    for (const message of planMessages) {
      if (message.type === "output") {
        this.emit("output", message as OutputMessage);
      } else {
        const act = message as ActivityMessage;
        if (act.tool === "ExitPlanMode") {
          this.logger.info("[CodexAppServer] finishTurn: emitting ExitPlanMode activity");
        }
        this.emit("activity", act);
      }
    }

    // Flush any message that was queued while processing
    if (this._pendingMessage) {
      const queued = this._pendingMessage;
      this._pendingMessage = null;
      this.send(queued);
    }
  }

  private emitCompactionEvent(turnId: string, raw?: unknown): void {
    if (this._lastCompactionTurnId === turnId) return;
    this._lastCompactionTurnId = turnId;
    this.emit("systemEvent", {
      type: "system_event",
      event: "compact_boundary",
      payload: {
        threadId: this._sessionId,
        turnId,
      },
      raw,
    } as SystemEventMessage);
  }

  private emitSessionInitEvent(raw?: unknown): void {
    this.emit(
      "systemEvent",
      buildSessionInitEvent(
        raw,
        {
          sessionId: this._sessionId,
          cwd: this.cwd,
          model: this._preferredModel ?? undefined,
        },
        "codex",
      ),
    );
  }

  private emitExit(code: number, stderrOrSignal?: string): void {
    const exit: ExitMessage = {
      type: "exit",
      code,
      signal: stderrOrSignal ?? undefined,
      stderr: this.stderrBuffer.trim() || undefined,
    };
    this.emit("exit", exit);
  }

  private hasWritableTransport(): boolean {
    return !!this.process?.stdin?.writable;
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private resolveApprovalPolicy(): string {
    if (this._runtimeMode === "full-access") return "never";
    if (this._runtimeMode === "writes-only") return "writes";
    // Plan and approval-required both use the same approval policy: let the
    // model decide when to escalate for approval. ("untrusted" would ask for
    // everything; "never" is reserved for full-access.) Note: Codex dropped the
    // old "on-failure" variant; valid values are untrusted/on-request/granular/never/writes.
    return "on-request";
  }

  private resolveSandboxMode(): string {
    if (this._runtimeMode === "full-access") return "danger-full-access";
    return "workspace-write";
  }

  private resetTimeout(): void {
    this.clearTimeout();
    if (this.processTimeout <= 0) return;
    this.timeoutHandle = setTimeout(() => {
      const child = this.process;
      if (!child) return;
      this.logger.warn(`[CodexAppServer] Timeout after ${this.processTimeout}ms`);
      // Seed stderr so the exit event carries a human-readable reason.
      // Do NOT flip _closingIntentionally — we want wireLifecycle to emit
      // the exit so the UI can move out of "working" into an error state.
      const reason = `Codex app-server went idle for ${Math.round(
        this.processTimeout / 1000,
      )}s and was terminated.`;
      this.stderrBuffer = (this.stderrBuffer ? this.stderrBuffer + "\n" : "") + reason;
      this.timeoutHandle = null;
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
    }, this.processTimeout);
  }

  private noteProcessActivity(): void {
    if (!this._isProcessing || this.processTimeout <= 0) return;
    this.resetTimeout();
  }

  private clearTimeout(): void {
    if (!this.timeoutHandle) return;
    clearTimeout(this.timeoutHandle);
    this.timeoutHandle = null;
  }
}

export async function fetchCodexProviderGlobalStateSnapshot({
  cwd,
  logger,
  processTimeout = 10_000,
  spawnProcess = spawn,
  codexPath = findCodexBinary() ?? "codex",
}: CodexProviderGlobalStateSnapshotOptions): Promise<import("#core/types.js").ProviderGlobalState> {
  const child = spawnProcess(codexPath, ["app-server", "--listen", "stdio://"], {
    cwd,
    env: buildCodexSpawnEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdin = child.stdin;
  const stdout = child.stdout;
  if (!stdin?.writable || !stdout) {
    child.kill("SIGTERM");
    throw new Error("Codex app-server transport unavailable");
  }

  let nextRpcId = 1;
  let lineBuffer = "";
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  const cleanup = () => {
    stdout.removeAllListeners("data");
    child.removeAllListeners();
  };

  const closeChild = () => {
    cleanup();
    if (!child.killed) child.kill("SIGTERM");
  };

  const rejectAll = (error: Error) => {
    for (const [, entry] of pending) {
      entry.reject(error);
    }
    pending.clear();
  };

  child.on("error", (err) => {
    rejectAll(err instanceof Error ? err : new Error(String(err)));
  });
  child.on("close", (code, signal) => {
    if (pending.size > 0) {
      rejectAll(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`));
    }
  });
  // Guard against EPIPE when the app-server dies mid-write (e.g. a broken binary
  // that exits immediately). An unhandled stdin 'error' would crash the process.
  stdin.on("error", (err) => {
    rejectAll(err instanceof Error ? err : new Error(String(err)));
  });

  stdout.on("data", (chunk: Buffer | string) => {
    lineBuffer += chunk.toString();
    let idx = lineBuffer.indexOf("\n");
    while (idx !== -1) {
      const line = lineBuffer.slice(0, idx).trim();
      lineBuffer = lineBuffer.slice(idx + 1);
      idx = lineBuffer.indexOf("\n");
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        if ("id" in msg && msg.id !== undefined && !("method" in msg)) {
          // RPC response
          const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
          const entry = pending.get(id);
          if (!entry) continue;
          pending.delete(id);
          if (msg.error) {
            entry.reject(
              new Error(msg.error.message ?? `RPC error ${msg.error.code ?? "unknown"}`),
            );
          } else {
            entry.resolve(msg.result);
          }
        } else if ("method" in msg && msg.method && !("id" in msg && msg.id !== undefined)) {
          // Push notification — ignored during cold snapshot (Codex no longer
          // pushes rate limits proactively; live sessions handle these separately)
          logger.debug(
            `[CodexAppServer] Snapshot received push notification: ${msg.method as string}`,
          );
        }
      } catch {
        logger.debug(`[CodexAppServer] Snapshot fetch ignoring non-JSON line: ${line}`);
      }
    }
  });

  const sendRpc = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextRpcId++;
      pending.set(id, { resolve, reject });
      stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  const sendNotification = (method: string, params?: unknown): void => {
    const msg: { jsonrpc: "2.0"; method: string; params?: unknown } = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    stdin.write(JSON.stringify(msg) + "\n");
  };

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("Timed out fetching Codex global state")), processTimeout);
  });

  try {
    await Promise.race([
      sendRpc("initialize", {
        clientInfo: { name: RELAY_CODEX_ORIGINATOR, version: "0.0.0" },
        capabilities: { experimentalApi: true },
      }),
      timeout,
    ]);
    sendNotification("initialized");

    const [mcpResult, appResult, accountResult, rateLimitsResult] = await Promise.all([
      Promise.race([sendRpc("mcpServerStatus/list", {}), timeout]).catch(() => null),
      Promise.race([sendRpc("app/list", {}), timeout]).catch(() => null),
      Promise.race([sendRpc("account/read", { refreshToken: false }), timeout]).catch(() => null),
      Promise.race([sendRpc("account/rateLimits/read", undefined), timeout]).catch(() => null),
    ]);

    const appPayload = asRecord(appResult);
    const account = normalizeCodexAccountSnapshot(accountResult) ?? undefined;

    // account/rateLimits/read currently returns null from a cold subprocess
    // (requires internal snapshots that only exist after a live turn). Kept
    // here so it starts working automatically if Codex adds cold-snapshot support.
    const rateLimits = normalizeCodexRateLimitsSnapshot(rateLimitsResult);

    return {
      provider: "codex",
      account:
        account || rateLimits?.length
          ? {
              ...(account ?? {}),
              rateLimits,
            }
          : undefined,
      mcpServers: normalizeMcpServerStatusSnapshot(mcpResult),
      apps: getStringArray(appPayload?.apps ?? appPayload?.items ?? appResult),
      updatedAt: Date.now(),
    };
  } finally {
    closeChild();
  }
}
