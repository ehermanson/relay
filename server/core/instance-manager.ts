/**
 * Instance Manager for Relay
 *
 * Manages multiple Claude Code instances, each with its own
 * provider session (SDK or CLI), metadata, and conversation history.
 *
 * Also discovers and monitors externally-running Claude Code sessions
 * by watching ~/.claude/session-env/ and their JSONL transcript files.
 */

import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { constants as osConstants } from "os";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  statSync,
  fstatSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { findProjectIcon } from "#core/favicon-scanner.js";
import type { ProviderSession } from "#core/provider.js";
import {
  resolveQueryFn,
  prewarmSdk,
  getSdkDiscoveredAccountInfo,
  getSdkDiscoveredModels,
  getSdkDiscoveredRateLimits,
} from "#core/providers/claude-sdk.js";
import type { ClaudeSdkSession } from "#core/providers/claude-sdk.js";
import { convertCodexTranscriptEntry } from "#core/providers/codex-transcript.js";
import { fetchCodexProviderGlobalStateSnapshot } from "#core/providers/codex-app-server.js";
import { getCachedCodexModels, prewarmCodexModels } from "#core/providers/codex-models.js";
import { isCodexInstalled } from "#core/providers/codex-cli.js";
import { SessionDB } from "#core/db.js";
import type { SessionRow, ManagedInstanceRow, SessionEventRow } from "#core/db.js";
import {
  BUILTIN_PROVIDER_MODELS,
  resolveProviderDefaultModelOption,
} from "#core/provider-catalog.js";
import { overlayManagedMcpConfiguration } from "#core/mcp.js";
import { SpaceManager } from "#core/space-manager.js";
import { SpinOffManager } from "#core/spin-off-manager.js";
import { ProjectManager } from "#core/project-manager.js";
import type { Project } from "#core/types.js";
import { discoverSkills } from "#core/skills.js";
import { hasTasks, loadTasks } from "#core/task-manager.js";
import type { CoreConfig } from "#core/config.js";
import { relayDir } from "#core/config.js";
import {
  providerStateFilePath,
  loadPersistedProviderState,
  persistProviderState,
} from "#core/provider-state-file.js";
import { createPatch } from "diff";
import { extFromPath } from "#core/paths.js";
import {
  buildKnownJsonlMap,
  collectActiveExternalSessions,
  emptyDiscoveryPollStats,
  formatSlowDiscoveryWarning,
  normalizeDiscoveryResult,
  type DiscoveryPollStats,
} from "#core/instance-discovery.js";
import {
  hasSessionStats,
  sortChatsByLastActivity,
  summaryFromManagedRow,
  summaryFromSessionRow,
  toChatSummaryInfo,
} from "#core/instance-listing.js";
import {
  buildPersistenceOwnershipReconciliation,
  getPersistenceRowProjectDirectory,
  getProjectDirectoryCandidates,
  normalizeProjectDirectory,
} from "#core/instance-ownership.js";
import {
  buildBackfilledManagedRow,
  buildBackfilledSessionRow,
  compareManagedCanonicalRows,
  hasPersistedTokenUsage,
  isSameManagedSessionIdentity,
  mergeBackfilledStats,
  toManagedInstanceRow,
  toSessionRow,
} from "#core/instance-persistence.js";
import { parseManagedRestoreState } from "#core/managed-session-restore.js";
import { restorePersistedRows } from "#core/instance-restore-pass.js";
import {
  buildExternalRestoreState,
  buildManagedRestoreState,
} from "#core/instance-restore-state.js";
import {
  attachReviewLinks,
  getAttachedReviewIds,
  pickPreferredAttachedReview,
  reviewBelongsToSource,
} from "#core/review-sessions.js";
import {
  collectManagedSessionKeys,
  isManagedShadowInstance,
  isManagedShadowSessionRow,
  mergeProviderBinding,
} from "#core/managed-session-identity.js";
import type {
  ServerMessage,
  OutputMessage,
  ExitMessage,
  ActivityMessage,
  UserMessage,
  TranscriptMessage,
  InstanceStatus,
  LastMessagePreview,
  InstanceInfo,
  HistoryEntry,
  Task,
  TaskItem,
  FileChange,
  SessionStats,
  ProjectArtifacts,
  ProjectPlan,
  ProviderKind,
  ProviderDescriptor,
  ProviderModelOptions,
  ProviderSkill,
  ProviderSlashCommand,
  ProviderContextBlock,
  ProviderRequest,
  ProviderRuntimeBinding,
  ProviderRuntimeMode,
  ProviderSessionBootstrap,
  SpaceInfo,
  ReasoningEffort,
  ProviderModelOption,
  UserInputQuestion,
  SystemEventMessage,
  SystemEventType,
  EditToolInput,
} from "#core/types.js";
import {
  captureManagedSessionForProvider,
  createManagedProviderSession,
  discoverLiveExternalSessions,
  getProviderCapabilities,
  getProviderModels,
  isProviderAvailable,
  listAvailableProviders,
  parseTranscriptForProvider,
  resolveManagedTranscriptPathForProvider,
} from "#core/provider-registry.js";
import {
  AUTO_CONTINUE_MSG,
  buildCustomInstructionsPrompt,
  buildFirstTurnTaskContextPrompt,
  buildPermissionGrantedRetryMessage,
  isInternalInjectedUserText,
  stripInjectedWrapper,
} from "#core/internal-user-messages.js";
import {
  buildSessionBootstrapContext,
  CUSTOM_INSTRUCTIONS_BLOCK_KIND,
  extractSpaceContextForInjection,
  getSessionContextFromRuntimePayload,
  hasSessionBootstrapBlock,
  SPACE_CONTEXT_BLOCK_KIND,
  TASK_CONTEXT_BLOCK_KIND,
} from "#core/session-context.js";
import {
  describeToolUse,
  describeToolDetail,
  extractInputDescription,
  extractToolResultText,
  extractAskQuestionTexts,
  parseAskUserQuestionAnswerText,
  INTERACTIVE_TOOLS,
  buildToolResultActivity,
  capDetail,
  TASK_TOOLS,
  FILE_WRITE_TOOLS,
  FILE_WRITE_GROUP,
} from "#core/tools.js";
import { buildSessionInitEvent } from "#core/session-init.js";
import {
  isGitRepo,
  getRepoRoot,
  getRemoteUrl,
  getCurrentBranch,
  removeWorktree,
  isWorktreeDirty,
  hasWorktreeChanges,
  commitAll,
  mergeWorktreeBranch,
  isRelayWorktreePath,
  resolveWorktreeOrigin,
  isGitWorktree,
  resolveAnyWorktreeOrigin,
  enrichDiffStats,
  enrichDiffStatsAsync,
  getCurrentBranchAsync,
  getGitInfoAsync,
  hasWorktreeChangesAsync,
  getFullDiff,
  getFileDiff,
} from "#core/git.js";
import {
  explicitOrInferredSpaceIdForPersistenceRow,
  inferSpaceIdForPersistenceRow,
  resolveExternalRestorePaths,
  resolveManagedRestorePaths,
} from "#core/instance-restore.js";
import { searchWorkspaceEntries, type WorkspaceEntry } from "#core/workspace-entries.js";
import { isPathWithinWorkspace } from "#core/workspace-paths.js";

// =============================================================================
// Re-exports
// =============================================================================

export type {
  InstanceStatus,
  LastMessagePreview,
  InstanceInfo,
  HistoryEntry,
} from "#core/types.js";

// =============================================================================
// Internal Types
// =============================================================================

interface ExternalState {
  jsonlPath: string;
  sessionId: string;
  /** PID of the external Claude CLI process (for SIGINT on takeover) */
  pid?: number;
}

interface WatchState {
  jsonlPath: string;
  fileOffset: number;
  /** Tracks tool_use_id → tool name for permission denial attribution */
  pendingTools: Map<string, string>;
  pendingTaskCreates: Map<string, { subject: string; activeForm?: string }>;
  pendingProviderCalls: Map<string, { name: string; arguments?: string }>;
  stats: SessionStats;
}

interface TranscriptParseResult {
  cwd: string;
  history: HistoryEntry[];
  tasks: Map<string, TaskItem>;
  files: Map<string, FileChange>;
  stats: SessionStats;
}

interface TranscriptCacheEntry {
  cacheKey: string;
  parsed: TranscriptParseResult;
}

function isUsableStoredWorktreePath(
  worktreePath: string | null | undefined,
): worktreePath is string {
  return Boolean(worktreePath && existsSync(worktreePath) && isGitRepo(worktreePath));
}

interface Instance {
  info: InstanceInfo;
  process: ProviderSession | null;
  providerBinding?: ProviderRuntimeBinding;
  history: HistoryEntry[];
  /** JSONL entries at or before this timestamp were already handled by the managed process */
  processHandledUntil?: number;
  externalState?: ExternalState;
  /** JSONL file watching state — independent of external vs managed */
  watchState?: WatchState;
  /** Auto-generate a title from the first user message */
  autoTitle?: boolean;
  /** Claude Code session ID (captured after first message exchange) */
  sessionId?: string;
  /** Path to the JSONL transcript file for this session */
  jsonlPath?: string;
  /** Accumulated task list state for task_list activity rendering */
  tasks?: Map<string, TaskItem>;
  /** Accumulated file change state for file_list activity rendering */
  files?: Map<string, FileChange>;
  /** Monotonic revision for file-state refreshes to guard async enrichment */
  fileStateRevision: number;
  /** Queued retry message when tool approval arrives while process is still running */
  pendingRetry?: string;
  /** Messages queued by the user while the agent is mid-turn */
  pendingMessages?: Array<{
    /** Stable id so a queued message can be removed/edited before dispatch */
    id: string;
    text: string;
    images?: string[];
    attachments?: string[];
    internal?: boolean;
  }>;
  /** Set when interrupt was triggered specifically to deliver queued messages */
  interruptedToSend?: boolean;
  /** Last plan file path detected from Edit/Write activity while in plan mode */
  planFilePath?: string;
  /** Path to the git worktree (if this instance runs in isolation) */
  worktreePath?: string;
  /** Git branch name for this instance's worktree */
  gitBranch?: string;
  /** Original project directory before worktree substitution */
  originalDirectory?: string;
  /** Actual CWD passed to the provider session (worktree path or original) */
  actualCwd?: string;
  /** False when only skeleton metadata is loaded from DB; true after full JSONL parse + git info */
  hydrated: boolean;
  /** True after task context has been injected into this session */
  taskContextInjected?: boolean;
  /** True after custom instructions have been injected into this session */
  customInstructionsInjected?: boolean;
  /** True while an async git-branch refresh is in flight */
  refreshingGitBranch?: boolean;
  /** True when the user explicitly cancelled — suppresses error exit messages */
  cancelledByUser?: boolean;
  /**
   * Resolved model id that the most recent user-visible turn was dispatched
   * under. Used to emit a `model_switched` divider at send time only when the
   * model actually changed between turns (so pre-send toggling produces no
   * noise). In-memory only — reset to undefined on restore, so the first send
   * after a server restart re-establishes the baseline without a divider.
   */
  lastTurnModel?: string;
}

export interface InstanceManagerEvents {
  "instance:output": [instanceId: string, message: OutputMessage];
  "instance:activity": [instanceId: string, message: ActivityMessage];
  "instance:system_event": [instanceId: string, message: SystemEventMessage];
  "instance:exit": [instanceId: string, message: ExitMessage];
  "instance:status": [instanceId: string, info: InstanceInfo];
  "instance:created": [instanceId: string, info: InstanceInfo];
  "instance:removed": [instanceId: string];
  "instance:error": [instanceId: string, message: string];
  "instance:user": [instanceId: string, message: UserMessage];
  "instance:queued_removed": [
    instanceId: string,
    message: import("#core/types.js").QueuedRemovedMessage,
  ];
  "instance:transcript": [instanceId: string, message: TranscriptMessage];
  /** A bulk mutation touched many chats at once — re-send the whole list. */
  "instances:changed": [];
  "scan:complete": [];
  "projects:changed": [];
  "tasks:changed": [projectId: string, tasks: Task[]];
  "provider_global_state:updated": [
    provider: import("#core/types.js").ProviderKind,
    state: import("#core/types.js").ProviderGlobalState,
  ];
}

export interface InstanceManager {
  on<E extends keyof InstanceManagerEvents>(
    event: E,
    listener: (...args: InstanceManagerEvents[E]) => void,
  ): this;
  emit<E extends keyof InstanceManagerEvents>(event: E, ...args: InstanceManagerEvents[E]): boolean;
  off<E extends keyof InstanceManagerEvents>(
    event: E,
    listener: (...args: InstanceManagerEvents[E]) => void,
  ): this;
}

// =============================================================================
// InstanceManager Class
// =============================================================================

const MAX_HISTORY = 1000;
const MAX_TRANSCRIPT_CACHE_ENTRIES = 100;
const DISCOVERY_INTERVAL = 30_000; // 30s
const SLOW_DISCOVERY_WARN_MS = 1_000;
/** Git branch refresh runs at most this often (multiple of discovery interval) */
const GIT_REFRESH_INTERVAL = 30_000; // 30s
const execFileAsync = promisify(execFile);

const WATCH_POLL_INTERVAL = 2_000; // 2s
const WATCH_DEDUP_GRACE_MS = 2_000; // Allow JSONL writes to catch up to managed process output
/** Number of consecutive discovery misses before marking an external session as ended */
const STALE_THRESHOLD = 3; // 3 × 30s = 90s grace period
const MAX_TITLE_LENGTH = 50;
const PLAN_TRANSCRIPT_RE = /read the full transcript at:\s*(\S+\.jsonl)/;
const TRANSCRIPT_AVAILABLE_RE = /^Full transcript available at:\s+(\S+)$/;
const COMPACT_COMMAND_RE = /^\s*\/compact\s*$/i;

// =============================================================================
// Rate-limit merge helpers
// =============================================================================

/** Severity ordering: rejected > allowed_warning > allowed */
const RL_SEVERITY: Record<string, number> = { rejected: 2, allowed_warning: 1, allowed: 0 };
export function rlSeverity(status?: string): number {
  return RL_SEVERITY[status ?? "allowed"] ?? 0;
}

/**
 * Merge incoming rate limit windows against the previously stored ones,
 * keeping the more severe status unless the window's resetAt has already
 * passed. This prevents a new session's opening "allowed" event from
 * wiping out a "rejected" status that is still active.
 */
export function mergeRateLimitWindows(
  prevWindows: import("#core/types.js").ProviderRateLimitWindow[] | undefined,
  patchWindows: import("#core/types.js").ProviderRateLimitWindow[] | undefined,
): import("#core/types.js").ProviderRateLimitWindow[] | undefined {
  if (!patchWindows) return prevWindows?.map((w) => ({ ...w }));
  return patchWindows.map((pw, i) => {
    const prev = prevWindows?.[i];
    if (!prev) return { ...pw };
    if (rlSeverity(prev.status) > rlSeverity(pw.status)) {
      // A patch carrying real utilization below 100% (get_usage snapshot or
      // a warning event) is affirmative evidence the window is no longer
      // exhausted — the patch is already known to be less severe here.
      const patchShowsCleared = typeof pw.usedPercent === "number" && pw.usedPercent < 100;
      // Otherwise keep the more severe status until its own reset time passes.
      // Carry prev.resetAt (not the patch's rolling next-window reset) so the
      // carried status can actually expire instead of sticking forever.
      const resetAt = prev.resetAt ? new Date(prev.resetAt).getTime() : null;
      const stillActive = resetAt !== null && Date.now() < resetAt;
      if (!patchShowsCleared && stillActive) {
        const hasFreshUsage = typeof pw.usedPercent === "number";
        return {
          ...pw,
          status: prev.status,
          usedPercent: hasFreshUsage ? pw.usedPercent : prev.usedPercent,
          remaining: hasFreshUsage ? pw.remaining : prev.remaining,
          resetAt: prev.resetAt,
        };
      }
    }
    // Field-level carry: a patch window without utilization (e.g. a live
    // `allowed` event) must not erase a previously known percentage while
    // the previous window is still current.
    if (typeof pw.usedPercent !== "number" && typeof prev.usedPercent === "number") {
      const prevResetAt = prev.resetAt ? new Date(prev.resetAt).getTime() : null;
      const prevStillCurrent = prevResetAt !== null && Date.now() < prevResetAt;
      if (prevStillCurrent) {
        return { ...pw, usedPercent: prev.usedPercent, remaining: prev.remaining };
      }
    }
    return { ...pw };
  });
}

/**
 * Merge incoming rate limit statuses against previously stored ones,
 * matching limits by scope/name and delegating window merging to
 * mergeRateLimitWindows.
 */
export function mergeRateLimits(
  prev: import("#core/types.js").ProviderRateLimitStatus[] | undefined,
  patch: import("#core/types.js").ProviderRateLimitStatus[] | undefined,
): import("#core/types.js").ProviderRateLimitStatus[] | undefined {
  if (!patch) return prev?.map((l) => ({ ...l }));
  return patch.map((patchLimit) => {
    const prevLimit = prev?.find(
      (pl) =>
        (patchLimit.scope && pl.scope === patchLimit.scope) ||
        (patchLimit.name && pl.name === patchLimit.name),
    );
    return {
      ...patchLimit,
      windows: mergeRateLimitWindows(prevLimit?.windows, patchLimit.windows),
    };
  });
}

/**
 * Strip internal Claude CLI XML tags from message text.
 * These are metadata injected by the CLI (system reminders, local command
 * wrappers, hook output, IDE events, etc.) and should never be shown to users.
 * Returns the cleaned text, or empty string if nothing meaningful remains.
 */
const INTERNAL_TAGS = [
  "system-reminder",
  "local-command-caveat",
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "user-prompt-submit-hook",
  "ide_opened_file",
  "synthetic",
  "task-notification",
  "task-id",
  "task_id",
  "task_type",
  "retrieval_status",
  "output-file",
  "session-id",
  "project-path",
  "partial_json_fragment",
  "more_fragments",
  "persisted-output",
  "tool_use_error",
];

const INTERNAL_TAG_RE = new RegExp(`<(${INTERNAL_TAGS.join("|")})[^>]*>[\\s\\S]*?</\\1>`, "g");

function stripInternalTags(text: string): string {
  return text.replace(INTERNAL_TAG_RE, "").trim();
}

/** Human-readable label for a provider, used in fallback session titles. */
function providerLabel(provider?: ProviderKind): string {
  switch (provider) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    default:
      return "";
  }
}

/** Default title when no content is available to derive one from. */
function defaultSessionTitle(provider?: ProviderKind): string {
  const label = providerLabel(provider);
  return label ? `External ${label} Session` : "New Session";
}

/**
 * True if `name` is a placeholder/default session title (provider-agnostic),
 * and therefore a candidate to be upgraded to a real generated/summary title.
 * Matches the values produced by `defaultSessionTitle()` case-insensitively.
 */
function isDefaultSessionTitle(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (trimmed.toLowerCase() === "new session") return true;
  return /^External (?:Claude|Codex) Session$/i.test(trimmed);
}

/**
 * Sanitise user message text into plain-text suitable for a session title.
 * 1. Strip XML/HTML-style tags (self-closing and paired) — covers
 *    task_reference, terminal_context, image tags, and anything else.
 * 2. Decode `@task:<id>:<encoded>` inline mentions to readable titles.
 * 3. Unescape common XML/HTML entities that may survive after tag removal.
 * 4. Collapse whitespace.
 */
export function sanitiseForTitle(text: string): string {
  return (
    text
      // Strip XML/HTML tags (opening, closing, and self-closing)
      .replace(/<\/?[a-zA-Z_][\w.-]*(?:\s[^>]*)?\/?>/g, "")
      // Strip truncated/unclosed XML-like tags (no closing >, e.g. from line splitting)
      .replace(/<\/?[a-zA-Z_][\w.-]*(?:\s[^>]*)?$/g, "")
      // Decode @task:id:encoded inline mentions
      .replace(/@task:([a-f0-9]{8})(?::([^\s@]*))?/g, (_m, _id, encoded) => {
        if (!encoded) return "";
        try {
          return decodeURIComponent(encoded);
        } catch {
          return encoded;
        }
      })
      // Unescape common XML/HTML entities
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&") // must be last
      // Collapse runs of whitespace into a single space
      .replace(/\s+/g, " ")
      .trim()
      // Strip leading pipe(s) and whitespace (markdown table artifacts)
      .replace(/^[\s|]+/, "")
  );
}

/** Generate a short session title from a user message. */
function generateTitle(text: string, provider?: ProviderKind): string {
  // Take the first line, strip markdown/special chars, then sanitise
  const firstLine = sanitiseForTitle(text.split("\n")[0].replace(/[#*`_~[\]>|]/g, ""));
  if (!firstLine) return defaultSessionTitle(provider);
  if (firstLine.length <= MAX_TITLE_LENGTH) return firstLine;
  // Truncate at word boundary
  const truncated = firstLine.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + "\u2026";
}

/** Words/patterns that make a user message useless as a title. */
const TRIVIAL_MESSAGE_RE =
  /^(ok|okay|yes|no|yep|nah|sure|thanks|thank you|great|good|done|lgtm|go ahead|sounds good|perfect|commit|commit this|ship it|push it|nice|cool|looks good|approved|continue|proceed|tool loaded|human turned off|👍|y|n)\.?!?$/i;

/** True if the message text is too short or too generic to be a useful title. */
function isTrivialMessage(text: string): boolean {
  const cleaned = text
    .replace(/[#*`_~[\]>|]/g, "")
    .split("\n")[0]
    .trim();
  return cleaned.length < 8 || TRIVIAL_MESSAGE_RE.test(cleaned);
}

/**
 * Extract meaningful text from a conversation transcript for search indexing.
 *
 * Includes both user and assistant messages, filtering out short throwaway
 * messages (acknowledgments, "ok sounds good", etc.) and non-text content
 * like tool use/results and thinking blocks. Internal/injected user messages
 * (auto-continue, permission grants, etc.) are stripped or excluded.
 */
const MIN_SEARCHABLE_LENGTH = 80;
const TASK_REF_SEARCH_RE = /@task:[a-f0-9]{8}(?::[^\s@]*)?\b/i;

export function extractSearchableText(history: HistoryEntry[]): string {
  const parts: string[] = [];
  for (const entry of history) {
    const msg = entry.message;
    if (msg.type === "user") {
      const userMsg = msg as UserMessage;
      // Skip hidden server-injected messages (auto-continue, permission grants)
      if (userMsg.internal) continue;
      // Strip injected wrappers (task context, custom instructions, space context)
      // to get the real user text
      let text = userMsg.text;
      if (text && isInternalInjectedUserText(text)) {
        text = stripInjectedWrapper(text);
      }
      if (text && (text.length >= MIN_SEARCHABLE_LENGTH || TASK_REF_SEARCH_RE.test(text))) {
        parts.push(text);
      }
    } else if (msg.type === "output") {
      const text = (msg as OutputMessage).text;
      if (text && text.length >= MIN_SEARCHABLE_LENGTH) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n");
}

function buildUserInputReply(
  request: ProviderRequest,
  decision: "accept" | "decline",
  response?: import("#core/types.js").ProviderRequestResponse,
): { text: string; resolution: "approved" | "dismissed" } {
  const answers = decision === "accept" ? (response?.answers ?? {}) : {};
  const questions = request.questions ?? [];
  const answerBlocks = questions
    .map((question) => {
      const values = answers[question.id]?.answers?.filter(
        (answer): answer is string => typeof answer === "string" && answer.trim().length > 0,
      );
      if (!values?.length) return null;
      const normalized = values.map((value) => value.trim()).join(", ");
      const prefix = `> ${question.question}`;
      return `${prefix}\n\n${normalized}`;
    })
    .filter((value): value is string => !!value);

  if (answerBlocks.length > 0) {
    return {
      text: answerBlocks.join("\n\n"),
      resolution: "approved",
    };
  }

  // The user declined the options but authored their own reply — send it verbatim
  // rather than a canned message.
  const authored = response?.text?.trim();
  if (authored) {
    return {
      text: authored,
      resolution: "approved",
    };
  }

  return {
    text: "I prefer not to answer that question. Please continue without it if possible.",
    resolution: "dismissed",
  };
}

function countPatchLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

function buildToolActivityInput(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
  toolUseId?: string,
): Record<string, unknown> | undefined {
  if (toolName === "AskUserQuestion" && toolUseId) {
    return { ...input, requestId: toolUseId };
  }
  // Normalize Edit input: generate a patch diff from old/new strings so the
  // UI has the same EditToolInput shape as the live provider path.
  if (toolName === "Edit" && input) {
    const filePath = (input.file_path ?? input.path) as string | undefined;
    const oldStr = input.old_string as string | undefined;
    const newStr = input.new_string as string | undefined;
    if (filePath && typeof oldStr === "string" && typeof newStr === "string") {
      const raw = createPatch(filePath, oldStr, newStr, undefined, undefined, { context: 3 });
      const diff = raw.split("\n").slice(4).join("\n");
      const { additions, deletions } = countPatchLines(diff);
      const editInput: EditToolInput = {
        file_path: filePath,
        extension: extFromPath(filePath),
        diff,
        additions,
        deletions,
      };
      return editInput as unknown as Record<string, unknown>;
    }
  }
  return input;
}

function extractUserInputRequest(activity: ActivityMessage): ProviderRequest | null {
  if (activity.activity !== "tool_use" || activity.tool !== "AskUserQuestion") return null;
  if (!activity.input || typeof activity.input !== "object") return null;
  const requestId = activity.input.requestId;
  if (typeof requestId !== "string") return null;

  const questions = Array.isArray(activity.input.questions)
    ? activity.input.questions
        .filter(
          (question): question is Record<string, unknown> =>
            typeof question === "object" &&
            question !== null &&
            typeof (question as { question?: unknown }).question === "string",
        )
        // AskUserQuestion tool input doesn't include `id` — generate one
        // deterministically by index so it matches the live permissionRequest
        // path (see claude-sdk.ts handleCanUseTool).
        .map(
          (question, index) =>
            ({
              ...question,
              id: typeof question.id === "string" ? question.id : `q_${index}`,
              // Preserve multiSelect through replay/restore so a rehydrated prompt
              // keeps its multiple-selection affordance (see claude-sdk.ts).
              multiSelect: question.multiSelect === true,
              // The Claude harness always offers a freeform "Other" answer; the
              // tool input has no flag for it, so mark it here so replayed/restored
              // AskUserQuestion prompts enable the composer (see claude-sdk.ts).
              isOther: true,
            }) as UserInputQuestion,
        )
    : [];
  if (questions.length === 0) return null;

  return {
    requestId,
    kind: "user_input",
    tool: "AskUserQuestion",
    description: questions[0]?.question,
    questions,
  };
}

/**
 * Extract the final assistant text output from a background agent transcript file.
 * Transcript files are JSONL (same format as session files) containing the agent's
 * full conversation — prompt, tool calls, and final output.
 * Returns { title, result } or null if the file is missing/unparseable.
 */
function extractTranscriptResult(filePath: string): { title: string; result: string } | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    let firstUserText: string | null = null;
    let lastAssistantText: string | null = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "user" && entry.message?.content && !firstUserText) {
          const content = entry.message.content;
          if (typeof content === "string") {
            firstUserText = stripInternalTags(content);
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && typeof block.text === "string") {
                const cleaned = stripInternalTags(block.text);
                if (cleaned) {
                  firstUserText = cleaned;
                  break;
                }
              }
            }
          }
        } else if (entry.type === "assistant" && entry.message?.content) {
          const content = entry.message.content;
          if (Array.isArray(content)) {
            const textParts: string[] = [];
            for (const block of content) {
              if (block.type === "text" && typeof block.text === "string") {
                textParts.push(block.text);
              }
            }
            if (textParts.length > 0) {
              lastAssistantText = textParts.join("\n");
            }
          }
        }
      } catch {
        // skip malformed lines
      }
    }

    if (!lastAssistantText) return null;
    const title = firstUserText ? generateTitle(firstUserText) : "Background agent";
    return { title, result: lastAssistantText };
  } catch {
    // File missing or unreadable
    return null;
  }
}

/**
 * Read the first user message from a JSONL file by scanning the first ~64KB.
 * Returns the user message text, or null if not found.
 */
function readFirstUserMessage(jsonlPath: string): string | null {
  try {
    const fd = openSync(jsonlPath, "r");
    try {
      const buf = Buffer.alloc(65536);
      const bytesRead = readSync(fd, buf, 0, 65536, 0);
      const text = buf.toString("utf-8", 0, bytesRead);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "user" && parsed.message?.content) {
            // User message content is an array of blocks
            for (const block of parsed.message.content) {
              if (block.type === "text" && typeof block.text === "string") {
                let cleaned = stripInternalTags(block.text);
                cleaned = stripInjectedWrapper(cleaned);
                if (cleaned && !isInternalInjectedUserText(cleaned) && !isTrivialMessage(cleaned))
                  return cleaned;
              }
            }
          }
        } catch {
          // partial line at end of buffer — skip
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // file read error
  }
  return null;
}

/** Read the last user or assistant message from a JSONL file by scanning the tail. */
function readLastMessage(jsonlPath: string): LastMessagePreview | null {
  try {
    const fd = openSync(jsonlPath, "r");
    try {
      const stat = fstatSync(fd);
      const tailSize = Math.min(stat.size, 32768);
      const offset = stat.size - tailSize;
      const buf = Buffer.alloc(tailSize);
      readSync(fd, buf, 0, tailSize, offset);
      const text = buf.toString("utf-8");
      const lines = text.split("\n");

      // Walk backwards to find the last substantive message
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          const ts = parsed.timestamp ? new Date(parsed.timestamp).getTime() : 0;

          // User message
          if (parsed.type === "user" && parsed.message?.content) {
            for (const block of parsed.message.content) {
              if (block.type === "text" && typeof block.text === "string") {
                const cleaned = stripInternalTags(block.text);
                if (cleaned && !isTrivialMessage(cleaned)) {
                  return { text: cleaned, from: "user", timestamp: ts || Date.now() };
                }
              }
            }
            continue;
          }

          // Assistant message — extract text from content blocks
          if (parsed.type === "assistant" && parsed.message?.content) {
            for (const block of parsed.message.content) {
              if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
                const preview =
                  block.text.length > 120 ? block.text.slice(0, 120) + "\u2026" : block.text;
                return { text: preview, from: "assistant", timestamp: ts || Date.now() };
              }
            }
            continue;
          }
        } catch {
          // partial line — skip
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // file read error
  }
  return null;
}

/**
 * Extract the most recent model ID from the tail of a JSONL file.
 * Reads last 32KB and walks backwards for an assistant entry with `message.model`.
 */
function readModelFromJsonl(jsonlPath: string): string | null {
  try {
    const fd = openSync(jsonlPath, "r");
    try {
      const stat = fstatSync(fd);
      const tailSize = Math.min(stat.size, 32768);
      const offset = stat.size - tailSize;
      const buf = Buffer.alloc(tailSize);
      readSync(fd, buf, 0, tailSize, offset);
      const text = buf.toString("utf-8");
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line || !line.includes('"model"')) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "assistant" && parsed.message?.model) {
            return parsed.message.model;
          }
        } catch {
          // partial line
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // file read error
  }
  return null;
}

function readClaudeStatsFromJsonl(jsonlPath: string): SessionStats | undefined {
  try {
    const content = readFileSync(jsonlPath, "utf-8");
    const stats: SessionStats = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };

    for (const line of content.split("\n")) {
      if (!line || !line.includes('"assistant"')) continue;
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          message?: {
            model?: string;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
            };
          };
        };
        if (entry.type !== "assistant" || !entry.message) continue;
        if (entry.message.model) {
          stats.model = entry.message.model;
        }
        if (!entry.message.usage) continue;
        stats.inputTokens += entry.message.usage.input_tokens ?? 0;
        stats.outputTokens += entry.message.usage.output_tokens ?? 0;
        stats.cacheCreationTokens += entry.message.usage.cache_creation_input_tokens ?? 0;
        stats.cacheReadTokens += entry.message.usage.cache_read_input_tokens ?? 0;
      } catch {
        // skip malformed lines
      }
    }

    return hasSessionStats(stats) ? stats : undefined;
  } catch {
    return undefined;
  }
}

function readCodexStatsFromJsonl(jsonlPath: string): SessionStats | undefined {
  try {
    const content = readFileSync(jsonlPath, "utf-8");
    const stats: SessionStats = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };

    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          payload?: Record<string, unknown>;
        };

        if (entry.type === "turn_context") {
          const model = entry.payload?.model;
          if (typeof model === "string" && model.trim()) {
            stats.model = model;
          }
          continue;
        }

        if (entry.type !== "event_msg" || entry.payload?.type !== "token_count") continue;
        const info =
          typeof entry.payload.info === "object" && entry.payload.info !== null
            ? (entry.payload.info as Record<string, unknown>)
            : null;
        const total =
          info && typeof info.total_token_usage === "object" && info.total_token_usage !== null
            ? (info.total_token_usage as Record<string, unknown>)
            : null;
        const last =
          info && typeof info.last_token_usage === "object" && info.last_token_usage !== null
            ? (info.last_token_usage as Record<string, unknown>)
            : null;

        if (total) {
          stats.inputTokens =
            typeof total.input_tokens === "number" ? total.input_tokens : stats.inputTokens;
          stats.cacheReadTokens =
            typeof total.cached_input_tokens === "number"
              ? total.cached_input_tokens
              : stats.cacheReadTokens;
          stats.outputTokens =
            typeof total.output_tokens === "number" ? total.output_tokens : stats.outputTokens;
          if (typeof total.reasoning_output_tokens === "number") {
            stats.reasoningTokens = total.reasoning_output_tokens;
          }
        }
        if (last) {
          if (typeof last.total_tokens === "number") {
            stats.contextTokens = last.total_tokens;
          } else if (typeof last.input_tokens === "number") {
            stats.contextTokens =
              last.input_tokens +
              (typeof last.cached_input_tokens === "number" ? last.cached_input_tokens : 0);
          }
        }
        if (info && typeof info.model_context_window === "number") {
          stats.contextWindow = info.model_context_window;
        }
      } catch {
        // skip malformed lines
      }
    }

    return hasSessionStats(stats) ? stats : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read cwd from a JSONL file by scanning the first ~32KB for an entry with a `cwd` field.
 * The init/system entry contains `cwd` but isn't always the first line
 * (file-history-snapshot can precede it), and can span many KB.
 */
function readCwdFromJsonl(jsonlPath: string): string | null {
  try {
    const fd = openSync(jsonlPath, "r");
    try {
      const buf = Buffer.alloc(32768);
      const bytesRead = readSync(fd, buf, 0, 32768, 0);
      const text = buf.toString("utf-8", 0, bytesRead);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.cwd) return parsed.cwd;
        } catch {
          // partial line at end of buffer — skip
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // file read error
  }
  return null;
}

/**
 * Decode a Claude CLI encoded project directory name back to a filesystem path.
 * Claude encodes `/` → `-`, but decoding `-` → `/` is lossy for paths containing dashes.
 * This uses greedy filesystem validation: builds the path left-to-right, checking
 * `existsSync` at each step, accumulating segments with dashes when `/` doesn't match.
 */
function decodeProjectDir(encodedName: string): string {
  // Strip leading dash (represents the leading /)
  const stripped = encodedName.startsWith("-") ? encodedName.slice(1) : encodedName;
  const segments = stripped.split("-");
  if (segments.length === 0) return "/" + stripped;

  let path = "";
  let accumulator = segments[0];

  for (let i = 1; i < segments.length; i++) {
    // Try treating the separator as / (new path component)
    const candidate = path + "/" + accumulator;
    if (existsSync(candidate)) {
      path = candidate;
      accumulator = segments[i];
    } else {
      // Accumulate with dash (segment is part of a dashed name)
      accumulator += "-" + segments[i];
    }
  }

  // Final segment
  const finalPath = path + "/" + accumulator;
  if (existsSync(finalPath)) return finalPath;

  // If nothing validated, fall back to naive decode but keep dashes for the last component
  // by returning what we've built so far
  return finalPath;
}

// Git info detection with per-directory caching (60s TTL)
const gitInfoCache = new Map<
  string,
  { info: { branch: string; isWorktree: boolean } | null; cachedAt: number }
>();
const GIT_CACHE_TTL = 60_000;
const GIT_INFO_TIMEOUT_MS = Number(process.env.RELAY_GIT_TIMEOUT_MS || "1500");

function getGitInfo(dir: string): { branch: string; isWorktree: boolean } | null {
  const cached = gitInfoCache.get(dir);
  if (cached && Date.now() - cached.cachedAt < GIT_CACHE_TTL) return cached.info;

  let info: { branch: string; isWorktree: boolean } | null = null;
  try {
    if (isRelayWorktreePath(dir) && !existsSync(join(dir, ".git"))) {
      gitInfoCache.set(dir, { info: null, cachedAt: Date.now() });
      return null;
    }
    const opts = {
      cwd: dir,
      timeout: GIT_INFO_TIMEOUT_MS,
      encoding: "utf8" as const,
      stdio: "pipe" as const,
    };
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], opts).trim();
    if (!branch || branch === "HEAD") {
      gitInfoCache.set(dir, { info: null, cachedAt: Date.now() });
      return null;
    }
    // Detect worktrees: in a worktree, --git-dir points to main-repo/.git/worktrees/<name>
    // while --git-common-dir points to main-repo/.git. In the main repo they are equal.
    // (--show-toplevel returns the worktree's own root, so it can't distinguish worktrees.)
    const gitDir = resolve(dir, execFileSync("git", ["rev-parse", "--git-dir"], opts).trim());
    const gitCommonDir = resolve(
      dir,
      execFileSync("git", ["rev-parse", "--git-common-dir"], opts).trim(),
    );
    info = { branch, isWorktree: gitDir !== gitCommonDir };
  } catch {
    // Not a git repo or git not available
  }
  gitInfoCache.set(dir, { info, cachedAt: Date.now() });
  return info;
}

/** Extract the last user or assistant message from parsed history for dashboard preview. */
function extractLastMessage(history: HistoryEntry[]): LastMessagePreview | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i].message;
    // Skip transcript messages — they shouldn't be the sidebar preview
    if (msg.type === "transcript") continue;
    if (msg.type === "user" && (msg as UserMessage).text) {
      return {
        text: (msg as UserMessage).text,
        from: "user",
        timestamp: history[i].timestamp,
      };
    } else if (msg.type === "output") {
      const output = msg as OutputMessage;
      if (output.text && output.text.trim() && !output.isWaiting) {
        return { text: output.text, from: "assistant", timestamp: history[i].timestamp };
      }
    }
  }
  return undefined;
}

/** Create an initialized WatchState for a JSONL file. */
function createWatchState(
  jsonlPath: string,
  fileOffset: number,
  existingStats?: SessionStats,
): WatchState {
  return {
    jsonlPath,
    fileOffset,
    pendingTools: new Map(),
    pendingTaskCreates: new Map(),
    pendingProviderCalls: new Map(),
    stats: existingStats
      ? { ...existingStats }
      : {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
  };
}

function extractResumeSessionId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") return undefined;
  const value = (resumeCursor as Record<string, unknown>).sessionId;
  return typeof value === "string" && value ? value : undefined;
}

function hasExplicitNonDefaultSpace(
  spaceManager: SpaceManager,
  spaceId: string | null | undefined,
): boolean {
  if (!spaceId) return false;
  const space = spaceManager.getSpace(spaceId);
  return Boolean(space && !space.isDefault);
}

function statsChanged(before: SessionStats, after: SessionStats): boolean {
  return (
    before.inputTokens !== after.inputTokens ||
    before.outputTokens !== after.outputTokens ||
    before.cacheCreationTokens !== after.cacheCreationTokens ||
    before.cacheReadTokens !== after.cacheReadTokens ||
    before.model !== after.model ||
    before.contextTokens !== after.contextTokens ||
    before.contextWindow !== after.contextWindow
  );
}

/**
 * Thrown by createInstance when the concurrent managed-process cap is reached.
 * Carries the limit so callers (HTTP route → UI) can surface a structured
 * "free up capacity" affordance instead of a bare error string.
 */
export class MaxProcessesError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`Maximum processes (${limit}) reached`);
    this.name = "MaxProcessesError";
    this.limit = limit;
  }
}

export class InstanceManager extends EventEmitter {
  private providerGlobalState = new Map<
    import("#core/types.js").ProviderKind,
    import("#core/types.js").ProviderGlobalState
  >();
  private providerGlobalHydrationInFlight = new Map<ProviderKind, Promise<void>>();
  private _providerStateFilePath = providerStateFilePath(relayDir);
  private _persistStateTimeout: ReturnType<typeof setTimeout> | null = null;
  private instances = new Map<string, Instance>();
  private instanceMutationChains = new Map<string, Promise<void>>();
  private missingRunnableCwdWarnings = new Map<string, string>();
  /** Space IDs we've already warned about for unusable worktrees — avoids N warnings for N sessions in the same space. */
  private warnedUnusableSpaces = new Set<string>();
  private baseConfig: CoreConfig;
  private db: SessionDB;
  private instanceCounter = 0;
  private discoveryInterval: ReturnType<typeof setInterval> | null = null;
  private watchIntervals = new Map<string, ReturnType<typeof setInterval>>();
  /** Tracks consecutive discovery misses per external instance (grace period before marking stopped) */
  private staleCounts = new Map<string, number>();
  /** Instance IDs that were auto-continued after a restart — excluded from the next processing-at-shutdown save to prevent restart loops */
  private recentlyAutoContinued = new Set<string>();
  /** Timestamp of the last git branch refresh pass (throttled to GIT_REFRESH_INTERVAL) */
  private lastGitRefreshAt = 0;
  private providerDirs: Record<ProviderKind, string>;
  /** Pre-resolved SDK query function — null if SDK not available (falls back to CLI) */
  private _sdkQueryFn: ((params: { prompt: unknown; options?: unknown }) => unknown) | null = null;
  /** Cached project icon paths: dir → absolute file path (null = scanned, not found) */
  private projectIconCache = new Map<string, string | null>();
  /** Parsed transcript cache keyed by provider + path + file metadata */
  private transcriptParseCache = new Map<string, TranscriptCacheEntry>();
  /** True once the background filesystem scan has completed */
  scanComplete = false;
  /** Guard to prevent concurrent discovery polls from overlapping */
  private discovering = false;
  /** Prevent late process/watcher events from mutating state after shutdown begins */
  private shuttingDown = false;
  /**
   * JSONL paths from instances the user explicitly removed.  Kept in memory
   * so the external-discovery loop doesn't immediately re-import a managed
   * session whose subprocess hasn't fully exited yet.  Entries are
   * auto-expired after 60 s — long enough for the process to die.
   */
  private dismissedJsonlPaths = new Map<string, number>();
  /** Space lifecycle manager */
  private spaceManager: SpaceManager;
  /** Spin-off generation and persistence */
  private spinOffManager: SpinOffManager;
  /** Project manager for explicit project registration */
  private _projectManager: ProjectManager;

  constructor(config: CoreConfig) {
    super();
    this.baseConfig = config;
    const home = homedir();
    this.providerDirs = {
      claude: config.providerDirs.claude ?? join(home, ".claude"),
      codex: config.providerDirs.codex ?? join(home, ".codex"),
    };
    this.db = new SessionDB(config.dbPath, config.logger);
    this.spaceManager = new SpaceManager(this.db, config.logger);
    this.spinOffManager = new SpinOffManager(this.db, config.logger);
    this._projectManager = new ProjectManager(this.db, config.logger);
    // Keep in-memory instances aligned with project registration changes.
    this._projectManager.on("project:created", (project) => {
      this.refreshInstanceProjectIds(project);
      this.emit("projects:changed");
    });
    this._projectManager.on("project:removed", (removedId) => {
      // Clear projectId on instances that belonged to the removed project
      for (const instance of this.instances.values()) {
        if (instance.info.projectId === removedId) {
          instance.info.projectId = undefined;
          instance.info.projectSlug = undefined;
        }
      }
      this.emit("projects:changed");
    });
    this._projectManager.on("project:updated", () => {
      this.emit("projects:changed");
    });
    this._projectManager.recoverProjectsFromSessionDirectories();

    // Restore persisted provider global state (rate limits, account info, etc.)
    // from the previous run. Treated as stale-but-valid: shown immediately while
    // live sessions push fresh updates.
    const persisted = loadPersistedProviderState(this._providerStateFilePath);
    for (const state of persisted) {
      this.providerGlobalState.set(state.provider, state);
    }
    if (persisted.length > 0) {
      this.baseConfig.logger.debug(
        `[InstanceManager] Restored provider state for: ${persisted.map((s) => s.provider).join(", ")}`,
      );
    }
  }

  /** Access the project manager for project CRUD operations. */
  get projectManager(): ProjectManager {
    return this._projectManager;
  }

  /** Access the session DB for global settings. */
  get sessionDb(): SessionDB {
    return this.db;
  }

  /**
   * Assign projectId to instances that don't have one yet but match
   * the given project's directory.
   */
  private refreshInstanceProjectIds(project: Project): void {
    for (const instance of this.instances.values()) {
      if (instance.info.projectId) continue;
      const instanceProjectDir = getPersistenceRowProjectDirectory({
        original_directory: instance.originalDirectory ?? instance.info.originalDirectory,
        working_directory: instance.info.workingDirectory,
      });
      if (instanceProjectDir === project.directory) {
        instance.info.projectId = project.id;
        instance.info.projectSlug = project.slug;
      }
    }
  }

  private refreshInstanceSpaceIdsFromDb(): void {
    for (const instance of this.instances.values()) {
      if (instance.info.spaceId) continue;

      if (instance.info.external) {
        const row = this.db.getByInstanceId(instance.info.id);
        if (row?.space_id) {
          instance.info.spaceId = row.space_id;
        }
        continue;
      }

      const row = this.db.getManagedByInstanceId(instance.info.id);
      if (row?.space_id) {
        instance.info.spaceId = row.space_id;
      }
    }
  }

  private backfillMissingSpaceIds(): void {
    // Compatibility shim: stamp explicit ownership onto legacy persisted rows
    // during scan so the rest of the app can treat `space_id` as canonical.
    let repaired = 0;
    const spacesByProjectDirectory = new Map<string, SpaceInfo[]>();
    const getSpaces = (projectDirectory: string): SpaceInfo[] => {
      const existing = spacesByProjectDirectory.get(projectDirectory);
      if (existing) {
        return existing;
      }
      const spaces = this.spaceManager.listAllSpaces(projectDirectory);
      spacesByProjectDirectory.set(projectDirectory, spaces);
      return spaces;
    };

    for (const row of this.db.getAllManagedActive()) {
      if (row.space_id) continue;
      if (row.worktree_path) {
        const directSpace = this.spaceManager.getSpaceByWorktreePath(row.worktree_path);
        if (directSpace) {
          this.db.updateManagedSpaceId(row.instance_id, directSpace.id);
          repaired++;
          this.logSpaceOwnershipRepair("scan-backfill", `managed:${row.instance_id}`, {
            previousSpaceId: row.space_id,
            nextSpaceId: directSpace.id,
            projectDirectory: getPersistenceRowProjectDirectory(row),
          });
          continue;
        }
      }
      const projectDirectory = getPersistenceRowProjectDirectory(row);
      const project = this._projectManager.getProjectByDirectory(projectDirectory);
      if (!project) continue;
      const spaceId = inferSpaceIdForPersistenceRow(row, getSpaces(project.directory));
      if (spaceId) {
        this.db.updateManagedSpaceId(row.instance_id, spaceId);
        repaired++;
        this.logSpaceOwnershipRepair("scan-backfill", `managed:${row.instance_id}`, {
          previousSpaceId: row.space_id,
          nextSpaceId: spaceId,
          projectDirectory,
        });
      }
    }

    for (const row of this.db.getAllActive()) {
      if (row.space_id) continue;
      if (row.worktree_path) {
        const directSpace = this.spaceManager.getSpaceByWorktreePath(row.worktree_path);
        if (directSpace) {
          this.db.updateSessionSpaceId(row.session_id, directSpace.id);
          repaired++;
          this.logSpaceOwnershipRepair("scan-backfill", `external:${row.session_id}`, {
            previousSpaceId: row.space_id,
            nextSpaceId: directSpace.id,
            projectDirectory: getPersistenceRowProjectDirectory(row),
          });
          continue;
        }
      }
      const projectDirectory = getPersistenceRowProjectDirectory(row);
      const project = this._projectManager.getProjectByDirectory(projectDirectory);
      if (!project) continue;
      const spaceId = inferSpaceIdForPersistenceRow(row, getSpaces(project.directory));
      if (spaceId) {
        this.db.updateSessionSpaceId(row.session_id, spaceId);
        repaired++;
        this.logSpaceOwnershipRepair("scan-backfill", `external:${row.session_id}`, {
          previousSpaceId: row.space_id,
          nextSpaceId: spaceId,
          projectDirectory,
        });
      }
    }

    if (repaired > 0) {
      this.baseConfig.logger.warn(
        `[InstanceManager] Backfilled explicit space ownership for ${repaired} persisted row(s) during scan`,
      );
    }
  }

  private inferPersistedSpaceIdForProjectDirectory(
    projectDirectory: string | null | undefined,
    row: {
      space_id: string | null;
      worktree_path: string | null;
      git_branch: string | null;
      original_directory?: string | null;
      working_directory: string;
    },
  ): string | null {
    // Compatibility shim: convert legacy branch/worktree metadata into
    // explicit ownership when a current space row already exists.
    if (!projectDirectory) return null;
    if (row.worktree_path) {
      const directSpace = this.spaceManager.getSpaceByWorktreePath(row.worktree_path);
      if (directSpace) return directSpace.id;
    }
    const project = this.getRegisteredProjectForDirectory(projectDirectory);
    const spaces = new Map<string, SpaceInfo>();
    for (const candidate of getProjectDirectoryCandidates(projectDirectory)) {
      for (const space of this.spaceManager.listAllSpaces(candidate)) {
        spaces.set(space.id, space);
      }
    }
    if (project?.directory) {
      for (const space of this.spaceManager.listAllSpaces(project.directory)) {
        spaces.set(space.id, space);
      }
    }
    let inferred = explicitOrInferredSpaceIdForPersistenceRow(row, [...spaces.values()]);
    if (inferred) return inferred;

    for (const knownProject of this.db.getAllProjects()) {
      for (const space of this.spaceManager.listAllSpaces(knownProject.directory)) {
        spaces.set(space.id, space);
      }
    }

    inferred = explicitOrInferredSpaceIdForPersistenceRow(row, [...spaces.values()]);
    return inferred ?? null;
  }

  private getRegisteredProjectForDirectory(directory: string | null | undefined): Project | null {
    for (const candidate of getProjectDirectoryCandidates(directory)) {
      const project = this._projectManager.getProjectByDirectory(candidate);
      if (project) return project;
    }
    return null;
  }

  private pruneLiveManagedShadows(managedKeys: {
    providerSessionIds: Set<string>;
    transcriptPaths: Set<string>;
  }): void {
    for (const [instanceId, instance] of this.instances) {
      if (!isManagedShadowInstance(this.toManagedShadowIdentity(instance), managedKeys)) {
        continue;
      }

      const watchInterval = this.watchIntervals.get(instanceId);
      if (watchInterval) {
        clearInterval(watchInterval);
        this.watchIntervals.delete(instanceId);
      }
      this.staleCounts.delete(instanceId);
      this.instances.delete(instanceId);

      if (instance.sessionId) {
        this.db.archive(instance.sessionId);
      }

      this.emit("instance:removed", instanceId);
      this.baseConfig.logger.info(
        `[InstanceManager] Pruned live external shadow ${instanceId} for managed session`,
      );
    }
  }

  private logSpaceOwnershipRepair(
    source: "scan-backfill" | "restore" | "persist",
    rowId: string,
    details: {
      previousSpaceId?: string | null;
      nextSpaceId?: string | null;
      projectDirectory?: string | null;
    },
  ): void {
    this.baseConfig.logger.warn(
      `[InstanceManager] Repaired space ownership during ${source} for ${rowId}: ${details.previousSpaceId ?? "null"} -> ${details.nextSpaceId ?? "null"}${details.projectDirectory ? ` (${details.projectDirectory})` : ""}`,
    );
  }

  private getAttachedReviewIds(source: InstanceInfo, excludingId?: string): string[] {
    return getAttachedReviewIds(
      source,
      Array.from(this.instances.values()).map((candidate) => candidate.info),
      excludingId,
    );
  }

  private toManagedShadowIdentity(instance: Instance) {
    return {
      external: instance.info.external,
      providerBinding: instance.providerBinding,
      processBinding: instance.process?.getRuntimeBinding(),
      sessionId: instance.sessionId,
      infoSessionId: instance.info.sessionId,
      jsonlPath: instance.jsonlPath,
      externalJsonlPath: instance.externalState?.jsonlPath,
    };
  }

  private isSpaceOwnedWorktree(instance: Instance): boolean {
    if (!instance.worktreePath || !instance.originalDirectory) return false;

    if (instance.info.spaceId) return true;

    if (
      this.spaceManager
        .listAllSpaces(instance.originalDirectory)
        .some((space) => space.worktreePath === instance.worktreePath)
    ) {
      return true;
    }

    if (instance.info.external) {
      return Boolean(this.db.getByInstanceId(instance.info.id)?.space_id);
    }

    return Boolean(this.db.getManagedByInstanceId(instance.info.id)?.space_id);
  }

  private isRegisteredProjectPath(directory: string): boolean {
    if (this._projectManager.getProjectByDirectory(directory)) {
      return true;
    }

    // For any git worktree (relay or external like .t3), resolve to the
    // parent repo and check if that is registered.
    if (isGitWorktree(directory)) {
      const origin = isRelayWorktreePath(directory)
        ? resolveWorktreeOrigin(directory)
        : resolveAnyWorktreeOrigin(directory);
      if (origin && this._projectManager.getProjectByDirectory(origin)) {
        return true;
      }
    }

    return false;
  }

  private shouldScanClaudeProjectDir(projectsDir: string, name: string): boolean {
    if (!name.startsWith("-")) return false;

    const fullProjDir = join(projectsDir, name);
    try {
      if (!statSync(fullProjDir).isDirectory()) return false;
    } catch {
      return false;
    }

    const decoded = decodeProjectDir(name);
    if (this.isRegisteredProjectPath(decoded)) {
      return true;
    }

    // Claude's encoded directory names are lossy for some worktree paths
    // (notably ~/.relay/worktrees/space-<id>). Fall back to transcript cwd.
    try {
      const jsonlFiles = readdirSync(fullProjDir).filter((file) => file.endsWith(".jsonl"));
      for (const jsonlFile of jsonlFiles) {
        const cwd = readCwdFromJsonl(join(fullProjDir, jsonlFile));
        if (cwd && this.isRegisteredProjectPath(cwd)) {
          return true;
        }
      }
    } catch {
      return false;
    }

    return false;
  }

  /**
   * Eagerly resolve the Agent SDK's query function and discover available models.
   * Call this once at startup before creating instances.
   * If the SDK is not installed, falls back to CLI provider silently.
   */
  async initSdkProvider(): Promise<void> {
    try {
      this._sdkQueryFn = (await resolveQueryFn()) as typeof this._sdkQueryFn;
      this.baseConfig.logger.info("[InstanceManager] Agent SDK provider initialized");
      // Spawn a short-lived subprocess to discover models + account info from
      // the SDK so both are available immediately (not just after the first
      // session). Fire-and-forget — pre-warm is best-effort; builtins are the
      // fallback for models, and account info remains null until a real
      // session runs if the pre-warm fails.
      void prewarmSdk(this.baseConfig.logger).then(() => {
        // Promote pre-warmed Claude account info into the provider global
        // state so the UI's global settings page sees plan/email at boot.
        void this.ensureProviderGlobalState("claude");
      });
    } catch {
      this.baseConfig.logger.info("[InstanceManager] Agent SDK not available, using CLI provider");
    }
  }

  /**
   * Pre-warm Codex: discover the model list and hydrate provider global
   * state (account + rate limits + MCP servers + apps) before the UI asks
   * for any of it. Fire-and-forget; non-fatal if the Codex binary is absent.
   *
   * Called alongside `initSdkProvider()` at server start so both providers'
   * model lists and account status are hot from the moment the HTTP server
   * begins accepting connections.
   */
  initCodexProvider(): void {
    if (!isCodexInstalled()) {
      this.baseConfig.logger.info(
        "[InstanceManager] Codex binary not available, skipping pre-warm",
      );
      return;
    }
    // Model discovery → populates module-level cache in codex-models.ts,
    // consumed by the codex provider driver's getModels() on next call.
    void prewarmCodexModels({ logger: this.baseConfig.logger });
    // Account info + MCP + apps → populates providerGlobalState, served to
    // the UI on connect. Rate limits come from live sessions (the cold
    // app-server probe can't read them without a prior turn snapshot).
    void this.ensureProviderGlobalState("codex");
  }

  private getProviderContext() {
    const registeredDirectories = new Set(
      this.getKnownDirectories().map((directoryInfo) => directoryInfo.path),
    );
    for (const project of this._projectManager.listProjects()) {
      for (const space of this.spaceManager.listAllSpaces(project.directory)) {
        if (space.worktreePath) {
          registeredDirectories.add(space.worktreePath);
        }
      }
    }
    return {
      providerDirs: this.providerDirs,
      logger: this.baseConfig.logger,
      sdkQueryFn: this._sdkQueryFn,
      registeredDirectories,
    };
  }

  /**
   * Create a ProviderSession for the requested provider using the driver registry.
   */
  private createProviderSession(
    config: CoreConfig,
    options?: {
      provider?: ProviderKind;
      resumeSessionId?: string;
      model?: string;
      runtimeMode?: ProviderRuntimeMode;
      allowedTools?: string[];
      modelOptions?: ProviderModelOptions;
      bootstrapContext?: ProviderSessionBootstrap;
    },
  ): ProviderSession {
    const provider = options?.provider ?? "claude";
    return createManagedProviderSession(provider, config, options, this.getProviderContext());
  }

  private buildBootstrapContext(
    project: Project | undefined,
    options?: {
      spaceId?: string;
      workingDirectory?: string;
      includeProjectInstructions?: boolean;
      includeTaskContext?: boolean;
    },
  ): ProviderSessionBootstrap | undefined {
    const customInstructionBlocks = this.getProjectCustomInstructionBlocks(
      project,
      options?.includeProjectInstructions ?? true,
    );
    const relayInstructionBlocks: ProviderContextBlock[] = [];
    const includeTaskContext = options?.includeTaskContext ?? true;

    const spaceBlock = this.buildSpaceBootstrapContextBlock(
      options?.spaceId,
      options?.workingDirectory,
    );
    if (spaceBlock) relayInstructionBlocks.push(spaceBlock);

    return buildSessionBootstrapContext({
      customInstructionBlocks,
      relayInstructionBlocks,
      includeTaskContext: project && includeTaskContext ? hasTasks(project.directory) : false,
    });
  }

  private getProjectCustomInstructionBlocks(
    project: Project | undefined,
    includeProjectInstructions = true,
  ): ProviderContextBlock[] {
    if (!project || !includeProjectInstructions) return [];

    const blocks: ProviderContextBlock[] = [];
    const globalCustomInstructions = this.db.getGlobalSettings().custom_instructions?.trim();
    if (globalCustomInstructions) {
      blocks.push({
        key: "global-custom-instructions",
        kind: CUSTOM_INSTRUCTIONS_BLOCK_KIND,
        title: "Global custom instructions",
        source: "Global settings",
        text: globalCustomInstructions,
      });
    }

    if (project.customInstructions?.trim()) {
      blocks.push({
        key: "project-custom-instructions",
        kind: CUSTOM_INSTRUCTIONS_BLOCK_KIND,
        title: "Project custom instructions",
        source: "Project settings",
        text: project.customInstructions.trim(),
      });
    }

    const instructionsPath = join(project.directory, ".relay", "instructions.md");
    try {
      if (existsSync(instructionsPath)) {
        const fileInstructions = readFileSync(instructionsPath, "utf8").trim();
        if (fileInstructions) {
          blocks.push({
            key: "relay-instructions-md",
            kind: CUSTOM_INSTRUCTIONS_BLOCK_KIND,
            title: "Project instructions file",
            source: ".relay/instructions.md",
            text: fileInstructions,
          });
        }
      }
    } catch {
      // Non-critical — skip if file can't be read.
    }

    return blocks;
  }

  private buildSpaceBootstrapContextBlock(
    spaceId: string | undefined,
    workingDirectory: string | undefined,
  ): ProviderContextBlock | undefined {
    if (!spaceId) return undefined;
    const space = this.getSpaceManager().getSpace(spaceId);
    if (!space) return undefined;

    const guidance =
      `You are working in a shared Space.\n\n` +
      `Worktree: \`${space.worktreePath || workingDirectory || space.projectDirectory}\`\n` +
      `Original project: \`${space.projectDirectory}\`\n\n` +
      `IMPORTANT: All file reads, writes, and searches must use paths under the worktree, not the original project directory. The worktree is an isolated copy.\n\n` +
      `The file \`.relay/space-context.md\` is the shared coordination source of truth for this Space. Read it before making decisions that may depend on sibling chats, and re-read it as you work whenever you need the latest shared status, interfaces, decisions, or blockers.\n\n` +
      `When you complete significant work, update \`.relay/space-context.md\` with decisions, interfaces other chats may depend on, current status, and blockers/questions.`;

    // Inject the brief's current contents (not just a pointer) so every chat in
    // the space starts with the shared context, mirroring how project custom
    // instructions inject their text. Skip when the file is empty or only the
    // seed template (headers/comments). See task b3e9f1a2 — completes the
    // bootstrap-content port custom_instructions received in 12fc245 (which
    // left the space brief as a pointer only).
    const brief = extractSpaceContextForInjection(this.getSpaceManager().readSpaceContext(spaceId));
    const text = brief
      ? `${guidance}\n\nCurrent \`.relay/space-context.md\` contents:\n\n${brief}`
      : guidance;

    return {
      key: `space:${spaceId}`,
      kind: SPACE_CONTEXT_BLOCK_KIND,
      title: `Space: ${space.name}`,
      source: ".relay/space-context.md",
      text,
    };
  }

  /**
   * Check if a provider session is a Claude SDK session (exposes sessionId eagerly).
   */
  private isSdkSession(proc: ProviderSession): proc is ClaudeSdkSession & ProviderSession {
    return proc.provider === "claude" && "sessionId" in proc;
  }

  private resolveRunnableCwd(instance: Instance): string {
    const cwd = instance.actualCwd || instance.info.workingDirectory;
    if (existsSync(cwd)) {
      if (this.missingRunnableCwdWarnings.get(instance.info.id) === cwd) {
        this.missingRunnableCwdWarnings.delete(instance.info.id);
      }
      return cwd;
    }

    if (hasExplicitNonDefaultSpace(this.spaceManager, instance.info.spaceId)) {
      if (this.missingRunnableCwdWarnings.get(instance.info.id) !== cwd) {
        this.missingRunnableCwdWarnings.set(instance.info.id, cwd);
        this.baseConfig.logger.warn(
          `[InstanceManager] Space-owned working directory ${cwd} is missing; keeping stale path to avoid falling back into the main repo`,
        );
      }
      return cwd;
    }

    if (instance.originalDirectory && existsSync(instance.originalDirectory)) {
      this.baseConfig.logger.warn(
        `[InstanceManager] Working directory ${cwd} no longer exists, falling back to original directory ${instance.originalDirectory}`,
      );
      instance.actualCwd = undefined;
      instance.worktreePath = undefined;
      instance.info.workingDirectory = instance.originalDirectory;
      return instance.originalDirectory;
    }

    return cwd;
  }

  private getBrokenSpaceWriteError(instance: Instance): string | null {
    const spaceId = instance.info.spaceId;
    if (!spaceId) {
      return null;
    }

    const space = this.spaceManager.getSpace(spaceId);
    if (!space) {
      return `Space ${spaceId} no longer exists`;
    }
    if (space.isDefault) {
      return null;
    }
    if (space.worktreePath) {
      return null;
    }

    return `Space "${space.name}" is missing its worktree and is currently read-only`;
  }

  private assertSpaceWritable(instance: Instance): void {
    const error = this.getBrokenSpaceWriteError(instance);
    if (error) {
      throw new Error(error);
    }
  }

  // ===========================================================================
  // Managed instances (read-write, spawned by relay)
  // ===========================================================================

  /**
   * Effective concurrent-process cap, resolved live from the global setting and
   * falling back to the server default (MAX_PROCESSES env / config). Reading it
   * per-create means changes apply immediately, no restart. Also keeps the
   * process listener ceiling in sync so a raised cap doesn't trip Node's
   * max-listeners warning (mirrors bin.ts's `setMaxListeners(max + 20)`).
   */
  private resolveMaxProcesses(): number {
    const configured = this.db.getGlobalSettings().max_processes;
    const max =
      typeof configured === "number" && configured > 0 ? configured : this.baseConfig.maxProcesses;
    if (process.getMaxListeners() < max + 20) {
      process.setMaxListeners(max + 20);
    }
    return max;
  }

  createInstance(options?: {
    provider?: ProviderKind;
    name?: string;
    workingDirectory?: string;
    runtimeMode?: ProviderRuntimeMode;
    resumeSessionId?: string;
    model?: string;
    spaceId?: string;
    modelOptions?: ProviderModelOptions;
    parentSessionId?: string;
    review?: import("#core/types.js").ReviewSessionInfo;
  }): InstanceInfo {
    const activeCount = [...this.instances.values()].filter(
      (i) => i.process && !i.info.external,
    ).length;
    const maxProcesses = this.resolveMaxProcesses();
    if (activeCount >= maxProcesses) {
      throw new MaxProcessesError(maxProcesses);
    }

    const id = randomUUID();
    this.instanceCounter++;
    let workingDirectory = options?.workingDirectory || this.baseConfig.workingDirectory;
    const now = Date.now();

    // If a space is specified, its worktree path always wins as the CWD
    const spaceId = options?.spaceId;
    let spaceOriginalDirectory: string | undefined;
    let spaceWorktreePath: string | undefined;
    let spaceGitBranch: string | undefined;
    if (spaceId) {
      const space = this.spaceManager.getSpace(spaceId);
      if (space) {
        if (!space.isDefault && !space.worktreePath) {
          throw new Error(
            `Space "${space.name}" is missing its worktree and is currently read-only`,
          );
        }
        spaceOriginalDirectory = space.projectDirectory;
        spaceGitBranch = space.gitBranch ?? undefined;
        if (space.worktreePath) {
          spaceWorktreePath = space.worktreePath;
          workingDirectory = space.worktreePath;
        } else {
          // Default space — use the project directory
          workingDirectory = space.projectDirectory;
        }
      }
      this.spaceManager.touchSpace(spaceId);
    }
    const resumeId = options?.resumeSessionId;

    // Auto-register project early so we can apply project-level defaults
    const projectDirectory = normalizeProjectDirectory(spaceOriginalDirectory ?? workingDirectory);
    let project = this._projectManager.getProjectByDirectory(projectDirectory);
    if (!project) {
      try {
        project = this._projectManager.addProject(projectDirectory);
      } catch {
        // Directory may not exist (e.g. remote sessions) — skip project registration
      }
    }

    // Resolve provider and model: explicit options > project defaults > global defaults > system defaults
    const globalSettings = this.db.getGlobalSettings();
    const provider: ProviderKind = options?.provider
      ? options.provider
      : (((project?.defaultProvider ?? globalSettings.default_provider) as ProviderKind) ??
        "claude");

    // Parse per-provider defaults from global settings
    let providerDefaults: Record<
      string,
      {
        model?: string;
        reasoningEffort?: string;
        runtimeMode?: string;
        fastMode?: boolean;
      }
    > = {};
    if (globalSettings.provider_defaults_json) {
      try {
        providerDefaults = JSON.parse(globalSettings.provider_defaults_json);
      } catch {}
    }
    const perProvider = providerDefaults[provider];

    // Resolve model: explicit > project default > per-provider default.
    // `isExplicitModel` tracks whether this came from a user choice (vs. being
    // inferred). It drives `preferredModel` on InstanceInfo, which the UI reads
    // to show the "Default" label when no explicit model was selected.
    // The *effective* session model (used in createProviderSession below) falls
    // back to the catalog default so the SDK/binary doesn't silently override
    // with its own internal default (which may not match our catalog).
    let model = options?.model ?? project?.defaultModel ?? perProvider?.model;
    let isExplicitModel = !!model;

    if (model) {
      // Cross-provider mismatch guard: clear the model when the requested ID
      // belongs to a *different* provider's builtin catalog (e.g. a Claude
      // model ID got stored while this session is Codex). Unknown model IDs
      // pass through — they may be newly discovered models the binary
      // supports but we don't list in the hardcoded catalog.
      const belongsToOtherProvider = (Object.keys(BUILTIN_PROVIDER_MODELS) as ProviderKind[]).some(
        (kind) => kind !== provider && BUILTIN_PROVIDER_MODELS[kind].some((m) => m.id === model),
      );
      if (belongsToOtherProvider) {
        model = undefined;
        isExplicitModel = false;
      }
    }

    // Resolve runtime mode: explicit options > per-provider global default > base config
    const resolvedRuntimeMode: ProviderRuntimeMode =
      options?.runtimeMode ??
      (perProvider?.runtimeMode as ProviderRuntimeMode | undefined) ??
      this.baseConfig.defaultRuntimeMode;

    const instanceConfig: CoreConfig = {
      ...this.baseConfig,
      workingDirectory,
      defaultRuntimeMode: resolvedRuntimeMode,
    };

    // Build canonical modelOptions: explicit modelOptions wins, then per-provider defaults
    let modelOptions: ProviderModelOptions | undefined =
      options?.modelOptions ??
      (perProvider?.reasoningEffort
        ? { reasoningEffort: perProvider.reasoningEffort as ReasoningEffort }
        : undefined);

    // Apply per-provider fastMode default only if caller didn't explicitly set it
    if (perProvider?.fastMode != null && options?.modelOptions?.fastMode === undefined) {
      modelOptions = { ...modelOptions, fastMode: perProvider.fastMode };
    }

    // Effective session model: explicit choice, or a provider fallback as a stable seed.
    // Claude is the exception: when the SDK has reported model metadata, leaving
    // the model unset lets Claude Code use its own current default without Relay
    // pinning a stale catalog ID.
    // This is separate from `preferredModel` on InstanceInfo, which stays undefined
    // so the UI renders the "Default" label and the user can always override.
    const effectiveSessionModel =
      model ??
      (provider === "claude" && getSdkDiscoveredModels()?.length
        ? undefined
        : resolveProviderDefaultModelOption(
            provider,
            provider === "codex" ? (getCachedCodexModels() ?? undefined) : undefined,
          )?.id);
    const bootstrapContext = resumeId
      ? this.buildBootstrapContext(project, {
          spaceId,
          workingDirectory,
          includeProjectInstructions: false,
          includeTaskContext: false,
        })
      : this.buildBootstrapContext(project, { spaceId, workingDirectory });

    const proc = this.createProviderSession(instanceConfig, {
      provider,
      resumeSessionId: resumeId,
      model: effectiveSessionModel,
      runtimeMode: resolvedRuntimeMode,
      modelOptions,
      bootstrapContext,
    });
    const deliveredBootstrap = bootstrapContext ?? proc.bootstrapContext;
    const initialBinding = proc.getRuntimeBinding();
    const providerBinding: ProviderRuntimeBinding = deliveredBootstrap
      ? {
          ...initialBinding,
          runtimePayload: {
            ...(initialBinding.runtimePayload ?? {}),
            sessionContext: { bootstrap: deliveredBootstrap },
          },
        }
      : initialBinding;
    if (options?.review) {
      providerBinding.runtimePayload = {
        ...(providerBinding.runtimePayload ?? {}),
        review: options.review,
      };
    }

    // Resolve name: explicit > session summary > auto-title from first message
    let name = options?.name || "";
    if (!name && resumeId) {
      name = this.getSessionSummary(resumeId, workingDirectory) || "";
    }
    if (!name) name = "New Session";

    const initialGitInfo = getGitInfo(workingDirectory) ?? undefined;
    const info: InstanceInfo = {
      id,
      provider,
      name,
      workingDirectory,
      status: "idle",
      createdAt: now,
      lastActivityAt: now,
      gitInfo: initialGitInfo,
      gitBranch: spaceGitBranch,
      originalGitBranch: initialGitInfo?.branch ?? getCurrentBranch(workingDirectory) ?? undefined,
      parentSessionId: options?.parentSessionId,
      preferredModel: isExplicitModel ? model : undefined,
      modelOptions,
      runtimeMode: resolvedRuntimeMode,
      originalDirectory: spaceOriginalDirectory,
      projectId: project?.id,
      projectSlug: project?.slug,
      spaceId,
      sessionContext: deliveredBootstrap ? { bootstrap: deliveredBootstrap } : undefined,
      review: options?.review,
    };

    const dirBasename = workingDirectory.split("/").pop() || "";
    const hasCustomName = !!(options?.name && options.name !== dirBasename);
    const instance: Instance = {
      info,
      process: proc,
      providerBinding,
      history: [],
      fileStateRevision: 0,
      autoTitle: !hasCustomName && !resumeId,
      worktreePath: spaceWorktreePath,
      gitBranch: spaceGitBranch,
      originalDirectory: spaceOriginalDirectory,
      actualCwd: spaceWorktreePath ? workingDirectory : undefined,
      hydrated: true,
      taskContextInjected: !!deliveredBootstrap?.blocks.some(
        (b) => b.kind === TASK_CONTEXT_BLOCK_KIND,
      ),
      customInstructionsInjected: !!deliveredBootstrap?.blocks.some(
        (b) => b.kind === CUSTOM_INSTRUCTIONS_BLOCK_KIND,
      ),
    };
    this.instances.set(id, instance);

    if (options?.review?.sourceInstanceId) {
      const source = this.instances.get(options.review.sourceInstanceId);
      if (source) {
        source.info.reviewInstanceId = id;
        this.dbSave(source);
        this.emit("instance:status", source.info.id, this.deriveInstanceView(source));
      }
    }

    this.wireProcessEvents(id, proc);

    if (resumeId) {
      // We already know the session ID — set it up directly instead of waiting for captureSessionId
      const transcriptPath = this.resolveManagedTranscriptPath(provider, {
        sessionId: resumeId,
        workingDirectory,
      });
      instance.sessionId = resumeId;
      instance.jsonlPath = transcriptPath;
      info.sessionId = resumeId;
      instance.providerBinding = {
        ...(instance.providerBinding ?? proc.getRuntimeBinding()),
        provider,
        providerSessionId: resumeId,
        resumeCursor: { sessionId: resumeId },
        transcriptPath,
        runtimeMode: resolvedRuntimeMode,
      };
      proc.setSessionId?.(resumeId);

      // Parse existing history so the UI shows the full conversation
      if (transcriptPath && existsSync(transcriptPath)) {
        const { history, tasks, files, stats } = this.parseProviderTranscript(
          provider,
          transcriptPath,
        );
        instance.history = history;
        if (tasks.size > 0) instance.tasks = tasks;
        if (files.size > 0) {
          instance.files = files;
          instance.fileStateRevision += 1;
          const diffCwd = instance.actualCwd || instance.info.workingDirectory;
          const origBranch = instance.originalDirectory
            ? (getCurrentBranch(instance.originalDirectory) ?? undefined)
            : undefined;
          enrichDiffStats(diffCwd, instance.files, {
            originalBranch: origBranch,
            sessionCreatedAt: instance.info.createdAt,
          });
        }
        if (hasSessionStats(stats)) info.stats = stats;

        // Start JSONL watcher
        try {
          instance.watchState = createWatchState(
            transcriptPath,
            statSync(transcriptPath).size,
            info.stats,
          );
          this.startWatching(id, instance);
        } catch {
          /* ignore */
        }
      }

      this.dbSave(instance);
      this.removeLiveExternalShadow(info.id, resumeId, transcriptPath);
    } else {
      this.dbSave(instance);
      this.captureSessionId(id, instance, proc);
    }

    this.baseConfig.logger.info(
      `[InstanceManager] Created instance "${name}" (${id})${resumeId ? ` resuming ${resumeId}` : ""}`,
    );
    const result = { ...info };
    this.emit("instance:created", id, result);
    return result;
  }

  /** Record an instance's JSONL paths as dismissed so discovery ignores them. */
  private dismissJsonlPaths(instance: Instance): void {
    const now = Date.now();
    if (instance.jsonlPath) this.dismissedJsonlPaths.set(instance.jsonlPath, now);
    if (instance.providerBinding?.transcriptPath) {
      this.dismissedJsonlPaths.set(instance.providerBinding.transcriptPath, now);
    }
    if (instance.externalState?.jsonlPath) {
      this.dismissedJsonlPaths.set(instance.externalState.jsonlPath, now);
    }
  }

  /** Check if a JSONL path was recently dismissed (within 60 s). */
  private isJsonlDismissed(jsonlPath: string): boolean {
    const dismissedAt = this.dismissedJsonlPaths.get(jsonlPath);
    if (dismissedAt === undefined) return false;
    if (Date.now() - dismissedAt > 60_000) {
      this.dismissedJsonlPaths.delete(jsonlPath);
      return false;
    }
    return true;
  }

  private deleteInstanceTranscriptFiles(instance: Instance): void {
    const transcriptPaths = new Set<string>();
    const bindingTranscriptPath = instance.providerBinding?.transcriptPath;
    if (bindingTranscriptPath) transcriptPaths.add(bindingTranscriptPath);
    if (instance.jsonlPath) transcriptPaths.add(instance.jsonlPath);

    for (const transcriptPath of transcriptPaths) {
      if (!existsSync(transcriptPath)) continue;
      try {
        unlinkSync(transcriptPath);
      } catch (err) {
        this.baseConfig.logger.warn(
          `[InstanceManager] Failed to delete transcript ${transcriptPath}: ${err}`,
        );
      }
    }
  }

  removeInstance(id: string, options?: { purge?: boolean }): boolean {
    const instance = this.instances.get(id);
    if (!instance) return false;
    const purge = options?.purge === true;
    const reviewSourceId = instance.info.review?.sourceInstanceId;

    const attachedReviewIds = this.getAttachedReviewIds(instance.info);
    for (const attachedReviewId of attachedReviewIds) {
      if (this.instances.has(attachedReviewId)) {
        this.removeInstance(attachedReviewId, purge ? { purge: true } : undefined);
      }
    }

    if (reviewSourceId) {
      const source = this.instances.get(reviewSourceId);
      if (source?.info.reviewInstanceId === id) {
        const [nextReviewId] = this.getAttachedReviewIds(source.info, id);
        source.info.reviewInstanceId = nextReviewId;
        this.dbSave(source);
        this.emit("instance:status", source.info.id, this.deriveInstanceView(source));
      }
    }

    if (instance.process) {
      instance.process.close();
    }

    // Stop JSONL watcher
    const watchInterval = this.watchIntervals.get(id);
    if (watchInterval) {
      clearInterval(watchInterval);
      this.watchIntervals.delete(id);
    }
    this.staleCounts.delete(id);
    this.missingRunnableCwdWarnings.delete(id);

    instance.info.status = "stopped";

    // Track JSONL paths so external discovery doesn't immediately re-import
    // this session while the subprocess is still winding down.
    this.dismissJsonlPaths(instance);

    this.instances.delete(id);
    if (purge) {
      if (instance.sessionId) this.db.deleteBySessionId(instance.sessionId);
      this.db.deleteByInstanceId(instance.info.id);
      this.db.deleteManagedByInstanceId(instance.info.id);
      this.deleteInstanceTranscriptFiles(instance);
    } else {
      if (instance.sessionId) this.db.archive(instance.sessionId);
      this.db.archiveManaged(instance.info.id);
    }

    // Only standalone worktree chats own their worktree lifecycle.
    // Space chats share a worktree owned by SpaceManager, so removing one chat
    // must not tear down the entire space's git metadata.
    if (
      !this.isSpaceOwnedWorktree(instance) &&
      instance.worktreePath &&
      instance.gitBranch &&
      instance.originalDirectory
    ) {
      const repoRoot = getRepoRoot(instance.originalDirectory);
      if (repoRoot) {
        try {
          removeWorktree(repoRoot, instance.worktreePath, instance.gitBranch);
          this.baseConfig.logger.info(
            `[InstanceManager] Removed worktree ${instance.worktreePath} and branch ${instance.gitBranch}`,
          );
        } catch (err) {
          this.baseConfig.logger.warn(`[InstanceManager] Failed to remove worktree: ${err}`);
        }
      }
    }

    this.baseConfig.logger.info(
      `[InstanceManager] ${purge ? "Purged" : "Removed"} instance "${instance.info.name}" (${id})`,
    );
    return true;
  }

  /**
   * Stop a managed session's process without removing the chat. This frees a
   * process slot (the cap counts `i.process && !external`) while keeping the
   * session in the sidebar and resumable: the next user message cold-boots it
   * again via bootManagedInstance (resume from sessionId).
   *
   * Returns false (no-op) when the instance is unknown, external, lacks a live
   * process, or has no resumable session id yet — a brand-new chat that has
   * never produced a session id cannot be revived, so stopping it would strand
   * it; such chats should be removed instead.
   */
  stopInstance(id: string): boolean {
    const instance = this.instances.get(id);
    if (!instance) return false;
    if (instance.info.external) return false;
    if (!instance.process) return false;
    // Must be resumable — bootManagedInstance needs a session id to revive.
    const resumable =
      instance.sessionId ?? instance.info.sessionId ?? instance.providerBinding?.providerSessionId;
    if (!resumable) return false;

    try {
      instance.process.close();
    } catch (err) {
      this.baseConfig.logger.warn(`[InstanceManager] Failed to close process during stop: ${err}`);
    }
    // Drop the binding so the active-process count frees a slot.
    instance.process = null;

    // Stop the JSONL watcher; it is re-established on revive.
    const watchInterval = this.watchIntervals.get(id);
    if (watchInterval) {
      clearInterval(watchInterval);
      this.watchIntervals.delete(id);
    }
    this.staleCounts.delete(id);

    this.setStatus(instance, "stopped");
    this.dbSave(instance);
    this.baseConfig.logger.info(
      `[InstanceManager] Stopped instance "${instance.info.name}" (${id})`,
    );
    return true;
  }

  /**
   * Merge a worktree instance's branch into the original directory's current branch,
   * then clean up the worktree and archive the instance.
   *
   * Throws if the instance has no worktree, the worktree is dirty, or the merge fails.
   */
  mergeInstance(id: string): { targetBranch: string } {
    const instance = this.instances.get(id);
    if (!instance) throw new Error(`Instance ${id} not found`);

    if (!instance.worktreePath || !instance.gitBranch || !instance.originalDirectory) {
      throw new Error("Instance does not have a worktree to merge");
    }

    // Auto-commit dirty worktrees — safe because worktrees are isolated Claude work
    if (isWorktreeDirty(instance.worktreePath)) {
      const commitMsg = instance.info.name || "Relay work";
      this.baseConfig.logger.info(
        `[InstanceManager] Auto-committing changes in worktree for "${commitMsg}"`,
      );
      const commitResult = commitAll(instance.worktreePath, commitMsg);
      if (!commitResult.success) {
        throw new Error(`Auto-commit failed: ${commitResult.error}`);
      }
    }

    const repoRoot = getRepoRoot(instance.originalDirectory);
    if (!repoRoot) {
      throw new Error("Could not determine git repository root");
    }

    const targetBranch = getCurrentBranch(repoRoot) || "unknown";

    const result = mergeWorktreeBranch(repoRoot, instance.gitBranch);
    if (!result.success) {
      throw new Error(`Merge failed: ${result.error}`);
    }

    this.baseConfig.logger.info(
      `[InstanceManager] Merged branch ${instance.gitBranch} into ${targetBranch}`,
    );

    // Clean up: remove worktree + archive instance
    this.removeInstance(id);
    this.emit("instance:removed", id);

    return { targetBranch };
  }

  // ===========================================================================
  // Space management (delegates to SpaceManager)
  // ===========================================================================

  getSpaceManager(): SpaceManager {
    return this.spaceManager;
  }

  /**
   * After a worktree has been converted into a Space, attach any existing
   * loose chats that already live in that worktree to the new space and
   * broadcast the updated `spaceId` for any in-memory instances.
   */
  claimChatsForSpace(spaceId: string): void {
    this.backfillMissingSpaceIds();
    this.refreshInstanceSpaceIdsFromDb();
    for (const instance of this.instances.values()) {
      if (instance.info.spaceId === spaceId) {
        this.emit("instance:status", instance.info.id, this.deriveInstanceView(instance));
      }
    }
  }

  getSpinOffManager(): SpinOffManager {
    return this.spinOffManager;
  }

  getChangedFiles(instanceId: string): FileChange[] | null {
    const instance = this.instances.get(instanceId);
    if (!instance?.files || instance.files.size === 0) return null;
    return Array.from(instance.files.values());
  }

  private cloneInstanceInfo(info: InstanceInfo): InstanceInfo {
    return {
      ...info,
      lastMessage: info.lastMessage ? { ...info.lastMessage } : undefined,
      pendingPermission: info.pendingPermission
        ? {
            ...info.pendingPermission,
            questions: info.pendingPermission.questions?.map((question) => ({
              ...question,
              options: question.options?.map((option) => ({ ...option })) ?? question.options,
            })),
          }
        : undefined,
      providerStatus: info.providerStatus
        ? {
            ...info.providerStatus,
            slashCommands: info.providerStatus.slashCommands?.map((command) => ({
              ...command,
              input: command.input ? { ...command.input } : undefined,
            })),
            skills: info.providerStatus.skills?.map((skill) => ({ ...skill })),
            mcpServers: info.providerStatus.mcpServers?.map((server) => ({ ...server })),
            account: info.providerStatus.account
              ? {
                  ...info.providerStatus.account,
                  rateLimits: info.providerStatus.account.rateLimits?.map((limit) => ({
                    ...limit,
                  })),
                }
              : undefined,
            diff: info.providerStatus.diff ? { ...info.providerStatus.diff } : undefined,
            apps: info.providerStatus.apps ? [...info.providerStatus.apps] : undefined,
            notices: info.providerStatus.notices?.map((notice) => ({ ...notice })),
          }
        : undefined,
      stats: info.stats ? { ...info.stats } : undefined,
      gitInfo: info.gitInfo ? { ...info.gitInfo } : undefined,
      branchChanged: info.branchChanged ? { ...info.branchChanged } : undefined,
      modelOptions: info.modelOptions ? { ...info.modelOptions } : undefined,
      sessionContext: info.sessionContext
        ? {
            bootstrap: info.sessionContext.bootstrap
              ? {
                  ...info.sessionContext.bootstrap,
                  blocks: info.sessionContext.bootstrap.blocks.map((block) => ({ ...block })),
                }
              : undefined,
          }
        : undefined,
      review: info.review
        ? {
            ...info.review,
            filePaths: info.review.filePaths ? [...info.review.filePaths] : undefined,
          }
        : undefined,
      reviewInstanceId: info.reviewInstanceId,
    };
  }

  private deriveInstanceView(instance: Instance): InstanceInfo {
    const info = this.cloneInstanceInfo(instance.info);
    if (!info.reviewInstanceId) {
      const preferred = pickPreferredAttachedReview(
        info,
        Array.from(this.instances.values())
          .filter((candidate) => candidate.info.id !== instance.info.id)
          .map((candidate) => candidate.info),
      );
      if (preferred) {
        info.reviewInstanceId = preferred.id;
      }
    }
    return info;
  }

  private cloneProviderGlobalState(
    state: import("#core/types.js").ProviderGlobalState,
  ): import("#core/types.js").ProviderGlobalState {
    return {
      ...state,
      account: state.account
        ? {
            ...state.account,
            rateLimits: state.account.rateLimits?.map((limit) => ({ ...limit })),
          }
        : undefined,
      mcpServers: state.mcpServers?.map((server) => ({ ...server })),
      apps: state.apps ? [...state.apps] : undefined,
      notices: state.notices?.map((notice) => ({ ...notice })),
    };
  }

  listProviderGlobalState(): import("#core/types.js").ProviderGlobalState[] {
    return Array.from(this.providerGlobalState.values()).map((state) =>
      this.cloneProviderGlobalState(state),
    );
  }

  async ensureProviderGlobalState(provider: ProviderKind, force = false): Promise<void> {
    const existing = this.providerGlobalState.get(provider);
    if (!force && existing && Date.now() - existing.updatedAt < 5 * 60_000) {
      return;
    }
    const inFlight = this.providerGlobalHydrationInFlight.get(provider);
    if (inFlight) return inFlight;

    const run = (async () => {
      try {
        if (provider === "claude") {
          // Plan/email/org come from the pre-warmed SDK account info if
          // available — this means the UI sees the user's plan at boot
          // instead of having to wait for the first managed session.
          const accountInfo = getSdkDiscoveredAccountInfo();
          const accountPatch: import("#core/types.js").ProviderAccountStatus = {};
          if (accountInfo?.subscriptionType) accountPatch.plan = accountInfo.subscriptionType;
          if (accountInfo?.email) accountPatch.email = accountInfo.email;
          if (accountInfo?.organization) accountPatch.label = accountInfo.organization;

          // Rate limits: prefer live `rate_limit_event` data accumulated by
          // active sessions, falling back to the experimental get_usage
          // snapshot cached at prewarm / session start (SDK >= 0.3.169).
          for (const instance of this.instances.values()) {
            if (instance.info.provider !== "claude" || !instance.process) continue;
            const session =
              instance.process as import("#core/providers/claude-sdk.js").ClaudeSdkSession;
            if (typeof session.getRateLimitSnapshot !== "function") continue;
            const rateLimits = session.getRateLimitSnapshot();
            if (rateLimits?.length) {
              accountPatch.rateLimits = rateLimits;
              break;
            }
          }
          if (!accountPatch.rateLimits) {
            const snapshot = getSdkDiscoveredRateLimits();
            if (snapshot?.length) accountPatch.rateLimits = snapshot;
          }

          if (Object.keys(accountPatch).length > 0) {
            this.updateProviderGlobalState("claude", { account: accountPatch });
          }
          return;
        }
        if (provider !== "codex") return;
        const cwd =
          Array.from(this.instances.values()).find(
            (instance) => instance.info.provider === provider,
          )?.actualCwd ??
          Array.from(this.instances.values()).find(
            (instance) => instance.info.provider === provider,
          )?.info.workingDirectory ??
          this.baseConfig.workingDirectory ??
          process.cwd();
        const snapshot = await fetchCodexProviderGlobalStateSnapshot({
          cwd,
          logger: this.baseConfig.logger,
        });
        this.updateProviderGlobalState(provider, snapshot);
      } catch (err) {
        this.baseConfig.logger.debug(
          `[InstanceManager] Failed to hydrate provider global state for ${provider}: ${err}`,
        );
      } finally {
        this.providerGlobalHydrationInFlight.delete(provider);
      }
    })();

    this.providerGlobalHydrationInFlight.set(provider, run);
    return run;
  }

  recordManagedMcpConfiguration(provider: ProviderKind, name: string): void {
    const existing = this.providerGlobalState.get(provider)?.mcpServers ?? [];
    this.updateProviderGlobalState(provider, {
      mcpServers: overlayManagedMcpConfiguration(existing, provider, name),
    });
  }

  private updateProviderGlobalState(
    provider: import("#core/types.js").ProviderKind,
    patch: Partial<import("#core/types.js").ProviderGlobalState>,
  ): void {
    const prev = this.providerGlobalState.get(provider);
    const next: import("#core/types.js").ProviderGlobalState = {
      provider,
      updatedAt: Date.now(),
      ...prev,
      ...patch,
      account: patch.account
        ? {
            ...prev?.account,
            ...patch.account,
            rateLimits: patch.account.rateLimits
              ? mergeRateLimits(prev?.account?.rateLimits, patch.account.rateLimits)
              : prev?.account?.rateLimits?.map((limit) => ({ ...limit })),
          }
        : prev?.account
          ? {
              ...prev.account,
              rateLimits: prev.account.rateLimits?.map((limit) => ({ ...limit })),
            }
          : undefined,
      mcpServers: patch.mcpServers
        ? patch.mcpServers.map((server) => ({ ...server }))
        : prev?.mcpServers?.map((server) => ({ ...server })),
      apps: patch.apps ? [...patch.apps] : prev?.apps ? [...prev.apps] : undefined,
      notices: patch.notices
        ? patch.notices.map((notice) => ({ ...notice }))
        : prev?.notices?.map((notice) => ({ ...notice })),
    };
    this.providerGlobalState.set(provider, next);
    this.emit("provider_global_state:updated", provider, this.cloneProviderGlobalState(next));

    // Debounced persistence: write all provider state to disk ~500 ms after the
    // last update so rapid consecutive updates collapse into a single write.
    if (this._persistStateTimeout !== null) {
      clearTimeout(this._persistStateTimeout);
    }
    this._persistStateTimeout = setTimeout(() => {
      this._persistStateTimeout = null;
      persistProviderState(
        this._providerStateFilePath,
        Array.from(this.providerGlobalState.values()),
      );
    }, 500);
  }

  private emitInstanceStatus(instance: Instance): void {
    if (this.shuttingDown) return;
    this.emit("instance:status", instance.info.id, this.deriveInstanceView(instance));
  }

  private isInstanceNotFoundError(err: unknown): boolean {
    return err instanceof Error && /Instance .* not found/.test(err.message);
  }

  private logQueuedMutationError(context: string, instanceId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (this.shuttingDown || this.isInstanceNotFoundError(err)) {
      this.baseConfig.logger.debug(
        `[InstanceManager] ${context} dropped for ${instanceId}: ${message}`,
      );
      return;
    }
    this.baseConfig.logger.error(
      `[InstanceManager] ${context} failed for ${instanceId}: ${message}`,
    );
  }

  private enqueueInstanceMutation<T>(
    instanceId: string,
    mutate: (instance: Instance) => T | Promise<T>,
  ): Promise<T> {
    const previous = this.instanceMutationChains.get(instanceId) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(async () => {
        const instance = this.instances.get(instanceId);
        if (!instance) throw new Error(`Instance ${instanceId} not found`);
        return mutate(instance);
      });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.instanceMutationChains.set(instanceId, tail);
    return run.finally(() => {
      if (this.instanceMutationChains.get(instanceId) === tail) {
        this.instanceMutationChains.delete(instanceId);
      }
    });
  }

  private async flushInstanceMutations(): Promise<void> {
    await Promise.all(
      [...this.instanceMutationChains.values()].map((chain) => chain.catch(() => {})),
    );
  }

  /**
   * Snapshot of `project_id -> slug` for every registered project. Built fresh
   * on each call so callers always see the current state; the lookup is small
   * (one entry per project) so this is cheap to recompute per listing.
   */
  private projectSlugLookup(): Map<string, string> {
    return new Map(this._projectManager.listProjects().map((p) => [p.id, p.slug] as const));
  }

  listInstances(): InstanceInfo[] {
    if (this.shuttingDown || this.instances.size === 0) {
      return [];
    }
    const managedKeys = this.collectManagedSessionKeys();
    return attachReviewLinks(
      Array.from(this.instances.values())
        .filter(
          (i) =>
            !!i.info.projectId &&
            !isManagedShadowInstance(this.toManagedShadowIdentity(i), managedKeys),
        )
        .map((i) => this.deriveInstanceView(i)),
    );
  }

  getInstance(id: string): InstanceInfo | undefined {
    const instance = this.instances.get(id);
    return instance ? this.deriveInstanceView(instance) : undefined;
  }

  getChatSummary(id: string): InstanceInfo | null {
    const live = this.instances.get(id);
    if (live) {
      return toChatSummaryInfo(this.deriveInstanceView(live));
    }

    const slugs = this.projectSlugLookup();

    const external = this.db.getByInstanceId(id);
    if (external) {
      return summaryFromSessionRow(external, slugs);
    }

    const managed = this.db.getManagedByInstanceId(id);
    if (managed) {
      return summaryFromManagedRow(managed, slugs);
    }

    return null;
  }

  listProjectChats(projectId: string): InstanceInfo[] {
    const chats = new Map<string, InstanceInfo>();
    const managedProviderSessionIds = new Set<string>();
    const managedTranscriptPaths = new Set<string>();
    const managedKeys = {
      providerSessionIds: managedProviderSessionIds,
      transcriptPaths: managedTranscriptPaths,
    };
    const slugs = this.projectSlugLookup();

    for (const instance of this.instances.values()) {
      if (instance.info.projectId !== projectId) {
        continue;
      }
      if (!instance.info.external) {
        const binding = instance.providerBinding ?? instance.process?.getRuntimeBinding();
        const providerSessionId =
          binding?.providerSessionId ?? instance.sessionId ?? instance.info.sessionId;
        const transcriptPath = binding?.transcriptPath ?? instance.jsonlPath;
        if (providerSessionId) managedProviderSessionIds.add(providerSessionId);
        if (transcriptPath) managedTranscriptPaths.add(transcriptPath);
      }
    }

    for (const row of this.db.getManagedByProjectId(projectId)) {
      if (row.provider_session_id) managedProviderSessionIds.add(row.provider_session_id);
      if (row.transcript_path) managedTranscriptPaths.add(row.transcript_path);
    }

    for (const instance of this.instances.values()) {
      if (instance.info.projectId !== projectId) {
        continue;
      }
      if (isManagedShadowInstance(this.toManagedShadowIdentity(instance), managedKeys)) {
        continue;
      }
      chats.set(instance.info.id, toChatSummaryInfo(this.deriveInstanceView(instance)));
    }

    for (const row of this.db.getManagedByProjectId(projectId)) {
      if (!chats.has(row.instance_id)) {
        chats.set(row.instance_id, summaryFromManagedRow(row, slugs));
      }
    }

    for (const row of this.db.getByProjectId(projectId)) {
      if (
        managedProviderSessionIds.has(row.session_id) ||
        managedTranscriptPaths.has(row.jsonl_path)
      ) {
        continue;
      }
      if (!chats.has(row.instance_id)) {
        chats.set(row.instance_id, summaryFromSessionRow(row, slugs));
      }
    }

    return sortChatsByLastActivity(attachReviewLinks(Array.from(chats.values())));
  }

  listSpaceChats(spaceId: string): InstanceInfo[] {
    const chats = new Map<string, InstanceInfo>();
    const managedProviderSessionIds = new Set<string>();
    const managedTranscriptPaths = new Set<string>();
    const managedKeys = {
      providerSessionIds: managedProviderSessionIds,
      transcriptPaths: managedTranscriptPaths,
    };
    const slugs = this.projectSlugLookup();

    for (const instance of this.instances.values()) {
      if (instance.info.spaceId !== spaceId) {
        continue;
      }
      if (!instance.info.external) {
        const binding = instance.providerBinding ?? instance.process?.getRuntimeBinding();
        const providerSessionId =
          binding?.providerSessionId ?? instance.sessionId ?? instance.info.sessionId;
        const transcriptPath = binding?.transcriptPath ?? instance.jsonlPath;
        if (providerSessionId) managedProviderSessionIds.add(providerSessionId);
        if (transcriptPath) managedTranscriptPaths.add(transcriptPath);
      }
    }

    for (const row of this.db.getManagedBySpaceId(spaceId)) {
      if (row.provider_session_id) managedProviderSessionIds.add(row.provider_session_id);
      if (row.transcript_path) managedTranscriptPaths.add(row.transcript_path);
    }

    for (const instance of this.instances.values()) {
      if (instance.info.spaceId !== spaceId) {
        continue;
      }
      if (isManagedShadowInstance(this.toManagedShadowIdentity(instance), managedKeys)) {
        continue;
      }
      chats.set(instance.info.id, toChatSummaryInfo(this.deriveInstanceView(instance)));
    }

    for (const row of this.db.getManagedBySpaceId(spaceId)) {
      if (!chats.has(row.instance_id)) {
        chats.set(row.instance_id, summaryFromManagedRow(row, slugs));
      }
    }

    for (const row of this.db.getBySpaceId(spaceId)) {
      if (
        managedProviderSessionIds.has(row.session_id) ||
        managedTranscriptPaths.has(row.jsonl_path)
      ) {
        continue;
      }
      if (!chats.has(row.instance_id)) {
        chats.set(row.instance_id, summaryFromSessionRow(row, slugs));
      }
    }

    return sortChatsByLastActivity(attachReviewLinks(Array.from(chats.values())));
  }

  getWorkspaceEntries(id: string, query: string): WorkspaceEntry[] | null {
    const instance = this.instances.get(id);
    if (!instance) return null;
    const root = instance.actualCwd || instance.info.workingDirectory;
    return searchWorkspaceEntries(root, query);
  }

  getAvailableProviders(): ProviderDescriptor[] {
    return listAvailableProviders(this.getProviderContext());
  }

  isProviderAvailable(provider: ProviderKind): boolean {
    return isProviderAvailable(provider, this.getProviderContext());
  }

  getProviderCapabilities(provider: ProviderKind) {
    return getProviderCapabilities(provider);
  }

  async getProviderModels(provider: ProviderKind): Promise<ProviderModelOption[]> {
    if (!this.isProviderAvailable(provider)) {
      throw new Error(`Provider '${provider}' is not available`);
    }
    return getProviderModels(provider, this.getProviderContext());
  }

  getInstanceDiff(id: string, filePath?: string): string | null {
    const instance = this.instances.get(id);
    if (!instance) return null;
    const cwd = this.resolveRunnableCwd(instance);
    const origBranch = instance.originalDirectory
      ? (getCurrentBranch(instance.originalDirectory) ?? undefined)
      : undefined;
    const opts = {
      originalBranch: origBranch,
      sessionCreatedAt: instance.info.createdAt,
    };
    return filePath ? getFileDiff(cwd, filePath, opts) : getFullDiff(cwd, opts);
  }

  private async dispatchUserMessageLocked(
    id: string,
    instance: Instance,
    text: string,
    images?: string[],
    internal?: boolean,
    attachments?: string[],
  ): Promise<InstanceInfo | undefined> {
    this.hydrateInstance(id, instance);
    this.assertSpaceWritable(instance);

    let resumed: InstanceInfo | undefined;
    if (instance.info.external) {
      resumed = await this.resumeInstanceLocked(id, instance);
    } else if (!instance.process) {
      this.bootManagedInstance(id, instance);
    } else if (instance.info.status === "stopped" && instance.sessionId) {
      resumed = this.reviveInstanceLocked(id, instance);
    }

    if (!instance.process) {
      throw new Error("Instance could not be started");
    }

    let shouldInjectTaskContext = false;
    let customInstructions: string | null = null;

    if (!instance.taskContextInjected && !internal && instance.info.projectId) {
      instance.taskContextInjected = true;
      const taskProject = this._projectManager.getProject(instance.info.projectId);
      if (taskProject && hasTasks(taskProject.directory)) {
        shouldInjectTaskContext = true;
      }
    }

    if (!instance.customInstructionsInjected && !internal) {
      instance.customInstructionsInjected = true;
      const project = instance.info.projectId
        ? this._projectManager.getProject(instance.info.projectId)
        : undefined;
      const blocks = this.getProjectCustomInstructionBlocks(project);
      if (blocks.length > 0) {
        customInstructions = blocks.map((block) => block.text.trim()).join("\n\n");
      }
    }

    if (instance.autoTitle) {
      instance.info.name = generateTitle(text);
      instance.autoTitle = false;
    }

    let messageText = text;
    if (images && images.length > 0) {
      const markers = images.map((p) => `[Image: source: ${p}]`).join("\n");
      messageText = messageText ? `${messageText}\n${markers}` : markers;
    }
    if (attachments && attachments.length > 0) {
      const markers = attachments.map((p) => `[File: source: ${p}]`).join("\n");
      messageText = messageText ? `${messageText}\n${markers}` : markers;
    }

    const isCompactCommand =
      !internal && !images?.length && !attachments?.length && COMPACT_COMMAND_RE.test(text);
    const canUseNativeCompact =
      isCompactCommand &&
      instance.info.provider === "codex" &&
      !!instance.process.compactThread &&
      !!(
        instance.sessionId ||
        instance.info.sessionId ||
        instance.providerBinding?.providerSessionId ||
        instance.process.getRuntimeBinding().providerSessionId
      );

    let outboundMessage = messageText;
    if (shouldInjectTaskContext) {
      outboundMessage = buildFirstTurnTaskContextPrompt(outboundMessage);
    }
    if (customInstructions) {
      outboundMessage = buildCustomInstructionsPrompt(outboundMessage, customInstructions);
    }

    const userMessage: UserMessage = {
      type: "user",
      text: messageText,
      images,
      attachments,
      instanceId: id,
      internal,
    };
    this.noteManagedProcessActivity(instance);
    // Emit a model-switch divider above this turn if the model changed since the
    // previous user turn. Skipped for internal (system-injected) messages, which
    // aren't user-visible turns. Must precede the user message pushHistory below.
    if (!internal) this.recordModelSwitchOnDispatch(instance);
    this.pushHistory(instance, userMessage);
    this.emit("instance:user", id, userMessage);

    instance.info.lastActivityAt = Date.now();
    instance.info.pendingTool = undefined;
    instance.info.pendingPermission = undefined;

    if (instance.info.pendingPlan && instance.info.runtimeMode === "plan") {
      instance.info.runtimeMode = "approval-required";
      instance.process?.setRuntimeMode("approval-required");
      this.baseConfig.logger.info(
        "[InstanceManager] Plan approved — exiting plan mode for execution",
      );
    }
    instance.info.pendingPlan = undefined;
    instance.planFilePath = undefined;
    this.setStatus(instance, "processing");

    if (canUseNativeCompact) {
      instance.process.compactThread!();
    } else {
      instance.process.send(outboundMessage);
    }
    return resumed ? this.cloneInstanceInfo(resumed) : undefined;
  }

  private async resolveRequestLocked(
    id: string,
    instance: Instance,
    requestId: string,
    decision: "accept" | "decline",
    response?: import("#core/types.js").ProviderRequestResponse,
  ): Promise<void> {
    this.assertSpaceWritable(instance);
    if (instance.info.external) throw new Error("Cannot approve tools on external instances");
    if (!instance.process) throw new Error("Instance is not running");
    const pendingRequest = instance.info.pendingPermission;
    if (!pendingRequest) throw new Error("Instance has no pending request");
    const pendingStateBefore = this.pendingStateSignature(instance);

    if (pendingRequest.kind === "user_input") {
      instance.info.pendingTool = undefined;
      instance.info.pendingPermission = undefined;
      this.emitPendingStateIfChanged(instance, pendingStateBefore);
      if (instance.process.respondToRequest?.(requestId, decision, response)) {
        // The SDK consumed the answer internally — emit a visible user message so
        // the answer appears in the chat (no re-send to the provider).
        const reply = buildUserInputReply(pendingRequest, decision, response);
        const userMessage: UserMessage = { type: "user", text: reply.text, instanceId: id };
        this.noteManagedProcessActivity(instance);
        this.pushHistory(instance, userMessage);
        this.emit("instance:user", id, userMessage);
        this.setStatus(instance, "processing");
        return;
      }

      const reply = buildUserInputReply(pendingRequest, decision, response);
      const activity: ActivityMessage = {
        type: "activity",
        activity: "tool_result",
        tool: "AskUserQuestion",
        description: "Tool completed",
        resolution: reply.resolution,
        input: { requestId },
      };
      this.noteManagedProcessActivity(instance);
      this.pushHistory(instance, activity);
      this.emit("instance:activity", id, activity);
      await this.dispatchUserMessageLocked(id, instance, reply.text);
      return;
    }

    if (pendingRequest.kind === "terminal_input") {
      instance.info.pendingTool = undefined;
      instance.info.pendingPermission = undefined;
      this.emitPendingStateIfChanged(instance, pendingStateBefore);
      if (instance.process.respondToRequest?.(requestId, decision, response)) {
        this.setStatus(instance, "processing");
        return;
      }

      const text = decision === "accept" ? (response?.text?.trim() ?? "") : "";
      if (text) {
        await this.dispatchUserMessageLocked(id, instance, text);
      }
      return;
    }

    const tool = pendingRequest.tool ?? requestId;
    const isFileWrite = FILE_WRITE_GROUP.includes(tool);
    const toolsToAdd = decision === "accept" ? (isFileWrite ? FILE_WRITE_GROUP : [tool]) : [];

    instance.info.pendingTool = undefined;
    instance.info.pendingPermission = undefined;
    this.emitPendingStateIfChanged(instance, pendingStateBefore);

    if (decision === "accept" && instance.sessionId) {
      try {
        const allTools = [...new Set(toolsToAdd)];
        const row = this.db.getBySessionId(instance.sessionId);
        if (row) {
          try {
            const existing = JSON.parse(row.allowed_tools) as string[];
            for (const allowedTool of existing) {
              if (!allTools.includes(allowedTool)) allTools.push(allowedTool);
            }
          } catch {
            // ignore parse errors
          }
        }
        this.db.updateAllowedTools(instance.sessionId, allTools);
      } catch (err) {
        this.baseConfig.logger.warn(`[InstanceManager] Failed to persist allowed tools: ${err}`);
      }
    }

    if (instance.process.respondToRequest) {
      for (const allowedTool of toolsToAdd) {
        instance.process.addAllowedTool(allowedTool);
      }
      instance.process.respondToRequest(requestId, decision, response);
      this.setStatus(instance, decision === "accept" ? "processing" : "idle");
      return;
    }

    if (decision !== "accept") {
      this.setStatus(instance, "idle");
      return;
    }

    for (const allowedTool of toolsToAdd) {
      instance.process.addAllowedTool(allowedTool);
    }

    const retryText = buildPermissionGrantedRetryMessage(isFileWrite ? "file writes" : tool);
    if (instance.process.isProcessing) {
      instance.pendingRetry = retryText;
      return;
    }

    const userMessage: UserMessage = {
      type: "user",
      text: retryText,
      instanceId: id,
      internal: true,
    };
    this.noteManagedProcessActivity(instance);
    this.pushHistory(instance, userMessage);
    this.emit("instance:user", id, userMessage);
    instance.info.lastActivityAt = Date.now();
    this.setStatus(instance, "processing");
    instance.process.send(retryText);
  }

  /**
   * Send a message to an instance. If the instance is external (read-only),
   * transparently resumes it first. Returns the updated InstanceInfo if a
   * resume happened (so callers can broadcast the transition), undefined otherwise.
   */
  async sendMessage(
    id: string,
    text: string,
    images?: string[],
    internal?: boolean,
    attachments?: string[],
  ): Promise<InstanceInfo | undefined> {
    return this.enqueueInstanceMutation(id, (instance) => {
      // If the agent is mid-turn, queue the message for delivery when the turn ends
      if (instance.process?.isProcessing && !instance.info.external) {
        if (!instance.pendingMessages) instance.pendingMessages = [];
        const queuedId = randomUUID();
        instance.pendingMessages.push({ id: queuedId, text, images, attachments, internal });

        // Emit to the UI so the queued message appears in the chat immediately,
        // but do NOT push to history — dispatchUserMessageLocked will create
        // the real history entry when the queue is drained.
        // Apply the same marker transform that dispatchUserMessageLocked uses,
        // so the placeholder text is self-contained and renderable.
        let displayText = text;
        if (images && images.length > 0) {
          const markers = images.map((p) => `[Image: source: ${p}]`).join("\n");
          displayText = displayText ? `${displayText}\n${markers}` : markers;
        }
        if (attachments && attachments.length > 0) {
          const markers = attachments.map((p) => `[File: source: ${p}]`).join("\n");
          displayText = displayText ? `${displayText}\n${markers}` : markers;
        }
        const userMessage: import("#core/types.js").UserMessage = {
          type: "user",
          text: displayText,
          images,
          attachments,
          instanceId: id,
          internal,
          queued: true,
          queuedId,
          queuedSourceText: text,
        };
        this.emit("instance:user", id, userMessage);
        instance.info.queuedMessageCount = instance.pendingMessages.length;
        this.emitInstanceStatus(instance);
        return undefined;
      }
      return this.dispatchUserMessageLocked(id, instance, text, images, internal, attachments);
    });
  }

  /**
   * Take over an external session — resumes it as a managed instance
   * without sending any user message. Returns the updated InstanceInfo.
   */
  async takeoverInstance(id: string): Promise<InstanceInfo | undefined> {
    return this.enqueueInstanceMutation(id, async (instance) => {
      if (!instance.info.external) throw new Error("Instance is not external");
      this.hydrateInstance(id, instance);
      this.assertSpaceWritable(instance);
      const resumed = await this.resumeInstanceLocked(id, instance);
      return resumed;
    });
  }

  async cancelMessage(id: string): Promise<void> {
    await this.enqueueInstanceMutation(id, async (instance) => {
      if (instance.info.external) throw new Error("Cannot cancel on external instances");
      if (!instance.process) throw new Error("Instance is not running");
      instance.cancelledByUser = true;
      instance.process.interrupt();
    });
  }

  /**
   * Interrupt the current agent turn so queued messages are delivered sooner.
   * The queued messages will be drained by the normal output/exit handler
   * once the process responds to the interrupt.
   */
  async interruptAndSend(id: string): Promise<void> {
    await this.enqueueInstanceMutation(id, (instance) => {
      if (instance.info.external) throw new Error("Cannot interrupt external instances");
      if (!instance.process) throw new Error("Instance is not running");
      if (!instance.pendingMessages?.length) throw new Error("No queued messages to send");
      // Use interruptedToSend so the exit handler knows to drain the queue
      // (distinct from cancelledByUser which is a plain cancel)
      instance.interruptedToSend = true;
      instance.process.interrupt();
    });
  }

  /**
   * Coalesce all pending queued messages into a single message for dispatch.
   * Combines text with double-newline separators and merges image arrays.
   */
  private coalescePendingMessages(instance: Instance): {
    text: string;
    images?: string[];
    attachments?: string[];
    internal?: boolean;
  } {
    const msgs = instance.pendingMessages ?? [];
    const texts = msgs.map((m) => m.text).filter(Boolean);
    const images = msgs.flatMap((m) => m.images ?? []);
    const attachments = msgs.flatMap((m) => m.attachments ?? []);
    // If any message is non-internal, treat the coalesced result as non-internal
    const allInternal = msgs.every((m) => m.internal);
    return {
      text: texts.join("\n\n"),
      images: images.length ? images : undefined,
      attachments: attachments.length ? attachments : undefined,
      internal: allInternal ? true : undefined,
    };
  }

  async respondToRequest(
    id: string,
    requestId: string,
    decision: "accept" | "decline",
    response?: import("#core/types.js").ProviderRequestResponse,
  ): Promise<void> {
    await this.enqueueInstanceMutation(id, (instance) =>
      this.resolveRequestLocked(id, instance, requestId, decision, response),
    );
  }

  async approveToolUse(id: string, tool: string): Promise<void> {
    await this.enqueueInstanceMutation(id, (instance) => {
      const requestId =
        typeof instance.info.pendingPermission === "object" &&
        instance.info.pendingPermission.tool === tool
          ? instance.info.pendingPermission.requestId
          : tool;
      return this.resolveRequestLocked(id, instance, requestId, "accept");
    });
  }

  private async waitForPidExit(pid: number, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          return true;
        }
        if (code === "EPERM") {
          this.baseConfig.logger.warn(
            `[InstanceManager] Lost permission to inspect external PID ${pid}; assuming it is still running`,
          );
          return false;
        }
        return true;
      }
      // kill(pid, 0) succeeds on zombies — processes that exited but haven't
      // been reaped by their parent. Treat zombies as exited: they can't hold
      // the session, and they may never disappear if the parent isn't reaping.
      if (await this.isZombieProcess(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }

  private async isZombieProcess(pid: number): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("ps", ["-o", "stat=", "-p", String(pid)], {
        encoding: "utf-8",
        timeout: 2000,
      });
      return stdout.trim().startsWith("Z");
    } catch {
      // ps failed or PID is gone — the kill(pid, 0) probe handles existence
      return false;
    }
  }

  /**
   * Resume an external session — converts it from read-only monitoring
   * to an interactive managed instance.
   */
  private async resumeInstanceLocked(id: string, instance: Instance): Promise<InstanceInfo> {
    this.assertSpaceWritable(instance);
    const sessionId = instance.externalState?.sessionId ?? instance.sessionId;
    const jsonlPath = instance.externalState?.jsonlPath ?? instance.jsonlPath;
    if (!sessionId) throw new Error("Instance has no session ID to resume");
    const cwd = this.resolveRunnableCwd(instance);

    // SIGINT the external CLI process so it exits cleanly before we take over
    if (instance.externalState?.pid) {
      const externalPid = instance.externalState.pid;
      try {
        let alreadyExited = false;
        try {
          process.kill(externalPid, "SIGINT");
          this.baseConfig.logger.info(
            `[InstanceManager] Sent SIGINT to external CLI process (PID ${externalPid})`,
          );
        } catch (err) {
          // ESRCH: the tracked PID is already gone (stale discovery data) —
          // there's nothing to stop, so proceed with the resume.
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
          alreadyExited = true;
          this.baseConfig.logger.info(
            `[InstanceManager] External CLI process (PID ${externalPid}) already exited — resuming without signals`,
          );
        }
        if (!alreadyExited && !(await this.waitForPidExit(externalPid))) {
          try {
            process.kill(externalPid, osConstants.signals.SIGKILL);
            this.baseConfig.logger.warn(
              `[InstanceManager] External PID ${externalPid} did not exit after SIGINT; sent SIGKILL before resuming`,
            );
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "ESRCH") {
              throw err;
            }
          }
          if (!(await this.waitForPidExit(externalPid, 2000))) {
            throw new Error(
              `External CLI process (PID ${externalPid}) did not exit after shutdown signals`,
            );
          }
        }
      } catch (err) {
        this.baseConfig.logger.warn(
          `[InstanceManager] Failed to stop external PID ${externalPid} before resume: ${err}`,
        );
        throw err;
      }
    } else {
      this.baseConfig.logger.warn(
        `[InstanceManager] No PID tracked for external session "${instance.info.name}" — cannot SIGINT`,
      );
    }

    // JSONL watcher keeps running — watchState is independent of externalState.
    // The watcher suppresses emissions while the process is active (dedup),
    // and picks up terminal-side changes when the process is idle.

    // Create a provider session that resumes — do this BEFORE
    // mutating instance state so a failure leaves the instance unchanged.
    const instanceConfig: CoreConfig = {
      ...this.baseConfig,
      workingDirectory: cwd,
    };

    let proc: ProviderSession;
    try {
      proc = this.createProviderSession(instanceConfig, {
        provider: instance.info.provider,
        resumeSessionId: sessionId,
        model: instance.info.preferredModel,
        runtimeMode: instance.info.runtimeMode,
        modelOptions: instance.info.modelOptions,
      });
    } catch (err) {
      this.baseConfig.logger.error(`[InstanceManager] Failed to create process for resume: ${err}`);
      throw err;
    }

    // Preserve session info so discovery doesn't re-create this instance
    instance.sessionId = sessionId;
    instance.jsonlPath = jsonlPath;
    instance.info.sessionId = sessionId;

    // Convert from external to managed — save previous state for rollback
    const prevExternal = instance.info.external;
    const prevExternalState = instance.externalState;
    const prevProcess = instance.process;

    instance.process = proc;
    instance.providerBinding = mergeProviderBinding(
      instance.providerBinding,
      proc.getRuntimeBinding(),
    );
    instance.info.external = false;
    delete instance.externalState;

    try {
      this.wireProcessEvents(id, proc);
      this.captureSessionId(id, instance, proc);
    } catch (err) {
      // Rollback: restore previous external state so discovery doesn't duplicate
      instance.process = prevProcess;
      instance.info.external = prevExternal;
      instance.externalState = prevExternalState;
      proc.close();
      this.baseConfig.logger.error(
        `[InstanceManager] Failed to wire resumed session, rolled back: ${err}`,
      );
      throw err;
    }

    this.setStatus(instance, "idle");
    this.dbSave(instance);
    this.baseConfig.logger.info(
      `[InstanceManager] Resumed session "${instance.info.name}" (claude session: ${sessionId})`,
    );

    return { ...instance.info };
  }

  /**
   * Revive a stopped session — creates a new provider session with resume
   * so the user can continue a previously ended conversation.
   */
  private reviveInstanceLocked(id: string, instance: Instance): InstanceInfo {
    this.assertSpaceWritable(instance);
    if (instance.info.status !== "stopped") throw new Error("Instance is not stopped");
    if (!instance.sessionId) throw new Error("Instance has no session to revive");

    const sessionId = instance.sessionId;
    const cwd = instance.actualCwd || instance.info.workingDirectory;

    const instanceConfig: CoreConfig = {
      ...this.baseConfig,
      workingDirectory: cwd,
    };

    let proc: ProviderSession;
    try {
      proc = this.createProviderSession(instanceConfig, {
        provider: instance.info.provider,
        resumeSessionId: sessionId,
        model: instance.info.preferredModel,
        runtimeMode: instance.info.runtimeMode,
        modelOptions: instance.info.modelOptions,
      });
    } catch (err) {
      this.baseConfig.logger.error(`[InstanceManager] Failed to create process for revive: ${err}`);
      throw err;
    }

    const prevProcess = instance.process;
    instance.process = proc;
    instance.providerBinding = mergeProviderBinding(
      instance.providerBinding,
      proc.getRuntimeBinding(),
    );

    try {
      this.wireProcessEvents(id, proc);
    } catch (err) {
      instance.process = prevProcess;
      proc.close();
      this.baseConfig.logger.error(
        `[InstanceManager] Failed to wire revived session, rolled back: ${err}`,
      );
      throw err;
    }

    // After reviving, this is a managed instance — clear external flag
    // so subsequent sendMessage calls route directly to process.send()
    // instead of hitting resumeInstance (which requires externalState).
    instance.info.external = false;
    delete instance.externalState;

    this.setStatus(instance, "idle");
    this.dbSave(instance);
    this.baseConfig.logger.info(
      `[InstanceManager] Revived session "${instance.info.name}" (claude session: ${sessionId})`,
    );

    return { ...instance.info };
  }

  getHistory(id: string): HistoryEntry[] {
    const instance = this.instances.get(id);
    if (!instance) throw new Error(`Instance ${id} not found`);

    const transcriptPath =
      instance.jsonlPath ??
      instance.providerBinding?.transcriptPath ??
      instance.externalState?.jsonlPath;
    if (!transcriptPath || !existsSync(transcriptPath)) {
      return this.buildHistoryView(instance.history, instance.files);
    }

    const hydrateStartedAt = Date.now();
    const { parsed, cacheHit } = this.parseProviderTranscriptCached(
      instance.info.provider,
      transcriptPath,
    );
    this.baseConfig.logger.debug(
      `[InstanceManager] Read passive history for ${id} from ${transcriptPath} in ${Date.now() - hydrateStartedAt}ms (${cacheHit ? "cache hit" : "cache miss"}, ${parsed.history.length} history entries)`,
    );

    const history = this.mergeSessionEvents(id, parsed.history);

    if (instance.hydrated) {
      instance.history = history;
      instance.tasks = parsed.tasks.size > 0 ? parsed.tasks : undefined;
      instance.files = parsed.files.size > 0 ? parsed.files : undefined;

      const parsedStats = hasSessionStats(parsed.stats) ? parsed.stats : undefined;
      if (parsedStats) {
        instance.info.stats = parsedStats;
        if (instance.watchState) instance.watchState.stats = { ...parsedStats };
      }

      const parsedLastMessage = extractLastMessage(parsed.history);
      if (parsedLastMessage) {
        instance.info.lastMessage = parsedLastMessage;
      }
      this.rebuildPendingInteractiveState(instance);
    }

    return this.buildHistoryView(history, parsed.files.size > 0 ? parsed.files : undefined);
  }

  /**
   * Return queued user messages that haven't been dispatched yet.
   * Used by the subscribe handler to re-emit them after a full replay,
   * so the client can display them even after a reconnect.
   */
  getPendingQueuedMessages(id: string): Array<import("#core/types.js").UserMessage> {
    const instance = this.instances.get(id);
    if (!instance?.pendingMessages?.length) return [];
    return instance.pendingMessages.map((m) => {
      let displayText = m.text;
      if (m.images && m.images.length > 0) {
        const markers = m.images.map((p) => `[Image: source: ${p}]`).join("\n");
        displayText = displayText ? `${displayText}\n${markers}` : markers;
      }
      if (m.attachments && m.attachments.length > 0) {
        const markers = m.attachments.map((p) => `[File: source: ${p}]`).join("\n");
        displayText = displayText ? `${displayText}\n${markers}` : markers;
      }
      return {
        type: "user" as const,
        text: displayText,
        images: m.images,
        attachments: m.attachments,
        instanceId: id,
        internal: m.internal,
        queued: true,
        queuedId: m.id,
        queuedSourceText: m.text,
      };
    });
  }

  /**
   * Remove a single queued (not yet dispatched) message. Throws if the queue
   * has already drained — the caller should surface "already sent" to the user.
   */
  async removeQueuedMessage(id: string, queuedId: string): Promise<void> {
    await this.enqueueInstanceMutation(id, (instance) => {
      const queue = instance.pendingMessages;
      const index = queue?.findIndex((m) => m.id === queuedId) ?? -1;
      if (!queue || index === -1) throw new Error("Message is no longer queued");
      queue.splice(index, 1);
      if (queue.length === 0) instance.pendingMessages = undefined;
      instance.info.queuedMessageCount = instance.pendingMessages?.length || undefined;
      this.emit("instance:queued_removed", id, {
        type: "queued_removed",
        instanceId: id,
        queuedId,
      });
      this.emitInstanceStatus(instance);
    });
  }

  private getPersistedAllowedTools(sessionId: string | undefined): string[] {
    if (!sessionId) return [];
    const row = this.db.getBySessionId(sessionId);
    if (!row?.allowed_tools) return [];
    try {
      const parsed = JSON.parse(row.allowed_tools) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((tool): tool is string => typeof tool === "string")
        : [];
    } catch {
      return [];
    }
  }

  private hydrateInstance(id: string, instance: Instance): void {
    if (instance.hydrated) return;

    const transcriptPath =
      instance.jsonlPath ??
      instance.providerBinding?.transcriptPath ??
      instance.externalState?.jsonlPath;

    if (transcriptPath && existsSync(transcriptPath)) {
      const hydrateStartedAt = Date.now();
      const { parsed, cacheHit } = this.parseProviderTranscriptCached(
        instance.info.provider,
        transcriptPath,
      );
      this.baseConfig.logger.debug(
        `[InstanceManager] Hydrated ${id} from ${transcriptPath} in ${Date.now() - hydrateStartedAt}ms (${cacheHit ? "cache hit" : "cache miss"}, ${parsed.history.length} history entries)`,
      );

      instance.history = this.mergeSessionEvents(id, parsed.history);
      instance.tasks = parsed.tasks.size > 0 ? parsed.tasks : undefined;
      instance.files = parsed.files.size > 0 ? parsed.files : undefined;
      instance.fileStateRevision += 1;

      const parsedStats = hasSessionStats(parsed.stats) ? parsed.stats : undefined;
      if (parsedStats) {
        instance.info.stats = parsedStats;
      }

      const parsedLastMessage = extractLastMessage(parsed.history);
      if (parsedLastMessage) {
        instance.info.lastMessage = parsedLastMessage;
      }
      this.rebuildPendingInteractiveState(instance);

      if (!instance.watchState) {
        try {
          instance.watchState = createWatchState(
            transcriptPath,
            statSync(transcriptPath).size,
            instance.info.stats,
          );
          this.startWatching(id, instance);
        } catch {
          // ignore — transcript may disappear between existsSync/statSync
        }
      }
    }

    instance.hydrated = true;
    this.dbSave(instance);
    this.emitInstanceStatus(instance);

    // Phase 2: Git enrichment — deferred so history is served immediately.
    // Runs async; emits a second instance:status when git data arrives.
    this.enrichGitDataAsync(id, instance).catch((err) => {
      this.baseConfig.logger.debug(`[InstanceManager] Git enrichment failed for ${id}: ${err}`);
    });
  }

  /**
   * Merge persisted Relay-level session events (e.g. model switches) into a
   * transcript-parsed history by timestamp. Provider transcripts never contain
   * these events, so without this merge they would vanish whenever history is
   * rebuilt from the JSONL (hydration, reconnect, server restart).
   */
  private mergeSessionEvents(instanceId: string, history: HistoryEntry[]): HistoryEntry[] {
    let rows: SessionEventRow[];
    try {
      rows = this.db.getSessionEvents(instanceId);
    } catch {
      return history;
    }
    if (rows.length === 0) return history;

    const merged = [...history];
    for (const row of rows) {
      let payload: Record<string, unknown> | undefined;
      if (row.payload_json) {
        try {
          payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        } catch {
          payload = undefined;
        }
      }
      const entry: HistoryEntry = {
        timestamp: row.timestamp,
        message: {
          type: "system_event",
          event: row.event as SystemEventType,
          instanceId,
          payload,
        },
      };
      // Insert after the last entry at or before the event's timestamp so the
      // divider lands between the turns it actually separates.
      let insertAt = merged.length;
      for (let i = merged.length - 1; i >= 0; i--) {
        if (merged[i].timestamp <= row.timestamp) {
          insertAt = i + 1;
          break;
        }
        insertAt = i;
      }
      merged.splice(insertAt, 0, entry);
    }
    return merged;
  }

  private buildHistoryView(
    history: HistoryEntry[],
    files?: Map<string, FileChange>,
  ): HistoryEntry[] {
    // If we have enriched file data on the instance, patch the last file_list
    // activity in history so the UI gets diff stats on initial load.
    if (files && files.size > 0) {
      const enriched = Array.from(files.values()).map((f) => ({ ...f }));
      const view = [...history];
      for (let i = view.length - 1; i >= 0; i--) {
        const msg = view[i].message;
        if (msg.type === "activity" && (msg as ActivityMessage).activity === "file_list") {
          view[i] = {
            ...view[i],
            message: { ...msg, files: enriched } as ActivityMessage,
          };
          break;
        }
      }
      return view;
    }

    return [...history];
  }

  private rebuildPendingInteractiveState(instance: Instance): void {
    instance.info.pendingTool = undefined;
    instance.info.pendingPermission = undefined;
    instance.info.pendingPlan = undefined;

    for (const entry of instance.history) {
      this.syncPendingInteractiveState(instance, entry.message);
    }
  }

  private pendingStateSignature(instance: Instance): string {
    return [
      instance.info.pendingTool ?? "",
      instance.info.pendingPermission?.kind ?? "",
      instance.info.pendingPermission?.requestId ?? "",
      instance.info.pendingPlan ? "plan" : "",
    ].join("|");
  }

  private emitPendingStateIfChanged(instance: Instance, before: string): void {
    if (this.pendingStateSignature(instance) !== before) {
      this.emitInstanceStatus(instance);
    }
  }

  /**
   * When the process goes idle while in plan mode but no pendingPlan is set,
   * re-read the last known plan file from disk and surface it for review.
   */
  private refreshPendingPlan(instance: Instance): void {
    // Always refresh planContent from disk when we have a plan file
    if (instance.planFilePath) {
      try {
        const content = readFileSync(instance.planFilePath, "utf-8");
        if (content.trim()) {
          instance.info.planContent = content;
          // Only set pendingPlan (composer review) if still in plan mode and not already set
          if (instance.info.runtimeMode === "plan" && !instance.info.pendingPlan) {
            this.baseConfig.logger.info(
              `[InstanceManager] refreshPendingPlan: setting pendingPlan from file (${instance.planFilePath})`,
            );
            instance.info.pendingPlan = content;
          }
          this.emitInstanceStatus(instance);
        }
      } catch {
        // Plan file may have been deleted — ignore
      }
    }
  }

  private syncPendingInteractiveState(instance: Instance, message: ServerMessage): void {
    if (message.type === "activity") {
      const activity = message as ActivityMessage;
      const promptRequest = extractUserInputRequest(activity);
      if (promptRequest) {
        instance.info.pendingTool = instance.info.external ? activity.tool : undefined;
        instance.info.pendingPermission = promptRequest;
        return;
      }

      if (
        activity.activity === "tool_use" &&
        activity.tool === "Bash" &&
        activity.description === "Terminal interaction required"
      ) {
        instance.info.pendingTool = "Bash";
        return;
      }

      if (activity.activity === "tool_use" && INTERACTIVE_TOOLS.has(activity.tool || "")) {
        // For managed sessions, plan mode tools are handled by the UI — only
        // set pendingTool for external/terminal sessions so the TerminalPermissionBar shows.
        const isPlanTool = activity.tool === "ExitPlanMode" || activity.tool === "EnterPlanMode";
        if (isPlanTool && !instance.info.external) {
          if (activity.tool === "ExitPlanMode") {
            const plan = (activity.input as Record<string, unknown> | undefined)?.plan as
              | string
              | undefined;
            if (plan) instance.info.planContent = plan;
            // Only surface the plan-review UI when in plan mode. After the first
            // approval/dismissal the session switches to "approval-required", so
            // subsequent ExitPlanMode calls route through the permission-banner
            // path instead of re-opening the plan review panel.
            if (instance.info.runtimeMode === "plan") {
              this.baseConfig.logger.info(
                `[InstanceManager] syncPending: ExitPlanMode — setting pendingPlan (${plan ? plan.length : 0} chars)`,
              );
              instance.info.pendingPlan = plan;
            }
          }
        } else {
          instance.info.pendingTool = activity.tool;
        }
        return;
      }

      if (activity.activity === "tool_result") {
        instance.info.pendingTool = undefined;
        instance.info.pendingPlan = undefined;
        // Clear a pending AskUserQuestion (user_input) when its result is replayed.
        // The transcript-parse path only sets `activity.tool` on permission denials,
        // so a normal answered/dismissed question arrives with `tool: undefined` but
        // a populated `resolution`. Matching on `tool` alone left pendingPermission
        // stranded on reload (panel reappeared). `resolution` is the reliable signal
        // for a resolved interactive result in both the live and replay paths.
        if (
          instance.info.pendingPermission?.kind === "user_input" &&
          (activity.tool === "AskUserQuestion" || !!activity.resolution)
        ) {
          instance.info.pendingPermission = undefined;
        }
        if (
          activity.tool === "Bash" &&
          instance.info.pendingPermission?.kind === "terminal_input"
        ) {
          instance.info.pendingPermission = undefined;
        }
      }
      return;
    }

    if (message.type === "user") {
      instance.info.pendingTool = undefined;
      instance.info.pendingPlan = undefined;
      if (
        instance.info.pendingPermission?.kind === "user_input" ||
        instance.info.pendingPermission?.kind === "terminal_input"
      ) {
        instance.info.pendingPermission = undefined;
      }
    }
  }

  /**
   * Async git enrichment — deferred from hydrateInstance so that history
   * delivery isn't blocked by synchronous git subprocess calls.
   */
  private async enrichGitDataAsync(id: string, instance: Instance): Promise<void> {
    const diffCwd = instance.actualCwd || instance.info.workingDirectory;
    const fileStateRevision = instance.fileStateRevision;
    const needsDiffStats = Boolean(instance.files && instance.files.size > 0);
    const needsGitInfo = !instance.info.gitInfo;
    const hasWorktree = Boolean(instance.worktreePath && instance.originalDirectory);

    const [origBranch, gitInfo, hasChanges] = await Promise.all([
      needsDiffStats && instance.originalDirectory
        ? getCurrentBranchAsync(instance.originalDirectory)
        : Promise.resolve(null),
      needsGitInfo
        ? getGitInfoAsync(
            instance.info.external && instance.worktreePath
              ? instance.worktreePath
              : instance.info.workingDirectory,
          )
        : Promise.resolve(null),
      hasWorktree
        ? hasWorktreeChangesAsync(instance.worktreePath!, instance.originalDirectory!)
        : Promise.resolve(null),
    ]);

    await this.enqueueInstanceMutation(id, async (live) => {
      let changed = false;
      if (
        needsDiffStats &&
        live.fileStateRevision === fileStateRevision &&
        live.files &&
        live.files.size > 0
      ) {
        await enrichDiffStatsAsync(diffCwd, live.files, {
          originalBranch: origBranch ?? undefined,
          sessionCreatedAt: live.info.createdAt,
        });
        changed = true;
      }
      if (!live.info.gitInfo && gitInfo) {
        live.info.gitInfo = gitInfo;
        changed = true;
      }
      if (!live.info.originalGitBranch) {
        const fallbackOriginalBranch = live.gitBranch ?? live.info.gitBranch;
        if (fallbackOriginalBranch || live.info.gitInfo?.branch) {
          live.info.originalGitBranch = fallbackOriginalBranch ?? live.info.gitInfo?.branch;
          changed = true;
        }
      }
      if (hasChanges != null && live.worktreePath && live.originalDirectory) {
        live.info.hasChanges = hasChanges;
        changed = true;
      }
      if (changed) {
        this.dbSave(live);
        this.emitInstanceStatus(live);
      }
    }).catch((err) => {
      this.baseConfig.logger.debug(
        `[InstanceManager] Git enrichment apply failed for ${id}: ${err}`,
      );
    });
  }

  private async refreshGitBranchStateAsync(id: string, _instance: Instance): Promise<void> {
    const prep = await this.enqueueInstanceMutation(id, (live) => {
      if (live.refreshingGitBranch) return null;
      live.refreshingGitBranch = true;
      return {
        cwd: this.resolveRunnableCwd(live),
        currentIsWorktree: live.info.gitInfo?.isWorktree ?? Boolean(live.worktreePath),
      };
    }).catch(() => null);
    if (!prep) return;

    try {
      const currentBranch = await getCurrentBranchAsync(prep.cwd);
      await this.enqueueInstanceMutation(id, (live) => {
        let changed = false;
        if (currentBranch) {
          if (
            !live.info.gitInfo ||
            live.info.gitInfo.branch !== currentBranch ||
            live.info.gitInfo.isWorktree !== prep.currentIsWorktree
          ) {
            live.info.gitInfo = {
              branch: currentBranch,
              isWorktree: prep.currentIsWorktree,
            };
            changed = true;
          }

          if (!live.info.originalGitBranch) {
            live.info.originalGitBranch = live.gitBranch ?? live.info.gitBranch ?? currentBranch;
            changed = true;
          }

          if (live.info.originalGitBranch !== currentBranch) {
            const nextBranchChanged = {
              originalBranch: live.info.originalGitBranch,
              currentBranch,
            };
            if (
              !live.info.branchChanged ||
              live.info.branchChanged.originalBranch !== nextBranchChanged.originalBranch ||
              live.info.branchChanged.currentBranch !== nextBranchChanged.currentBranch
            ) {
              live.info.branchChanged = nextBranchChanged;
              changed = true;
            }
          } else if (live.info.branchChanged) {
            live.info.branchChanged = undefined;
            changed = true;
          }
        }
        if (changed) {
          this.dbSave(live);
          this.emitInstanceStatus(live);
        }
      });
    } finally {
      await this.enqueueInstanceMutation(id, (live) => {
        live.refreshingGitBranch = false;
      }).catch(() => {});
    }
  }

  private bootManagedInstance(id: string, instance: Instance): void {
    if (instance.info.external || instance.process) return;
    this.assertSpaceWritable(instance);

    const binding = instance.providerBinding;
    const resumeSessionId =
      binding?.providerSessionId ??
      instance.sessionId ??
      instance.info.sessionId ??
      extractResumeSessionId(binding?.resumeCursor);
    if (!resumeSessionId) return;

    const cwd = instance.actualCwd || instance.info.workingDirectory;
    const instanceConfig: CoreConfig = {
      ...this.baseConfig,
      workingDirectory: cwd,
      defaultRuntimeMode: instance.info.runtimeMode ?? this.baseConfig.defaultRuntimeMode,
    };
    const existingSessionContext = getSessionContextFromRuntimePayload(binding?.runtimePayload);
    if (existingSessionContext && !instance.info.sessionContext) {
      instance.info.sessionContext = existingSessionContext;
    }
    if (hasSessionBootstrapBlock(instance.info.sessionContext, TASK_CONTEXT_BLOCK_KIND)) {
      instance.taskContextInjected = true;
    }
    if (hasSessionBootstrapBlock(instance.info.sessionContext, CUSTOM_INSTRUCTIONS_BLOCK_KIND)) {
      instance.customInstructionsInjected = true;
    }

    const proc = this.createProviderSession(instanceConfig, {
      provider: instance.info.provider,
      resumeSessionId,
      model: instance.info.preferredModel,
      runtimeMode: instance.info.runtimeMode,
      allowedTools: this.getPersistedAllowedTools(resumeSessionId),
      modelOptions: instance.info.modelOptions,
    });

    instance.process = proc;
    const procBinding = proc.getRuntimeBinding();
    instance.providerBinding = {
      ...binding,
      ...procBinding,
      provider: instance.info.provider,
      providerSessionId: resumeSessionId,
      transcriptPath: binding?.transcriptPath ?? instance.jsonlPath,
      runtimePayload: {
        ...(binding?.runtimePayload ?? {}),
        ...(procBinding.runtimePayload ?? {}),
      },
    };
    instance.sessionId = resumeSessionId;
    instance.info.sessionId = resumeSessionId;

    this.wireProcessEvents(id, proc);

    if (instance.info.status === "stopped") {
      this.setStatus(instance, "idle");
    } else {
      this.emitInstanceStatus(instance);
    }
    this.dbSave(instance);
  }

  /**
   * Return registered project directories, sorted by most recent activity.
   */
  getKnownDirectories(): { path: string; lastUsed: number }[] {
    try {
      return this._projectManager
        .listProjects()
        .filter((p) => existsSync(p.directory))
        .map((p) => ({ path: p.directory, lastUsed: p.lastActivityAt ?? p.createdAt }))
        .sort((a, b) => b.lastUsed - a.lastUsed);
    } catch {
      return [];
    }
  }

  /**
   * Aggregate project artifacts (memory, plans, sessions, tasks) for a given
   * project ID (the encoded directory name under ~/.claude/projects/).
   */
  /**
   * Resolve a project slug to the full encoded directory name under ~/.claude/projects/.
   * Accepts either:
   *   - Full encoded path (e.g., "-Users-erichermanson-projects-claude-relay") — exact match
   *   - Basename slug (e.g., "claude-relay") — scans for dirs ending with "-{slug}"
   * Returns the directory name or null if not found.
   */
  resolveProjectId(slug: string): string | null {
    const projectsDir = join(this.providerDirs.claude, "projects");

    // Exact match first
    const exact = join(projectsDir, slug);
    try {
      if (statSync(exact).isDirectory()) return slug;
    } catch {
      /* not found */
    }

    // Scan for directories ending with "-{slug}"
    const suffix = `-${slug}`;
    try {
      const dirs = readdirSync(projectsDir).filter((d) => {
        if (!d.endsWith(suffix)) return false;
        try {
          return statSync(join(projectsDir, d)).isDirectory();
        } catch {
          return false;
        }
      });
      if (dirs.length === 1) return dirs[0];
      if (dirs.length > 1) {
        // Prefer the directory whose decoded path basename exactly matches the slug
        // (e.g. slug "relay" should prefer "-Users-...-relay" over "-Users-...-claude-relay")
        const exactBasename = dirs.find((d) => {
          const decoded = decodeProjectDir(d);
          return decoded.split("/").pop() === slug;
        });
        if (exactBasename) return exactBasename;

        // Fallback: pick most recently modified (by newest JSONL mtime)
        let best = dirs[0];
        let bestMtime = 0;
        for (const d of dirs) {
          try {
            const files = readdirSync(join(projectsDir, d)).filter((f) => f.endsWith(".jsonl"));
            for (const f of files) {
              try {
                const mt = statSync(join(projectsDir, d, f)).mtimeMs;
                if (mt > bestMtime) {
                  bestMtime = mt;
                  best = d;
                }
              } catch {
                /* skip */
              }
            }
          } catch {
            /* skip */
          }
        }
        return best;
      }
    } catch {
      /* ignore */
    }

    return null;
  }

  getGlobalStats(): {
    sessionCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  } {
    return this.db.getGlobalStats();
  }

  getProjectArtifacts(projectId: string): ProjectArtifacts | null {
    const registeredProject = this._projectManager.getProject(projectId);
    const resolvedId = registeredProject ? null : this.resolveProjectId(projectId);
    const claudeProjectsDir = join(this.providerDirs.claude, "projects");

    // projectDir is the provider-specific metadata directory (e.g. ~/.claude/projects/...).
    // May not exist for projects that only have sessions from other providers (e.g. Codex-only).
    const projectDir = registeredProject
      ? this.cwdToProjectDir(registeredProject.directory, claudeProjectsDir)
      : resolvedId
        ? join(claudeProjectsDir, resolvedId)
        : null;

    // Resolve real path — JSONL cwd is authoritative, with instance-based fallback.
    let directory = registeredProject?.directory ?? "";
    if (projectDir) {
      try {
        const jsonlFiles = readdirSync(projectDir)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => {
            const fullPath = join(projectDir, f);
            try {
              return { path: fullPath, mtime: statSync(fullPath).mtimeMs };
            } catch {
              return null;
            }
          })
          .filter((f): f is { path: string; mtime: number } => f !== null);

        if (jsonlFiles.length > 0) {
          jsonlFiles.sort((a, b) => b.mtime - a.mtime);
          try {
            const head = readFileSync(jsonlFiles[0].path, "utf-8").split("\n")[0];
            const parsed = JSON.parse(head);
            if (parsed.cwd && existsSync(parsed.cwd)) directory = parsed.cwd;
          } catch {
            /* fall back below */
          }
        }
      } catch {
        /* ignore */
      }
    }

    // Fallback: check active instances whose encoded workingDirectory matches
    if (!directory && resolvedId) {
      for (const instance of this.instances.values()) {
        if (instance.info.workingDirectory.replace(/[^A-Za-z0-9_-]/g, "-") === resolvedId) {
          directory = instance.info.workingDirectory;
          break;
        }
      }
    }

    // Fallback: match instances by directory basename (for non-Claude providers like Codex)
    if (!directory) {
      for (const instance of this.instances.values()) {
        const basename = instance.info.workingDirectory.split("/").pop() || "";
        if (basename === projectId) {
          directory = instance.info.workingDirectory;
          break;
        }
      }
    }

    if (!directory && !resolvedId && !registeredProject) return null;

    // Last resort: filesystem-validated decode
    if (!directory && resolvedId) {
      directory = decodeProjectDir(resolvedId);
    }

    // Memory
    let memory: string | null = null;
    if (projectDir) {
      const memoryPath = join(projectDir, "memory", "MEMORY.md");
      try {
        memory = readFileSync(memoryPath, "utf-8");
      } catch {
        /* no memory file */
      }
    }

    // CLAUDE.md from project root
    let claudeMd: string | null = null;
    if (directory) {
      try {
        claudeMd = readFileSync(join(directory, "CLAUDE.md"), "utf-8");
      } catch {
        /* no CLAUDE.md */
      }
    }

    // README.md from project root (last-resort fallback)
    let readmeMd: string | null = null;
    if (directory) {
      try {
        readmeMd = readFileSync(join(directory, "README.md"), "utf-8");
      } catch {
        /* no README.md */
      }
    }

    // Plans — Claude-specific: collect slugs from JSONL files, then check {claudeDir}/plans/.
    // Skipped entirely for non-Claude projects (projectDir is null).
    const plans: ProjectPlan[] = [];
    const seenSlugs = new Set<string>();
    if (projectDir)
      try {
        const jsonlFiles = readdirSync(projectDir)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => join(projectDir, f));

        // Pass 1: slug-based discovery (fast — reads first 32KB of each JSONL)
        for (const jsonlPath of jsonlFiles) {
          const slug = this.extractSlugFromJsonl(jsonlPath);
          if (slug && !seenSlugs.has(slug)) {
            seenSlugs.add(slug);
            const planPath = join(this.providerDirs.claude, "plans", `${slug}.md`);
            try {
              const content = readFileSync(planPath, "utf-8");
              // Use the JSONL session mtime (when the plan was last used) rather than
              // the plan file mtime (when the plan was written — often a one-time event)
              let mtime: number;
              try {
                mtime = statSync(jsonlPath).mtimeMs;
              } catch {
                mtime = statSync(planPath).mtimeMs;
              }
              let title = slug;
              for (const line of content.split("\n")) {
                if (line.startsWith("# ")) {
                  title = line.slice(2).trim();
                  break;
                }
              }
              plans.push({ slug, title, modifiedAt: mtime, content });
            } catch {
              /* plan file missing */
            }
          }
        }

        // Pass 2: discover plans with custom filenames (not matching session slug).
        // Check plan files on disk that weren't found via slug, then search JSONL
        // content for references to them (Write/Edit tool calls to ~/.claude/plans/).
        const plansDir = join(this.providerDirs.claude, "plans");
        try {
          const undiscovered = readdirSync(plansDir)
            .filter((f) => f.endsWith(".md"))
            .map((f) => f.slice(0, -3))
            .filter((s) => !seenSlugs.has(s));

          if (undiscovered.length > 0) {
            for (const jsonlPath of jsonlFiles) {
              if (undiscovered.length === 0) break;
              try {
                const raw = readFileSync(jsonlPath, "utf-8");
                if (!raw.includes(`${this.providerDirs.claude}/plans/`)) continue;
                for (let i = undiscovered.length - 1; i >= 0; i--) {
                  const planSlug = undiscovered[i];
                  if (raw.includes(`plans/${planSlug}.md`)) {
                    seenSlugs.add(planSlug);
                    undiscovered.splice(i, 1);
                    const planPath = join(plansDir, `${planSlug}.md`);
                    try {
                      const content = readFileSync(planPath, "utf-8");
                      let mtime: number;
                      try {
                        mtime = statSync(jsonlPath).mtimeMs;
                      } catch {
                        mtime = statSync(planPath).mtimeMs;
                      }
                      let title = planSlug;
                      for (const line of content.split("\n")) {
                        if (line.startsWith("# ")) {
                          title = line.slice(2).trim();
                          break;
                        }
                      }
                      plans.push({
                        slug: planSlug,
                        title,
                        modifiedAt: mtime,
                        content,
                      });
                    } catch {
                      /* plan file missing */
                    }
                  }
                }
              } catch {
                /* read error */
              }
            }
          }
        } catch {
          /* plans dir missing */
        }

        plans.sort((a, b) => a.modifiedAt - b.modifiedAt);
      } catch {
        /* ignore */
      }

    // Backfill transcript-derived stats/model metadata for unopened historical sessions
    // in this project before aggregating usage.
    this.backfillProjectTranscriptStats(directory);

    // Aggregate token/cost stats from DB
    const baseStats = this.db.getProjectStats(directory);
    const modelUsage = this.db.getProjectModelStats(directory);
    const stats = { ...baseStats, modelUsage };

    // GitHub URL from git remote
    const githubUrl = getRemoteUrl(directory);

    // Tasks
    const tasks = hasTasks(directory) ? loadTasks(directory) : null;

    // Skills
    const skills = discoverSkills(directory || undefined);

    const resolvedProjectId =
      registeredProject?.id ??
      this._projectManager.getProjectByDirectory(directory)?.id ??
      resolvedId ??
      projectId;

    const projectSlug =
      registeredProject?.slug ??
      (directory ? this._projectManager.getProjectByDirectory(directory)?.slug : undefined);

    return {
      projectId: resolvedProjectId,
      projectSlug,
      directory,
      memory,
      claudeMd,
      readmeMd,
      plans,
      stats,
      githubUrl,
      tasks,
      skills,
      spaces: directory ? this.spaceManager.listSpaces(directory) : [],
    };
  }

  /**
   * Scan a project directory for an icon. Thin wrapper around the pure
   * `findProjectIcon` scanner — passes through the project name/slug so the
   * scanner can apply path-aware bias in monorepos (where multiple apps may
   * all have equally-scored icons).
   */
  private scanProjectIcon(dir: string): string | null {
    const project = this._projectManager.getProjectByDirectory(dir);
    const projectNames = project ? [project.name, project.slug] : [];
    return findProjectIcon(dir, { projectNames });
  }

  /**
   * Return a map of project directory → icon file path for all known projects.
   * Scans lazily (once per directory) and caches the result.
   */
  getProjectIcons(): Record<string, string> {
    const dirs = new Set<string>();
    for (const instance of this.instances.values()) {
      dirs.add(instance.info.workingDirectory);
    }
    const result: Record<string, string> = {};
    for (const dir of dirs) {
      if (!this.projectIconCache.has(dir)) {
        this.projectIconCache.set(dir, this.scanProjectIcon(dir));
      }
      const icon = this.projectIconCache.get(dir);
      if (icon) result[dir] = icon;
    }
    return result;
  }

  private extractSlugFromJsonl(filePath: string): string | null {
    let fd: number;
    try {
      fd = openSync(filePath, "r");
    } catch {
      return null;
    }
    try {
      const buf = Buffer.alloc(32768);
      const bytesRead = readSync(fd, buf, 0, 32768, 0);
      const head = buf.toString("utf-8", 0, bytesRead);
      for (const line of head.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.slug) return entry.slug;
        } catch {
          /* partial line at end of buffer */
        }
      }
    } finally {
      closeSync(fd);
    }
    return null;
  }

  get defaultWorkingDirectory(): string {
    return this.baseConfig.workingDirectory;
  }

  private get processingAtShutdownPath(): string {
    return join(this.baseConfig.dbPath, "..", "processing-at-shutdown.json");
  }

  async stopAllGracefully(): Promise<void> {
    this.stopDiscovery();
    await this.flushInstanceMutations();
    this.shuttingDown = true;

    const instances = [...this.instances.values()];
    const processingIds: string[] = [];

    for (const instance of instances) {
      const wasProcessing = instance.process?.isProcessing ?? false;
      if (
        wasProcessing &&
        !instance.info.external &&
        !this.recentlyAutoContinued.has(instance.info.id)
      ) {
        processingIds.push(instance.info.id);
      }
      if (wasProcessing) {
        try {
          instance.process?.interrupt();
        } catch {
          // best-effort
        }
      }
    }

    await Promise.all(
      instances.map(async (instance) => {
        try {
          if (instance.process) {
            await Promise.resolve(instance.process.close());
          }
          instance.info.status = "stopped";
          if (instance.sessionId) {
            this.db.updateLastActivity(instance.sessionId, instance.info.lastActivityAt);
          }
        } catch (err) {
          this.baseConfig.logger.warn(
            `[InstanceManager] Error closing instance ${instance.info.id} during shutdown: ${String(err)}`,
          );
        }
      }),
    );

    await this.flushInstanceMutations();

    try {
      if (processingIds.length > 0) {
        writeFileSync(this.processingAtShutdownPath, JSON.stringify(processingIds));
      } else if (existsSync(this.processingAtShutdownPath)) {
        unlinkSync(this.processingAtShutdownPath);
      }
    } catch {
      // best-effort
    }

    try {
      this.db.checkpointWal();
    } catch {
      // best-effort
    }

    this.instances.clear();
    this.instanceMutationChains.clear();
    this.staleCounts.clear();
    this.db.close();
  }

  stopAll(): void {
    this.shuttingDown = true;
    const processingIds: string[] = [];
    for (const instance of this.instances.values()) {
      const wasProcessing = instance.process?.isProcessing ?? false;
      if (instance.process) {
        void Promise.resolve(instance.process.close());
      }
      instance.info.status = "stopped";
      if (instance.sessionId) {
        this.db.updateLastActivity(instance.sessionId, instance.info.lastActivityAt);
      }
      if (
        wasProcessing &&
        !instance.info.external &&
        !this.recentlyAutoContinued.has(instance.info.id)
      ) {
        processingIds.push(instance.info.id);
      }
    }
    // Persist which instances were mid-turn so we can auto-continue after restart
    try {
      if (processingIds.length > 0) {
        writeFileSync(this.processingAtShutdownPath, JSON.stringify(processingIds));
      } else {
        if (existsSync(this.processingAtShutdownPath)) unlinkSync(this.processingAtShutdownPath);
      }
    } catch {
      // best-effort
    }
    this.instances.clear();
    this.instanceMutationChains.clear();
    this.staleCounts.clear();
    this.stopDiscovery();
    try {
      this.db.checkpointWal();
    } catch {
      // best-effort
    }
    this.db.close();
  }

  // ===========================================================================
  // External session discovery
  // ===========================================================================

  startDiscovery(): void {
    this.discoverExisting();
    this.discoveryInterval = setInterval(() => {
      this.discoverExisting();
    }, DISCOVERY_INTERVAL);
    this.baseConfig.logger.debug("[InstanceManager] Session discovery started");
  }

  stopDiscovery(): void {
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
    }
    for (const interval of this.watchIntervals.values()) {
      clearInterval(interval);
    }
    this.watchIntervals.clear();
  }

  private async discoverExisting(): Promise<void> {
    if (this.discovering) return; // Prevent overlapping discovery polls
    this.discovering = true;
    const t0 = performance.now();
    let discoverMs = 0;
    let gitRefreshMs = 0;
    let gitRefreshCount = 0;
    let stats: DiscoveryPollStats = emptyDiscoveryPollStats();
    try {
      const discoverStartedAt = performance.now();
      stats = await this.discoverExistingInner();
      discoverMs = performance.now() - discoverStartedAt;

      // Throttle git-branch refresh — no need to run every discovery cycle
      const now = Date.now();
      if (now - this.lastGitRefreshAt >= GIT_REFRESH_INTERVAL) {
        this.lastGitRefreshAt = now;
        const refreshTargets = Array.from(this.instances.entries()).filter(
          ([, instance]) => instance.externalState || instance.watchState || instance.process,
        );
        gitRefreshCount = refreshTargets.length;
        const gitRefreshStartedAt = performance.now();
        await Promise.all(
          refreshTargets.map(([instanceId, instance]) =>
            this.refreshGitBranchStateAsync(instanceId, instance).catch((err) => {
              this.baseConfig.logger.debug(
                `[Discover] Git branch refresh failed for ${instanceId}:`,
                err instanceof Error ? err.message : err,
              );
            }),
          ),
        );
        gitRefreshMs = performance.now() - gitRefreshStartedAt;
      }
    } catch (err) {
      this.baseConfig.logger.debug(
        "[Discovery] Error during discovery poll:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      this.discovering = false;
      const totalMs = performance.now() - t0;
      if (totalMs > SLOW_DISCOVERY_WARN_MS) {
        this.baseConfig.logger.warn(
          formatSlowDiscoveryWarning({
            totalMs,
            discoverMs,
            stats,
            gitRefreshMs,
            gitRefreshCount,
          }),
        );
      }
    }
  }

  private async discoverExistingInner(): Promise<DiscoveryPollStats> {
    const discovery = normalizeDiscoveryResult(await this.discoverExternalSessions());
    const discoveredSessions = discovery.sessions;
    if (discoveredSessions.length === 0) {
      const stale = this.removeStaleExternals(new Set());
      return {
        externalSessionCount: 0,
        activeSessionCount: 0,
        staleCheckedCount: stale.staleCount,
        endedCount: stale.endedCount,
        providerTimings: discovery.timings,
      };
    }

    // Collect managed session identity keys for dedup (session IDs + transcript paths)
    const managedKeys = this.collectManagedSessionKeys();

    const activeSessions = collectActiveExternalSessions({
      sessions: discoveredSessions,
      managedProviderSessionIds: managedKeys.providerSessionIds,
      isRegisteredProject: (cwd) => !!this.getRegisteredProjectForDirectory(cwd),
    });

    // Track known JSONL paths (external + managed)
    const knownJsonls = buildKnownJsonlMap({
      instances: Array.from(this.instances.entries()).map(([instanceId, instance]) => ({
        id: instanceId,
        externalJsonlPath: instance.externalState?.jsonlPath,
        jsonlPath: instance.jsonlPath,
      })),
      managedTranscriptPaths: managedKeys.transcriptPaths,
    });

    // Eagerly reserve Claude JSONL paths for managed instances that haven't captured
    // their session yet. Without this, an external Claude process in the same CWD can
    // pick up the managed instance's JSONL (the most recently modified) and duplicate it.
    const reservedKnownJsonls = new Set(knownJsonls.keys());
    this.reservePendingManagedClaudeJsonls(reservedKnownJsonls);
    for (const reservedPath of reservedKnownJsonls) {
      if (!knownJsonls.has(reservedPath)) {
        knownJsonls.set(reservedPath, "__reserved_managed__");
      }
    }

    // Remove external instances that are no longer active
    const stale = this.removeStaleExternals(new Set(activeSessions.keys()));

    // Discover new sessions (and upgrade restored stopped externals)
    for (const [jsonlPath, active] of activeSessions) {
      // Skip JSONL paths from instances the user recently deleted — the
      // subprocess may still be alive for a few seconds after removal.
      if (this.isJsonlDismissed(jsonlPath)) continue;

      if (knownJsonls.has(jsonlPath)) {
        // Check if this is a restored stopped external that should be upgraded to active
        const existingId = knownJsonls.get(jsonlPath)!;
        const existing = this.instances.get(existingId);
        if (existing && existing.info.external && existing.info.status === "stopped") {
          this.upgradeRestoredExternal(existingId, existing, jsonlPath);
        }
        // Update PID on existing external instances (PIDs can change across restarts)
        if (existing?.externalState && active.pid !== undefined) {
          existing.externalState.pid = active.pid;
        }
        continue;
      }

      try {
        // Auto-unarchive: if this session is archived in DB, restore it
        const archivedRow = this.db.getByJsonlPath(jsonlPath);
        if (archivedRow?.archived) {
          this.db.unarchive(archivedRow.session_id);
        }

        // Check for plan-continuation parent (explicit reference in first message)
        const planParent = this.findPlanParent(jsonlPath);
        const parentSessionId = planParent?.sessionId || planParent?.info.sessionId;
        await this.addExternalInstance(
          active.provider,
          active.sessionId,
          jsonlPath,
          parentSessionId,
          active.pid,
        );
      } catch (err) {
        this.baseConfig.logger.debug(`[InstanceManager] Failed to add external session: ${err}`);
      }
    }

    return {
      externalSessionCount: discoveredSessions.length,
      activeSessionCount: activeSessions.size,
      staleCheckedCount: stale.staleCount,
      endedCount: stale.endedCount,
      providerTimings: discovery.timings,
    };
  }

  private async discoverExternalSessions() {
    const managedPids = new Set<number>();
    for (const [, instance] of this.instances) {
      const pid = instance.process?.pid;
      if (pid !== undefined) managedPids.add(pid);
    }
    return discoverLiveExternalSessions(this.getProviderContext(), managedPids);
  }

  private cwdToProjectDir(cwd: string, projectsDir: string): string | null {
    const encoded = cwd.replace(/[^A-Za-z0-9_-]/g, "-");
    const projectDir = join(projectsDir, encoded);
    return existsSync(projectDir) ? projectDir : null;
  }

  /** Return the N most recently modified JSONL files in a project dir */
  private findRecentJsonls(projectDir: string, count: number): string[] {
    try {
      const files = readdirSync(projectDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
          const fullPath = join(projectDir, f);
          try {
            return { path: fullPath, mtime: statSync(fullPath).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter((f): f is { path: string; mtime: number } => f !== null);

      files.sort((a, b) => b.mtime - a.mtime);
      return files.slice(0, count).map((f) => f.path);
    } catch {
      return [];
    }
  }

  private collectManagedSessionKeys(options?: { includePersisted?: boolean }): {
    providerSessionIds: Set<string>;
    transcriptPaths: Set<string>;
  } {
    return collectManagedSessionKeys({
      persistedRows:
        options?.includePersisted !== false ? this.db.getAllManagedActive() : undefined,
      liveInstances: Array.from(this.instances.values()).map((instance) =>
        this.toManagedShadowIdentity(instance),
      ),
    });
  }

  private collapseManagedDuplicates(preferredInstanceId?: string): void {
    const activeRows = this.db.getAllManagedActive();
    const archived = new Set<string>();

    for (let i = 0; i < activeRows.length; i++) {
      const seed = activeRows[i];
      if (archived.has(seed.instance_id)) continue;

      const cluster = [seed];
      for (let j = i + 1; j < activeRows.length; j++) {
        const candidate = activeRows[j];
        if (archived.has(candidate.instance_id)) continue;
        if (cluster.some((row) => isSameManagedSessionIdentity(row, candidate))) {
          cluster.push(candidate);
        }
      }

      if (cluster.length < 2) continue;

      let canonical = cluster[0];
      for (const row of cluster.slice(1)) {
        if (compareManagedCanonicalRows(row, canonical, preferredInstanceId) > 0) {
          canonical = row;
        }
      }

      for (const row of cluster) {
        if (row.instance_id === canonical.instance_id) continue;
        archived.add(row.instance_id);
        this.db.archiveManaged(row.instance_id);
        this.db.archiveByInstanceId(row.instance_id);
        this.baseConfig.logger.warn(
          `[InstanceManager] Archived duplicate managed session ${row.instance_id} in favor of ${canonical.instance_id} (${canonical.provider_session_id ?? canonical.transcript_path ?? "unknown"})`,
        );
      }
    }
  }

  private reservePendingManagedClaudeJsonls(knownJsonls: Set<string>): void {
    const recentJsonlsByProjectDir = new Map<string, string[]>();
    for (const instance of this.instances.values()) {
      if (instance.info.external || instance.jsonlPath) continue;
      if (instance.info.provider !== "claude") continue;
      const cwd = instance.actualCwd || instance.info.workingDirectory;
      const encoded = cwd.replace(/[^A-Za-z0-9_-]/g, "-");
      const projectDir = join(this.providerDirs.claude, "projects", encoded);
      if (!existsSync(projectDir)) continue;
      let recentJsonls = recentJsonlsByProjectDir.get(projectDir);
      if (!recentJsonls) {
        recentJsonls = this.findRecentJsonls(projectDir, 5);
        recentJsonlsByProjectDir.set(projectDir, recentJsonls);
      }
      for (const candidate of recentJsonls) {
        if (!knownJsonls.has(candidate)) {
          knownJsonls.add(candidate);
          break;
        }
      }
    }
  }

  private removeStaleExternals(activeJsonlPaths: Set<string>): {
    staleCount: number;
    endedCount: number;
  } {
    let staleCount = 0;
    let endedCount = 0;

    for (const [instanceId, instance] of this.instances) {
      if (!instance.externalState) continue;

      if (activeJsonlPaths.has(instance.externalState.jsonlPath)) {
        // Found in active set — reset stale counter
        this.staleCounts.delete(instanceId);
        continue;
      }

      // Not found in ps/lsof — check JSONL mtime as secondary signal
      const jsonlPath = instance.externalState.jsonlPath;
      try {
        const mtime = statSync(jsonlPath).mtimeMs;
        const age = Date.now() - mtime;
        if (age < DISCOVERY_INTERVAL * STALE_THRESHOLD) {
          // JSONL was recently modified — session is likely still active
          this.staleCounts.delete(instanceId);
          continue;
        }
      } catch {
        // File gone — proceed to stale tracking
      }

      // Increment stale counter
      const count = (this.staleCounts.get(instanceId) || 0) + 1;
      this.staleCounts.set(instanceId, count);

      if (count < STALE_THRESHOLD) {
        staleCount++;
        continue;
      }

      // Grace period exceeded — mark as stopped
      this.staleCounts.delete(instanceId);
      instance.jsonlPath = instance.externalState.jsonlPath;
      instance.sessionId = instance.sessionId || instance.externalState.sessionId;
      delete instance.externalState;

      // Stop the JSONL watcher — session is no longer active
      const watchInterval = this.watchIntervals.get(instanceId);
      if (watchInterval) {
        clearInterval(watchInterval);
        this.watchIntervals.delete(instanceId);
      }

      this.setStatus(instance, "stopped");
      if (instance.sessionId) {
        this.db.updateLastActivity(instance.sessionId, instance.info.lastActivityAt);
      }
      endedCount++;
    }

    if (staleCount > 0) {
      this.baseConfig.logger.debug(
        `[InstanceManager] ${staleCount} external session(s) not found in ps`,
      );
    }
    if (endedCount > 0) {
      this.baseConfig.logger.info(`[InstanceManager] ${endedCount} external session(s) ended`);
    }

    return { staleCount, endedCount };
  }

  /**
   * Upgrade a restored stopped external session to active — called when
   * discovery finds a running claude process with a JSONL that matches
   * a stopped instance from the manifest.
   */
  private upgradeRestoredExternal(instanceId: string, instance: Instance, jsonlPath: string): void {
    const sessionId = instance.sessionId || jsonlPath.split("/").pop()?.replace(".jsonl", "") || "";

    let fileSize: number;
    try {
      fileSize = statSync(jsonlPath).size;
    } catch {
      return;
    }

    instance.externalState = {
      jsonlPath,
      sessionId,
      // PID will be populated by the next discovery cycle
    };

    instance.watchState = createWatchState(jsonlPath, fileSize, instance.info.stats);

    this.startWatching(instanceId, instance);
    this.setStatus(instance, "idle");
    this.dbSave(instance);

    this.baseConfig.logger.debug(
      `[InstanceManager] Upgraded restored session "${instance.info.name}" to active`,
    );
  }

  private async addExternalInstance(
    provider: ProviderKind,
    sessionId: string,
    jsonlPath: string,
    parentSessionId?: string,
    pid?: number,
  ): Promise<void> {
    const { cwd, history, tasks, files, stats } = this.parseProviderTranscript(provider, jsonlPath);
    if (!cwd) return; // Can't determine working directory

    // Detect worktree paths (relay or external like .t3) and resolve to the
    // original project directory so sessions group under the parent project.
    let workingDirectory = cwd;
    let worktreePath: string | undefined;
    let gitBranch: string | undefined;
    let originalDirectory: string | undefined;

    if (isGitWorktree(cwd)) {
      const origin = isRelayWorktreePath(cwd)
        ? resolveWorktreeOrigin(cwd)
        : resolveAnyWorktreeOrigin(cwd);
      if (origin) {
        workingDirectory = origin;
        worktreePath = cwd;
        originalDirectory = origin;
      }
    }

    const id = randomUUID();
    const name =
      this.resolveSessionTitle(sessionId, workingDirectory, history, provider) ||
      defaultSessionTitle(provider);
    const now = Date.now();
    const lastActivity = history.length > 0 ? history[history.length - 1].timestamp : now;

    const lastMessage = extractLastMessage(history);

    // Use async git calls to avoid blocking the event loop during discovery
    const [gitInfo, worktreeGitInfo] = await Promise.all([
      getGitInfoAsync(workingDirectory),
      worktreePath ? getGitInfoAsync(cwd) : Promise.resolve(null),
    ]);
    if (worktreeGitInfo && worktreePath) gitBranch = worktreeGitInfo.branch;

    const project = this._projectManager.getProjectByDirectory(
      normalizeProjectDirectory(originalDirectory ?? workingDirectory),
    );
    const info: InstanceInfo = {
      id,
      provider,
      name,
      workingDirectory,
      status: "idle",
      createdAt: lastActivity,
      lastActivityAt: lastActivity,
      external: true,
      lastMessage,
      sessionId,
      stats: hasSessionStats(stats) ? stats : undefined,
      gitInfo: (worktreePath ? worktreeGitInfo : gitInfo) ?? undefined,
      gitBranch,
      originalDirectory,
      parentSessionId,
      spaceId:
        originalDirectory && (worktreePath || gitBranch)
          ? explicitOrInferredSpaceIdForPersistenceRow(
              {
                space_id: null,
                worktree_path: worktreePath ?? null,
                git_branch: gitBranch ?? null,
                original_directory: originalDirectory,
                working_directory: workingDirectory,
              },
              this.spaceManager.listAllSpaces(originalDirectory),
            )
          : undefined,
      projectId: project?.id,
      projectSlug: project?.slug,
    };

    let fileSize: number;
    try {
      fileSize = statSync(jsonlPath).size;
    } catch {
      return;
    }

    const instance: Instance = {
      info,
      process: null,
      providerBinding: {
        provider,
        providerSessionId: sessionId,
        resumeCursor: { sessionId },
        runtimePayload: { cwd },
        transcriptPath: jsonlPath,
      },
      history,
      sessionId,
      jsonlPath,
      externalState: {
        jsonlPath,
        sessionId,
        pid,
      },
      watchState: createWatchState(jsonlPath, fileSize, info.stats),
      tasks: tasks.size > 0 ? tasks : undefined,
      files: files.size > 0 ? files : undefined,
      fileStateRevision: files.size > 0 ? 1 : 0,
      worktreePath,
      gitBranch,
      originalDirectory,
      actualCwd: worktreePath ? cwd : undefined,
      hydrated: true,
    };

    // Enrich files with git diff stats (async to avoid blocking event loop)
    if (instance.files && instance.files.size > 0) {
      const diffCwd = instance.actualCwd || workingDirectory;
      const origBranch = originalDirectory
        ? ((await getCurrentBranchAsync(originalDirectory)) ?? undefined)
        : undefined;
      await enrichDiffStatsAsync(diffCwd, instance.files, {
        originalBranch: origBranch,
        sessionCreatedAt: instance.info.createdAt,
      });
    }

    this.instances.set(id, instance);
    this.startWatching(id, instance);
    this.emit("instance:created", id, { ...info });
    this.dbSave(instance);

    this.baseConfig.logger.info(
      `[InstanceManager] Discovered external ${provider} session "${name}" in ${cwd}`,
    );
  }

  /**
   * Detect plan-continuation sessions: when Claude Code exits plan mode,
   * the user approves, and a new session is created to implement the plan.
   * The new session's first user message contains an explicit reference:
   *   "read the full transcript at: /path/to/<parent-session-id>.jsonl"
   * Returns the parent instance if found, null otherwise.
   */
  private findPlanParent(jsonlPath: string): Instance | null {
    try {
      // Read up to 32KB — enough to find the first user message even with
      // system events and metadata preceding it.
      const MAX_SCAN_BYTES = 32 * 1024;
      const fd = openSync(jsonlPath, "r");
      let content: string;
      try {
        const fileSize = statSync(jsonlPath).size;
        const readSize = Math.min(fileSize, MAX_SCAN_BYTES);
        const buf = Buffer.alloc(readSize);
        readSync(fd, buf, 0, readSize, 0);
        content = buf.toString("utf-8");
      } finally {
        closeSync(fd);
      }
      const lines = content.split("\n");

      // Scan until first user message is found (no arbitrary line limit).
      // The byte limit above provides the safety cap.
      for (const line of lines) {
        if (!line.trim()) continue;

        let entry: {
          type?: string;
          message?: { content?: string | Array<{ type: string; text?: string }> };
        };
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }

        if (entry.type !== "user" || !entry.message?.content) continue;

        // Extract text from content (string or array-of-blocks)
        let text = "";
        const content = entry.message.content;
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!)
            .join("\n");
        }

        const match = text.match(PLAN_TRANSCRIPT_RE);
        if (!match) continue;

        const parentJsonlPath = match[1];

        // Look up parent instance by JSONL path
        for (const instance of this.instances.values()) {
          if (
            instance.jsonlPath === parentJsonlPath ||
            instance.externalState?.jsonlPath === parentJsonlPath
          ) {
            this.baseConfig.logger.info(
              `[InstanceManager] Plan-continuation detected: "${instance.info.name}" → ${jsonlPath.split("/").pop()}`,
            );
            return instance;
          }
        }

        // Parent JSONL path found in message but no matching instance
        return null;
      }
    } catch {
      // File read error — fall through
    }

    return null;
  }

  // ===========================================================================
  // JSONL parsing
  // ===========================================================================

  private parseJsonl(filePath: string): {
    cwd: string;
    history: HistoryEntry[];
    tasks: Map<string, TaskItem>;
    files: Map<string, FileChange>;
    stats: SessionStats;
  } {
    let cwd = "";
    let history: HistoryEntry[] = [];
    const zeroStats: SessionStats = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      return {
        cwd,
        history,
        tasks: new Map(),
        files: new Map(),
        stats: zeroStats,
      };
    }

    const lines = content.split("\n");

    // Pre-scan backwards for the last compact_boundary. We still preserve the
    // earlier conversation, but we only do full stateful parsing from the
    // boundary forward; older history uses a lighter conversation-only pass.
    let boundaryLineIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.includes('"compact_boundary"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "system" && entry.subtype === "compact_boundary") {
          boundaryLineIdx = i;
          break;
        }
      } catch {
        // skip malformed lines
      }
    }

    const ctx: {
      pendingTools: Map<string, string>;
      pendingAskInputs: Map<string, string[]>;
      pendingTaskCreates: Map<string, { subject: string; activeForm?: string }>;
      tasks: Map<string, TaskItem>;
      files: Map<string, FileChange>;
      stats: SessionStats;
      cwd?: string;
    } = {
      pendingTools: new Map<string, string>(),
      pendingAskInputs: new Map<string, string[]>(),
      pendingTaskCreates: new Map<string, { subject: string; activeForm?: string }>(),
      tasks: new Map<string, TaskItem>(),
      files: new Map<string, FileChange>(),
      stats: { ...zeroStats },
    };

    const fullParseStart = boundaryLineIdx > 0 ? boundaryLineIdx : 0;

    // Phase 1: pre-boundary lightweight parse. Preserve user/assistant
    // conversation and usage/cwd, but skip expensive task/file/tool rebuilds.
    for (let i = 0; i < fullParseStart; i++) {
      const line = lines[i];
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (!cwd && entry.cwd) {
          cwd = entry.cwd;
          ctx.cwd = cwd;
        }
        history.push(...this.convertJsonlEntryLightweight(entry, ctx));
      } catch {
        // skip malformed lines
      }
    }

    // Phase 2: post-boundary full parse.
    for (let i = fullParseStart; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (!cwd && entry.cwd) {
          cwd = entry.cwd;
          ctx.cwd = cwd;
        }
        history.push(...this.convertJsonlEntry(entry, ctx));
      } catch {
        // skip malformed lines
      }
    }

    // Trim to MAX_HISTORY as a safety net
    if (history.length > MAX_HISTORY) {
      history = history.slice(-MAX_HISTORY);
    }

    return {
      cwd,
      history,
      tasks: ctx.tasks,
      files: ctx.files,
      stats: ctx.stats,
    };
  }

  private cloneParsedTranscript(parsed: TranscriptParseResult): TranscriptParseResult {
    return {
      cwd: parsed.cwd,
      history: parsed.history.map((entry) => ({
        ...entry,
        message: structuredClone(entry.message),
      })),
      tasks: new Map(Array.from(parsed.tasks.entries(), ([id, task]) => [id, { ...task }])),
      files: new Map(Array.from(parsed.files.entries(), ([path, file]) => [path, { ...file }])),
      stats: { ...parsed.stats },
    };
  }

  private buildTranscriptCacheKey(provider: ProviderKind, filePath: string): string | null {
    try {
      const stat = statSync(filePath);
      return `${provider}:${filePath}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }

  private parseProviderTranscriptCached(
    provider: ProviderKind,
    filePath: string,
  ): { parsed: TranscriptParseResult; cacheHit: boolean } {
    const cacheKey = this.buildTranscriptCacheKey(provider, filePath);
    if (cacheKey) {
      const cached = this.transcriptParseCache.get(cacheKey);
      if (cached) {
        // Refresh insertion order so the oldest key is the least-recently-used one.
        this.transcriptParseCache.delete(cacheKey);
        this.transcriptParseCache.set(cacheKey, cached);
        return { parsed: this.cloneParsedTranscript(cached.parsed), cacheHit: true };
      }
    }

    const parsed = parseTranscriptForProvider(provider, filePath, (path) => this.parseJsonl(path));

    if (cacheKey) {
      this.transcriptParseCache.set(cacheKey, {
        cacheKey,
        parsed,
      });

      if (this.transcriptParseCache.size > MAX_TRANSCRIPT_CACHE_ENTRIES) {
        const oldestKey = this.transcriptParseCache.keys().next().value;
        if (oldestKey) {
          this.transcriptParseCache.delete(oldestKey);
        }
      }
    }

    return { parsed: this.cloneParsedTranscript(parsed), cacheHit: false };
  }

  private parseProviderTranscript(provider: ProviderKind, filePath: string): TranscriptParseResult {
    return this.parseProviderTranscriptCached(provider, filePath).parsed;
  }

  private resolveManagedTranscriptPath(
    provider: ProviderKind,
    options: {
      sessionId?: string;
      transcriptPath?: string;
      workingDirectory?: string;
    },
  ): string | undefined {
    return resolveManagedTranscriptPathForProvider(provider, {
      ...options,
      providerDirs: this.providerDirs,
    });
  }

  /**
   * Handle a tool_result content block from JSONL replay.
   * Shared between user-message and assistant-message tool_result handling.
   */
  private handleToolResultBlock(
    block: { tool_use_id?: string; is_error?: boolean; content?: string },
    timestamp: number,
    ctx: {
      pendingTools?: Map<string, string>;
      pendingAskInputs?: Map<string, string[]>;
      pendingTaskCreates?: Map<string, { subject: string; activeForm?: string }>;
      tasks?: Map<string, TaskItem>;
    },
    results: HistoryEntry[],
    toolResultMeta?: { nonExecutionKind?: string; userFeedback?: string },
  ): void {
    const toolName = ctx.pendingTools?.get(block.tool_use_id || "");
    const isTaskTool = TASK_TOOLS.has(toolName || "");
    const blockContent = extractToolResultText(block.content);

    if (isTaskTool) {
      if (toolName === "TaskCreate") {
        const idMatch = blockContent.match(/Task #(\d+)/);
        const pending = ctx.pendingTaskCreates?.get(block.tool_use_id || "");
        if (idMatch && pending && ctx.tasks) {
          const taskId = idMatch[1];
          ctx.tasks.set(taskId, {
            id: taskId,
            subject: pending.subject,
            status: "pending",
            activeForm: pending.activeForm,
          });
          ctx.pendingTaskCreates?.delete(block.tool_use_id || "");
          results.push({
            timestamp,
            message: {
              type: "activity",
              activity: "task_list",
              description: "Tasks",
              tasks: Array.from(ctx.tasks.values()).map((t) => ({ ...t })),
            } as ActivityMessage,
          });
        }
      }
      // Other task tool results — skip
    } else {
      const toolName = ctx.pendingTools?.get(block.tool_use_id || "");
      // The live answer path emits the user's AskUserQuestion answer as a visible
      // chat message (see resolveRequestLocked). That message is in-memory only —
      // it's never written to the JSONL — so rebuild it from the tool_result on
      // replay to keep the answer visible after reload. The tool_result activity is
      // still emitted below so pending-state clears (syncPendingInteractiveState).
      if (toolName === "AskUserQuestion" && !block.is_error) {
        const questions = ctx.pendingAskInputs?.get(block.tool_use_id || "") ?? [];
        const answerText = parseAskUserQuestionAnswerText(blockContent, questions);
        if (answerText) {
          results.push({
            timestamp,
            message: { type: "user", text: answerText } as UserMessage,
          });
        }
      }
      results.push({
        timestamp,
        message: buildToolResultActivity(block.is_error, toolName, blockContent, toolResultMeta),
      });
    }
  }

  private convertJsonlEntry(
    entry: {
      type?: string;
      subtype?: string;
      cwd?: string;
      timestamp?: string;
      /** Set on SDKAssistantMessage when the turn was cut short by an interrupt. */
      aborted?: boolean;
      data?: Record<string, unknown>;
      message?: {
        role?: string;
        model?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
        content?:
          | string
          | Array<{
              type: string;
              text?: string;
              thinking?: string;
              name?: string;
              id?: string;
              input?: Record<string, unknown>;
              is_error?: boolean;
              content?: string;
              tool_use_id?: string;
            }>;
      };
    },
    ctx?: {
      pendingTools?: Map<string, string>;
      pendingTaskCreates?: Map<string, { subject: string; activeForm?: string }>;
      tasks?: Map<string, TaskItem>;
      files?: Map<string, FileChange>;
      stats?: SessionStats;
      cwd?: string;
    },
  ): HistoryEntry[] {
    const rawTimestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
    const timestamp = isNaN(rawTimestamp) ? Date.now() : rawTimestamp;

    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      return [
        {
          timestamp,
          message: {
            type: "system_event",
            event: "compact_boundary",
            raw: entry,
          },
          raw: entry,
        },
      ];
    }
    if (entry.type === "system" && entry.subtype === "init") {
      return [
        {
          timestamp,
          message: buildSessionInitEvent(entry),
          raw: entry,
        },
      ];
    }
    if (entry.type === "user" && entry.message?.content) {
      return this.convertUserEntry(entry.message.content, timestamp, ctx);
    }
    if (entry.type === "assistant" && entry.message?.content) {
      return this.convertAssistantEntry(entry.message, timestamp, ctx, entry.aborted);
    }
    if (entry.type === "progress" && entry.data) {
      return this.convertProgressEntry(entry.data, timestamp);
    }
    return [];
  }

  /** Parse a user JSONL entry into history entries. */
  private convertUserEntry(
    content:
      | string
      | Array<{
          type: string;
          text?: string;
          tool_use_id?: string;
          is_error?: boolean;
          content?: string;
        }>,
    timestamp: number,
    ctx?: {
      pendingTools?: Map<string, string>;
      pendingAskInputs?: Map<string, string[]>;
      pendingTaskCreates?: Map<string, { subject: string; activeForm?: string }>;
      tasks?: Map<string, TaskItem>;
    },
  ): HistoryEntry[] {
    const results: HistoryEntry[] = [];
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const c of content) {
        if (c.type === "text" && c.text) {
          parts.push(c.text);
        } else if (c.type === "image") {
          const source = (c as Record<string, unknown>).source as
            | { type?: string; file_path?: string; url?: string; data?: string }
            | undefined;
          if (source?.file_path) {
            parts.push(`[Image: source: ${source.file_path}]`);
          } else if (source?.url) {
            parts.push(`[Image: source: ${source.url}]`);
          }
          // Skip base64 data images — too large for history
        } else if (c.type === "tool_result" && ctx) {
          // In Claude API format, tool_result blocks are in user messages.
          const rawMeta = (c as Record<string, unknown>).tool_result_meta;
          const toolResultMeta =
            rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)
              ? (() => {
                  const m = rawMeta as Record<string, unknown>;
                  const nonExecutionKind =
                    typeof m.non_execution_kind === "string" ? m.non_execution_kind : undefined;
                  const userFeedback =
                    typeof m.user_feedback === "string" ? m.user_feedback : undefined;
                  return nonExecutionKind !== undefined || userFeedback !== undefined
                    ? { nonExecutionKind, userFeedback }
                    : undefined;
                })()
              : undefined;
          this.handleToolResultBlock(c, timestamp, ctx, results, toolResultMeta);
        }
      }
      text = parts.join("\n");
    }
    // Strip internal CLI tags; skip if nothing meaningful remains
    text = stripInternalTags(text);
    if (text && !text.startsWith("[Request interrupted")) {
      const transcriptMatch = TRANSCRIPT_AVAILABLE_RE.exec(text);
      if (transcriptMatch) {
        const transcript = extractTranscriptResult(transcriptMatch[1]);
        if (transcript) {
          results.push({
            timestamp,
            message: {
              type: "transcript",
              title: transcript.title,
              result: transcript.result,
            } as TranscriptMessage,
          });
        }
      } else {
        text = stripInjectedWrapper(text);
        const internal = isInternalInjectedUserText(text) ? true : undefined;
        results.push({
          timestamp,
          message: { type: "user", text, internal } as UserMessage,
        });
      }
    }
    return results;
  }

  private convertJsonlEntryLightweight(
    entry: {
      type?: string;
      subtype?: string;
      cwd?: string;
      timestamp?: string;
      message?: {
        model?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
        content?:
          | string
          | Array<{
              type: string;
              text?: string;
            }>;
      };
    },
    ctx?: {
      stats?: SessionStats;
    },
  ): HistoryEntry[] {
    const rawTimestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
    const timestamp = isNaN(rawTimestamp) ? Date.now() : rawTimestamp;

    if (entry.type === "system" && entry.subtype === "init") {
      return [
        {
          timestamp,
          message: buildSessionInitEvent(entry),
          raw: entry,
        },
      ];
    }
    if (entry.type === "user" && entry.message?.content) {
      return this.convertUserEntry(entry.message.content, timestamp);
    }
    if (entry.type === "assistant" && entry.message) {
      return this.convertAssistantConversationEntry(entry.message, timestamp, ctx);
    }
    return [];
  }

  /** Parse an assistant JSONL entry into history entries. */
  private convertAssistantEntry(
    message: {
      model?: string;
      /** ISO-8601 model-completion time from SDKAssistantMessage.timestamp */
      timestamp?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      content?:
        | string
        | Array<{
            type: string;
            text?: string;
            thinking?: string;
            name?: string;
            id?: string;
            input?: Record<string, unknown>;
            is_error?: boolean;
            content?: string;
            tool_use_id?: string;
          }>;
    },
    timestamp: number,
    ctx?: {
      pendingTools?: Map<string, string>;
      pendingAskInputs?: Map<string, string[]>;
      pendingTaskCreates?: Map<string, { subject: string; activeForm?: string }>;
      tasks?: Map<string, TaskItem>;
      files?: Map<string, FileChange>;
      stats?: SessionStats;
      cwd?: string;
    },
    aborted?: boolean,
  ): HistoryEntry[] {
    const results: HistoryEntry[] = [];
    const content = message.content;
    const modelTimestamp = message.timestamp ? new Date(message.timestamp).getTime() : undefined;
    if (Array.isArray(content)) {
      let textParts: string[] = [];

      for (const block of content) {
        if (block.type === "thinking" && block.thinking) {
          results.push({
            timestamp,
            message: {
              type: "activity",
              activity: "thinking",
              description: "Reasoning...",
              detail: capDetail(block.thinking),
            } as ActivityMessage,
          });
        } else if (block.type === "tool_use") {
          // Flush accumulated text before tool_use
          const flushed = stripInternalTags(textParts.join(""));
          if (flushed) {
            results.push({
              timestamp,
              message: { type: "output", text: flushed, isWaiting: false } as OutputMessage,
            });
          }
          textParts = [];
          if (block.id && block.name && ctx?.pendingTools) {
            ctx.pendingTools.set(block.id, block.name);
            if (block.name === "AskUserQuestion" && ctx.pendingAskInputs) {
              const askQuestions = extractAskQuestionTexts(block.input);
              if (askQuestions.length) ctx.pendingAskInputs.set(block.id, askQuestions);
            }
          }
          this.convertToolUseBlock(block, timestamp, ctx, results);
        } else if (block.type === "tool_result" && ctx) {
          this.handleToolResultBlock(block, timestamp, ctx, results);
        } else if (block.type === "text" && block.text) {
          textParts.push(block.text);
        }
      }

      // Flush remaining text
      const remaining = stripInternalTags(textParts.join(""));
      if (remaining) {
        results.push({
          timestamp,
          message: { type: "output", text: remaining, isWaiting: false } as OutputMessage,
        });
      }

      // Mark end of assistant turn; carry aborted flag when the turn was interrupted
      results.push({
        timestamp,
        message: {
          type: "output",
          text: "",
          isWaiting: true,
          modelTimestamp,
          aborted: aborted || undefined,
        } as OutputMessage,
      });
    }

    // Accumulate token usage
    if (ctx?.stats && message.usage && message.model) {
      const usage = message.usage;
      const u = {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
      };
      ctx.stats.inputTokens += u.input_tokens;
      ctx.stats.outputTokens += u.output_tokens;
      ctx.stats.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
      ctx.stats.cacheReadTokens += u.cache_read_input_tokens ?? 0;
      ctx.stats.model = message.model;
      ctx.stats.contextTokens =
        u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }

    return results;
  }

  private convertAssistantConversationEntry(
    message: {
      model?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      content?:
        | string
        | Array<{
            type: string;
            text?: string;
          }>;
    },
    timestamp: number,
    ctx?: {
      stats?: SessionStats;
    },
  ): HistoryEntry[] {
    const results: HistoryEntry[] = [];
    const content = message.content;

    if (typeof content === "string") {
      const text = stripInternalTags(content);
      if (text) {
        results.push({
          timestamp,
          message: { type: "output", text, isWaiting: false } as OutputMessage,
        });
      }
      results.push({
        timestamp,
        message: { type: "output", text: "", isWaiting: true } as OutputMessage,
      });
    } else if (Array.isArray(content)) {
      const text = stripInternalTags(
        content
          .filter((block) => block.type === "text" && block.text)
          .map((block) => block.text)
          .join(""),
      );
      if (text) {
        results.push({
          timestamp,
          message: { type: "output", text, isWaiting: false } as OutputMessage,
        });
      }
      results.push({
        timestamp,
        message: { type: "output", text: "", isWaiting: true } as OutputMessage,
      });
    }

    if (ctx?.stats && message.usage && message.model) {
      const usage = message.usage;
      const u = {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
      };
      ctx.stats.inputTokens += u.input_tokens;
      ctx.stats.outputTokens += u.output_tokens;
      ctx.stats.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
      ctx.stats.cacheReadTokens += u.cache_read_input_tokens ?? 0;
      ctx.stats.model = message.model;
      ctx.stats.contextTokens =
        u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }

    return results;
  }

  /** Handle a single tool_use block within an assistant entry. */
  private convertToolUseBlock(
    block: {
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
    },
    timestamp: number,
    ctx:
      | {
          pendingTaskCreates?: Map<string, { subject: string; activeForm?: string }>;
          tasks?: Map<string, TaskItem>;
          files?: Map<string, FileChange>;
          cwd?: string;
        }
      | undefined,
    results: HistoryEntry[],
  ): void {
    const isTaskTool = TASK_TOOLS.has(block.name || "");
    if (isTaskTool && ctx) {
      const input = block.input as Record<string, unknown> | undefined;
      if (block.name === "TodoWrite" && input && ctx.tasks) {
        const todos = input.todos as
          | Array<{ content?: string; status?: string; activeForm?: string }>
          | undefined;
        if (Array.isArray(todos)) {
          ctx.tasks.clear();
          for (let i = 0; i < todos.length; i++) {
            const t = todos[i];
            if (!t.content) continue;
            const id = `todo-${i}`;
            ctx.tasks.set(id, {
              id,
              subject: t.content,
              status: (t.status as TaskItem["status"]) || "pending",
              activeForm: t.activeForm,
            });
          }
          results.push({
            timestamp,
            message: {
              type: "activity",
              activity: "task_list",
              description: "Tasks",
              tasks: Array.from(ctx.tasks.values()).map((t) => ({ ...t })),
            } as ActivityMessage,
          });
        }
      } else if (block.name === "TaskCreate" && input && block.id) {
        ctx.pendingTaskCreates?.set(block.id, {
          subject: (input.subject as string) || "Untitled task",
          activeForm: input.activeForm as string | undefined,
        });
      } else if (block.name === "TaskUpdate" && input) {
        const taskId = input.taskId as string;
        const status = input.status as string | undefined;
        if (taskId && status === "deleted") {
          ctx.tasks?.delete(taskId);
          results.push({
            timestamp,
            message: {
              type: "activity",
              activity: "task_list",
              description: "Tasks",
              tasks: Array.from(ctx.tasks?.values() ?? []).map((t) => ({ ...t })),
            } as ActivityMessage,
          });
        } else if (taskId && status && ctx.tasks?.has(taskId)) {
          const task = ctx.tasks.get(taskId)!;
          task.status = status as TaskItem["status"];
          if (input.subject) task.subject = input.subject as string;
          if (input.activeForm) task.activeForm = input.activeForm as string;
          results.push({
            timestamp,
            message: {
              type: "activity",
              activity: "task_list",
              description: "Tasks",
              tasks: Array.from(ctx.tasks.values()).map((t) => ({ ...t })),
            } as ActivityMessage,
          });
        }
      }
      // TaskList and TaskGet — skip entirely (no activity emitted)
    } else {
      // Track file changes for Edit/Write/NotebookEdit
      if (ctx?.files && block.name && FILE_WRITE_TOOLS.has(block.name)) {
        const input = block.input as Record<string, unknown> | undefined;
        const filePath = (input?.file_path || input?.path || input?.notebook_path) as
          | string
          | undefined;
        if (filePath && (!ctx.cwd || isPathWithinWorkspace(ctx.cwd, filePath))) {
          const existing = ctx.files.get(filePath);
          if (existing) {
            existing.editCount++;
          } else {
            ctx.files.set(filePath, {
              path: filePath,
              editCount: 1,
              type: block.name === "Write" ? "added" : "edited",
            });
          }
          results.push({
            timestamp,
            message: {
              type: "activity",
              activity: "file_list",
              description: "Files changed",
              files: Array.from(ctx.files.values()).map((f) => ({ ...f })),
            } as ActivityMessage,
          });
        }
      }

      results.push({
        timestamp,
        message: {
          type: "activity",
          activity: "tool_use",
          tool: block.name,
          description: describeToolUse(block.name || "Unknown", block.input),
          detail: describeToolDetail(block.name || "Unknown", block.input),
          input: buildToolActivityInput(
            block.name,
            block.input as Record<string, unknown> | undefined,
            block.id,
          ),
          inputDescription: extractInputDescription(block.name || "Unknown", block.input),
        } as ActivityMessage,
      });
    }
  }

  /** Parse a progress JSONL entry (bash_progress / agent_progress). */
  private convertProgressEntry(data: Record<string, unknown>, timestamp: number): HistoryEntry[] {
    const dataType = data.type as string | undefined;
    if (dataType === "bash_progress") {
      const elapsed = data.elapsed_seconds as number | undefined;
      const output = data.output as string | undefined;
      if (elapsed != null) {
        return [
          {
            timestamp,
            message: {
              type: "activity",
              activity: "tool_use",
              tool: "Bash",
              description: `Running... ${Math.round(elapsed)}s`,
              detail: output ? (output.length > 300 ? output.slice(-300) : output) : undefined,
            } as ActivityMessage,
          },
        ];
      }
    } else if (dataType === "agent_progress") {
      return this.convertAgentProgress(data, timestamp);
    }
    // hook_progress: skip
    return [];
  }

  /** Extract tool_use activities from an agent_progress event. */
  private convertAgentProgress(data: Record<string, unknown>, timestamp: number): HistoryEntry[] {
    const message = data.message as Record<string, unknown> | undefined;
    if (!message) return [];
    const innerMessage = message.message as Record<string, unknown> | undefined;
    if (!innerMessage) return [];
    const content = innerMessage.content as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(content)) return [];

    const entries: HistoryEntry[] = [];
    for (const block of content) {
      if (block.type === "tool_use") {
        const tool = (block.name as string) || "Unknown";
        const input = block.input as Record<string, unknown> | undefined;
        entries.push({
          timestamp,
          message: {
            type: "activity",
            activity: "tool_use",
            tool,
            description: describeToolUse(tool, input),
            detail: describeToolDetail(tool, input),
            input: buildToolActivityInput(tool, input, block.id as string | undefined),
            inputDescription: extractInputDescription(tool, input),
          } as ActivityMessage,
        });
      }
    }
    return entries;
  }

  // ===========================================================================
  // JSONL file watching
  // ===========================================================================

  private startWatching(instanceId: string, instance: Instance): void {
    if (!instance.watchState) return;
    if (this.watchIntervals.has(instanceId)) return; // Already watching

    const interval = setInterval(() => {
      this.refreshGitBranchStateAsync(instanceId, instance).catch((err) => {
        this.baseConfig.logger.debug(
          `[Watcher] Git branch refresh failed for ${instanceId}:`,
          err instanceof Error ? err.message : err,
        );
      });

      try {
        if (!instance.watchState || !this.instances.has(instanceId)) return;
        const stat = statSync(instance.watchState.jsonlPath);
        const observedOffset = instance.watchState.fileOffset;
        const readOffset = observedOffset > stat.size ? 0 : observedOffset;
        if (stat.size <= readOffset) return;

        // Read new bytes
        const fd = openSync(instance.watchState.jsonlPath, "r");
        let newContent: string;
        try {
          const buf = Buffer.alloc(stat.size - readOffset);
          readSync(fd, buf, 0, buf.length, readOffset);
          newContent = buf.toString("utf-8");
        } finally {
          closeSync(fd);
        }

        void this.enqueueInstanceMutation(instanceId, (live) => {
          if (!live.watchState) return;
          if (live.watchState.fileOffset !== observedOffset) return;
          live.watchState.fileOffset = stat.size;
          if (live.process?.isProcessing) return;
          for (const line of newContent.split("\n")) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              this.applyWatcherEntry(instanceId, live, entry);
            } catch {
              // skip malformed lines
            }
          }
        }).catch((err) => this.logQueuedMutationError("watcher mutation", instanceId, err));
      } catch (err) {
        this.baseConfig.logger.debug(
          `[Watcher] Read error for ${instanceId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }, WATCH_POLL_INTERVAL);

    this.watchIntervals.set(instanceId, interval);
  }

  private noteManagedProcessActivity(instance: Instance): void {
    instance.processHandledUntil = Math.max(
      instance.processHandledUntil ?? 0,
      Date.now() + WATCH_DEDUP_GRACE_MS,
    );
  }

  private shouldSkipWatcherEntry(instance: Instance, entry: { timestamp?: string }): boolean {
    if (!instance.processHandledUntil || !entry.timestamp) return false;
    const entryTime = new Date(entry.timestamp).getTime();
    if (Number.isNaN(entryTime)) return false;
    return entryTime <= instance.processHandledUntil;
  }

  private applyWatcherEntry(
    instanceId: string,
    instance: Instance,
    entry: {
      type?: string;
      timestamp?: string;
      message?: {
        role?: string;
        model?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
        content?:
          | string
          | Array<{
              type: string;
              text?: string;
              thinking?: string;
              name?: string;
              id?: string;
              input?: Record<string, unknown>;
              is_error?: boolean;
              content?: string;
              tool_use_id?: string;
            }>;
      };
    },
  ): void {
    if (!instance.watchState) return;
    if (this.shouldSkipWatcherEntry(instance, entry)) return;

    if (!instance.tasks) instance.tasks = new Map();
    if (!instance.files) instance.files = new Map();

    const prevStats = { ...instance.watchState.stats };
    const converted =
      instance.info.provider === "codex"
        ? convertCodexTranscriptEntry(entry as Record<string, unknown>, {
            pendingCalls: instance.watchState.pendingProviderCalls,
            tasks: instance.tasks,
            files: instance.files,
            stats: instance.watchState.stats,
            cwd: instance.actualCwd || instance.info.workingDirectory,
          })
        : this.convertJsonlEntry(entry, {
            pendingTools: instance.watchState.pendingTools,
            pendingTaskCreates: instance.watchState.pendingTaskCreates,
            tasks: instance.tasks,
            files: instance.files,
            stats: instance.watchState.stats,
            cwd: instance.actualCwd || instance.info.workingDirectory,
          });
    if (statsChanged(prevStats, instance.watchState.stats)) {
      instance.info.stats = { ...instance.watchState.stats };
      this.emitInstanceStatus(instance);
    }

    for (const histEntry of converted) {
      const msg = histEntry.message;
      const pendingStateBefore = this.pendingStateSignature(instance);

      this.pushHistory(instance, msg);
      instance.info.lastActivityAt = Date.now();

      if (msg.type === "output") {
        const output = msg as OutputMessage;
        if (output.isWaiting) {
          this.checkWorktreeChanges(instance);
          this.setStatus(instance, "idle");
          this.doRefreshTitle(instance);
        } else {
          this.setStatus(instance, "processing");
        }
        this.emit("instance:output", instanceId, output);
      } else if (msg.type === "activity") {
        const activity = msg as ActivityMessage;
        this.syncPendingInteractiveState(instance, activity);
        this.emitPendingStateIfChanged(instance, pendingStateBefore);
        if (activity.activity === "file_list" && activity.files && instance.files) {
          instance.fileStateRevision += 1;
          // Enrich with git diff stats for watcher path
          const diffCwd = instance.actualCwd || instance.info.workingDirectory;
          const origBranch = instance.originalDirectory
            ? (getCurrentBranch(instance.originalDirectory) ?? undefined)
            : undefined;
          enrichDiffStats(diffCwd, instance.files, {
            originalBranch: origBranch,
            sessionCreatedAt: instance.info.createdAt,
          });
          activity.files = Array.from(instance.files.values()).map((f) => ({ ...f }));
        }
        this.setStatus(instance, "processing");
        this.emit("instance:activity", instanceId, activity);
      } else if (msg.type === "transcript") {
        this.emit("instance:transcript", instanceId, msg as TranscriptMessage);
      } else if (msg.type === "user") {
        this.syncPendingInteractiveState(instance, msg);
        this.emitPendingStateIfChanged(instance, pendingStateBefore);
        // For managed instances, sendMessage() / pendingRetry already emitted
        // instance:user — skip the watcher emit to avoid duplicate messages.
        if (!instance.process) {
          this.emit("instance:user", instanceId, msg as UserMessage);
        }
      }
    }
  }

  // ===========================================================================
  // Instance persistence (SQLite)
  // ===========================================================================

  private shouldPersistManagedInstance(instance: Instance): boolean {
    const binding = instance.providerBinding ?? instance.process?.getRuntimeBinding();
    const resumeSessionId =
      binding?.providerSessionId ??
      instance.sessionId ??
      instance.info.sessionId ??
      extractResumeSessionId(binding?.resumeCursor);

    return !!(resumeSessionId || binding?.transcriptPath || instance.jsonlPath);
  }

  private reconcileInstancePersistenceIdentity(instance: Instance): void {
    const persistedProjectDirectory = getPersistenceRowProjectDirectory({
      original_directory: instance.originalDirectory ?? instance.info.originalDirectory,
      working_directory: instance.info.workingDirectory,
    });
    const inferredSpaceId = this.inferPersistedSpaceIdForProjectDirectory(
      persistedProjectDirectory,
      {
        space_id: instance.info.spaceId ?? null,
        worktree_path: instance.worktreePath ?? null,
        git_branch: instance.gitBranch ?? null,
        original_directory: instance.originalDirectory ?? instance.info.originalDirectory ?? null,
        working_directory: instance.info.workingDirectory,
      },
    );

    const currentSpaceId = instance.info.spaceId ?? inferredSpaceId ?? undefined;
    if (!instance.info.spaceId && inferredSpaceId) {
      instance.info.spaceId = inferredSpaceId;
      this.logSpaceOwnershipRepair("persist", instance.info.id, {
        previousSpaceId: null,
        nextSpaceId: inferredSpaceId,
        projectDirectory: persistedProjectDirectory,
      });
    }

    const space = currentSpaceId ? this.spaceManager.getSpace(currentSpaceId) : undefined;
    const project = this.getRegisteredProjectForDirectory(
      space?.projectDirectory
        ? normalizeProjectDirectory(space.projectDirectory)
        : persistedProjectDirectory,
    );
    const reconciliation = buildPersistenceOwnershipReconciliation({
      workingDirectory: instance.info.workingDirectory,
      originalDirectory: instance.originalDirectory,
      infoOriginalDirectory: instance.info.originalDirectory,
      infoProjectId: instance.info.projectId,
      projectId: project?.id,
      space,
    });

    if (reconciliation.nextInfoProjectId) {
      this.baseConfig.logger.warn(
        `[InstanceManager] Reconciled project ownership for ${instance.info.id} before persistence: ${instance.info.projectId ?? "null"} -> ${reconciliation.nextInfoProjectId}`,
      );
      instance.info.projectId = reconciliation.nextInfoProjectId;
      const reconciledProject = this._projectManager.getProject(reconciliation.nextInfoProjectId);
      instance.info.projectSlug = reconciledProject?.slug;
    }

    if (!space || space.isDefault) {
      return;
    }

    if (reconciliation.nextOriginalDirectory) {
      this.baseConfig.logger.warn(
        `[InstanceManager] Reconciled originalDirectory for ${instance.info.id} before persistence: ${instance.originalDirectory ?? "null"} -> ${reconciliation.nextOriginalDirectory}`,
      );
      instance.originalDirectory = reconciliation.nextOriginalDirectory;
    }
    if (reconciliation.nextInfoOriginalDirectory) {
      this.baseConfig.logger.warn(
        `[InstanceManager] Reconciled info.originalDirectory for ${instance.info.id} before persistence: ${instance.info.originalDirectory ?? "null"} -> ${reconciliation.nextInfoOriginalDirectory}`,
      );
      instance.info.originalDirectory = reconciliation.nextInfoOriginalDirectory;
    }
  }

  private dbSave(instance: Instance): void {
    if (this.shuttingDown) return;
    try {
      this.reconcileInstancePersistenceIdentity(instance);
      const isManaged = !instance.info.external && this.shouldPersistManagedInstance(instance);
      if (isManaged) {
        instance.providerBinding = mergeProviderBinding(
          instance.providerBinding,
          instance.process?.getRuntimeBinding(),
        );
        this.db.upsertManaged(
          toManagedInstanceRow({
            info: instance.info,
            binding: instance.providerBinding,
            sessionId: instance.sessionId,
            jsonlPath: instance.jsonlPath,
            gitBranch: instance.gitBranch,
            worktreePath: instance.worktreePath,
            originalDirectory: instance.originalDirectory,
            defaultRuntimeMode: this.baseConfig.defaultRuntimeMode,
          }),
        );
        this.collapseManagedDuplicates(instance.info.id);
      }
      if (instance.sessionId && instance.jsonlPath) {
        this.db.upsert(
          toSessionRow({
            info: instance.info,
            sessionId: instance.sessionId,
            jsonlPath: instance.jsonlPath,
            gitBranch: instance.gitBranch,
            worktreePath: instance.worktreePath,
            originalDirectory: instance.originalDirectory,
          }),
        );
      }

      // Update searchable transcript text from the in-memory history
      if (instance.history.length > 0) {
        this.db.updateSearchContent(instance.info.id, extractSearchableText(instance.history));
      }

      // Index once per instance — prefer managed source when both exist
      if (isManaged) {
        this.db.indexSession(instance.info.id, "managed");
      } else if (instance.sessionId && instance.jsonlPath) {
        this.db.indexSession(instance.info.id, "session");
      }
    } catch (err) {
      this.baseConfig.logger.warn(`[InstanceManager] Failed to persist session: ${err}`);
    }
  }

  private backfillSessionModel(sessionId: string, model: string): void {
    this.db.updateSessionModel(sessionId, model);
    for (const instance of this.instances.values()) {
      if (instance.sessionId !== sessionId && instance.info.sessionId !== sessionId) continue;
      const nextStats = instance.info.stats
        ? { ...instance.info.stats, model }
        : {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            model,
          };
      instance.info.stats = nextStats;
      if (instance.watchState) {
        instance.watchState.stats = { ...instance.watchState.stats, model };
      }
    }
  }

  private backfillSessionStats(
    instanceId: string,
    sessionId: string | undefined,
    stats: SessionStats,
  ): void {
    for (const instance of this.instances.values()) {
      if (instance.info.id !== instanceId && instance.sessionId !== sessionId) continue;
      const nextStats = mergeBackfilledStats(instance.info.stats, stats);
      instance.info.stats = nextStats;
      if (instance.watchState) {
        instance.watchState.stats = { ...instance.watchState.stats, ...nextStats };
      }
      return;
    }
  }

  private readTranscriptStats(
    provider: ProviderKind,
    transcriptPath: string,
  ): SessionStats | undefined {
    if (!existsSync(transcriptPath)) return undefined;
    if (provider === "claude") return readClaudeStatsFromJsonl(transcriptPath);
    if (provider === "codex") return readCodexStatsFromJsonl(transcriptPath);
    return undefined;
  }

  private backfillProjectTranscriptStats(directory: string): void {
    for (const row of this.db.getAllActive()) {
      if (row.working_directory !== directory) continue;
      if (hasPersistedTokenUsage(row) && row.model) continue;
      const stats = this.readTranscriptStats(row.provider_name as ProviderKind, row.jsonl_path);
      if (!stats) continue;
      const nextRow = buildBackfilledSessionRow(row, stats);
      if (!nextRow) continue;
      this.db.upsert(nextRow);
      this.backfillSessionStats(row.instance_id, row.session_id, {
        ...stats,
        model: nextRow.model ?? undefined,
      });
    }

    for (const row of this.db.getAllManagedActive()) {
      if (row.working_directory !== directory) continue;
      if (hasPersistedTokenUsage(row) && row.model) continue;

      let resumeCursor: unknown;
      try {
        resumeCursor = row.resume_cursor_json ? JSON.parse(row.resume_cursor_json) : undefined;
      } catch {
        resumeCursor = undefined;
      }
      const transcriptPath = this.resolveManagedTranscriptPath(row.provider_name as ProviderKind, {
        sessionId: row.provider_session_id ?? extractResumeSessionId(resumeCursor),
        transcriptPath: row.transcript_path ?? undefined,
        workingDirectory: row.working_directory,
      });
      if (!transcriptPath) continue;

      const stats = this.readTranscriptStats(row.provider_name as ProviderKind, transcriptPath);
      if (!stats) continue;
      const nextRow = buildBackfilledManagedRow(row, stats, transcriptPath);
      if (!nextRow) continue;
      this.db.upsertManaged(nextRow);
      this.backfillSessionStats(row.instance_id, row.provider_session_id ?? undefined, {
        ...stats,
        model: nextRow.model ?? undefined,
      });
    }
  }

  /**
   * Scan JSONL files on disk for registered project directories.
   * Only scans directories that match an explicit project registration.
   */
  private scanAllSessions(): void {
    const scanStart = performance.now();
    const projectsDir = join(this.providerDirs.claude, "projects");

    const knownPaths = this.db.getJsonlPaths();
    const managedKeys = this.collectManagedSessionKeys();
    const reservedManagedJsonls = new Set(managedKeys.transcriptPaths);
    this.reservePendingManagedClaudeJsonls(reservedManagedJsonls);
    const diskPaths = new Set<string>();
    /** Project subdirs under ~/.claude/projects/ that were actually scanned */
    const scannedProjectDirs = new Set<string>();
    let discovered = 0;
    let archived = 0;

    // --- Scan Codex sessions (~/.codex/sessions/) ---
    this.scanCodexSessions(knownPaths, diskPaths, managedKeys);

    if (!existsSync(projectsDir)) return;

    try {
      const projectDirs = readdirSync(projectsDir).filter((name) =>
        this.shouldScanClaudeProjectDir(projectsDir, name),
      );

      const rows: SessionRow[] = [];

      for (const projDir of projectDirs) {
        const fullProjDir = join(projectsDir, projDir);
        scannedProjectDirs.add(fullProjDir);
        let jsonlFiles: string[];
        try {
          jsonlFiles = readdirSync(fullProjDir).filter((f) => f.endsWith(".jsonl"));
        } catch {
          continue;
        }

        // Try to read sessions-index.json for fast metadata
        let sessionsIndex: Map<
          string,
          { summary?: string; createdAt?: number; lastActivityAt?: number; messageCount?: number }
        > | null = null;
        try {
          const indexPath = join(fullProjDir, "sessions-index.json");
          const indexData = JSON.parse(readFileSync(indexPath, "utf-8"));
          if (indexData.entries && Array.isArray(indexData.entries)) {
            sessionsIndex = new Map();
            for (const e of indexData.entries) {
              if (e.sessionId) {
                sessionsIndex.set(e.sessionId, {
                  summary: e.summary,
                  createdAt: e.createdAt ? new Date(e.createdAt).getTime() : undefined,
                  lastActivityAt: e.lastActivityAt
                    ? new Date(e.lastActivityAt).getTime()
                    : undefined,
                  messageCount: e.messageCount,
                });
              }
            }
          }
        } catch {
          // no index or parse error
        }

        for (const jsonlFile of jsonlFiles) {
          const jsonlPath = join(fullProjDir, jsonlFile);
          diskPaths.add(jsonlPath);
          const sessionId = jsonlFile.replace(".jsonl", "");
          const matchesManagedSession =
            managedKeys.providerSessionIds.has(sessionId) || reservedManagedJsonls.has(jsonlPath);

          if (knownPaths.has(jsonlPath)) {
            // Already in DB — update last_activity_at and repair working_directory if needed
            try {
              const existing = this.db.getByJsonlPath(jsonlPath);
              if (matchesManagedSession && existing && !existing.archived) {
                this.db.archive(existing.session_id);
                archived++;
                continue;
              }
              const mtime = Math.floor(statSync(jsonlPath).mtimeMs);
              if (existing) {
                if (mtime > existing.last_activity_at) {
                  this.db.updateLastActivity(existing.session_id, mtime);
                }
                // Repair corrupted working_directory: re-read from JSONL and validate.
                // Skip repair for worktree instances — their working_directory was
                // intentionally set to the original project dir, not the worktree path
                // that Claude Code writes into the JSONL cwd field.
                if (!existing.original_directory) {
                  let correctCwd = readCwdFromJsonl(jsonlPath);
                  if (correctCwd && !existsSync(correctCwd)) {
                    // JSONL cwd is stale (project renamed?) — try filesystem decode
                    const decoded = decodeProjectDir(projDir);
                    if (existsSync(decoded)) correctCwd = decoded;
                  }
                  if (!correctCwd) {
                    // No JSONL cwd — try filesystem decode
                    const decoded = decodeProjectDir(projDir);
                    if (existsSync(decoded)) correctCwd = decoded;
                  }
                  if (correctCwd && correctCwd !== existing.working_directory) {
                    this.db.updateWorkingDirectory(existing.session_id, correctCwd);
                  }
                }
                if (!existing.model) {
                  const model = readModelFromJsonl(jsonlPath);
                  if (model) {
                    this.backfillSessionModel(existing.session_id, model);
                  }
                }
              }
            } catch {
              // ignore stat errors
            }
            continue;
          }

          if (matchesManagedSession) {
            const existing = this.db.getBySessionId(sessionId);
            if (existing && !existing.archived) {
              this.db.archive(existing.session_id);
              archived++;
            }
            continue;
          }

          // New file — discover session
          const indexEntry = sessionsIndex?.get(sessionId);

          // Try to resolve CWD from JSONL, with filesystem-validated fallback
          let cwd = readCwdFromJsonl(jsonlPath) || "";
          let createdAt = 0;
          if (cwd && !existsSync(cwd)) {
            // JSONL cwd is stale (project renamed?) — try filesystem decode
            const decoded = decodeProjectDir(projDir);
            if (existsSync(decoded)) cwd = decoded;
          }
          if (!cwd) {
            // No JSONL cwd — use filesystem-validated decode
            cwd = decodeProjectDir(projDir);
          }

          // Detect worktree paths (relay or external like .t3) and resolve the
          // Detect worktree paths (relay or external like .t3) and resolve to
          // the original project directory so sessions group under the parent.
          let scanWorktreePath: string | null = null;
          let scanOriginalDir: string | null = null;
          let scanGitBranch: string | null = null;

          if (isGitWorktree(cwd)) {
            const origin = isRelayWorktreePath(cwd)
              ? resolveWorktreeOrigin(cwd)
              : resolveAnyWorktreeOrigin(cwd);
            if (origin) {
              scanWorktreePath = cwd;
              scanOriginalDir = origin;
              cwd = origin; // Use original dir as working_directory
              const gitInfo = getGitInfo(scanWorktreePath);
              if (gitInfo) scanGitBranch = gitInfo.branch;
            }
          }

          try {
            const head = readFileSync(jsonlPath, "utf-8").split("\n")[0];
            const parsed = JSON.parse(head);
            if (parsed.timestamp) {
              const ts = new Date(parsed.timestamp).getTime();
              if (!isNaN(ts)) createdAt = ts;
            }
          } catch {
            // ignore
          }

          let lastActivityAt: number;
          try {
            lastActivityAt = Math.floor(statSync(jsonlPath).mtimeMs);
          } catch {
            lastActivityAt = Date.now();
          }

          if (!createdAt) {
            createdAt = indexEntry?.createdAt ?? lastActivityAt;
          }

          const firstMsg = readFirstUserMessage(jsonlPath);
          const rawSummary = indexEntry?.summary;
          const name =
            (rawSummary ? sanitiseForTitle(rawSummary) || rawSummary : null) ||
            (firstMsg ? generateTitle(firstMsg, "claude") : defaultSessionTitle("claude"));
          const gitInfo = scanWorktreePath ? getGitInfo(scanWorktreePath) : getGitInfo(cwd);
          const lastMsg = readLastMessage(jsonlPath);
          const model = readModelFromJsonl(jsonlPath);

          rows.push({
            session_id: sessionId,
            instance_id: randomUUID(),
            provider_name: "claude",
            name,
            working_directory: cwd,
            jsonl_path: jsonlPath,
            created_at: createdAt,
            last_activity_at: indexEntry?.lastActivityAt ?? lastActivityAt,
            type: "external",
            archived: 0,
            custom_title: 0,
            pinned: 0,
            done_at: null,
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,

            summary: indexEntry?.summary ?? null,
            first_prompt: null,
            git_branch: scanGitBranch,
            message_count: indexEntry?.messageCount ?? 0,
            allowed_tools: "[]",
            worktree_path: scanWorktreePath,
            original_directory: scanOriginalDir,
            parent_session_id: null,
            preferred_model: null,
            reasoning_budget: null,
            runtime_mode: null,
            last_message_text: lastMsg?.text ?? null,
            last_message_from: lastMsg?.from ?? null,
            last_message_at: lastMsg?.timestamp ?? null,
            git_info_branch: gitInfo?.branch ?? null,
            git_info_is_worktree:
              gitInfo?.isWorktree !== undefined ? (gitInfo.isWorktree ? 1 : 0) : null,
            project_id:
              this._projectManager.getProjectByDirectory(
                normalizeProjectDirectory(scanOriginalDir ?? cwd),
              )?.id ?? null,
            model,
            space_id: this.inferPersistedSpaceIdForProjectDirectory(
              normalizeProjectDirectory(scanOriginalDir ?? cwd),
              {
                space_id: null,
                worktree_path: scanWorktreePath,
                git_branch: scanGitBranch,
                original_directory: scanOriginalDir,
                working_directory: cwd,
              },
            ),
          });
          discovered++;
        }
      }

      if (rows.length > 0) {
        this.db.upsertMany(rows);
      }
    } catch (err) {
      this.baseConfig.logger.warn(`[InstanceManager] Session scan failed: ${err}`);
    }

    // Archive sessions whose JSONL no longer exists on disk
    // Only consider paths under directories we actually scanned — don't archive
    // sessions from unregistered projects that were simply skipped.
    const codexSessionsDir = join(this.providerDirs.codex, "sessions");
    for (const knownPath of knownPaths) {
      // Codex sessions: always check
      if (knownPath.startsWith(codexSessionsDir)) {
        if (!diskPaths.has(knownPath)) {
          const row = this.db.getByJsonlPath(knownPath);
          if (row && !row.archived) {
            this.db.archive(row.session_id);
            archived++;
          }
        }
        continue;
      }
      // Claude sessions: only archive if the parent project dir was scanned
      if (!knownPath.startsWith(projectsDir)) continue;
      const parentDir = knownPath.substring(0, knownPath.lastIndexOf("/"));
      if (!scannedProjectDirs.has(parentDir)) continue;
      if (!diskPaths.has(knownPath)) {
        const row = this.db.getByJsonlPath(knownPath);
        if (row && !row.archived) {
          this.db.archive(row.session_id);
          archived++;
        }
      }
    }

    // Archive sessions from deleted or temp directories
    for (const row of this.db.getAllActive()) {
      if (!row.working_directory) continue;
      const isTempDir = /^(\/private)?\/tmp(\/|$)/.test(row.working_directory);
      if (isTempDir) {
        // Only sweep genuinely orphaned scratch sessions. A session tied to a
        // registered project (or a still-present worktree origin) is not
        // ephemeral clutter and must survive. This guard also fixes an
        // OS-dependent inconsistency: on Linux the temp root is /tmp, so
        // legitimate sessions under a temp-rooted project would otherwise be
        // archived here — macOS never tripped it because its temp lives under
        // /var/folders, not /tmp.
        if (row.project_id) continue;
        if (row.original_directory && existsSync(row.original_directory)) continue;
        this.db.archive(row.session_id);
        archived++;
      } else if (!existsSync(row.working_directory)) {
        // Don't archive worktree instances if the original directory still exists —
        // the worktree path may have been cleaned up but the session is still valid.
        if (row.original_directory && existsSync(row.original_directory)) {
          continue;
        }
        this.db.archive(row.session_id);
        archived++;
      }
    }

    const scanMs = (performance.now() - scanStart).toFixed(0);
    this.baseConfig.logger.info(
      `[ScanAll] ${scanMs}ms — ${discovered} discovered, ${archived} archived, ${diskPaths.size} on disk, ${knownPaths.size} in DB`,
    );
  }

  /** Recursively scan ~/.codex/sessions/ for Codex JSONL transcripts. */
  private scanCodexSessions(
    knownPaths: Set<string>,
    diskPaths: Set<string>,
    managedKeys: { providerSessionIds: Set<string>; transcriptPaths: Set<string> },
  ): void {
    const sessionsDir = join(this.providerDirs.codex, "sessions");
    if (!existsSync(sessionsDir)) return;

    const rows: SessionRow[] = [];
    let archivedShadows = 0;

    const walk = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath);
          } else if (entry.endsWith(".jsonl")) {
            diskPaths.add(fullPath);
            if (knownPaths.has(fullPath)) {
              const existing = this.db.getByJsonlPath(fullPath);
              if (existing) {
                // Archive external shadow rows that belong to managed sessions
                const matchesManaged =
                  managedKeys.providerSessionIds.has(existing.session_id) ||
                  managedKeys.transcriptPaths.has(fullPath);
                if (matchesManaged && existing.type === "external" && !existing.archived) {
                  this.db.archive(existing.session_id);
                  archivedShadows++;
                  continue;
                }
                if (!existing.model) {
                  const meta = this.readCodexSessionMeta(fullPath);
                  if (meta?.model) {
                    this.backfillSessionModel(existing.session_id, meta.model);
                  }
                }
              }
              continue;
            }

            // Read session_meta from first line
            const meta = this.readCodexSessionMeta(fullPath);
            if (!meta) continue;

            // Skip JSONL files that belong to managed sessions
            if (
              managedKeys.providerSessionIds.has(meta.id) ||
              managedKeys.transcriptPaths.has(fullPath)
            ) {
              continue;
            }

            const cwd = meta.cwd;
            if (!cwd || !existsSync(cwd)) continue;

            const lastMsg = readLastMessage(fullPath);
            const projectDirectory = normalizeProjectDirectory(cwd);

            rows.push({
              session_id: meta.id,
              instance_id: randomUUID(),
              provider_name: "codex",
              name: meta.firstUserMessage
                ? generateTitle(meta.firstUserMessage, "codex")
                : defaultSessionTitle("codex"),
              working_directory: cwd,
              jsonl_path: fullPath,
              created_at: meta.createdAt,
              last_activity_at: Math.floor(stat.mtimeMs),
              type: "external",
              archived: 0,
              custom_title: 0,
              pinned: 0,
              done_at: null,
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_tokens: 0,
              cache_read_tokens: 0,

              summary: null,
              first_prompt: null,
              git_branch: null,
              message_count: 0,
              allowed_tools: "[]",
              worktree_path: null,
              original_directory: null,
              parent_session_id: null,
              preferred_model: null,
              reasoning_budget: null,
              runtime_mode: null,
              last_message_text: lastMsg?.text ?? null,
              last_message_from: lastMsg?.from ?? null,
              last_message_at: lastMsg?.timestamp ?? null,
              git_info_branch: null,
              git_info_is_worktree: null,
              project_id: this._projectManager.getProjectByDirectory(projectDirectory)?.id ?? null,
              model: meta.model,
              space_id: this.inferPersistedSpaceIdForProjectDirectory(projectDirectory, {
                space_id: null,
                worktree_path: null,
                git_branch: null,
                original_directory: null,
                working_directory: cwd,
              }),
            });
          }
        } catch {
          // skip unreadable entries
        }
      }
    };

    walk(sessionsDir);

    if (rows.length > 0 || archivedShadows > 0) {
      if (rows.length > 0) this.db.upsertMany(rows);
      this.baseConfig.logger.info(
        `[InstanceManager] Codex scan: discovered ${rows.length} session(s)` +
          (archivedShadows > 0 ? `, archived ${archivedShadows} managed shadow(s)` : ""),
      );
    }
  }

  /** Read session_meta + first user message from a Codex JSONL file. */
  private readCodexSessionMeta(jsonlPath: string): {
    id: string;
    cwd: string;
    createdAt: number;
    firstUserMessage: string | null;
    model: string | null;
  } | null {
    try {
      const fd = openSync(jsonlPath, "r");
      try {
        const buf = Buffer.alloc(65536);
        const bytesRead = readSync(fd, buf, 0, 65536, 0);
        const text = buf.toString("utf-8", 0, bytesRead);

        let id: string | null = null;
        let cwd: string | null = null;
        let createdAt = 0;
        let firstUserMessage: string | null = null;
        let model: string | null = null;

        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "session_meta" && parsed.payload) {
              id = parsed.payload.id;
              cwd = parsed.payload.cwd;
              const ts = new Date(parsed.payload.timestamp || parsed.timestamp).getTime();
              createdAt = isNaN(ts) ? Date.now() : ts;
            } else if (
              !firstUserMessage &&
              parsed.type === "event_msg" &&
              parsed.payload?.type === "user_message" &&
              parsed.payload.message
            ) {
              const msg = parsed.payload.message.trim();
              if (msg && !isTrivialMessage(msg)) {
                firstUserMessage = msg;
              }
            } else if (
              !model &&
              parsed.type === "turn_context" &&
              typeof parsed.payload?.model === "string" &&
              parsed.payload.model.trim()
            ) {
              model = parsed.payload.model;
            }
            // Stop once we have all metadata we care about.
            if (id && firstUserMessage && model) break;
          } catch {
            // partial line
          }
        }

        if (!id || !cwd) return null;
        return { id, cwd, createdAt, firstUserMessage, model };
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  /**
   * Restore a single external session row from the DB into an in-memory Instance.
   * Returns true if the instance was created, false if skipped.
   */
  private restoreExternalFromRow(entry: SessionRow): boolean {
    if (entry.type !== "external") return false;
    if (this.instances.has(entry.instance_id)) return false;
    if (!existsSync(entry.jsonl_path)) {
      this.db.archive(entry.session_id);
      return false;
    }

    let restoreWorkingDirectory = entry.working_directory;
    let extWorktreePath = entry.worktree_path ?? undefined;
    const extOriginalDir = entry.original_directory ?? undefined;
    const extGitBranch = entry.git_branch ?? undefined;
    const hasExplicitSpaceOwnership = hasExplicitNonDefaultSpace(this.spaceManager, entry.space_id);
    // Compatibility shim: allow legacy rows to recover ownership from the
    // current spaces table during restore instead of leaking into main.
    const inferredSpaceId = this.inferPersistedSpaceIdForProjectDirectory(
      getPersistenceRowProjectDirectory(entry),
      entry,
    );

    const restoredPaths = resolveExternalRestorePaths({
      row: entry,
      hasExplicitSpaceOwnership,
      usableStoredWorktreePath: isUsableStoredWorktreePath(entry.worktree_path),
    });
    restoreWorkingDirectory = restoredPaths.workingDirectory;
    extWorktreePath = restoredPaths.worktreePath;

    if (entry.worktree_path && !restoredPaths.worktreePath) {
      if (hasExplicitSpaceOwnership && entry.space_id) {
        if (!this.warnedUnusableSpaces.has(entry.space_id)) {
          this.warnedUnusableSpaces.add(entry.space_id);
          this.baseConfig.logger.warn(
            `[InstanceManager] Worktree ${entry.worktree_path} is no longer usable for space ${entry.space_id}; keeping sessions read-only`,
          );
        }
      } else if (restoredPaths.repairedStaleWorktree) {
        this.baseConfig.logger.warn(
          `[InstanceManager] Worktree ${entry.worktree_path} is no longer usable, using original directory`,
        );
      }
    }

    // Detect provider from JSONL path if mismatched (legacy migration fix)
    let provider = (entry.provider_name as ProviderKind) || "claude";
    if (provider === "claude" && entry.jsonl_path?.includes("/.codex/")) {
      provider = "codex";
      this.db.updateProvider(entry.session_id, "codex");
    }

    const restoredState = buildExternalRestoreState({
      entry,
      provider,
      workingDirectory: restoreWorkingDirectory,
      worktreePath: extWorktreePath,
      originalDirectory: extOriginalDir,
      gitBranch: extGitBranch,
      inferredSpaceId: inferredSpaceId ?? undefined,
      defaultRuntimeMode: this.baseConfig.defaultRuntimeMode,
    });
    if (restoredState.info.projectId) {
      restoredState.info.projectSlug = this._projectManager.getProject(
        restoredState.info.projectId,
      )?.slug;
    }

    const instance: Instance = {
      info: restoredState.info,
      process: null,
      providerBinding: restoredState.providerBinding,
      history: [], // deferred until hydration
      sessionId: entry.session_id,
      jsonlPath: entry.jsonl_path,
      // tasks and files deferred until hydration
      fileStateRevision: 0,
      worktreePath: extWorktreePath,
      gitBranch: extGitBranch,
      originalDirectory: extOriginalDir,
      actualCwd: restoredState.actualCwd,
      hydrated: false,
    };

    this.instances.set(entry.instance_id, instance);
    if (entry.space_id !== inferredSpaceId) {
      this.db.updateSessionSpaceId(entry.session_id, inferredSpaceId);
      this.logSpaceOwnershipRepair("restore", `external:${entry.session_id}`, {
        previousSpaceId: entry.space_id,
        nextSpaceId: inferredSpaceId,
        projectDirectory: getPersistenceRowProjectDirectory(entry),
      });
    }
    if (restoredPaths.repairedStaleWorktree) {
      this.dbSave(instance);
    }
    this.emit("instance:created", entry.instance_id, { ...restoredState.info });
    return true;
  }

  /**
   * Restore a single managed session row from the DB into an in-memory Instance.
   * Returns true if the instance was created, false if skipped.
   */
  private restoreManagedFromRow(entry: ManagedInstanceRow): boolean {
    if (this.instances.has(entry.instance_id)) return false;

    let restoreActualCwd = entry.working_directory;
    let restoreWorktreePath: string | undefined;
    let restoreGitBranch: string | undefined;
    let restoreOriginalDirectory: string | undefined;

    const hasExplicitSpaceOwnership = hasExplicitNonDefaultSpace(this.spaceManager, entry.space_id);
    // Compatibility shim: allow legacy rows to recover ownership from the
    // current spaces table during restore instead of leaking into main.
    const inferredSpaceId = this.inferPersistedSpaceIdForProjectDirectory(
      getPersistenceRowProjectDirectory(entry),
      entry,
    );
    const restoredPaths = resolveManagedRestorePaths({
      row: entry,
      hasExplicitSpaceOwnership,
      usableStoredWorktreePath: isUsableStoredWorktreePath(entry.worktree_path),
    });
    restoreActualCwd = restoredPaths.workingDirectory;
    restoreWorktreePath = restoredPaths.worktreePath;
    restoreGitBranch = restoredPaths.gitBranch;
    restoreOriginalDirectory = restoredPaths.originalDirectory;

    if (entry.worktree_path && !restoredPaths.worktreePath) {
      if (hasExplicitSpaceOwnership && entry.space_id) {
        if (!this.warnedUnusableSpaces.has(entry.space_id)) {
          this.warnedUnusableSpaces.add(entry.space_id);
          this.baseConfig.logger.warn(
            `[InstanceManager] Worktree ${entry.worktree_path} is no longer usable for space ${entry.space_id}; keeping sessions read-only`,
          );
        }
      } else if (restoredPaths.repairedStaleWorktree) {
        this.baseConfig.logger.warn(
          `[InstanceManager] Worktree ${entry.worktree_path} is no longer usable, using original directory`,
        );
      }
    }

    const restoredState = parseManagedRestoreState(entry);
    let { resumeCursor, runtimePayload } = restoredState;
    const explicitReview = restoredState.review;
    if (restoredPaths.repairedStaleWorktree) {
      runtimePayload = { ...runtimePayload, cwd: restoreActualCwd };
    }

    const resumeSessionId = entry.provider_session_id ?? extractResumeSessionId(resumeCursor);
    const provider = entry.provider_name as ProviderKind;
    const transcriptPath = this.resolveManagedTranscriptPath(provider, {
      sessionId: resumeSessionId,
      transcriptPath: entry.transcript_path ?? undefined,
      workingDirectory: restoreActualCwd,
    });
    if (!resumeSessionId && !transcriptPath) {
      this.db.archiveManaged(entry.instance_id);
      this.baseConfig.logger.info(
        `[InstanceManager] Archived incomplete managed session "${entry.name}" (${entry.instance_id}) with no resumable binding`,
      );
      return false;
    }

    const builtRestore = buildManagedRestoreState({
      entry,
      workingDirectory: restoreActualCwd,
      worktreePath: restoreWorktreePath,
      originalDirectory: restoreOriginalDirectory,
      gitBranch: restoreGitBranch,
      inferredSpaceId: inferredSpaceId ?? undefined,
      resumeCursor,
      runtimePayload,
      resumeSessionId,
      transcriptPath,
      modelOptions: restoredState.modelOptions,
      review: explicitReview,
      reviewInstanceId: restoredState.reviewInstanceId,
    });
    if (builtRestore.info.projectId) {
      builtRestore.info.projectSlug = this._projectManager.getProject(
        builtRestore.info.projectId,
      )?.slug;
    }

    const instance: Instance = {
      info: builtRestore.info,
      process: null,
      providerBinding: builtRestore.providerBinding,
      history: [], // deferred until hydration
      sessionId: resumeSessionId,
      jsonlPath: transcriptPath,
      // watchState, tasks, and files deferred until hydration
      fileStateRevision: 0,
      worktreePath: restoreWorktreePath,
      gitBranch: restoreGitBranch,
      originalDirectory: restoreOriginalDirectory,
      actualCwd: builtRestore.actualCwd,
      hydrated: false,
      taskContextInjected: builtRestore.taskContextInjected,
      customInstructionsInjected: builtRestore.customInstructionsInjected,
    };

    this.instances.set(entry.instance_id, instance);
    if (entry.space_id !== inferredSpaceId) {
      this.db.updateManagedSpaceId(entry.instance_id, inferredSpaceId);
      this.logSpaceOwnershipRepair("restore", `managed:${entry.instance_id}`, {
        previousSpaceId: entry.space_id,
        nextSpaceId: inferredSpaceId,
        projectDirectory: getPersistenceRowProjectDirectory(entry),
      });
    }
    if (
      transcriptPath !== (entry.transcript_path ?? undefined) ||
      restoredPaths.repairedStaleWorktree
    ) {
      this.dbSave(instance);
    }
    this.removeLiveExternalShadow(entry.instance_id, resumeSessionId ?? undefined, transcriptPath);
    this.emit("instance:created", entry.instance_id, { ...builtRestore.info });
    return true;
  }

  /**
   * Seed the module-level gitInfoCache from DB metadata so the first discovery
   * poll doesn't re-run git rev-parse on every known directory.
   */
  private preloadGitInfoCache(): void {
    const seeded = new Set<string>();
    const seed = (dir: string, branch: string | null, isWorktree: number | null) => {
      if (!dir || seeded.has(dir) || branch === null) return;
      seeded.add(dir);
      gitInfoCache.set(dir, {
        info: { branch, isWorktree: isWorktree === 1 },
        cachedAt: Date.now(),
      });
    };
    for (const row of this.db.getAllActive()) {
      seed(row.working_directory, row.git_info_branch, row.git_info_is_worktree);
    }
    for (const row of this.db.getAllManagedActive()) {
      seed(row.working_directory, row.git_info_branch, row.git_info_is_worktree);
    }
    if (seeded.size > 0) {
      this.baseConfig.logger.debug(
        `[InstanceManager] Seeded git info cache for ${seeded.size} directories`,
      );
    }
  }

  private restorePersistedRowsFromDb(): number {
    return restorePersistedRows({
      externalRows: this.db.getAllActive(),
      managedRows: this.db.getAllManagedActive(),
      managedKeys: this.collectManagedSessionKeys(),
      isManagedShadowSessionRow,
      restoreExternalRow: (entry) => this.restoreExternalFromRow(entry),
      restoreManagedRow: (entry) => this.restoreManagedFromRow(entry),
    });
  }

  /**
   * Fast restore from DB cache only — no filesystem scan.
   * Gets instances into the sidebar immediately from cached metadata.
   */
  restoreInstances(): void {
    this.preloadGitInfoCache();
    this.collapseManagedDuplicates();

    if (this.db.needsRebuild) {
      this.baseConfig.logger.info("[InstanceManager] DB was rebuilt from JSONL scan");
    }

    const restored = this.restorePersistedRowsFromDb();

    this.pruneLiveManagedShadows(this.collectManagedSessionKeys());

    if (restored > 0) {
      this.baseConfig.logger.info(
        `[InstanceManager] Restored ${restored} instance(s) from database`,
      );
    }

    // Defer plan-parent linking to after server.listen()
    queueMicrotask(() => this.linkPlanSessions());

    // Refresh titles for sessions that have a trivial/stale name
    for (const inst of this.instances.values()) {
      if (
        !inst.info.customTitle &&
        (isDefaultSessionTitle(inst.info.name) || isTrivialMessage(inst.info.name))
      ) {
        this.doRefreshTitle(inst);
      }
    }

    // Auto-continue instances that were mid-turn when the server shut down
    this.autoContinueAfterRestart();

    // Rebuild the FTS search index on startup for freshness.
    // Populate search_content with transcript text for all instances —
    // most are unhydrated (history: []) so we parse their transcript from disk.
    try {
      let indexed = 0;
      for (const inst of this.instances.values()) {
        try {
          let history = inst.history;
          if (history.length === 0 && inst.jsonlPath) {
            // Instance not yet hydrated — parse transcript from disk
            const parsed = this.parseProviderTranscript(inst.info.provider, inst.jsonlPath);
            history = parsed.history;
          }
          if (history.length > 0) {
            this.db.updateSearchContent(inst.info.id, extractSearchableText(history));
            indexed++;
          }
        } catch {
          // Skip instances whose transcript can't be parsed (corrupt, missing, etc.)
        }
      }
      this.db.rebuildSearchIndex();
      this.baseConfig.logger.info(
        `[InstanceManager] Search index rebuilt (${indexed} transcripts indexed)`,
      );
    } catch (err) {
      this.baseConfig.logger.warn("[InstanceManager] Search index rebuild failed", err);
    }
  }

  /**
   * Run the filesystem scan and restore any newly-discovered sessions.
   * Returns the number of new instances created.
   */
  private scanAndRestoreNew(): number {
    this.scanAllSessions();
    this._projectManager.recoverProjectsFromSessionDirectories();
    this.spaceManager.recoverSpacesFromSessionMetadata();
    this.backfillMissingSpaceIds();
    this.refreshInstanceSpaceIdsFromDb();

    const discovered = this.restorePersistedRowsFromDb();

    this.pruneLiveManagedShadows(this.collectManagedSessionKeys());

    if (discovered > 0) {
      this.baseConfig.logger.info(
        `[InstanceManager] Scan discovered ${discovered} new instance(s)`,
      );
    }

    // Re-link plan sessions for any newly discovered instances
    this.linkPlanSessions();

    this.scanComplete = true;
    this.emit("scan:complete");

    return discovered;
  }

  /**
   * Full synchronous restore: DB cache + filesystem scan.
   * Used by tests and any path that needs everything ready immediately.
   */
  restoreAndScan(): void {
    this.restoreInstances();
    this.scanAndRestoreNew();
  }

  /**
   * Re-run the filesystem scan to discover sessions for newly registered projects.
   * Not scoped — rescans all registered project directories.
   */
  rescanAll(): void {
    this.scanAndRestoreNew();
  }

  /**
   * Background filesystem scan — discovers new sessions, archives stale ones,
   * creates Instance objects for any newly found DB rows. Emits scan:complete when done.
   * Call this after server.listen() so the UI is already available.
   */
  async scanInBackground(): Promise<void> {
    // Yield to the event loop so server.listen() callback and pending WS connections
    // get processed before the sync filesystem scan blocks.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    this.scanAndRestoreNew();
    this.backfillLastMessages();
  }

  /** Backfill lastMessage for restored instances that have a JSONL path but no preview. */
  private backfillLastMessages(): void {
    let count = 0;
    for (const instance of this.instances.values()) {
      if (instance.info.lastMessage) continue;
      const jsonlPath =
        instance.watchState?.jsonlPath || instance.externalState?.jsonlPath || instance.jsonlPath;
      if (!jsonlPath) continue;
      const lastMsg = readLastMessage(jsonlPath);
      if (lastMsg) {
        instance.info.lastMessage = lastMsg;
        this.emitInstanceStatus(instance);
        this.dbSave(instance);
        count++;
      }
    }
    if (count > 0) {
      this.baseConfig.logger.info(
        `[InstanceManager] Backfilled last-message previews for ${count} session(s)`,
      );
    }
  }

  private autoContinueAfterRestart(): void {
    let processingIds: string[];
    try {
      if (!existsSync(this.processingAtShutdownPath)) return;
      processingIds = JSON.parse(readFileSync(this.processingAtShutdownPath, "utf-8"));
      unlinkSync(this.processingAtShutdownPath);
    } catch {
      return;
    }

    if (!processingIds.length) return;

    // Delay briefly to let the server finish starting up
    setTimeout(() => {
      for (const id of processingIds) {
        const instance = this.instances.get(id);
        if (!instance || instance.info.external) continue;

        this.baseConfig.logger.info(
          `[InstanceManager] Auto-continuing instance "${instance.info.name}" (${id}) — was mid-turn at shutdown`,
        );

        try {
          this.bootManagedInstance(id, instance);
          if (instance.process) {
            const userMessage: UserMessage = {
              type: "user",
              text: AUTO_CONTINUE_MSG,
              instanceId: id,
              internal: true,
            };
            this.noteManagedProcessActivity(instance);
            this.pushHistory(instance, userMessage);
            instance.process.send(AUTO_CONTINUE_MSG);
            this.setStatus(instance, "processing");

            // Track this ID so that if the server restarts again quickly (e.g. a build
            // triggered by the auto-continued Claude), we don't re-save it to
            // processing-at-shutdown.json and create an endless restart loop.
            this.recentlyAutoContinued.add(id);
            setTimeout(() => this.recentlyAutoContinued.delete(id), 120_000);
          }
        } catch (err) {
          this.baseConfig.logger.warn(`[InstanceManager] Auto-continue failed for ${id}: ${err}`);
        }
      }
    }, 1000);
  }

  /**
   * Set `parentSessionId` on restored instances that are plan-continuations.
   * UI-only metadata — no history merging or state mutation.
   */
  private linkPlanSessions(): void {
    let linked = 0;

    for (const instance of this.instances.values()) {
      if (instance.info.parentSessionId) continue; // already linked (from DB)

      const jsonlPath = instance.jsonlPath || instance.externalState?.jsonlPath;
      if (!jsonlPath) continue;

      const parent = this.findPlanParent(jsonlPath);
      if (!parent || parent.info.id === instance.info.id) continue;

      const parentSid = parent.sessionId || parent.info.sessionId;
      if (!parentSid) continue;

      instance.info.parentSessionId = parentSid;
      this.dbSave(instance);
      linked++;
    }

    if (linked > 0) {
      this.baseConfig.logger.info(
        `[InstanceManager] Linked ${linked} plan-continuation session(s) to parents`,
      );
    }
  }

  // ===========================================================================
  // Event wiring
  // ===========================================================================

  private wireProcessEvents(id: string, proc: ProviderSession): void {
    proc.on("output", (message) => {
      void this.enqueueInstanceMutation(id, async (live) => {
        if (this.shuttingDown || live.process !== proc) return;
        this.noteManagedProcessActivity(live);
        live.providerBinding = mergeProviderBinding(live.providerBinding, proc.getRuntimeBinding());
        this.pushHistory(live, message);
        live.info.lastActivityAt = Date.now();

        if (message.isWaiting) {
          if (live.watchState) {
            try {
              live.watchState.fileOffset = statSync(live.watchState.jsonlPath).size;
            } catch {
              // ignore — file may not exist yet
            }
          }

          if (live.pendingRetry) {
            const retryText = live.pendingRetry;
            live.pendingRetry = undefined;
            const userMessage: UserMessage = {
              type: "user",
              text: retryText,
              instanceId: id,
              internal: true,
            };
            this.noteManagedProcessActivity(live);
            this.pushHistory(live, userMessage);
            this.emit("instance:user", id, userMessage);
            live.info.lastActivityAt = Date.now();
            this.setStatus(live, "processing");
            live.process?.send(retryText);
          } else if (live.pendingMessages?.length) {
            // Drain queued user messages as the next turn
            const coalesced = this.coalescePendingMessages(live);
            live.pendingMessages = undefined;
            live.info.queuedMessageCount = undefined;
            this.emitInstanceStatus(live);
            await this.dispatchUserMessageLocked(
              id,
              live,
              coalesced.text,
              coalesced.images,
              coalesced.internal,
              coalesced.attachments,
            );
          } else {
            this.checkWorktreeChanges(live);
            this.refreshPendingPlan(live);
            this.setStatus(live, "idle");
            this.doRefreshTitle(live);
          }
        } else {
          this.setStatus(live, "processing");
        }

        this.dbSave(live);
        this.emit("instance:output", id, message);
      }).catch((err) => this.logQueuedMutationError("output handler", id, err));
    });

    proc.on("activity", (message) => {
      void this.enqueueInstanceMutation(id, (live) => {
        if (this.shuttingDown || live.process !== proc) return;
        this.noteManagedProcessActivity(live);
        live.providerBinding = mergeProviderBinding(live.providerBinding, proc.getRuntimeBinding());
        const pendingStateBefore = this.pendingStateSignature(live);
        if (message.activity === "task_list" && message.tasks) {
          if (!live.tasks) live.tasks = new Map();
          live.tasks.clear();
          for (const task of message.tasks) {
            live.tasks.set(task.id, { ...task });
          }
        }
        if (message.activity === "file_list" && message.files) {
          if (!live.files) live.files = new Map();
          live.files.clear();
          live.fileStateRevision += 1;
          for (const file of message.files) {
            live.files.set(file.path, { ...file });
          }
          const diffCwd = live.actualCwd || live.info.workingDirectory;
          const origBranch = live.originalDirectory
            ? (getCurrentBranch(live.originalDirectory) ?? undefined)
            : undefined;
          enrichDiffStats(diffCwd, live.files, {
            originalBranch: origBranch,
            sessionCreatedAt: live.info.createdAt,
          });
          message.files = Array.from(live.files.values()).map((file) => ({ ...file }));
        }
        if (
          live.info.runtimeMode === "plan" &&
          message.activity === "tool_use" &&
          (message.tool === "Edit" || message.tool === "Write") &&
          message.input
        ) {
          const filePath = (message.input as Record<string, unknown>).file_path as
            | string
            | undefined;
          if (filePath) {
            live.planFilePath = filePath;
          }
        }
        if (message.permissionDenied) {
          live.info.pendingPermission = {
            requestId: message.permissionDenied,
            kind: "approval",
            tool: message.permissionDenied,
            description: message.description,
          };
          this.emitInstanceStatus(live);
        }
        this.syncPendingInteractiveState(live, message);
        this.emitPendingStateIfChanged(live, pendingStateBefore);
        this.pushHistory(live, message);
        live.info.lastActivityAt = Date.now();
        this.setStatus(live, "processing");
        this.dbSave(live);
        this.emit("instance:activity", id, message);
      }).catch((err) => this.logQueuedMutationError("activity handler", id, err));
    });

    proc.on(
      "systemEvent" as keyof import("./provider.js").ProviderSessionEvents,
      ((message: SystemEventMessage) => {
        void this.enqueueInstanceMutation(id, (live) => {
          if (this.shuttingDown || live.process !== proc) return;
          if (message.event === "session_init") {
            const payload = message.payload ?? {};
            const slashCommands: ProviderSlashCommand[] = Array.isArray(payload.slashCommands)
              ? payload.slashCommands.flatMap((value) => {
                  if (typeof value === "string" && value.trim()) return [{ name: value.trim() }];
                  if (!value || typeof value !== "object") return [];
                  const record = value as Record<string, unknown>;
                  if (typeof record.name !== "string" || !record.name.trim()) return [];
                  const input =
                    record.input && typeof record.input === "object"
                      ? (record.input as Record<string, unknown>)
                      : null;
                  return [
                    {
                      name: record.name.trim(),
                      description:
                        typeof record.description === "string" && record.description.trim()
                          ? record.description.trim()
                          : undefined,
                      input:
                        input && typeof input.hint === "string" && input.hint.trim()
                          ? { hint: input.hint.trim() }
                          : undefined,
                    },
                  ];
                })
              : [];
            const skills: ProviderSkill[] = Array.isArray(payload.skills)
              ? payload.skills.reduce<ProviderSkill[]>((acc, value) => {
                  if (typeof value === "string" && value.trim()) {
                    acc.push({ name: value.trim(), enabled: true, invocationPrefix: "$" });
                    return acc;
                  }
                  if (!value || typeof value !== "object") return acc;
                  const record = value as Record<string, unknown>;
                  if (typeof record.name !== "string" || !record.name.trim()) return acc;
                  acc.push({
                    name: record.name.trim(),
                    displayName:
                      typeof record.displayName === "string" && record.displayName.trim()
                        ? record.displayName.trim()
                        : undefined,
                    description:
                      typeof record.description === "string" && record.description.trim()
                        ? record.description.trim()
                        : undefined,
                    shortDescription:
                      typeof record.shortDescription === "string" && record.shortDescription.trim()
                        ? record.shortDescription.trim()
                        : undefined,
                    path:
                      typeof record.path === "string" && record.path.trim()
                        ? record.path.trim()
                        : undefined,
                    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
                    invocationPrefix:
                      record.invocationPrefix === "/" || record.invocationPrefix === "$"
                        ? record.invocationPrefix
                        : "$",
                  });
                  return acc;
                }, [])
              : [];
            const mcpServers = Array.isArray(payload.mcpServers)
              ? payload.mcpServers.flatMap((server) => {
                  if (!server || typeof server !== "object") return [];
                  const record = server as Record<string, unknown>;
                  return typeof record.id === "string" &&
                    typeof record.name === "string" &&
                    record.provider === live.info.provider
                    ? [{ ...record } as unknown as import("./types.js").ProviderMcpServerStatus]
                    : [];
                })
              : undefined;
            if (slashCommands.length || skills.length || mcpServers !== undefined) {
              live.info.providerStatus = {
                ...live.info.providerStatus,
                slashCommands: slashCommands.length
                  ? slashCommands
                  : live.info.providerStatus?.slashCommands,
                skills: skills.length ? skills : live.info.providerStatus?.skills,
                ...(mcpServers !== undefined ? { mcpServers } : {}),
              };
              this.emitInstanceStatus(live);
            }
          } else if (message.event === "provider_status") {
            const payload = message.payload ?? {};
            const globalPatch: Partial<import("./types.js").ProviderGlobalState> = {};
            if (Array.isArray(payload.mcpServers)) {
              globalPatch.mcpServers = payload.mcpServers.map((server) => ({ ...server }));
            }
            if (payload.account && typeof payload.account === "object") {
              globalPatch.account = {
                ...(payload.account as Record<string, unknown>),
                rateLimits: Array.isArray((payload.account as Record<string, unknown>).rateLimits)
                  ? (
                      (payload.account as Record<string, unknown>).rateLimits as Array<
                        Record<string, unknown>
                      >
                    ).map((limit) => ({ ...limit }))
                  : undefined,
              };
            }
            if (Array.isArray(payload.apps)) {
              globalPatch.apps = payload.apps.filter(
                (app): app is string => typeof app === "string",
              );
            }
            if (globalPatch.account || globalPatch.mcpServers || globalPatch.apps) {
              this.updateProviderGlobalState(live.info.provider, globalPatch);
            }
            live.info.providerStatus = {
              ...live.info.providerStatus,
              threadStatus:
                typeof payload.threadStatus === "string"
                  ? payload.threadStatus
                  : live.info.providerStatus?.threadStatus,
              turnStatus:
                typeof payload.turnStatus === "string"
                  ? payload.turnStatus
                  : live.info.providerStatus?.turnStatus,
              slashCommands: Array.isArray(payload.slashCommands)
                ? payload.slashCommands.flatMap((command) => {
                    if (!command || typeof command !== "object") return [];
                    const record = command as Record<string, unknown>;
                    if (typeof record.name !== "string" || !record.name.trim()) return [];
                    const input =
                      record.input && typeof record.input === "object"
                        ? (record.input as Record<string, unknown>)
                        : null;
                    return [
                      {
                        name: record.name.trim(),
                        description:
                          typeof record.description === "string" && record.description.trim()
                            ? record.description.trim()
                            : undefined,
                        input:
                          input && typeof input.hint === "string" && input.hint.trim()
                            ? { hint: input.hint.trim() }
                            : undefined,
                      },
                    ];
                  })
                : live.info.providerStatus?.slashCommands,
              skills: Array.isArray(payload.skills)
                ? payload.skills.flatMap((skill) => {
                    if (!skill || typeof skill !== "object") return [];
                    const record = skill as Record<string, unknown>;
                    if (typeof record.name !== "string" || !record.name.trim()) return [];
                    const invocationPrefix =
                      record.invocationPrefix === "/" || record.invocationPrefix === "$"
                        ? record.invocationPrefix
                        : undefined;
                    return [
                      {
                        name: record.name.trim(),
                        displayName:
                          typeof record.displayName === "string" && record.displayName.trim()
                            ? record.displayName.trim()
                            : undefined,
                        description:
                          typeof record.description === "string" && record.description.trim()
                            ? record.description.trim()
                            : undefined,
                        shortDescription:
                          typeof record.shortDescription === "string" &&
                          record.shortDescription.trim()
                            ? record.shortDescription.trim()
                            : undefined,
                        enabled: typeof record.enabled === "boolean" ? record.enabled : undefined,
                        scope:
                          typeof record.scope === "string" && record.scope.trim()
                            ? record.scope.trim()
                            : undefined,
                        path:
                          typeof record.path === "string" && record.path.trim()
                            ? record.path.trim()
                            : undefined,
                        source:
                          record.source === "project" ||
                          record.source === "user" ||
                          record.source === "system"
                            ? record.source
                            : undefined,
                        invocationPrefix,
                      },
                    ];
                  })
                : live.info.providerStatus?.skills,
              mcpServers: Array.isArray(payload.mcpServers)
                ? payload.mcpServers.map((server) => ({ ...server }))
                : live.info.providerStatus?.mcpServers,
              diff:
                payload.diff && typeof payload.diff === "object"
                  ? { ...(payload.diff as Record<string, unknown>) }
                  : live.info.providerStatus?.diff,
              // string sets, explicit null clears, absent keeps the prior value
              fastModeDisabledReason:
                typeof payload.fastModeDisabledReason === "string"
                  ? payload.fastModeDisabledReason
                  : payload.fastModeDisabledReason === null
                    ? undefined
                    : live.info.providerStatus?.fastModeDisabledReason,
            };
            if (
              typeof payload.turnStatus === "string" &&
              payload.turnStatus !== "inProgress" &&
              live.info.pendingPermission?.kind === "terminal_input"
            ) {
              live.info.pendingPermission = undefined;
              live.info.pendingTool = undefined;
            }
            this.emitInstanceStatus(live);
          } else if (message.event === "model_rerouted") {
            const payload = message.payload ?? {};
            live.info.providerStatus = {
              ...live.info.providerStatus,
              requestedModel:
                typeof payload.requestedModel === "string"
                  ? payload.requestedModel
                  : live.info.providerStatus?.requestedModel,
              effectiveModel:
                typeof payload.effectiveModel === "string"
                  ? payload.effectiveModel
                  : live.info.providerStatus?.effectiveModel,
              reroutedFromModel:
                typeof payload.reroutedFromModel === "string"
                  ? payload.reroutedFromModel
                  : live.info.providerStatus?.reroutedFromModel,
            };
            this.emitInstanceStatus(live);
          } else if (message.event === "provider_notice") {
            const payload = message.payload ?? {};
            if (typeof payload.message === "string" && payload.message.trim()) {
              const notice = {
                level: payload.level === "info" ? "info" : "warning",
                scope:
                  payload.scope === "global" ||
                  payload.scope === "project" ||
                  payload.scope === "instance"
                    ? payload.scope
                    : undefined,
                source: typeof payload.source === "string" ? payload.source : undefined,
                code: typeof payload.code === "string" ? payload.code : undefined,
                message: payload.message,
                detail: typeof payload.detail === "string" ? payload.detail : undefined,
              } satisfies import("./types.js").ProviderNotice;

              if (notice.scope === "global") {
                const existing = this.providerGlobalState.get(live.info.provider);
                const notices = existing?.notices ? [...existing.notices] : [];
                notices.push(notice);
                this.updateProviderGlobalState(live.info.provider, { notices: notices.slice(-5) });
              } else {
                const notices = live.info.providerStatus?.notices
                  ? [...live.info.providerStatus.notices]
                  : [];
                notices.push(notice);
                live.info.providerStatus = {
                  ...live.info.providerStatus,
                  notices: notices.slice(-5),
                };
                this.emitInstanceStatus(live);
              }
            }
          }
          this.pushHistory(live, message);
          this.dbSave(live);
          this.emit("instance:system_event", id, message);
        }).catch((err) => this.logQueuedMutationError("systemEvent handler", id, err));
      }) as (...args: unknown[]) => void,
    );

    proc.on("stats", (stats) => {
      void this.enqueueInstanceMutation(id, (live) => {
        if (this.shuttingDown || live.process !== proc) return;
        live.info.stats = {
          ...stats,
          // Preserve context fields from prior refreshContextUsage() when this
          // stats event (e.g. a usage event) doesn't include them yet.
          contextTokens: stats.contextTokens ?? live.info.stats?.contextTokens,
          contextWindow: stats.contextWindow ?? live.info.stats?.contextWindow,
          contextCategories: stats.contextCategories ?? live.info.stats?.contextCategories,
        };
        live.providerBinding = mergeProviderBinding(live.providerBinding, proc.getRuntimeBinding());
        this.dbSave(live);
        this.emitInstanceStatus(live);
      }).catch((err) => this.logQueuedMutationError("stats handler", id, err));
    });

    proc.on("exit", (message) => {
      void this.enqueueInstanceMutation(id, async (live) => {
        if (this.shuttingDown || live.process !== proc) return;
        live.providerBinding = mergeProviderBinding(live.providerBinding, proc.getRuntimeBinding());
        const wasCancelledByUser = live.cancelledByUser;
        const wasInterruptedToSend = live.interruptedToSend;
        live.cancelledByUser = false;
        live.interruptedToSend = false;

        // If user interrupted specifically to deliver queued messages, dispatch them now
        // (this restarts the process via dispatchUserMessageLocked)
        if (wasInterruptedToSend && live.pendingMessages?.length) {
          const coalesced = this.coalescePendingMessages(live);
          live.pendingMessages = undefined;
          live.info.queuedMessageCount = undefined;
          this.setStatus(live, "stopped");
          this.emitInstanceStatus(live);
          this.dbSave(live);
          await this.dispatchUserMessageLocked(
            id,
            live,
            coalesced.text,
            coalesced.images,
            coalesced.internal,
            coalesced.attachments,
          );
          return;
        }

        if (message.code !== 0 && !wasCancelledByUser) {
          this.pushHistory(live, message);
          this.setStatus(live, "error");
        } else {
          this.setStatus(live, "stopped");
        }
        // Clear any orphaned queue on non-interrupt exits and broadcast the update
        if (live.pendingMessages?.length) {
          live.pendingMessages = undefined;
          live.info.queuedMessageCount = undefined;
          this.emitInstanceStatus(live);
        }
        this.dbSave(live);
        if (!wasCancelledByUser && !wasInterruptedToSend) {
          this.emit("instance:exit", id, message);
        }
      }).catch((err) => this.logQueuedMutationError("exit handler", id, err));
    });

    // Provider-level errors (e.g. auth failures) — surface to the UI
    proc.on(
      "providerError" as keyof import("./provider.js").ProviderSessionEvents,
      ((errorMsg: string) => {
        void this.enqueueInstanceMutation(id, (live) => {
          if (this.shuttingDown || live.process !== proc) return;
          const errorMessage: import("./types.js").ErrorMessage = {
            type: "error",
            message: errorMsg,
          };
          this.pushHistory(live, errorMessage);
          this.dbSave(live);
          this.emit("instance:error", id, errorMsg);
        }).catch((err) => this.logQueuedMutationError("providerError handler", id, err));
      }) as (...args: unknown[]) => void,
    );

    // SDK permission requests — set pending state without creating a chat activity
    proc.on(
      "permissionRequest" as keyof import("#core/provider.js").ProviderSessionEvents,
      ((request: ProviderRequest) => {
        void this.enqueueInstanceMutation(id, (live) => {
          if (this.shuttingDown || live.process !== proc) return;
          live.info.pendingPermission = request;
          this.emitInstanceStatus(live);
        }).catch((err) => this.logQueuedMutationError("permissionRequest handler", id, err));
      }) as (...args: unknown[]) => void,
    );

    // Provider-generated title (e.g. Codex thread/name/updated)
    proc.on(
      "titleUpdate" as keyof import("#core/provider.js").ProviderSessionEvents,
      ((name: string) => {
        void this.enqueueInstanceMutation(id, (live) => {
          if (this.shuttingDown || live.process !== proc) return;
          const sanitised = sanitiseForTitle(name) || name;
          if (live.info.customTitle || sanitised === live.info.name) return;
          live.info.name = sanitised;
          this.emitInstanceStatus(live);
          this.dbSave(live);
          const sid = live.sessionId || live.info.sessionId;
          if (sid) this.db.updateName(sid, name, false);
        }).catch((err) => this.logQueuedMutationError("titleUpdate handler", id, err));
      }) as (...args: unknown[]) => void,
    );
  }

  private captureSessionId(id: string, instance: Instance, proc: ProviderSession): void {
    const isSdk = this.isSdkSession(proc);

    const onOutput = (message: OutputMessage) => {
      if (!message.isWaiting) return;

      // One-shot: remove this listener after first capture
      proc.off("output", onOutput);

      try {
        const binding = proc.getRuntimeBinding();
        const captured = captureManagedSessionForProvider(instance.info.provider, {
          proc,
          binding,
          fallbackSessionId:
            (isSdk && (proc as ClaudeSdkSession).sessionId) ||
            binding.providerSessionId ||
            instance.providerBinding?.providerSessionId ||
            instance.sessionId,
          workingDirectory: instance.actualCwd || instance.info.workingDirectory,
          providerDirs: this.providerDirs,
        });
        if (!captured?.sessionId) return;

        this.finalizeSessionCapture(
          id,
          instance,
          proc,
          captured.sessionId,
          captured.transcriptPath,
        );
      } catch (err) {
        this.baseConfig.logger.debug(
          `[InstanceManager] Failed to capture ${instance.info.provider} session ID for "${instance.info.name}": ${err}`,
        );
      }
    };

    proc.on("output", onOutput);
  }

  private finalizeSessionCapture(
    id: string,
    instance: Instance,
    proc: ProviderSession,
    sessionId: string,
    jsonlPath?: string,
  ): void {
    instance.sessionId = sessionId;
    instance.jsonlPath = jsonlPath;
    instance.info.sessionId = sessionId;
    instance.providerBinding = {
      ...(instance.providerBinding ?? proc.getRuntimeBinding()),
      provider: instance.info.provider,
      providerSessionId: sessionId,
      resumeCursor: { sessionId },
      transcriptPath: jsonlPath,
      runtimePayload: {
        ...((instance.providerBinding ?? proc.getRuntimeBinding()).runtimePayload ?? {}),
        sessionContext: instance.info.sessionContext,
      },
      runtimeMode: instance.info.runtimeMode ?? this.baseConfig.defaultRuntimeMode,
    };

    // Feed session ID back to the CLI process so subsequent sends use
    // --resume <id> instead of --continue (which can pick up the wrong session).
    proc.setSessionId?.(sessionId);

    // Start JSONL watching so terminal-side changes are picked up.
    if (jsonlPath && instance.watchState?.jsonlPath !== jsonlPath) {
      const oldInterval = this.watchIntervals.get(id);
      if (oldInterval) {
        clearInterval(oldInterval);
        this.watchIntervals.delete(id);
      }
      try {
        instance.watchState = createWatchState(
          jsonlPath,
          statSync(jsonlPath).size,
          instance.info.stats,
        );
        this.startWatching(id, instance);
      } catch {
        // ignore — file may have been removed between checks
      }
    }

    this.removeLiveExternalShadow(
      id,
      sessionId,
      jsonlPath ?? instance.providerBinding?.transcriptPath ?? instance.jsonlPath,
    );

    this.dbSave(instance);

    this.baseConfig.logger.debug(
      `[InstanceManager] Captured session ID "${sessionId}" for instance "${instance.info.name}"`,
    );
  }

  private removeLiveExternalShadow(
    managedInstanceId: string,
    providerSessionId?: string,
    transcriptPath?: string,
  ): void {
    if (!providerSessionId && !transcriptPath) {
      return;
    }

    for (const [instanceId, candidate] of this.instances) {
      if (instanceId === managedInstanceId || !candidate.info.external) {
        continue;
      }

      const candidateBinding = candidate.providerBinding ?? candidate.process?.getRuntimeBinding();
      const candidateSessionId =
        candidateBinding?.providerSessionId ?? candidate.sessionId ?? candidate.info.sessionId;
      const candidateTranscriptPath =
        candidateBinding?.transcriptPath ??
        candidate.externalState?.jsonlPath ??
        candidate.jsonlPath;
      const sessionMatch = providerSessionId && candidateSessionId === providerSessionId;
      const transcriptMatch = transcriptPath && candidateTranscriptPath === transcriptPath;

      if (!sessionMatch && !transcriptMatch) {
        continue;
      }

      const watchInterval = this.watchIntervals.get(instanceId);
      if (watchInterval) {
        clearInterval(watchInterval);
        this.watchIntervals.delete(instanceId);
      }
      this.staleCounts.delete(instanceId);
      this.instances.delete(instanceId);

      if (candidate.sessionId) {
        this.db.archive(candidate.sessionId);
      }

      this.emit("instance:removed", instanceId);
      this.baseConfig.logger.info(
        `[InstanceManager] Removed live external shadow ${instanceId} for managed instance ${managedInstanceId}`,
      );
    }
  }

  // ===========================================================================
  // Internal helpers
  // ===========================================================================

  /**
   * Try to find a good title for an external session:
   * 1. Check sessions-index.json for a summary
   * 2. Fall back to first user message
   */
  private resolveSessionTitle(
    sessionId: string,
    cwd: string,
    history: HistoryEntry[],
    provider?: ProviderKind,
  ): string | null {
    // Try sessions-index.json summary
    const summary = this.getSessionSummary(sessionId, cwd);
    if (summary) return summary;

    // Fall back to first user message
    for (const h of history) {
      if (h.message.type === "user" && (h.message as UserMessage).text) {
        return generateTitle((h.message as UserMessage).text, provider);
      }
    }

    return null;
  }

  /**
   * Look up the summary for a session from sessions-index.json.
   */
  private getSessionSummary(sessionId: string, cwd: string): string | null {
    const encoded = cwd.replace(/[^A-Za-z0-9_-]/g, "-");
    const indexPath = join(this.providerDirs.claude, "projects", encoded, "sessions-index.json");
    try {
      const indexData = JSON.parse(readFileSync(indexPath, "utf-8"));
      if (indexData.entries && Array.isArray(indexData.entries)) {
        const entry = indexData.entries.find(
          (e: { sessionId?: string }) => e.sessionId === sessionId,
        );
        if (entry?.summary) return sanitiseForTitle(entry.summary) || entry.summary;
      }
    } catch {
      // no index or parse error
    }
    return null;
  }

  async renameInstance(id: string, name: string): Promise<boolean> {
    return this.enqueueInstanceMutation(id, async (instance) => {
      const trimmed = name.trim();
      if (!trimmed) return false;

      instance.info.name = trimmed;
      instance.info.customTitle = true;
      this.emitInstanceStatus(instance);
      this.dbSave(instance);
      const sid = instance.sessionId || instance.info.sessionId;
      if (sid) this.db.updateName(sid, trimmed, true);
      return true;
    }).catch((err) => {
      if (this.isInstanceNotFoundError(err)) return false;
      throw err;
    });
  }

  /**
   * Pin or unpin a chat so it sorts to the top of its project's chat lists.
   * Works for chats without a live in-memory instance (stopped/historical
   * sessions that only exist as DB rows) — the pin is written straight to the
   * session tables, and the live instance info is updated when present.
   */
  async setInstancePinned(id: string, pinned: boolean): Promise<boolean> {
    const persisted = this.db.setPinned(id, pinned);
    const updatedLive = await this.enqueueInstanceMutation(id, async (instance) => {
      instance.info.pinned = pinned;
      this.emitInstanceStatus(instance);
      return true;
    }).catch((err) => {
      if (this.isInstanceNotFoundError(err)) return false;
      throw err;
    });
    return persisted || updatedLive;
  }

  /**
   * Mark a chat done (or clear the marker). Like pinning, this works for chats
   * with no live instance, so the write goes straight to the session tables.
   *
   * `doneAt` is a timestamp, not a flag: consumers treat a chat as done only
   * while its recency is at or below the marker, so any later activity revives
   * it without the server having to detect and clear anything.
   */
  async setInstanceDone(id: string, done: boolean): Promise<boolean> {
    const doneAt = done ? Date.now() : null;
    const persisted = this.db.setDone(id, doneAt);
    const updatedLive = await this.enqueueInstanceMutation(id, async (instance) => {
      instance.info.doneAt = doneAt ?? undefined;
      this.emitInstanceStatus(instance);
      return true;
    }).catch((err) => {
      if (this.isInstanceNotFoundError(err)) return false;
      throw err;
    });
    return persisted || updatedLive;
  }

  /**
   * Bulk variant of {@link setInstanceDone} for sweeping a backlog of stale
   * chats in one go. Returns how many chats were updated.
   *
   * All of them get the *same* `doneAt` — the sweep's timestamp, never each
   * chat's own last activity: a chat reads as done only while its recency is at
   * or below the marker, and recency can come from a transcript message that is
   * newer than the row's `last_activity_at`, so stamping anything older than
   * "now" would leave some of the swept chats still showing as not done.
   *
   * Emits one `instances:changed` rather than a status message per chat — a
   * sweep touches hundreds of rows, and that many broadcasts would stall the UI.
   */
  setInstancesDone(ids: readonly string[], done: boolean): number {
    const doneAt = done ? Date.now() : null;
    const unique = [...new Set(ids)];
    const updated = new Set(this.db.setDoneBulk(unique, doneAt));

    // Live instances win over the DB summaries in the UI's merge, so they have
    // to be updated in memory too or swept chats would come back on refresh.
    for (const id of unique) {
      const instance = this.instances.get(id);
      if (!instance) continue;
      instance.info.doneAt = doneAt ?? undefined;
      updated.add(id);
    }
    if (updated.size > 0) this.emit("instances:changed");
    return updated.size;
  }

  /**
   * Set the preferred model for a managed instance.
   * The model is applied on the next message send via --model <id>.
   * Pass null to clear the preference (reverts to Claude's default).
   */
  async setModel(id: string, model: string | null): Promise<boolean> {
    return this.enqueueInstanceMutation(id, async (instance) => {
      if (instance.info.external) return false;

      instance.info.preferredModel = model ?? undefined;
      // When clearing to "Default", resolve the catalog default so the SDK
      // doesn't silently fall back to its own internal default (e.g. Sonnet).
      const effectiveModel = this.resolveEffectiveModel(instance);
      instance.process?.setModel(effectiveModel);
      // NB: the model_switched divider is intentionally NOT recorded here.
      // Switching in the UI without sending a message has no effect on the
      // conversation, so the divider is emitted at message-dispatch time
      // (recordModelSwitchOnDispatch) only when the model actually differs
      // from the previous turn's — pre-send toggling produces no noise.
      this.emitInstanceStatus(instance);
      this.dbSave(instance);
      const sid = instance.sessionId || instance.info.sessionId;
      if (sid) this.db.updatePreferredModel(sid, model);
      return true;
    }).catch((err) => {
      if (this.isInstanceNotFoundError(err)) return false;
      throw err;
    });
  }

  /**
   * Resolve the effective model id for an instance — the explicit preference,
   * or the provider's catalog default when cleared to "Default" (so we compare
   * against a concrete id rather than undefined).
   */
  private resolveEffectiveModel(instance: Instance): string | null {
    return (
      instance.info.preferredModel ??
      BUILTIN_PROVIDER_MODELS[instance.info.provider].find((x) => x.isDefault)?.id ??
      null
    );
  }

  /**
   * At user-message dispatch, emit a `model_switched` divider iff the resolved
   * model differs from the one the previous turn ran under. This is the only
   * place the divider is recorded: switching in the UI is a no-op until a
   * message is actually sent, and switching back and forth before sending nets
   * to nothing. The first turn establishes the baseline without a divider.
   *
   * The event is a Relay-level system event — provider transcripts never
   * contain it, so it is persisted to session_events and re-merged into history
   * by mergeSessionEvents() on every hydrate. Must be called BEFORE the user
   * message is pushed to history so the divider sits above the turn it labels.
   */
  private recordModelSwitchOnDispatch(instance: Instance): void {
    const current = this.resolveEffectiveModel(instance);
    const previous = instance.lastTurnModel;
    instance.lastTurnModel = current ?? undefined;

    // No baseline yet (first turn), unresolved model, or unchanged → nothing.
    if (!previous || !current || previous === current) return;

    const labelFor = (m: string) =>
      BUILTIN_PROVIDER_MODELS[instance.info.provider].find((x) => x.id === m)?.label;
    const message: SystemEventMessage = {
      type: "system_event",
      event: "model_switched",
      instanceId: instance.info.id,
      payload: {
        fromModel: previous,
        toModel: current,
        fromModelLabel: labelFor(previous),
        toModelLabel: labelFor(current),
      },
    };
    this.pushHistory(instance, message);
    this.db.insertSessionEvent(
      instance.info.id,
      Date.now(),
      "model_switched",
      JSON.stringify(message.payload),
    );
    this.emit("instance:system_event", instance.info.id, message);
  }

  /**
   * Sparse-merge model options on a managed instance.
   * Omitted keys are left unchanged; null clears/resets a field.
   */
  async setModelOptions(
    id: string,
    patch: {
      reasoningEffort?: string | null;
      fastMode?: boolean | null;
    },
  ): Promise<boolean> {
    return this.enqueueInstanceMutation(id, async (instance) => {
      if (instance.info.external) return false;

      const current = instance.info.modelOptions ?? {};
      const next: ProviderModelOptions = { ...current };

      if ("reasoningEffort" in patch) {
        next.reasoningEffort = patch.reasoningEffort ?? undefined;
      }
      if ("fastMode" in patch) {
        next.fastMode = patch.fastMode ?? undefined;
      }

      const isEmpty = next.reasoningEffort == null && next.fastMode == null;
      instance.info.modelOptions = isEmpty ? undefined : next;

      if (instance.process?.setModelOptions) {
        instance.process.setModelOptions(isEmpty ? {} : next);
      }

      this.emitInstanceStatus(instance);
      this.dbSave(instance);
      return true;
    }).catch((err) => {
      if (this.isInstanceNotFoundError(err)) return false;
      throw err;
    });
  }

  async setRuntimeMode(id: string, mode: ProviderRuntimeMode): Promise<boolean> {
    return this.enqueueInstanceMutation(id, async (instance) => {
      if (instance.info.external || !instance.process) return false;
      if (!getProviderCapabilities(instance.info.provider).runtimeModes?.[mode]) return false;

      instance.info.runtimeMode = mode;
      instance.process.setRuntimeMode(mode);

      // When switching to full-access while a permission prompt is pending,
      // the prompt becomes irrelevant — the provider auto-approves now.
      if (mode === "full-access" && instance.info.pendingPermission) {
        instance.info.pendingPermission = undefined;
      }

      this.emitInstanceStatus(instance);
      this.dbSave(instance);
      return true;
    }).catch((err) => {
      if (this.isInstanceNotFoundError(err)) return false;
      throw err;
    });
  }

  async setReviewInstance(id: string, reviewInstanceId: string): Promise<boolean> {
    return this.enqueueInstanceMutation(id, async (instance) => {
      const reviewInstance = this.instances.get(reviewInstanceId);
      if (!reviewInstance) return false;
      if (!reviewBelongsToSource(instance.info, reviewInstance.info)) return false;

      instance.info.reviewInstanceId = reviewInstanceId;
      this.emitInstanceStatus(instance);
      this.dbSave(instance);
      return true;
    }).catch((err) => {
      if (this.isInstanceNotFoundError(err)) return false;
      throw err;
    });
  }

  /**
   * Switch the provider on an instance that has not yet sent a message.
   * Tears down the current process and creates a new one for the target provider.
   * Returns false if the instance already has a session (message was sent).
   */
  async setProvider(id: string, provider: ProviderKind): Promise<boolean> {
    return this.enqueueInstanceMutation(id, async (instance) => {
      if (instance.info.external) return false;
      if (!this.isProviderAvailable(provider)) return false;
      if (instance.sessionId || instance.info.sessionId) return false;
      if (instance.info.provider === provider) return true;

      const globalSettings = this.db.getGlobalSettings();
      let providerDefaults: Record<
        string,
        {
          model?: string;
          reasoningEffort?: string;
          fastMode?: boolean;
        }
      > = {};
      if (globalSettings.provider_defaults_json) {
        try {
          providerDefaults = JSON.parse(globalSettings.provider_defaults_json);
        } catch {}
      }
      const perProvider = providerDefaults[provider];
      const preferredModel = perProvider?.model;
      let modelOptions: ProviderModelOptions | undefined = perProvider?.reasoningEffort
        ? { reasoningEffort: perProvider.reasoningEffort as ReasoningEffort }
        : undefined;
      if (perProvider?.fastMode != null) {
        modelOptions = { ...modelOptions, fastMode: perProvider.fastMode };
      }

      const previousProcess = instance.process;
      instance.process = null;
      if (previousProcess) {
        await Promise.resolve(previousProcess.close());
      }

      instance.info.preferredModel = preferredModel;
      instance.info.modelOptions = modelOptions;
      instance.info.provider = provider;

      const instanceConfig: CoreConfig = {
        ...this.baseConfig,
        workingDirectory: instance.actualCwd || instance.info.workingDirectory,
        defaultRuntimeMode: instance.info.runtimeMode ?? this.baseConfig.defaultRuntimeMode,
      };

      const proc = this.createProviderSession(instanceConfig, {
        provider,
        runtimeMode: instance.info.runtimeMode,
        model:
          preferredModel ??
          (provider === "claude" && getSdkDiscoveredModels()?.length
            ? undefined
            : resolveProviderDefaultModelOption(
                provider,
                provider === "codex" ? (getCachedCodexModels() ?? undefined) : undefined,
              )?.id),
        modelOptions,
      });
      instance.process = proc;
      instance.providerBinding = mergeProviderBinding(
        instance.providerBinding,
        proc.getRuntimeBinding(),
      );

      this.wireProcessEvents(id, proc);
      this.captureSessionId(id, instance, proc);

      this.emitInstanceStatus(instance);
      this.dbSave(instance);
      this.baseConfig.logger.info(
        `[InstanceManager] Switched instance ${id} to provider "${provider}"`,
      );
      return true;
    }).catch((err) => {
      if (this.isInstanceNotFoundError(err)) return false;
      throw err;
    });
  }

  private doRefreshTitle(instance: Instance): boolean {
    if (instance.info.customTitle) return false;

    const sessionId = instance.sessionId || instance.info.sessionId;
    if (!sessionId) return false;

    // Best source: sessions-index.json summary (generated by Claude CLI)
    const summary = this.getSessionSummary(sessionId, instance.info.workingDirectory);
    if (summary && summary !== instance.info.name) {
      instance.info.name = summary;
      this.emitInstanceStatus(instance);
      this.dbSave(instance);
      if (sessionId) this.db.updateName(sessionId, summary, false);
      return true;
    }

    // Fallback: scan history backwards for a substantive user message
    // (skip trivial messages like "ok", "done", "commit this", etc.)
    for (let i = instance.history.length - 1; i >= 0; i--) {
      const msg = instance.history[i].message;
      if (msg.type === "transcript") continue;
      if (msg.type === "user" && (msg as UserMessage).text && !(msg as UserMessage).internal) {
        const text = (msg as UserMessage).text;
        if (isTrivialMessage(text)) continue;
        const title = generateTitle(text);
        if (title && title !== instance.info.name) {
          instance.info.name = title;
          this.emitInstanceStatus(instance);
          this.dbSave(instance);
          const sid = instance.sessionId || instance.info.sessionId;
          if (sid) this.db.updateName(sid, title, false);
          return true;
        }
        break;
      }
    }

    return false;
  }

  private checkWorktreeChanges(instance: Instance): void {
    if (!instance.worktreePath || !instance.originalDirectory) return;
    instance.info.hasChanges = hasWorktreeChanges(
      instance.worktreePath,
      instance.originalDirectory,
    );
  }

  private setStatus(instance: Instance, status: InstanceStatus): void {
    if (instance.info.status === status) return;
    instance.info.status = status;
    this.emitInstanceStatus(instance);
  }

  private pushHistory(instance: Instance, message: ServerMessage): void {
    const now = Date.now();
    // Preserve raw on the HistoryEntry for debug/context display.
    // We keep raw on the message too so it flows to clients over WS.
    const msgAny = message as unknown as Record<string, unknown>;
    const raw = msgAny.raw;

    // Coalesce consecutive streaming output deltas that share the same provider
    // itemId into a single history entry. Without this, Codex (which emits one
    // OutputMessage per delta chunk) would fill MAX_HISTORY with fragments of a
    // single assistant turn and evict earlier turns from memory.
    if (
      message.type === "output" &&
      !(message as OutputMessage).isWaiting &&
      !(message as OutputMessage).thinking &&
      raw !== null &&
      typeof raw === "object"
    ) {
      const itemId = (raw as Record<string, unknown>).itemId;
      if (typeof itemId === "string") {
        const last = instance.history[instance.history.length - 1];
        if (
          last &&
          last.message.type === "output" &&
          last.raw !== null &&
          typeof last.raw === "object" &&
          (last.raw as Record<string, unknown>).itemId === itemId
        ) {
          // Append delta text to existing entry in-place.
          const lastOut = last.message as OutputMessage;
          lastOut.text = (lastOut.text ?? "") + ((message as OutputMessage).text ?? "");
          last.timestamp = now;
          if (lastOut.text.trim()) {
            instance.info.lastMessage = { text: lastOut.text, from: "assistant", timestamp: now };
          }
          return;
        }
      }
    }

    const entry: HistoryEntry = { timestamp: now, message };
    if (raw !== undefined) entry.raw = raw;
    instance.history.push(entry);
    if (instance.history.length > MAX_HISTORY) {
      instance.history = instance.history.slice(-MAX_HISTORY);
    }

    // Track last meaningful message for dashboard preview (skip transcripts + internal)
    if (message.type === "transcript") return;
    if (
      message.type === "user" &&
      (message as UserMessage).text &&
      !(message as UserMessage).internal
    ) {
      instance.info.lastMessage = {
        text: (message as UserMessage).text,
        from: "user",
        timestamp: now,
      };
    } else if (message.type === "output") {
      const output = message as OutputMessage;
      if (output.text && output.text.trim() && !output.isWaiting) {
        instance.info.lastMessage = {
          text: output.text,
          from: "assistant",
          timestamp: now,
        };
      }
    }
  }
}
