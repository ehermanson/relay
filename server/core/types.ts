/**
 * Shared type definitions for Relay
 *
 * Pure type definitions with zero runtime imports.
 * Used by both server code and the React UI.
 */

// =============================================================================
// Terminal Types
// =============================================================================

export type TerminalScope =
  | { type: "space"; spaceId: string }
  | { type: "instance"; instanceId: string };

export interface TerminalInfo {
  id: string;
  scope: TerminalScope;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  exited: boolean;
  exitCode?: number;
}

// =============================================================================
// Space Types
// =============================================================================

export type SpaceStatus = "active" | "broken" | "completed" | "archived";
export type MergeMethod = "squash" | "merge-commit" | "external";

export interface SpaceInfo {
  id: string;
  projectDirectory: string;
  name: string;
  gitBranch: string | null;
  worktreePath: string | null;
  missingWorktreePath?: string | null;
  isDefault: boolean;
  status: SpaceStatus;
  createdAt: number;
  lastActivityAt: number;
  chatCount: number;
  mergeCommit?: string | null;
  mergeMethod?: MergeMethod | null;
  mergedAt?: number | null;
  targetBranch?: string | null;
  remoteStatus?: string | null;
  prUrl?: string | null;
}

// =============================================================================
// Suggestion Types
// =============================================================================

/**
 * String enum of allowed Lucide icon names for suggestions.
 * Mapped to actual Lucide components at render time in the UI.
 */
export type SuggestionIcon =
  | "Eye"
  | "FlaskConical"
  | "Play"
  | "ScrollText"
  | "Sparkles"
  | "Bug"
  | "Code"
  | "FileText"
  | "GitBranch"
  | "Lightbulb"
  | "ListChecks"
  | "MessageSquare"
  | "Pencil"
  | "Rocket"
  | "Search"
  | "Settings"
  | "Shield"
  | "Trash2"
  | "Wrench"
  | "Zap";

/** Patch applied to a built-in suggestion. `prompt` reserved for Phase 3 editing. */
export interface SuggestionPatch {
  prompt?: string;
  disabled?: boolean;
}

/** User-defined custom suggestion. */
export interface CustomSuggestion {
  id: string;
  label: string;
  description: string;
  icon: SuggestionIcon;
  prompt: string;
  disabled?: boolean;
}

/** Layered config: patches target built-in IDs, custom adds new suggestions. */
export interface SuggestionsConfig {
  patches: Record<string, SuggestionPatch>;
  custom: CustomSuggestion[];
}

/**
 * Conditions that control when a suggestion is visible.
 * - `"has-changes"` — only show when the working tree has uncommitted changes (client-evaluated)
 * - `"has-reviewable-diff"` — uncommitted changes OR commits ahead of base branch; for
 *   space chats this includes committed work on the space branch (client-evaluated)
 * - `"in-space"` — only show inside a space with sibling chats (client-evaluated)
 * - `"has-tasks"` — only show when the project has open tasks (server-evaluated, filtered before sending)
 */
export type SuggestionCondition = "has-changes" | "has-reviewable-diff" | "in-space" | "has-tasks";

/** Built-in suggestion definition (immutable base set). */
export interface BuiltInSuggestion {
  id: string;
  label: string;
  description: string;
  icon: SuggestionIcon;
  prompt: string;
  /** Client-evaluated visibility conditions. All must be satisfied. */
  conditions?: SuggestionCondition[];
}

/** Fully resolved suggestion ready for rendering. */
export interface ResolvedSuggestion {
  id: string;
  label: string;
  description: string;
  icon: SuggestionIcon;
  prompt: string;
  builtIn: boolean;
  /** Client-evaluated visibility conditions. All must be satisfied. */
  conditions?: SuggestionCondition[];
}

// =============================================================================
// Instance Types
// =============================================================================

export type InstanceStatus = "idle" | "processing" | "error" | "stopped";
export type ProviderKind = "claude" | "codex";
export type ProviderRuntimeMode =
  | "approval-required"
  | "full-access"
  | "plan"
  | "auto"
  | "writes-only";

/**
 * Canonical cross-provider reasoning effort level.
 * `max` is the Relay-canonical way to request the highest available effort.
 * Provider-native values (e.g. Codex `xhigh`) may appear via passthrough/restore.
 */
export type ReasoningEffort = "low" | "medium" | "high" | "max" | (string & {});

/**
 * Canonical provider-agnostic model options.
 * Provider drivers map these to provider-specific session args.
 */
export interface ProviderModelOptions {
  reasoningEffort?: ReasoningEffort;
  fastMode?: boolean;
}

export interface UserInputOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options?: UserInputOption[] | null;
  // When true the user may pick more than one option for this question (Claude's
  // AskUserQuestion `multiSelect`). The answer is always a `string[]`, so this only
  // affects how many entries it may hold and how the picker behaves.
  multiSelect?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
}

export interface UserInputAnswer {
  answers: string[];
}

export type ProviderRequestKind = "approval" | "user_input" | "terminal_input";
export type ProviderRequestCategory = "command" | "file_change" | "generic";
export type ProviderRequestSource = "agent" | "command" | "mcp" | "provider";

export interface ProviderNotice {
  level: "info" | "warning";
  scope?: "global" | "project" | "instance";
  source?: string;
  code?: string;
  message: string;
  detail?: string;
}

export type ProviderMcpScope = "global" | "project" | "chat" | "unknown";
export type ProviderMcpSource = "provider" | "relay";
export type ProviderMcpConnectionState =
  | "connected"
  | "connecting"
  | "needs_auth"
  | "failed"
  | "disabled"
  | "unknown";

export interface ProviderMcpTool {
  name: string;
  description?: string;
}

export interface ProviderMcpServerStatus {
  /** Stable within a Provider. Falls back to the Provider-reported name. */
  id: string;
  name: string;
  provider: ProviderKind;
  scope: ProviderMcpScope;
  source: ProviderMcpSource;
  /** Whether the Provider reports the server in configuration. */
  configured?: boolean;
  /** Whether the Provider reports the server loaded for the current scope/Chat. */
  available?: boolean;
  connectionState: ProviderMcpConnectionState;
  authentication?: {
    method: "oauth" | "bearer_token" | "none" | "unknown";
    login: boolean;
    logout: boolean;
  };
  tools?: ProviderMcpTool[];
  /** Raw Provider fields retained for diagnostics, never used for UI branching. */
  status?: string;
  authStatus?: string;
  connected?: boolean;
  toolCount?: number;
  detail?: string;
}

export interface ProviderRateLimitWindow {
  label?: string;
  limit?: number;
  remaining?: number;
  usedPercent?: number;
  windowMinutes?: number;
  resetAt?: string;
  /** "allowed" | "allowed_warning" | "rejected" — from Claude rate_limit_event */
  status?: string;
}

export interface ProviderRateLimitStatus {
  name?: string;
  scope?: string;
  plan?: string;
  windows?: ProviderRateLimitWindow[];
}

export interface ProviderAccountStatus {
  plan?: string;
  label?: string;
  email?: string;
  status?: string;
  rateLimits?: ProviderRateLimitStatus[];
}

export type ProviderSkillInvocationPrefix = "/" | "$";

export interface ProviderSlashCommand {
  name: string;
  description?: string;
  input?: {
    hint?: string;
  };
}

export interface ProviderSkill {
  name: string;
  displayName?: string;
  description?: string;
  shortDescription?: string;
  enabled?: boolean;
  scope?: string;
  path?: string;
  source?: SkillInfo["source"];
  invocationPrefix?: ProviderSkillInvocationPrefix;
}

export interface ProviderGlobalState {
  provider: ProviderKind;
  account?: ProviderAccountStatus;
  mcpServers?: ProviderMcpServerStatus[];
  apps?: string[];
  notices?: ProviderNotice[];
  updatedAt: number;
}

// Reserved for future provider state that is shared across chats in the same
// project/workspace but not necessarily global across the whole provider.
export interface ProviderProjectState {
  provider: ProviderKind;
  projectId: string;
}

export interface ProviderDiffStatus {
  status?: string;
  changedFiles?: number;
  summary?: string;
}

export interface ProviderStatusSummary {
  threadStatus?: string;
  turnStatus?: string;
  requestedModel?: string;
  effectiveModel?: string;
  reroutedFromModel?: string;
  slashCommands?: ProviderSlashCommand[];
  skills?: ProviderSkill[];
  mcpServers?: ProviderMcpServerStatus[];
  account?: ProviderAccountStatus;
  diff?: ProviderDiffStatus;
  apps?: string[];
  notices?: ProviderNotice[];
  /** SDK-reported reason fast mode is unavailable (SDK >= 0.3.219). */
  fastModeDisabledReason?: string;
}

export interface ProviderRequest {
  requestId: string;
  kind: ProviderRequestKind;
  category?: ProviderRequestCategory;
  source?: ProviderRequestSource;
  tool?: string;
  description?: string;
  questions?: UserInputQuestion[];
  prompt?: string;
  command?: string;
  cwd?: string;
  reason?: string;
  files?: string[];
  server?: string;
  raw?: Record<string, unknown>;
  agentId?: string;
}

export interface ProviderRequestResponse {
  answers?: Record<string, UserInputAnswer>;
  text?: string;
}

export interface ProviderContextBlock {
  key: string;
  kind: string;
  title: string;
  text: string;
  source?: string;
}

export interface ProviderSessionBootstrap {
  blocks: ProviderContextBlock[];
  baseInstructions?: string;
  developerInstructions?: string;
}

export interface ProviderSessionContext {
  bootstrap?: ProviderSessionBootstrap;
}

export interface ProviderRuntimeBinding {
  provider: ProviderKind;
  providerSessionId?: string;
  resumeCursor?: unknown;
  runtimePayload?: Record<string, unknown>;
  transcriptPath?: string;
  runtimeMode?: ProviderRuntimeMode;
}

export interface ControlOption {
  label: string;
  description: string;
}

export interface ProviderCapabilities {
  supportsResume: boolean;
  supportsTranscriptReplay: boolean;
  supportsApprovals: boolean;
  supportsUserInputRequests: boolean;
  supportsReasoningEffort: boolean;
  supportsFastMode: boolean;
  supportsModelSelection: boolean;
  supportsTitleUpdates: boolean;
  /** MCP discovery is read-only; configuration capabilities are intentionally separate. */
  mcp?: {
    discovery: "global" | "chat" | "global-and-chat";
    toolEnumeration: boolean;
    management?: {
      scopes: Array<"global" | "project">;
      bearerTokenEnvVar: boolean;
      transports: Array<"http" | "sse" | "stdio">;
    };
  };
  /** Labels/descriptions for reasoning effort levels, rendered by the UI as-is */
  reasoningEffortLevels?: {
    effort: ReasoningEffort;
    label: string;
    description: string;
    isDefault?: boolean;
  }[];
  /**
   * Runtime modes this provider exposes, with labels/descriptions for the UI.
   * Omitted modes are not selectable. Providers that omit this field render no
   * runtime-mode picker. The default mode is `"approval-required"`.
   */
  runtimeModes?: Partial<Record<ProviderRuntimeMode, ControlOption>>;
  /** Labels/descriptions for the fast mode toggle */
  fastModes?: { off: ControlOption; on: ControlOption };
  /**
   * When true, the session's stop/cancel path passes cancel_queued:true to the
   * SDK interrupt call so that queued messages are cancelled alongside the running
   * turn. Advertised by the CLI's interrupt_cancel_queued_v1 capability; set by
   * the Claude driver once the installed CLI version is confirmed to support it.
   */
  interruptCancelQueued?: boolean;
  /**
   * Advisory describing whether the provider's installed CLI is current with
   * the latest published version. Populated asynchronously by the version
   * probe; absent or `status: "unknown"` means the probe hasn't completed
   * (or failed). UI uses this to surface a launch toast + settings card.
   */
  versionAdvisory?: ProviderVersionAdvisory;
  /**
   * Hint text shown under the chat composer describing the input affordances
   * (@ mentions, / commands, $ skills) this provider supports. Rendered by the
   * UI verbatim — the UI must NOT branch on provider name to derive it.
   */
  composerHints?: { helpText: string };
}

export type ProviderInstallMethod = "npm" | "brew" | "bun" | "pnpm" | "native" | "manual";
export type ProviderVersionStatus = "unknown" | "current" | "behind_latest";

export interface ProviderVersionAdvisory {
  status: ProviderVersionStatus;
  currentVersion: string | null;
  latestVersion: string | null;
  /** npm package name (or equivalent), e.g. "@anthropic-ai/claude-code" */
  packageName: string | null;
  /** Human-readable update command, e.g. "npm install -g @anthropic-ai/claude-code@latest" */
  updateCommand: string | null;
  /** How the binary was installed, used to pick the update command and label it in UI */
  installMethod: ProviderInstallMethod | null;
  /** ISO timestamp of last successful probe; null if the probe has never completed */
  checkedAt: string | null;
}

export interface ProviderDescriptor {
  provider: ProviderKind;
  label: string;
  capabilities: ProviderCapabilities;
}

export interface ProviderModelOption {
  provider: ProviderKind;
  id: string;
  label: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  availabilityNote?: string;
  upgradeTo?: string;
  /**
   * Per-model capability overrides. Merged on top of the provider's default
   * capabilities by `mergeCapabilities()` — present fields win, omitted fields
   * inherit from the provider. Use for model-specific deltas (e.g. latest Opus
   * exposes a higher reasoning-effort tier than other Claude models).
   *
   * Populated programmatically when the provider exposes per-model metadata
   * (Claude SDK's `supportedModels()` reports `supportedEffortLevels` etc.),
   * or hardcoded in the builtin catalog otherwise.
   */
  capabilities?: Partial<ProviderCapabilities>;
  /** Provider-default capabilities with per-model overrides already applied. */
  resolvedCapabilities?: ProviderCapabilities;
}

export interface ProviderModelsResponse {
  provider: ProviderKind;
  models: ProviderModelOption[];
  capabilities: ProviderCapabilities;
  defaultModel?: ProviderModelOption;
}

export interface ProviderDefaults {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  runtimeMode?: ProviderRuntimeMode;
  fastMode?: boolean;
}

export interface GlobalSettings {
  theme: "dark" | "light" | "system";
  defaultOpenTarget: string | null;
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultSpaceBranch: string | null;
  spaceBranchSource: "local" | "remote";
  providerDefaults: Record<string, ProviderDefaults>;
  customInstructions: string | null;
  projectOrder: string[] | null;
  suggestions: SuggestionsConfig | null;
  /**
   * Max concurrent managed sessions. `null` falls back to the server default
   * (MAX_PROCESSES env or 15). Applied live — no restart required.
   */
  maxProcesses: number | null;
  /**
   * Sidebar presentation. `"inbox"` (the default) is one flat recency-sorted
   * list across every project; `"projects"` groups chats under collapsible
   * project headers.
   */
  sidebarLayout: SidebarLayout;
}

export type SidebarLayout = "projects" | "inbox";

export interface SessionStats {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Model identifier from the most recent API response (e.g. "claude-opus-4-6") */
  model?: string;
  /**
   * Most recent context footprint reported by the provider for the current thread/request.
   * Represents current context window utilization — NOT a cumulative session total.
   * When available, this should include cached input that still occupies context.
   */
  contextTokens?: number;
  /** Provider-reported context window size when available. */
  contextWindow?: number;
  /** Per-category context token breakdown from SDK getContextUsage() when available. */
  contextCategories?: { name: string; tokens: number; color: string; isDeferred?: boolean }[];
  /** Reasoning/thinking output tokens (Codex/OpenAI models). */
  reasoningTokens?: number;
}

export interface LastMessagePreview {
  text: string;
  from: "user" | "assistant";
  timestamp: number;
}

export interface ReviewSessionInfo {
  sourceInstanceId?: string;
  sourceSessionId?: string;
  sourceName: string;
  scope: "session-files" | "branch";
  filePaths?: string[];
}

export interface InstanceInfo {
  id: string;
  provider: ProviderKind;
  name: string;
  workingDirectory: string;
  status: InstanceStatus;
  createdAt: number;
  lastActivityAt: number;
  external?: boolean;
  lastMessage?: LastMessagePreview;
  /** Tool name when an external/terminal session has a pending tool_use awaiting approval */
  pendingTool?: string;
  /** Pending managed-provider request awaiting user action */
  pendingPermission?: ProviderRequest;
  /** Provider-native live status/details that do not belong in transcript history */
  providerStatus?: ProviderStatusSummary;
  sessionId?: string;
  /** True when the user has manually set the title (prevents auto-refresh) */
  customTitle?: boolean;
  /** True when the user pinned this chat to the top of its project's chat lists */
  pinned?: boolean;
  /**
   * Timestamp the user marked this chat done. The chat only reads as done
   * while its recency is at or below this value, so later activity revives it.
   */
  doneAt?: number;
  /** Running token/cost stats for this session */
  stats?: SessionStats;
  /** Git branch name when instance runs in a worktree (e.g. "relay/a1b2c3d4") */
  gitBranch?: string;
  /** True when the worktree has uncommitted changes or commits ahead of the original branch */
  hasChanges?: boolean;
  /** Original project directory before worktree substitution */
  originalDirectory?: string;
  /** Git metadata for the working directory (directory-level, independent of worktrees) */
  gitInfo?: { branch: string; isWorktree: boolean };
  /** Git branch at session creation time — used to detect mid-chat branch switches */
  originalGitBranch?: string;
  /** Set when the current branch differs from the branch this chat started on */
  branchChanged?: { originalBranch: string; currentBranch: string };
  /** Claude session ID of the plan-mode parent (UI-only link, no state merging) */
  parentSessionId?: string;
  /** Preferred model override for this instance (e.g. "claude-opus-4-6") */
  preferredModel?: string;
  /** Canonical provider-agnostic model options */
  modelOptions?: ProviderModelOptions;
  /** Active provider runtime mode for this instance (defaults to "approval-required") */
  runtimeMode?: ProviderRuntimeMode;
  /** Pending plan markdown from ExitPlanMode, awaiting user approval/feedback */
  pendingPlan?: string;
  /** Latest plan document content for sidecar display (persists after approval) */
  planContent?: string;
  /** Project ID this instance belongs to */
  projectId?: string;
  /** Stable, URL-safe slug of the project this instance belongs to. Mirrors `Project.slug`. */
  projectSlug?: string;
  /** Space this instance belongs to (null = implicit main space) */
  spaceId?: string;
  /** Number of user messages queued while the agent is processing */
  queuedMessageCount?: number;
  /** Internal bootstrap/runtime context Relay supplied to the provider. */
  sessionContext?: ProviderSessionContext;
  /** Review-session metadata when this chat was created to audit another chat's work. */
  review?: ReviewSessionInfo;
  /** Attached review instance for this chat, rendered in the sidecar rather than main nav. */
  reviewInstanceId?: string;
}

export interface HistoryEntry {
  timestamp: number;
  message: ServerMessage;
  /** Raw SDK/provider message object for debug display. */
  raw?: unknown;
}

// =============================================================================
// Client -> Server Messages
// =============================================================================

export interface MessagePayload {
  type: "message";
  text: string;
}

export interface CancelPayload {
  type: "cancel";
}

export interface ListInstancesPayload {
  type: "list_instances";
}

export interface CreateInstancePayload {
  type: "create_instance";
  provider?: ProviderKind;
  name?: string;
  workingDirectory?: string;
  /** Resume an existing Claude Code session by ID */
  resumeSessionId?: string;
  /** Model ID to use (e.g. "claude-opus-4-6") */
  model?: string;
  /** Space to create this instance in */
  spaceId?: string;
  /** Canonical model options (reasoning budget, effort, fast mode) */
  modelOptions?: ProviderModelOptions;
  /** Initial runtime mode (defaults to "approval-required") */
  runtimeMode?: ProviderRuntimeMode;
  /** Parent session ID for child chats like reviews or plan continuations */
  parentSessionId?: string;
  /** Review-session metadata */
  review?: ReviewSessionInfo;
}

export interface RemoveInstancePayload {
  type: "remove_instance";
  instanceId: string;
}

export interface PurgeInstancePayload {
  type: "purge_instance";
  instanceId: string;
}

export interface StopInstancePayload {
  type: "stop_instance";
  instanceId: string;
}

export interface SubscribePayload {
  type: "subscribe";
  instanceId: string;
  lastSeenSequence?: number;
  replayEpoch?: number;
}

export interface UnsubscribePayload {
  type: "unsubscribe";
  instanceId: string;
}

export interface InstanceMessagePayload {
  type: "instance_message";
  instanceId: string;
  text: string;
  /** Paths to image attachments — render inline as <img> in the transcript. */
  images?: string[];
  /** Paths to non-image file attachments — render as a clickable chip. */
  attachments?: string[];
  internal?: boolean;
}

export interface InstanceCancelPayload {
  type: "instance_cancel";
  instanceId: string;
}

export interface InstanceInterruptAndSendPayload {
  type: "instance_interrupt_and_send";
  instanceId: string;
}

export interface RemoveQueuedMessagePayload {
  type: "remove_queued_message";
  instanceId: string;
  queuedId: string;
}

export interface InstanceTakeoverPayload {
  type: "instance_takeover";
  instanceId: string;
}

export interface RespondToRequestPayload {
  type: "respond_to_request";
  instanceId: string;
  requestId: string;
  decision: "accept" | "decline";
  answers?: Record<string, UserInputAnswer>;
  text?: string;
}

export interface RenameInstancePayload {
  type: "rename_instance";
  instanceId: string;
  name: string;
}

export interface RenameSpacePayload {
  type: "rename_space";
  spaceId: string;
  name: string;
}

export interface MergeInstancePayload {
  type: "merge_instance";
  instanceId: string;
}

export interface SetModelPayload {
  type: "set_model";
  instanceId: string;
  /** Model ID to use (e.g. "claude-opus-4-6"), or null to clear the preference */
  model: string | null;
}

export interface SetRuntimeModePayload {
  type: "set_runtime_mode";
  instanceId: string;
  mode: ProviderRuntimeMode;
}

export interface SetModelOptionsPayload {
  type: "set_model_options";
  instanceId: string;
  /** Sparse merge: omitted key = leave unchanged, null = clear/reset to default */
  modelOptions: {
    reasoningEffort?: ReasoningEffort | null;
    fastMode?: boolean | null;
  };
}

export interface SetProviderPayload {
  type: "set_provider";
  instanceId: string;
  /** Target provider to switch to */
  provider: ProviderKind;
}

export interface SetReviewInstancePayload {
  type: "set_review_instance";
  instanceId: string;
  reviewInstanceId: string;
}

export interface CreateSpacePayload {
  type: "create_space";
  projectDirectory: string;
  name?: string;
  baseBranch?: string;
}

export interface CompleteSpacePayload {
  type: "complete_space";
  spaceId: string;
  mergeMethod?: MergeMethod;
  squashMessage?: string;
}

export interface MarkSpaceMergedPayload {
  type: "mark_space_merged";
  spaceId: string;
}

export interface DeleteSpacePayload {
  type: "delete_space";
  spaceId: string;
}

// ── Terminal client messages ──────────────────────────────────────────

export interface TerminalCreatePayload {
  type: "terminal_create";
  scope: TerminalScope;
  cwd?: string;
  cols?: number;
  rows?: number;
  /** When true, the server will only create a terminal if none exist for this scope. */
  ifEmpty?: boolean;
}

export interface TerminalInputPayload {
  type: "terminal_input";
  terminalId: string;
  data: string;
}

export interface TerminalResizePayload {
  type: "terminal_resize";
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalClosePayload {
  type: "terminal_close";
  terminalId: string;
}

export interface TerminalSubscribePayload {
  type: "terminal_subscribe";
  terminalId: string;
}

export interface TerminalUnsubscribePayload {
  type: "terminal_unsubscribe";
  terminalId: string;
}

export interface TerminalListPayload {
  type: "terminal_list";
  scope: TerminalScope;
}

export type ClientMessage =
  | MessagePayload
  | CancelPayload
  | ListInstancesPayload
  | CreateInstancePayload
  | RemoveInstancePayload
  | PurgeInstancePayload
  | StopInstancePayload
  | SubscribePayload
  | UnsubscribePayload
  | InstanceMessagePayload
  | InstanceCancelPayload
  | InstanceInterruptAndSendPayload
  | RemoveQueuedMessagePayload
  | InstanceTakeoverPayload
  | RespondToRequestPayload
  | RenameInstancePayload
  | RenameSpacePayload
  | MergeInstancePayload
  | SetModelPayload
  | SetRuntimeModePayload
  | SetModelOptionsPayload
  | SetProviderPayload
  | SetReviewInstancePayload
  | CreateSpacePayload
  | CompleteSpacePayload
  | MarkSpaceMergedPayload
  | DeleteSpacePayload
  | TerminalCreatePayload
  | TerminalInputPayload
  | TerminalResizePayload
  | TerminalClosePayload
  | TerminalSubscribePayload
  | TerminalUnsubscribePayload
  | TerminalListPayload;

// =============================================================================
// Server -> Client Messages
// =============================================================================

export interface ConnectedMessage {
  type: "connected";
}

export interface OutputMessage {
  type: "output";
  text: string;
  isWaiting: boolean;
  thinking?: string;
  instanceId?: string;
  eventSequence?: number;
  /** Unix ms timestamp from the SDK's model-completion event — more accurate than server receive time. */
  modelTimestamp?: number;
  /** True when this turn was cut short by a user interrupt before completion. */
  aborted?: boolean;
  /** Raw SDK/provider message for debug display. */
  raw?: unknown;
}

export interface UserMessage {
  type: "user";
  text: string;
  images?: string[];
  attachments?: string[];
  instanceId?: string;
  eventSequence?: number;
  /** If true, this message was injected programmatically (e.g. auto-continue after restart) and should be hidden from the chat UI. */
  internal?: boolean;
  /** True when this message was queued while the agent was processing and hasn't been delivered yet. */
  queued?: boolean;
  /** Stable id for a queued message so it can be removed/edited before dispatch. */
  queuedId?: string;
  /** Raw text as typed (no attachment markers) — used to restore into the composer on edit. */
  queuedSourceText?: string;
}

/** A queued (not yet dispatched) user message was removed before delivery. */
export interface QueuedRemovedMessage {
  type: "queued_removed";
  instanceId: string;
  queuedId: string;
  eventSequence?: number;
}

export interface ExitMessage {
  type: "exit";
  code: number;
  signal?: string;
  stderr?: string;
  instanceId?: string;
  eventSequence?: number;
}

export interface ErrorMessage {
  type: "error";
  message: string;
  instanceId?: string;
  /** Machine-readable error discriminator (e.g. "max_processes"). */
  code?: string;
  /** Resolved concurrent-process cap when `code === "max_processes"`. */
  limit?: number;
  /**
   * Echo of the create request that failed, so the client can retry it after
   * the user frees capacity. Present on `code === "max_processes"` errors from
   * the `create_instance` WS path.
   */
  createRequest?: Omit<CreateInstancePayload, "type">;
}

export interface NotificationMessage {
  type: "notification";
  message: string;
  instanceId?: string;
}

export type SystemEventType =
  | "compact_boundary"
  | "session_init"
  | "provider_status"
  | "provider_notice"
  | "model_rerouted"
  | "model_switched";

export interface SystemEventMessage {
  type: "system_event";
  event: SystemEventType;
  instanceId?: string;
  eventSequence?: number;
  payload?: Record<string, unknown>;
  /** Raw SDK/provider message for debug display. */
  raw?: unknown;
}

export interface TaskItem {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface FileChange {
  path: string;
  editCount: number;
  /** "added" when first operation was Write, "edited" for Edit/NotebookEdit */
  type: "added" | "edited";
  /** Lines added (from git diff --numstat) */
  additions?: number;
  /** Lines deleted (from git diff --numstat) */
  deletions?: number;
}

/**
 * Normalized Edit tool input — provider-agnostic shape emitted by both
 * Claude and Codex. Always contains a patch diff string; both providers
 * convert to this format server-side.
 * One activity per file; counts are pre-computed.
 */
export interface EditToolInput {
  file_path: string;
  /** File extension without the dot (e.g. "ts", "tsx"). */
  extension?: string;
  /** Patch diff string (the `@@` / `+` / `-` format). */
  diff?: string;
  /** Server-computed line counts so the UI can display +/- without recomputing. */
  additions?: number;
  deletions?: number;
  /** File change kind: "add", "update", "delete". */
  kind?: string;
  /** Destination path when a file is moved/renamed. */
  movePath?: string;
}

export interface ActivityMessage {
  type: "activity";
  activity: "tool_use" | "tool_result" | "thinking" | "task_list" | "file_list";
  tool?: string;
  description: string;
  detail?: string;
  input?: Record<string, unknown>;
  instanceId?: string;
  eventSequence?: number;
  permissionDenied?: string;
  /** Resolution of an interactive tool (ExitPlanMode, AskUserQuestion) from the terminal. */
  resolution?: "approved" | "dismissed" | "feedback";
  tasks?: TaskItem[];
  files?: FileChange[];
  inputDescription?: string;
  mcp?: {
    serverId: string;
    serverName: string;
    toolName: string;
    callId?: string;
    durationMs?: number;
  };
  /** SDK-reported reason a tool was not executed (SDK >= 0.3.216). */
  toolResultMeta?: {
    nonExecutionKind?: string;
    userFeedback?: string;
  };
  /** Raw SDK/provider message for debug display. */
  raw?: unknown;
}

export interface InstanceListMessage {
  type: "instance_list";
  instances: InstanceInfo[];
}

export interface InstanceCreatedMessage {
  type: "instance_created";
  instanceId: string;
  instance: InstanceInfo;
}

export interface InstanceRemovedMessage {
  type: "instance_removed";
  instanceId: string;
}

export interface InstanceStatusMessage {
  type: "instance_status";
  instanceId: string;
  instance: InstanceInfo;
}

export interface ProviderGlobalStateListMessage {
  type: "provider_global_state_list";
  states: ProviderGlobalState[];
}

export interface ProviderGlobalStateMessage {
  type: "provider_global_state";
  provider: ProviderKind;
  state: ProviderGlobalState;
}

export interface InstanceHistoryMessage {
  type: "instance_history";
  instanceId: string;
  history: HistoryEntry[];
  replayMode?: "full" | "delta";
  latestSequence?: number;
  replayEpoch?: number;
}

export interface TranscriptMessage {
  type: "transcript";
  title: string;
  result: string;
  instanceId?: string;
  eventSequence?: number;
}

export interface ScanCompleteMessage {
  type: "scan_complete";
}

export interface ProjectsChangedMessage {
  type: "projects_changed";
  projects: Project[];
}

export interface TasksChangedMessage {
  type: "tasks_changed";
  projectId: string;
  tasks: Task[];
}

export interface SpaceCreatedMessage {
  type: "space_created";
  space: SpaceInfo;
}

export interface SpaceCompletedMessage {
  type: "space_completed";
  spaceId: string;
  targetBranch: string;
  mergeMethod?: string;
  mergeCommit?: string;
}

export interface SpaceRemovedMessage {
  type: "space_removed";
  spaceId: string;
}

export interface SpaceListMessage {
  type: "space_list";
  projectDirectory: string;
  spaces: SpaceInfo[];
}

// ── Terminal server messages ──────────────────────────────────────────

export interface TerminalCreatedMessage {
  type: "terminal_created";
  terminal: TerminalInfo;
}

export interface TerminalOutputMessage {
  type: "terminal_output";
  terminalId: string;
  data: string;
}

export interface TerminalExitMessage {
  type: "terminal_exit";
  terminalId: string;
  code: number;
  signal?: string;
}

export interface TerminalRemovedMessage {
  type: "terminal_removed";
  terminalId: string;
}

export interface TerminalScrollbackMessage {
  type: "terminal_scrollback";
  terminalId: string;
  data: string;
}

export interface TerminalListResponse {
  type: "terminal_list_response";
  scope: TerminalScope;
  terminals: TerminalInfo[];
}

/** Live-terminal count for a single scope (chat or space). */
export interface TerminalScopeSummary {
  scope: TerminalScope;
  /** Number of live (non-exited) terminals in this scope. */
  count: number;
}

/**
 * Global snapshot of which scopes currently have live terminals.
 * Broadcast to all clients on every terminal lifecycle change so the
 * sidebar can flag chats/spaces with running terminals without having
 * to open each scope first.
 */
export interface TerminalScopesMessage {
  type: "terminal_scopes";
  scopes: TerminalScopeSummary[];
}

// =============================================================================
// Update Types
// =============================================================================

export type UpdateStatus =
  | "unavailable"
  | "idle"
  | "checking"
  | "available"
  | "up_to_date"
  | "updating"
  | "restart_pending"
  | "error";

/**
 * Sub-stage of the "updating" status, so the UI can surface finer-grained
 * progress (pull → install deps → build → restart). `null` when not installing.
 */
export type UpdateStage = "pulling" | "installing" | "building" | "restarting";

export interface UpdateSnapshot {
  enabled: boolean;
  installAction: "restart";
  status: UpdateStatus;
  stage: UpdateStage | null;
  currentVersion: string;
  currentCommit: string | null;
  latestCommit: string | null;
  updateAvailable: boolean;
  checkedAt: number | null;
  error: string | null;
}

export interface UpdateInstallResult {
  ok: boolean;
  action: "restart";
  error?: string;
}

export interface SpinOffCreatedMessage {
  type: "spin_off_created";
  spinOff: SpinOffInfo;
}

export interface SpinOffSentMessage {
  type: "spin_off_sent";
  spinOff: SpinOffInfo;
}

export interface HeartbeatMessage {
  type: "heartbeat";
}

export type ServerMessage =
  | ConnectedMessage
  | OutputMessage
  | UserMessage
  | QueuedRemovedMessage
  | ExitMessage
  | ErrorMessage
  | NotificationMessage
  | SystemEventMessage
  | ActivityMessage
  | InstanceListMessage
  | InstanceCreatedMessage
  | InstanceRemovedMessage
  | InstanceStatusMessage
  | ProviderGlobalStateListMessage
  | ProviderGlobalStateMessage
  | InstanceHistoryMessage
  | TranscriptMessage
  | ScanCompleteMessage
  | ProjectsChangedMessage
  | TasksChangedMessage
  | SpaceCreatedMessage
  | SpaceCompletedMessage
  | SpaceRemovedMessage
  | SpaceListMessage
  | TerminalCreatedMessage
  | TerminalOutputMessage
  | TerminalExitMessage
  | TerminalRemovedMessage
  | TerminalScrollbackMessage
  | TerminalListResponse
  | TerminalScopesMessage
  | SpinOffCreatedMessage
  | SpinOffSentMessage
  | HeartbeatMessage;

// =============================================================================
// Session Types
// =============================================================================

export interface Session {
  id: string;
  createdAt: number;
  expiresAt: number;
}

// =============================================================================
// Project Artifact Types
// =============================================================================

export interface Project {
  id: string;
  name: string;
  /**
   * Stable, URL-safe identifier derived from the project's directory basename at
   * registration time. Sticky: not recomputed when `name` is edited. Unique across
   * registered projects (collisions are suffixed with `-2`, `-3`, …).
   */
  slug: string;
  directory: string;
  repoRoot: string | null;
  remoteUrl: string | null;
  targetBranch: string | null;
  customInstructions: string | null;
  defaultSpaceBranch: string | null;
  spaceBranchSource: "local" | "remote" | null;
  defaultProvider: string | null;
  defaultModel: string | null;
  createdAt: number;
  lastActivityAt: number | null;
  suggestions: SuggestionsConfig | null;
}

export interface ProjectPlan {
  slug: string;
  title: string;
  modifiedAt: number;
  content: string;
}

export interface ModelUsageStats {
  model: string;
  providerName: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface ProjectStats {
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelUsage: ModelUsageStats[];
}

export type NativeOpenTargetKind = "default" | "app" | "finder" | "file-manager" | "terminal";

export interface NativeOpenTarget {
  id: string;
  label: string;
  kind: NativeOpenTargetKind;
  description?: string;
}

export interface NativeOpenTargetsResponse {
  path: string;
  preferredTargetId: string | null;
  targets: NativeOpenTarget[];
}

export interface NativeOpenRequest {
  path: string;
  line?: number;
  column?: number;
  targetId?: string;
  rememberForProject?: boolean;
}

export type TaskStatus = "open" | "in_progress" | "blocked" | "done";
export type TaskType = "epic" | "task" | "bug";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  type: TaskType;
  tags: string[];
  parent: string | null;
  blockedBy: string[];
  createdAt: string;
  updatedAt: string;
  /** Tombstone flag for append-only deletion */
  deleted?: boolean;
}

export interface SkillInfo {
  /** Skill name from SKILL.md frontmatter (or directory name fallback) */
  name: string;
  /** Description / trigger text from SKILL.md frontmatter */
  description: string;
  /** Where the skill was discovered (highest-priority location wins) */
  source: "project" | "user" | "system";
  /** Absolute path to the skill directory (highest-priority location) */
  path: string;
  /** Which providers can use this skill (based on which directories it was found in) */
  providers: ProviderKind[];
}

// =============================================================================
// Spin-off Types
// =============================================================================

export type SpinOffStatus = "draft" | "sent";

/**
 * Structured spin-off packet — minimal context for starting a focused follow-up
 * chat. Empty/null sections should be omitted entirely in the rendered output.
 */
export interface SpinOffPacket {
  currentState?: string;
  touchedFiles?: string;
}

/**
 * Standalone spin-off object with bidirectional provenance links.
 * Persisted in SQLite; the packet payload is stored as JSON.
 */
export interface SpinOffInfo {
  id: string;
  sourceChatId: string;
  sourceChatName: string | null;
  targetChatId: string | null;
  targetChatName: string | null;
  sourceAnchorMessageIndex: number | null;
  packet: SpinOffPacket;
  status: SpinOffStatus;
  createdAt: number;
  sentAt: number | null;
}

export interface ProjectArtifacts {
  projectId: string;
  /** Sticky human-readable identifier used in URLs. Undefined for unregistered projects. */
  projectSlug?: string;
  directory: string;
  memory: string | null;
  /** Contents of CLAUDE.md from the project root */
  claudeMd: string | null;
  /** Contents of README.md from the project root (last-resort fallback) */
  readmeMd: string | null;
  plans: ProjectPlan[];
  /** Aggregated token/cost stats across all sessions in this project */
  stats: ProjectStats;
  /** GitHub/GitLab repository URL for this project (from git remote) */
  githubUrl: string | null;
  /** Tasks from .relay/tasks.json, if present in the project */
  tasks: Task[] | null;
  /** Installed skills discovered from .claude/skills/, ~/.claude/skills/, etc. */
  skills: SkillInfo[];
  /** Spaces in this project */
  spaces: SpaceInfo[];
}
