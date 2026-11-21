/**
 * Antigravity managed session — drives `agy acp` (Agent Client Protocol).
 *
 * One `agy acp` process per chat, spawned lazily on the first send. The flow:
 *
 *   initialize → authenticate → session/new | session/resume
 *     → session/set_config_option (model, thought_level) + session/set_mode
 *     → session/prompt … (session/update notifications stream the turn)
 *
 * `agy` specifics this driver relies on (verified against agy 1.5.13):
 * - Models are families (`gemini-4-neon`) with a separate `thought_level`
 *   config option; both are set per session and re-applied before a turn when
 *   they change.
 * - Modes are `default`, `accept-edits`, `auto` and `plan`. Relay's full
 *   access runs in `accept-edits` and answers every remaining permission
 *   request itself; a plan is a brain artifact written with
 *   `ArtifactMetadata.RequestFeedback`, surfaced as Relay's plan review.
 * - A prompt sent while one is running steers the running turn (1.5+): the
 *   first prompt answers `end_turn` and the turn continues under the new one.
 * - Subagents are detached conversations; when one reports back, agy starts a
 *   reply on its own with no prompt open. Such replies are treated as turns
 *   and end at their trailing `usage_update`.
 * - The system prompt is appended through `_meta.antigravity.systemPrompt`
 *   when the agent advertises it, which is how bootstrap context and Relay's
 *   orchestration guidance reach the model.
 */

import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { readFileSync, readdirSync, statSync } from "fs";
import { extname, join } from "path";
import type { CoreConfig } from "#core/config.js";
import type { ProviderSession } from "#core/provider.js";
import {
  RELAY_MCP_SERVER_NAME,
  RELAY_ORCHESTRATION_INSTRUCTIONS,
} from "#core/orchestration/instructions.js";
import type {
  ActivityMessage,
  AgentInfo,
  ExitMessage,
  FileChange,
  OutputMessage,
  ProviderModelOptions,
  ProviderRequest,
  ProviderRequestResponse,
  ProviderRuntimeBinding,
  ProviderRuntimeMode,
  ProviderSessionBootstrap,
  RelayMcpEndpoint,
  SessionStats,
  SystemEventMessage,
  TaskItem,
} from "#core/types.js";
import {
  AcpConnection,
  AcpRequestError,
  acpMethodNotFound,
} from "#core/providers/acp-connection.js";
import {
  antigravityDataDir,
  buildAntigravitySpawnEnv,
  compareAntigravityVersions,
  findAntigravityBinary,
  parseAntigravityVersion,
  RELAY_ANTIGRAVITY_CLIENT_NAME,
} from "#core/providers/antigravity-cli.js";
import {
  antigravityExitCode,
  antigravityReadPreview,
  antigravityToolUseActivity,
  antigravityWorkspacePath,
  cleanAntigravityToolOutput,
  parseAntigravityChecklist,
  describeAntigravityTool,
  type AntigravityToolView,
} from "#core/providers/antigravity-tools.js";
import {
  antigravityBrainDir,
  antigravityTranscriptPath,
  createZeroStats,
  parseAntigravitySubagentCreated,
  readAntigravityAgentReports,
} from "#core/providers/antigravity-transcript.js";
import {
  resolveAntigravityEffort,
  splitAntigravityModelId,
} from "#core/providers/antigravity-models.js";

type SpawnFn = typeof spawn;
type Json = Record<string, unknown>;

const RELAY_VERSION = "1.0.0";
const MAX_TOOL_DETAIL = 16_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** An unprompted reply (a subagent waking its parent) ends this long after its trailing usage update. */
const UNPROMPTED_SETTLE_MS = 2_500;
/**
 * Fallback end for an unprompted reply that never sends a usage update: this
 * long with no update, no tool running and no question open.
 */
const UNPROMPTED_IDLE_MS = 60_000;
/** After Stop on an unprompted reply, its stragglers are dropped for at most this long. */
const UNPROMPTED_CANCEL_GRACE_MS = 10_000;
/** How strictly each agy mode gates writes; lower is stricter. */
const MODE_STRICTNESS: Record<string, number> = {
  plan: 0,
  default: 1,
  "accept-edits": 2,
  auto: 3,
};
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

export interface AntigravitySessionOptions {
  logger: CoreConfig["logger"];
  cwd: string;
  /** Gemini home (`~/.gemini`); undefined = the CLI's own resolution. */
  home: string;
  model?: string;
  runtimeMode?: ProviderRuntimeMode;
  modelOptions?: ProviderModelOptions;
  resumeSessionId?: string;
  readOnly?: boolean;
  bootstrapContext?: ProviderSessionBootstrap;
  relayMcp?: RelayMcpEndpoint;
  additionalDirectories?: string[];
  processTimeout?: number;
  /**
   * The chat's token totals so far, on a resume: agy reports usage per prompt,
   * so totals continue from these.
   */
  initialStats?: SessionStats;
  binaryPath?: string;
  spawnProcess?: SpawnFn;
}

interface ToolState {
  id: string;
  name: string;
  view: AntigravityToolView;
  emittedUse: boolean;
  finished: boolean;
}

interface PendingPermission {
  kind: "approval" | "user_input";
  options: Array<{ optionId: string; name: string; kind: string }>;
  resolve(result: Json): void;
  toolCallId?: string;
}

interface ConfigOption {
  id: string;
  category?: string;
  currentValue?: string;
  options: Array<{ value: string; name: string }>;
}

function asRecord(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function flattenSelectOptions(value: unknown): Array<{ value: string; name: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) return [];
    if (Array.isArray(record.options)) return flattenSelectOptions(record.options);
    const optionValue = getString(record.value);
    if (!optionValue) return [];
    return [{ value: optionValue, name: getString(record.name) ?? optionValue }];
  });
}

export function parseAcpConfigOptions(value: unknown): ConfigOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const id = getString(record?.id);
    if (!record || !id) return [];
    return [
      {
        id,
        category: getString(record.category),
        currentValue: getString(record.currentValue),
        options: flattenSelectOptions(record.options),
      },
    ];
  });
}

/** Relay runtime mode → agy session mode. */
export function antigravityModeFor(mode: ProviderRuntimeMode, readOnly: boolean): string {
  if (readOnly) return "default";
  switch (mode) {
    case "plan":
      return "plan";
    case "auto":
      return "auto";
    case "full-access":
      return "accept-edits";
    default:
      return "default";
  }
}

/** Text from a tool result: `rawOutput.output`, else its text content blocks. */
function toolOutputText(update: Json): string | undefined {
  const rawOutput = update.rawOutput;
  if (typeof rawOutput === "string" && rawOutput.trim()) return rawOutput;
  const output = asRecord(rawOutput);
  for (const key of ["output", "combinedOutput", "combined_output", "formatted_output", "result"]) {
    const value = output?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  if (Array.isArray(update.content)) {
    const texts = update.content.flatMap((block) => {
      const record = asRecord(block);
      const inner = asRecord(record?.content);
      return record?.type === "content" && inner?.type === "text" && typeof inner.text === "string"
        ? [inner.text]
        : [];
    });
    if (texts.length) return texts.join("\n");
  }
  return undefined;
}

function truncate(text: string, max = MAX_TOOL_DETAIL): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/** `[Image: source: /path]` markers Relay appends for attached images. */
export function extractImagePaths(text: string): string[] {
  return Array.from(text.matchAll(/\[Image: source: ([^\]\n]+)\]/g), (match) => match[1].trim());
}

export class AntigravityAcpSession extends EventEmitter implements ProviderSession {
  private readonly logger: CoreConfig["logger"];
  private readonly cwd: string;
  private readonly home: string;
  private readonly binaryPath: string;
  private readonly spawnProcess: SpawnFn;
  private readonly readOnly: boolean;
  private readonly relayMcp?: RelayMcpEndpoint;
  private readonly additionalDirectories?: string[];
  private readonly processTimeout: number;
  readonly bootstrapContext?: ProviderSessionBootstrap;

  private process: ChildProcess | null = null;
  private connection: AcpConnection | null = null;
  private starting: Promise<void> | null = null;
  private closingIntentionally = false;
  private stderrBuffer = "";

  private _sessionId: string | undefined;
  private _isProcessing = false;
  private _stats: SessionStats = createZeroStats();
  private _preferredModel: string | null;
  private _modelOptions: ProviderModelOptions;
  private _runtimeMode: ProviderRuntimeMode;

  private agentVersion: string | null = null;
  private appendsSystemPrompt = false;
  private configOptions: ConfigOption[] = [];
  private currentModeId: string | undefined;
  private availableModeIds = new Set<string>();

  /** Prompts accepted by send() and not yet answered (more than one while steering). */
  private promptsInFlight = 0;
  /** Of those, the ones already sent to agy (the rest are still waiting on session setup). */
  private dispatchedPrompts = 0;
  /** Bumped by Stop: a prompt still in setup from an older generation is never sent. */
  private promptGeneration = 0;
  /** Tool calls of the current turn that haven't finished. */
  private readonly openTools = new Set<string>();
  /** Stop ended an unprompted reply: drop its stragglers until this time (or its usage update). */
  private dropUnpromptedUntil = 0;
  private interrupted = false;
  private unpromptedTimer: NodeJS.Timeout | null = null;
  private turnTimeout: NodeJS.Timeout | null = null;
  private queuedMessage: string | null = null;

  private thoughtBuffer = "";
  private readonly tools = new Map<string, ToolState>();
  private readonly fileMap = new Map<string, FileChange>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  /** invoke_subagent tool call id → agent card state. */
  private readonly agents = new Map<string, AgentInfo>();
  /** Child conversation ids already attributed to a card. */
  private readonly knownChildren = new Set<string>();
  private lastPlan: string | undefined;

  constructor(options: AntigravitySessionOptions) {
    super();
    this.logger = options.logger;
    this.cwd = options.cwd;
    this.home = options.home;
    const binary = options.binaryPath ?? findAntigravityBinary();
    if (!binary) {
      throw new Error(
        "Antigravity CLI (agy) not found. Install it from https://antigravity.google/cli, then sign in by running `agy`.",
      );
    }
    this.binaryPath = binary;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.readOnly = !!options.readOnly;
    this.relayMcp = options.readOnly ? undefined : options.relayMcp;
    this.additionalDirectories = options.readOnly ? undefined : options.additionalDirectories;
    this.processTimeout = options.processTimeout ?? 0;
    this.bootstrapContext = options.bootstrapContext;
    this._sessionId = options.resumeSessionId;
    this._preferredModel = options.model ?? null;
    this._modelOptions = options.modelOptions ?? {};
    this._runtimeMode = options.runtimeMode ?? "approval-required";
    if (options.initialStats) {
      const { contextTokens: _context, contextWindow: _window, ...totals } = options.initialStats;
      this._stats = { ...this._stats, ...totals };
    }
    if (this._preferredModel) this._stats.model = this._preferredModel;
  }

  // ===========================================================================
  // ProviderSession interface
  // ===========================================================================

  get isProcessing(): boolean {
    return this._isProcessing;
  }

  get provider(): "antigravity" {
    return "antigravity";
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  get stats(): SessionStats {
    return { ...this._stats };
  }

  getRuntimeBinding(): ProviderRuntimeBinding {
    return {
      provider: "antigravity",
      providerSessionId: this._sessionId,
      resumeCursor: this._sessionId ? { sessionId: this._sessionId } : undefined,
      transcriptPath: this._sessionId
        ? antigravityTranscriptPath(this.home, this._sessionId)
        : undefined,
      runtimePayload: {
        cwd: this.cwd,
        model: this._preferredModel ?? undefined,
        sessionContext: this.bootstrapContext ? { bootstrap: this.bootstrapContext } : undefined,
      },
      runtimeMode: this._runtimeMode,
    };
  }

  send(message: string): void {
    const steering = this.promptsInFlight > 0;
    if (steering && !this.canSteer()) {
      // Older runtimes queue a mid-turn prompt themselves; keep it here so the
      // turn boundaries stay ours.
      this.queuedMessage = this.queuedMessage ? `${this.queuedMessage}\n\n${message}` : message;
      return;
    }
    this.clearUnpromptedTimer();
    this.dropUnpromptedUntil = 0;
    if (!steering) this.beginTurn();
    this.promptsInFlight++;
    void this.runPrompt(message, this.promptGeneration);
  }

  interrupt(): void {
    this.queuedMessage = null;
    // Every open permission request is answered "cancelled" by the agent's
    // own cancel handling; drop ours so a late click is a no-op.
    this.cancelPendingPermissions();
    const sessionReady = !!(this._sessionId && this._sessionIdReady && this.connection);

    if (this.promptsInFlight > 0) {
      // Prompts still waiting on session setup are never sent.
      this.promptGeneration++;
      this.promptsInFlight = this.dispatchedPrompts;
      if (this.dispatchedPrompts > 0 && sessionReady) {
        this.interrupted = true;
        this.logger.info("[Antigravity] Cancelling turn");
        this.connection!.notify("session/cancel", { sessionId: this._sessionId! });
        return; // the prompt's answer ends the turn
      }
      this.logger.info("[Antigravity] Stopped before the prompt was sent");
      this.finishTurn({ aborted: true });
      return;
    }

    if (this._isProcessing) {
      // An unprompted reply (a subagent waking this chat): no prompt answers
      // the cancel, so the turn ends here and the reply's tail is dropped.
      if (sessionReady) {
        this.logger.info("[Antigravity] Cancelling unprompted reply");
        this.connection!.notify("session/cancel", { sessionId: this._sessionId! });
        this.dropUnpromptedUntil = Date.now() + UNPROMPTED_CANCEL_GRACE_MS;
      }
      this.finishTurn({ aborted: true });
    }
  }

  private cancelPendingPermissions(): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.pendingPermissions.delete(requestId);
    }
  }

  close(): Promise<void> {
    this.clearUnpromptedTimer();
    this.clearTurnTimeout();
    const child = this.process;
    this.closingIntentionally = true;
    // Nothing queued or waiting on setup may start a new process after close.
    this.queuedMessage = null;
    this.promptGeneration++;
    this.promptsInFlight = this.dispatchedPrompts;
    this.cancelPendingPermissions();
    this.connection?.close();
    this.connection = null;
    this.process = null;
    this.starting = null;
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        resolve();
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.stdin?.end();
        child.kill("SIGTERM");
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  setModel(model: string | null): void {
    this._preferredModel = model;
    this._stats.model = model ?? undefined;
    this.emit("stats", { ...this._stats });
    if (!this._isProcessing) void this.applySessionConfig().catch(() => {});
  }

  setModelOptions(modelOptions: ProviderModelOptions): void {
    this._modelOptions = { ...this._modelOptions, ...modelOptions };
    if (!this._isProcessing) void this.applySessionConfig().catch(() => {});
  }

  setRuntimeMode(mode: ProviderRuntimeMode): void {
    if (this.readOnly) return;
    if (
      mode !== "approval-required" &&
      mode !== "full-access" &&
      mode !== "plan" &&
      mode !== "auto"
    ) {
      this.logger.warn(`[Antigravity] Unknown runtime mode: ${mode}`);
      return;
    }
    this._runtimeMode = mode;
    if (mode === "full-access") {
      for (const requestId of Array.from(this.pendingPermissions.keys())) {
        const pending = this.pendingPermissions.get(requestId);
        if (pending?.kind === "approval") this.respondToRequest(requestId, "accept");
      }
    }
    if (this._isProcessing) {
      // Mid-turn: applied now when possible; the next prompt re-checks it.
      void this.applyMode().then((applied) => {
        if (!applied && this.connection && this.modeLooserThanDesired()) {
          this.emit(
            "providerError",
            "Antigravity didn't accept the mode change. It applies from the next message, which won't be sent until it does.",
          );
        }
      });
      return;
    }
    void this.applyMode();
  }

  addAllowedTool(_tool: string): void {
    // Approvals are answered one request at a time through respondToRequest.
  }

  respondToRequest(
    requestId: string,
    decision: "accept" | "decline",
    response?: ProviderRequestResponse,
  ): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);

    if (pending.kind === "user_input") {
      const chosen =
        decision === "accept"
          ? (Object.values(response?.answers ?? {})[0]?.answers?.[0] ?? response?.text?.trim())
          : undefined;
      const option =
        chosen !== undefined
          ? (pending.options.find((candidate) => candidate.name === chosen) ??
            pending.options.find((candidate) => candidate.optionId === chosen))
          : undefined;
      pending.resolve(
        option
          ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } },
      );
      this.emit("activity", {
        type: "activity",
        activity: "tool_result",
        tool: "AskUserQuestion",
        description: "Tool completed",
        resolution: option ? "approved" : "dismissed",
        input: { requestId },
      } as ActivityMessage);
      return true;
    }

    const option = this.pickOption(pending.options, decision === "accept" ? "allow" : "reject");
    pending.resolve(
      option
        ? { outcome: { outcome: "selected", optionId: option.optionId } }
        : { outcome: { outcome: "cancelled" } },
    );
    return true;
  }

  // ===========================================================================
  // Turn lifecycle
  // ===========================================================================

  private canSteer(): boolean {
    return (
      this.agentVersion !== null && compareAntigravityVersions(this.agentVersion, "1.5.0") >= 0
    );
  }

  private beginTurn(): void {
    this._isProcessing = true;
    this.interrupted = false;
    this.resetTurnTimeout();
  }

  private async runPrompt(message: string, generation: number): Promise<void> {
    let dispatched = false;
    try {
      await this.ensureSession();
      if (generation !== this.promptGeneration) return; // stopped during setup
      await this.applySessionConfig();
      if (generation !== this.promptGeneration) return;
      this.assertModeNotLooser();
      const connection = this.connection;
      if (!connection || !this._sessionId) throw new Error("Antigravity session is not running");
      dispatched = true;
      this.dispatchedPrompts++;
      const request = connection.request<Json>("session/prompt", {
        sessionId: this._sessionId,
        prompt: this.buildPromptBlocks(message),
      });
      const result = await request.finally(() => {
        this.dispatchedPrompts = Math.max(0, this.dispatchedPrompts - 1);
      });
      this.recordPromptUsage(asRecord(result?.usage));
      const stopReason = getString(result?.stopReason);
      this.promptsInFlight = Math.max(0, this.promptsInFlight - 1);
      if (this.promptsInFlight > 0) return; // steered: the turn continues
      if (stopReason === "refusal") {
        this.emit(
          "providerError",
          "Antigravity refused the request (this can mean the account's usage limit was reached).",
        );
      }
      this.finishTurn({ aborted: this.interrupted || stopReason === "cancelled" });
    } catch (error) {
      // Stop already settled a prompt that never left setup.
      if (!dispatched && generation !== this.promptGeneration) return;
      this.promptsInFlight = Math.max(0, this.promptsInFlight - 1);
      if (this.promptsInFlight > 0) return;
      const text = this.describeError(error);
      this.logger.warn(`[Antigravity] Prompt failed: ${text}`);
      if (!this.closingIntentionally) this.emit("providerError", text);
      this.finishTurn({ aborted: this.interrupted });
    }
  }

  private finishTurn(options: { aborted?: boolean } = {}): void {
    this.clearUnpromptedTimer();
    this.clearTurnTimeout();
    this.flushThought();
    if (!this._isProcessing) {
      this.drainQueuedMessage();
      return;
    }
    this.syncChildReports();
    this._isProcessing = false;
    this.interrupted = false;
    this.openTools.clear();
    this.emit("stats", { ...this._stats });
    this.emit("output", {
      type: "output",
      text: "",
      isWaiting: true,
      ...(options.aborted ? { aborted: true } : {}),
    } as OutputMessage);
    this.drainQueuedMessage();
  }

  private drainQueuedMessage(): void {
    if (!this.queuedMessage || this.closingIntentionally) return;
    const next = this.queuedMessage;
    this.queuedMessage = null;
    this.send(next);
  }

  /**
   * Updates that arrive with no prompt open are an unprompted reply (a
   * subagent's wake). Returns false when the update belongs to a reply the
   * user stopped and must be dropped.
   */
  private noteUnpromptedActivity(): boolean {
    if (this.promptsInFlight > 0) return true;
    if (this.dropUnpromptedUntil > Date.now()) return false;
    this.dropUnpromptedUntil = 0;
    if (!this._isProcessing) this.beginTurn();
    // Ongoing output: only the fallback end applies until the trailing usage update.
    this.armUnpromptedTimer(UNPROMPTED_IDLE_MS);
    return true;
  }

  /**
   * End an unprompted reply after `delayMs` of quiet. A tool still running or
   * a question waiting on the user keeps it open: the reply isn't over.
   */
  private armUnpromptedTimer(delayMs: number): void {
    this.clearUnpromptedTimer();
    this.unpromptedTimer = setTimeout(() => {
      this.unpromptedTimer = null;
      if (this.promptsInFlight > 0 || !this._isProcessing) return;
      if (this.openTools.size > 0 || this.pendingPermissions.size > 0) {
        this.armUnpromptedTimer(UNPROMPTED_IDLE_MS);
        return;
      }
      this.finishTurn();
    }, delayMs);
  }

  private clearUnpromptedTimer(): void {
    if (this.unpromptedTimer) clearTimeout(this.unpromptedTimer);
    this.unpromptedTimer = null;
  }

  private resetTurnTimeout(): void {
    this.clearTurnTimeout();
    if (!this.processTimeout) return;
    this.turnTimeout = setTimeout(() => {
      // Time spent waiting on the user isn't the agent hanging.
      if (this.pendingPermissions.size > 0) {
        this.resetTurnTimeout();
        return;
      }
      this.logger.warn("[Antigravity] Turn timed out; cancelling");
      this.interrupt();
    }, this.processTimeout);
  }

  private clearTurnTimeout(): void {
    if (this.turnTimeout) clearTimeout(this.turnTimeout);
    this.turnTimeout = null;
  }

  // ===========================================================================
  // Process + session setup
  // ===========================================================================

  private ensureSession(): Promise<void> {
    if (this.connection && !this.connection.isClosed && this._sessionIdReady) {
      return Promise.resolve();
    }
    if (!this.starting) {
      this.starting = this.startSession().catch((error) => {
        this.starting = null;
        // A half-started (possibly hung) agent is never reused: the next send
        // starts a fresh one.
        this.discardProcess();
        throw error;
      });
    }
    return this.starting;
  }

  /** True once session/new or session/resume answered on the current process. */
  private _sessionIdReady = false;

  private spawnAgent(): AcpConnection {
    this.closingIntentionally = false;
    this.stderrBuffer = "";
    const env = buildAntigravitySpawnEnv(this.home);
    const child = this.spawnProcess(this.binaryPath, ["acp"], {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-8_000);
    });
    const connection = new AcpConnection(child, {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onAgentRequest(method, params),
      onStrayLine: (line) => this.logger.debug(`[Antigravity] stdout: ${line.slice(0, 300)}`),
    });
    // A failed spawn (ENOENT, EACCES) emits `error` and never `exit`: tear
    // down the same way, so nothing reuses the dead connection.
    child.on("error", (error) => {
      this.logger.error(`[Antigravity] agy process error: ${error.message}`);
      this.stderrBuffer = `${this.stderrBuffer}\n${error.message}`.slice(-8_000);
      this.onProcessExit(child, connection, null, null);
    });
    child.on("exit", (code, signal) => this.onProcessExit(child, connection, code, signal));
    this.connection = connection;
    return connection;
  }

  /** Drop the current agent process without reporting an exit (it is being replaced). */
  private discardProcess(): void {
    const child = this.process;
    this.connection?.close(new Error("Antigravity session setup failed"));
    this.connection = null;
    this.process = null;
    this._sessionIdReady = false;
    if (!child || child.exitCode !== null) return;
    try {
      child.stdin?.end();
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }

  private onProcessExit(
    child: ChildProcess,
    connection: AcpConnection,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    connection.close(new Error(this.exitDescription(code, signal)));
    if (this.process !== child) return;
    this.process = null;
    this.connection = null;
    this.starting = null;
    this._sessionIdReady = false;
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();
    if (this.closingIntentionally) return;
    this.logger.warn(`[Antigravity] agy exited (${code ?? signal})`);
    if (this._isProcessing) {
      this.promptsInFlight = 0;
      this.dispatchedPrompts = 0;
      this.promptGeneration++;
      this.finishTurn({ aborted: true });
    }
    const exit: ExitMessage = {
      type: "exit",
      code: code ?? 1,
      signal: signal ?? undefined,
      stderr: this.stderrBuffer.trim() || undefined,
    };
    this.emit("exit", exit);
  }

  private exitDescription(code: number | null, signal: NodeJS.Signals | null): string {
    const tail = this.stderrBuffer.trim().split("\n").slice(-3).join("\n");
    return `agy exited (${code ?? signal})${tail ? `: ${tail}` : ""}`;
  }

  private authMethodId(): string {
    try {
      const raw = readFileSync(
        join(antigravityDataDir(this.home), "cache", "acp-auth-state.json"),
        "utf-8",
      );
      const methodId = getString(asRecord(JSON.parse(raw))?.methodId);
      if (methodId) return methodId;
    } catch {
      // first run: the CLI's default sign-in
    }
    return "oauth-personal";
  }

  private async startSession(): Promise<void> {
    const connection =
      this.connection && !this.connection.isClosed ? this.connection : this.spawnAgent();
    const init = await connection.request<Json>(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: RELAY_ANTIGRAVITY_CLIENT_NAME, title: "Relay", version: RELAY_VERSION },
      },
      { timeoutMs: 60_000 },
    );
    this.agentVersion = parseAntigravityVersion(getString(asRecord(init?.agentInfo)?.version));
    const capabilities = asRecord(init?.agentCapabilities);
    const meta = asRecord(asRecord(capabilities?._meta)?.antigravity);
    this.appendsSystemPrompt = asRecord(meta?.systemPrompt)?.append === true;

    try {
      await connection.request(
        "authenticate",
        { methodId: this.authMethodId() },
        { timeoutMs: 60_000 },
      );
    } catch (error) {
      throw new Error(this.describeAuthError(error));
    }

    const sessionParams: Json = {
      cwd: this.cwd,
      mcpServers: this.mcpServers(),
      ...(this.additionalDirectories?.length
        ? { additionalDirectories: this.additionalDirectories }
        : {}),
      ...this.systemPromptMeta(),
    };

    let result: Json | undefined;
    if (this._sessionId) {
      try {
        result = await connection.request<Json>(
          "session/resume",
          { sessionId: this._sessionId, ...sessionParams },
          { timeoutMs: 120_000 },
        );
      } catch (error) {
        this.logger.warn(
          `[Antigravity] Resume of ${this._sessionId} failed: ${this.describeError(error)}`,
        );
        throw new Error(
          `Couldn't resume this Antigravity conversation: ${this.describeError(error)}`,
        );
      }
    } else {
      result = await connection.request<Json>("session/new", sessionParams, { timeoutMs: 120_000 });
      const sessionId = getString(result?.sessionId);
      if (!sessionId) throw new Error("agy did not return a session id");
      this._sessionId = sessionId;
    }
    this._sessionIdReady = true;
    this.absorbSessionState(result);
    this.emitSessionInit(init, result);
  }

  private systemPromptMeta(): Json {
    if (!this.appendsSystemPrompt) return {};
    const append = [
      this.bootstrapContext?.baseInstructions,
      this.bootstrapContext?.developerInstructions,
      this.relayMcp ? RELAY_ORCHESTRATION_INSTRUCTIONS : undefined,
      this.readOnly
        ? "This is a read-only side conversation: do not modify files, run commands that change state, or delegate work."
        : undefined,
    ]
      .filter((value): value is string => !!value?.trim())
      .join("\n\n");
    return append ? { _meta: { antigravity: { systemPrompt: { append } } } } : {};
  }

  private mcpServers(): Json[] {
    if (!this.relayMcp) return [];
    return [
      {
        type: "http",
        name: RELAY_MCP_SERVER_NAME,
        url: this.relayMcp.url,
        headers: [{ name: "Authorization", value: `Bearer ${this.relayMcp.token}` }],
      },
    ];
  }

  private absorbSessionState(result: Json | undefined): void {
    if (!result) return;
    const options = parseAcpConfigOptions(result.configOptions);
    if (options.length) this.configOptions = options;
    const modes = asRecord(result.modes);
    if (modes) {
      this.currentModeId = getString(modes.currentModeId) ?? this.currentModeId;
      if (Array.isArray(modes.availableModes)) {
        this.availableModeIds = new Set(
          modes.availableModes.flatMap((mode) => {
            const id = getString(asRecord(mode)?.id);
            return id ? [id] : [];
          }),
        );
      }
    }
  }

  private emitSessionInit(init: Json | undefined, result: Json | undefined): void {
    const model = this.optionValue("model") ?? this._preferredModel ?? undefined;
    if (model) this._stats.model = model;
    this.emit("systemEvent", {
      type: "system_event",
      event: "session_init",
      payload: {
        sessionId: this._sessionId,
        cwd: this.cwd,
        model,
        version: this.agentVersion ?? undefined,
      },
      raw: { initialize: init, session: result },
    } as SystemEventMessage);
  }

  private optionValue(category: string): string | undefined {
    return this.configOptions.find(
      (option) => option.category === category || option.id === category,
    )?.currentValue;
  }

  private optionId(category: string): string | undefined {
    return this.configOptions.find(
      (option) => option.category === category || option.id === category,
    )?.id;
  }

  /** Push model, thinking level and mode to the session when they differ. */
  private async applySessionConfig(): Promise<void> {
    const connection = this.connection;
    if (!connection || !this._sessionId || !this._sessionIdReady) return;
    if (this._preferredModel) {
      const modelOptionId = this.optionId("model");
      const modelOption = this.configOptions.find((option) => option.id === modelOptionId);
      // A model the session lists under its full id (`gpt-oss-120b-medium`)
      // is used as is; otherwise a legacy `<family>-<level>` id is split.
      const listedWhole = modelOption?.options.some((o) => o.value === this._preferredModel);
      const { model, effort } = listedWhole
        ? { model: this._preferredModel, effort: undefined }
        : splitAntigravityModelId(this._preferredModel);
      if (
        modelOptionId &&
        model !== modelOption?.currentValue &&
        (!modelOption?.options.length || modelOption.options.some((o) => o.value === model))
      ) {
        await this.setConfigOption(modelOptionId, model);
      }
      if (effort && !this._modelOptions.reasoningEffort) {
        await this.applyEffort(effort);
      }
    }
    if (this._modelOptions.reasoningEffort) {
      await this.applyEffort(this._modelOptions.reasoningEffort);
    }
    await this.applyMode();
  }

  private async applyEffort(requested: string): Promise<void> {
    const thoughtId = this.optionId("thought_level");
    if (!thoughtId) return;
    const option = this.configOptions.find((candidate) => candidate.id === thoughtId);
    const value = resolveAntigravityEffort(
      requested,
      option?.options.map((candidate) => candidate.value) ?? [],
    );
    if (value && value !== option?.currentValue) await this.setConfigOption(thoughtId, value);
  }

  private async setConfigOption(configId: string, value: string): Promise<void> {
    if (!this.connection || !this._sessionId) return;
    try {
      const result = await this.connection.request<Json>("session/set_config_option", {
        sessionId: this._sessionId,
        configId,
        value,
      });
      const options = parseAcpConfigOptions(result?.configOptions);
      if (options.length) this.configOptions = options;
      if (configId === this.optionId("model")) {
        this._stats.model = value;
        this.emit("stats", { ...this._stats });
      }
    } catch (error) {
      this.logger.warn(
        `[Antigravity] set_config_option ${configId}=${value} failed: ${this.describeError(error)}`,
      );
    }
  }

  private desiredModeId(): string {
    const modeId = antigravityModeFor(this._runtimeMode, this.readOnly);
    return this.availableModeIds.size && !this.availableModeIds.has(modeId) ? "default" : modeId;
  }

  /** Returns false when agy refused the mode change. */
  private async applyMode(): Promise<boolean> {
    if (!this.connection || !this._sessionId || !this._sessionIdReady) return true;
    const modeId = this.desiredModeId();
    if (modeId === this.currentModeId) return true;
    try {
      await this.connection.request("session/set_mode", { sessionId: this._sessionId, modeId });
      this.currentModeId = modeId;
      return true;
    } catch (error) {
      this.logger.warn(`[Antigravity] set_mode ${modeId} failed: ${this.describeError(error)}`);
      return false;
    }
  }

  private modeLooserThanDesired(): boolean {
    const desired = this.desiredModeId();
    const current = this.currentModeId;
    if (current === desired) return false;
    // An agent that reports no modes at all has nothing to switch.
    if (current === undefined && this.availableModeIds.size === 0) return false;
    const rank = (modeId: string | undefined) =>
      modeId !== undefined && modeId in MODE_STRICTNESS
        ? MODE_STRICTNESS[modeId]
        : Number.POSITIVE_INFINITY;
    return rank(current) > rank(desired);
  }

  /**
   * Never send a prompt while agy runs in a looser mode than the chat shows:
   * edits agy approves itself never reach Relay's approval flow. A mode that
   * is stricter than asked (a failed switch to full access) is safe to run.
   */
  private assertModeNotLooser(): void {
    if (!this.modeLooserThanDesired()) return;
    const desired = this.desiredModeId();
    const current = this.currentModeId;
    throw new Error(
      `Antigravity didn't switch to its "${desired}" mode (it is in ${current ? `"${current}"` : "an unknown mode"}), so the message wasn't sent. Try again, or change the chat's mode.`,
    );
  }

  private buildPromptBlocks(message: string): Json[] {
    const blocks: Json[] = [{ type: "text", text: message }];
    for (const path of extractImagePaths(message)) {
      const mimeType = IMAGE_MIME[extname(path).toLowerCase()];
      if (!mimeType) continue;
      try {
        if (statSync(path).size > MAX_IMAGE_BYTES) continue;
        blocks.push({ type: "image", mimeType, data: readFileSync(path).toString("base64") });
      } catch {
        // The path stays in the text; the agent can still read it.
      }
    }
    return blocks;
  }

  private recordPromptUsage(usage: Json | undefined): void {
    if (!usage) return;
    const num = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
    this._stats.inputTokens += num("inputTokens");
    this._stats.outputTokens += num("outputTokens");
    this._stats.cacheReadTokens += num("cachedReadTokens");
    this._stats.cacheCreationTokens += num("cachedWriteTokens");
    if (num("thoughtTokens")) {
      this._stats.reasoningTokens = (this._stats.reasoningTokens ?? 0) + num("thoughtTokens");
    }
  }

  // ===========================================================================
  // Agent → Relay
  // ===========================================================================

  private onNotification(method: string, params: Json): void {
    if (method !== "session/update") return;
    if (this._sessionId && params.sessionId && params.sessionId !== this._sessionId) return;
    const update = asRecord(params.update);
    if (!update) return;
    const kind = getString(update.sessionUpdate);
    if (this._isProcessing) this.resetTurnTimeout();

    switch (kind) {
      case "agent_message_chunk": {
        const text = this.contentText(update.content);
        if (!text) return;
        if (!this.noteUnpromptedActivity()) return;
        this.flushThought();
        this.emit("output", { type: "output", text, isWaiting: false } as OutputMessage);
        return;
      }
      case "agent_thought_chunk": {
        const text = this.contentText(update.content);
        if (!text) return;
        if (!this.noteUnpromptedActivity()) return;
        this.thoughtBuffer += text;
        return;
      }
      case "tool_call":
      case "tool_call_update":
        if (!this.noteUnpromptedActivity()) return;
        this.flushThought();
        this.onToolCall(update);
        return;
      case "plan": {
        const tasks = this.planTasks(update.entries);
        if (tasks.length) {
          this.emit("activity", {
            type: "activity",
            activity: "task_list",
            description: "Plan",
            tasks,
          } as ActivityMessage);
        }
        return;
      }
      case "usage_update": {
        const used = typeof update.used === "number" ? update.used : undefined;
        const size = typeof update.size === "number" ? update.size : undefined;
        if (used !== undefined) this._stats.contextTokens = used;
        if (size !== undefined) this._stats.contextWindow = size;
        this.emit("stats", { ...this._stats });
        if (this.promptsInFlight > 0) return;
        if (this.dropUnpromptedUntil) {
          // The stopped reply's trailing update: what follows is a new reply.
          this.dropUnpromptedUntil = 0;
          return;
        }
        // The trailing usage_update closes an unprompted reply.
        if (this._isProcessing) this.armUnpromptedTimer(UNPROMPTED_SETTLE_MS);
        return;
      }
      case "session_info_update": {
        const title = getString(update.title)?.trim();
        if (title) this.emit("titleUpdate", title);
        return;
      }
      case "available_commands_update": {
        const commands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
        const slashCommands = commands.flatMap((command) => {
          const record = asRecord(command);
          const name = getString(record?.name);
          if (!name) return [];
          const hint = getString(asRecord(record?.input)?.hint);
          return [
            {
              name,
              ...(getString(record?.description) ? { description: record?.description } : {}),
              ...(hint ? { input: { hint } } : {}),
            },
          ];
        });
        this.emit("systemEvent", {
          type: "system_event",
          event: "provider_status",
          payload: { slashCommands },
        } as SystemEventMessage);
        return;
      }
      case "current_mode_update":
        this.currentModeId = getString(update.currentModeId) ?? this.currentModeId;
        return;
      case "config_option_update": {
        const options = parseAcpConfigOptions(update.configOptions);
        if (options.length) this.configOptions = options;
        const model = this.optionValue("model");
        if (model && model !== this._stats.model) {
          this._stats.model = model;
          this.emit("stats", { ...this._stats });
        }
        return;
      }
      default:
        return;
    }
  }

  private contentText(content: unknown): string {
    const record = asRecord(content);
    return record?.type === "text" && typeof record.text === "string" ? record.text : "";
  }

  private flushThought(): void {
    const thought = this.thoughtBuffer.trim();
    this.thoughtBuffer = "";
    if (!thought) return;
    this.emit("activity", {
      type: "activity",
      activity: "thinking",
      description: "Reasoning...",
      detail: thought,
    } as ActivityMessage);
  }

  private planTasks(entries: unknown): TaskItem[] {
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry, index) => {
      const record = asRecord(entry);
      const content = getString(record?.content);
      if (!content) return [];
      const status = getString(record?.status);
      return [
        {
          id: String(index + 1),
          subject: content,
          status:
            status === "completed"
              ? "completed"
              : status === "in_progress"
                ? "in_progress"
                : "pending",
        } as TaskItem,
      ];
    });
  }

  /**
   * A tool call's card is emitted once its arguments are known — they decide
   * whether it is a plan, a file change or a subagent — or when it finishes or
   * asks for permission without them (`force`).
   */
  private onToolCall(update: Json, options: { force?: boolean } = {}): void {
    const id = getString(update.toolCallId);
    if (!id) return;
    let state = this.tools.get(id);
    const name =
      getString(update.name) ??
      state?.name ??
      getString(update.title)?.replace(/^Run(?:ning)?\s+|\?$/g, "") ??
      "tool";
    const args = update.args ?? update.rawInput;
    const status = getString(update.status);
    const final = status === "completed" || status === "failed";
    if (!state || (args !== undefined && !state.emittedUse)) {
      const view = describeAntigravityTool(name, args, {
        cwd: this.cwd,
        brainDir: this._sessionId ? antigravityBrainDir(this.home, this._sessionId) : undefined,
      });
      state = state
        ? { ...state, name, view }
        : { id, name, view, emittedUse: false, finished: false };
      this.tools.set(id, state);
    }
    if (!state.finished && !final) this.openTools.add(id);
    if (!state.emittedUse && (args !== undefined || final || options.force)) {
      state.emittedUse = true;
      this.emitToolUse(state, update);
    }

    if (state.finished || !final) return;
    state.finished = true;
    this.openTools.delete(id);
    this.emitToolResult(state, update, status === "failed");
  }

  private emitToolUse(state: ToolState, update: Json): void {
    const view = state.view;
    if (view.plan !== undefined) {
      // A plan written for review is Relay's plan-review flow, not a file write.
      if (view.plan === this.lastPlan) return;
      this.lastPlan = view.plan;
      this.emit("activity", {
        type: "activity",
        activity: "tool_use",
        toolUseId: state.id,
        tool: "ExitPlanMode",
        description: "Plan ready for review",
        input: { plan: view.plan },
        raw: update,
      } as ActivityMessage);
      return;
    }
    this.emit("activity", antigravityToolUseActivity(view, state.id, update));
    if (view.subagent) {
      const agent: AgentInfo = {
        agentId: state.id,
        origin: "provider",
        originToolUseId: state.id,
        status: "running",
        ...(view.subagent.role
          ? { name: view.subagent.role, description: view.subagent.role }
          : {}),
        ...(view.subagent.typeName ? { role: view.subagent.typeName } : {}),
        ...(view.subagent.prompt ? { assignment: view.subagent.prompt } : {}),
        startedAt: Date.now(),
      };
      this.agents.set(state.id, agent);
      this.emit("agentUpdate", { type: "agent_update", agent });
    }
  }

  private emitToolResult(state: ToolState, update: Json, failed: boolean): void {
    const view = state.view;
    if (view.plan !== undefined) {
      // Plan review stays pending until the user answers; no tool_result.
      return;
    }
    const rawText = toolOutputText(update);
    let output = rawText ? cleanAntigravityToolOutput(rawText) : "";
    if (!output && !failed && view.tool === "Read" && typeof view.input.file_path === "string") {
      output =
        antigravityReadPreview(
          view.input.file_path,
          typeof view.input.offset === "number" ? view.input.offset : undefined,
          typeof view.input.limit === "number" ? view.input.limit : undefined,
        ) ?? "";
    }
    const exitCode =
      view.tool === "Bash"
        ? (antigravityExitCode(rawText) ??
          (typeof asRecord(update.rawOutput)?.exit_code === "number"
            ? (asRecord(update.rawOutput)?.exit_code as number)
            : undefined))
        : undefined;

    if (!failed && view.changedFile) {
      this.trackFile(view.changedFile.path, view.changedFile.kind);
      this.emit("activity", {
        type: "activity",
        activity: "file_list",
        description: "Files changed",
        files: Array.from(this.fileMap.values()).map((file) => ({ ...file })),
      } as ActivityMessage);
    }

    this.emit("activity", {
      type: "activity",
      activity: "tool_result",
      toolUseId: state.id,
      tool: view.tool,
      description: failed
        ? "Tool error"
        : exitCode !== undefined && exitCode !== 0
          ? "Command failed"
          : `${view.tool} completed`,
      detail: output ? truncate(output) : undefined,
      ...(view.tool === "Bash" && exitCode !== undefined
        ? { input: { ...view.input, exitCode } }
        : {}),
      raw: update,
    } as ActivityMessage);

    if (view.subagent) this.attributeSubagent(state.id, failed, rawText ?? output);
    if (!failed && view.artifact) this.emitArtifactTasks(view.artifact.path);
  }

  /** A checklist artifact (`todo.md`) is the agent's task list. */
  private emitArtifactTasks(path: string): void {
    if (!path.endsWith(".md")) return;
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      return;
    }
    const tasks = parseAntigravityChecklist(text);
    if (tasks.length === 0) return;
    this.emit("activity", {
      type: "activity",
      activity: "task_list",
      description: "Tasks",
      tasks,
    } as ActivityMessage);
  }

  /**
   * Subagent reports. A child reports to its parent with a message agy injects
   * into the parent's conversation — recorded in the transcript, never sent
   * over ACP — and the parent then replies on its own. Read the reports of
   * running children from the transcript tail and complete their cards.
   */
  private syncChildReports(): void {
    if (!this._sessionId) return;
    const running = new Map<string, AgentInfo>();
    for (const agent of this.agents.values()) {
      if (agent.providerAgentId && agent.status === "running")
        running.set(agent.providerAgentId, agent);
    }
    if (running.size === 0) return;
    for (const report of readAntigravityAgentReports(
      antigravityTranscriptPath(this.home, this._sessionId),
    )) {
      const agent = running.get(report.sender);
      if (!agent) continue;
      running.delete(report.sender);
      const patch: AgentInfo = {
        agentId: agent.agentId,
        status: "completed",
        result: report.text,
        endedAt: report.timestamp,
      };
      this.agents.set(agent.agentId, { ...agent, ...patch });
      this.emit("agentUpdate", { type: "agent_update", agent: patch });
    }
  }

  /** A launched subagent's conversation id, from the parent's subagent records. */
  private attributeSubagent(agentId: string, failed: boolean, output: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    if (failed) {
      const patch: AgentInfo = {
        agentId,
        status: "failed",
        statusDetail: output || "Subagent failed to start",
        endedAt: Date.now(),
      };
      this.emit("agentUpdate", { type: "agent_update", agent: patch });
      return;
    }
    // The launch result names its child; the subagent records are only a
    // fallback, and only when exactly one new record can be this launch's.
    const childId =
      parseAntigravitySubagentCreated(output) ??
      this.findNewChildConversation(agent.startedAt ?? Date.now());
    if (!childId || this.knownChildren.has(childId)) return;
    this.knownChildren.add(childId);
    const patch: AgentInfo = { agentId, providerAgentId: childId };
    this.agents.set(agentId, { ...agent, ...patch });
    this.emit("agentUpdate", { type: "agent_update", agent: patch });
  }

  private findNewChildConversation(launchedAt: number): string | undefined {
    if (!this._sessionId) return undefined;
    const dir = join(
      antigravityBrainDir(this.home, this._sessionId),
      ".system_generated",
      "subagents",
    );
    try {
      const candidates = readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => ({ id: name.slice(0, -5), mtime: statSync(join(dir, name)).mtimeMs }))
        .filter((entry) => !this.knownChildren.has(entry.id))
        // Records from before this launch (earlier processes) are never it.
        .filter((entry) => entry.mtime >= launchedAt - 2_000);
      const unattributed = Array.from(this.agents.values()).filter(
        (candidate) => candidate.status === "running" && !candidate.providerAgentId,
      ).length;
      // Several launches racing for several records: guessing could swap them.
      return candidates.length === 1 && unattributed <= 1 ? candidates[0].id : undefined;
    } catch {
      return undefined;
    }
  }

  private trackFile(reported: string, type: FileChange["type"]): void {
    const path = antigravityWorkspacePath(this.cwd, reported);
    if (!path) return;
    const existing = this.fileMap.get(path);
    if (existing) {
      existing.editCount++;
      if (existing.type !== "added") existing.type = type;
      return;
    }
    this.fileMap.set(path, { path, editCount: 1, type });
  }

  private async onAgentRequest(method: string, params: Json): Promise<unknown> {
    if (method !== "session/request_permission") throw acpMethodNotFound(method);
    const toolCall = asRecord(params.toolCall) ?? {};
    const toolCallId = getString(toolCall.toolCallId);
    const options = (Array.isArray(params.options) ? params.options : []).flatMap((option) => {
      const record = asRecord(option);
      const optionId = getString(record?.optionId);
      return optionId
        ? [
            {
              optionId,
              name: getString(record?.name) ?? optionId,
              kind: getString(record?.kind) ?? "",
            },
          ]
        : [];
    });
    if (!this.noteUnpromptedActivity()) return { outcome: { outcome: "cancelled" } };
    if (toolCallId) {
      this.onToolCall({ ...toolCall, toolCallId, status: "pending" }, { force: true });
    }

    // agy's own questions arrive as permission requests on an `interaction_` call.
    if (toolCallId?.startsWith("interaction_")) {
      return this.askUser(toolCallId, getString(toolCall.title) ?? "Question", options, toolCall);
    }

    const kind = getString(toolCall.kind);
    const autoAnswer = this.autoPermissionAnswer(kind);
    if (autoAnswer) {
      const option = this.pickOption(options, autoAnswer);
      return option
        ? { outcome: { outcome: "selected", optionId: option.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }

    const requestId = `agy-permission-${toolCallId ?? Date.now()}`;
    return new Promise<Json>((resolve) => {
      this.pendingPermissions.set(requestId, { kind: "approval", options, resolve, toolCallId });
      this.emit("permissionRequest", this.buildApprovalRequest(requestId, toolCall, toolCallId));
    });
  }

  private autoPermissionAnswer(kind: string | undefined): "allow" | "reject" | undefined {
    if (this.readOnly) {
      return kind === "read" || kind === "search" || kind === "fetch" || kind === "think"
        ? "allow"
        : "reject";
    }
    if (this._runtimeMode === "full-access") return "allow";
    return undefined;
  }

  private buildApprovalRequest(
    requestId: string,
    toolCall: Json,
    toolCallId: string | undefined,
  ): ProviderRequest {
    const state = toolCallId ? this.tools.get(toolCallId) : undefined;
    const view =
      state?.view ??
      describeAntigravityTool(
        getString(toolCall.name) ?? "tool",
        toolCall.args ?? toolCall.rawInput,
        {
          cwd: this.cwd,
        },
      );
    const kind = getString(toolCall.kind);
    if (kind === "execute" || view.tool === "Bash") {
      const command = getString(view.input.command) ?? getString(toolCall.title) ?? "command";
      return {
        requestId,
        kind: "approval",
        category: "command",
        source: "command",
        tool: "Bash",
        description: command,
        command,
        cwd: getString(view.input.cwd) ?? this.cwd,
        raw: toolCall,
      };
    }
    if (kind === "edit" || view.changedFile) {
      const file = view.changedFile?.path ?? getString(view.input.file_path);
      return {
        requestId,
        kind: "approval",
        category: "file_change",
        source: "agent",
        tool: view.tool,
        description: file ? `${view.description} ${file}` : view.description,
        ...(file ? { files: [file] } : {}),
        raw: toolCall,
      };
    }
    return {
      requestId,
      kind: "approval",
      category: "generic",
      source: "provider",
      tool: view.tool,
      description: view.inputDescription
        ? `${view.description}: ${view.inputDescription}`
        : (getString(toolCall.title) ?? view.description),
      raw: toolCall,
    };
  }

  private askUser(
    toolCallId: string,
    question: string,
    options: Array<{ optionId: string; name: string; kind: string }>,
    toolCall: Json,
  ): Promise<Json> {
    const requestId = `agy-question-${toolCallId}`;
    return new Promise<Json>((resolve) => {
      this.pendingPermissions.set(requestId, { kind: "user_input", options, resolve, toolCallId });
      this.emit("permissionRequest", {
        requestId,
        kind: "user_input",
        source: "provider",
        tool: "AskUserQuestion",
        description: question,
        questions: [
          {
            id: toolCallId,
            header: "Question",
            question,
            options: options.map((option) => ({ label: option.name, description: "" })),
          },
        ],
        raw: toolCall,
      } satisfies ProviderRequest);
    });
  }

  private pickOption(
    options: Array<{ optionId: string; name: string; kind: string }>,
    answer: "allow" | "reject",
  ): { optionId: string } | undefined {
    if (answer === "allow") {
      return (
        options.find((option) => option.kind === "allow_once") ??
        options.find((option) => option.kind === "allow_always") ??
        options.find((option) => /^allow/i.test(option.optionId))
      );
    }
    return (
      options.find((option) => option.kind === "reject_once") ??
      options.find((option) => option.kind === "reject_always") ??
      options.find((option) => /^(deny|reject)/i.test(option.optionId))
    );
  }

  // ===========================================================================
  // Errors
  // ===========================================================================

  private describeError(error: unknown): string {
    if (error instanceof AcpRequestError) {
      const data = asRecord(error.data);
      const detail = getString(data?.message) ?? getString(data?.details);
      return detail && !error.message.includes(detail)
        ? `${error.message}: ${detail}`
        : error.message;
    }
    return error instanceof Error ? error.message : String(error);
  }

  private describeAuthError(error: unknown): string {
    const text = this.describeError(error);
    if (
      (error instanceof AcpRequestError && error.code === -32000) ||
      /no browser is available|sign in|authenticat|login/i.test(text)
    ) {
      return `Antigravity isn't signed in. Run \`agy\` in a terminal and sign in, then send again. (${text})`;
    }
    return `Antigravity sign-in check failed: ${text}`;
  }
}
