import { useCallback, useReducer, useRef } from "react";
import type {
  ServerMessage,
  ActivityMessage,
  AgentInfo,
  HistoryEntry,
  MessageAuthor,
  OutputMessage,
  TaskItem,
  FileChange,
  SystemEventMessage,
  InstanceStatus,
  UserMessage,
} from "@shared/types";
import type { ChatItem, LiveActivity, MergedActivity } from "@/lib/chat-types";
import { classifyLargeUserText } from "@/lib/message-rendering";
import { hasAnchorInItems, isMainStreamAgent } from "@/lib/agents";
import { mergeAgentInfo } from "@shared/agent-info";
import { INTERACTIVE_TOOLS } from "@shared/tools";

// Re-export for consumers
export type { ChatItem, LiveActivity };

/** Merge incoming file list into the existing accumulated list.
 *  Later entries for the same path win (updated editCount, type, stats). */
function mergeFileLists(existing: FileChange[] | null, incoming: FileChange[]): FileChange[] {
  const map = new Map<string, FileChange>();
  if (existing) {
    for (const f of existing) map.set(f.path, f);
  }
  for (const f of incoming) map.set(f.path, f);
  return Array.from(map.values());
}

const IMAGE_ONLY_PATTERN = /^\s*(\[Image: source: [^\]]+\]\s*)+$/;
const GENERIC_LIVE_STRIP_TOOLS = new Set(["Edit", "Write", "Read", "Grep", "Glob"]);

function isImageOnly(text: string): boolean {
  return IMAGE_ONLY_PATTERN.test(text);
}

function buildLiveActivity(
  update: Omit<LiveActivity, "startedAt">,
  previous?: LiveActivity | null,
): LiveActivity {
  const shouldPreserveStart =
    previous &&
    previous.phase === update.phase &&
    previous.presentation === update.presentation &&
    previous.tool === update.tool &&
    previous.description === update.description;
  return {
    ...update,
    startedAt: shouldPreserveStart ? previous.startedAt : Date.now(),
  };
}

function classifyActivityForStrip(message: ActivityMessage): Omit<LiveActivity, "startedAt"> {
  if (message.activity === "task_list") {
    return {
      phase: "task_list",
      presentation: "generic",
      description: "Updating tasks...",
    };
  }
  if (message.activity === "file_list") {
    return {
      phase: "file_list",
      presentation: "generic",
      description: "Writing files...",
    };
  }
  if (message.activity === "thinking") {
    return {
      phase: "thinking",
      presentation: "generic",
      description: "Thinking...",
    };
  }

  const tool = message.tool;
  const genericTool =
    message.activity === "tool_use" && (tool ? GENERIC_LIVE_STRIP_TOOLS.has(tool) : false);
  return {
    phase: "tool",
    presentation: genericTool ? "generic" : "detailed",
    description: message.description || tool || "Working...",
    tool,
  };
}

function mergeToolResult(activities: MergedActivity[], result: ActivityMessage): boolean {
  // Permission denials stay as separate entries — they have their own UI
  if (result.permissionDenied) return false;
  // Interactive tool resolutions stay separate — handled by resolvedInteractive logic
  if (result.resolution) return false;

  const status = result.description === "Tool error" ? "error" : "success";

  // IDs are authoritative: parallel calls can finish in any order. Never attach
  // an identified result to a different call just because it is more recent.
  const index = result.toolUseId
    ? activities.findIndex(
        (act) => act.activity === "tool_use" && act.toolUseId === result.toolUseId,
      )
    : activities.findIndex(
        (act) =>
          act.activity === "tool_use" &&
          !!act.input &&
          !act.mergedResultStatus &&
          (!result.tool || act.tool === result.tool) &&
          !INTERACTIVE_TOOLS.has(act.tool || ""),
      );
  // Legacy events without IDs use the oldest unmatched call (provider emission
  // order). They must never overwrite an already paired result.
  if (index >= 0) {
    activities[index] = {
      ...activities[index],
      mergedResultDetail: result.detail,
      mergedResultStatus: status,
      toolResultMeta: result.toolResultMeta,
    };
    return true;
  }
  return false;
}

/**
 * Merge a tool_result into an already-flushed item list: scan backwards past
 * assistant/thinking rows to the nearest activity group(s). Returns true when
 * the result was placed (merged into its call, or appended as a standalone
 * permission-denied / interactive entry).
 */
function mergeToolResultIntoItems(items: ChatItem[], msg: ActivityMessage): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "activity-group") {
      const acts = [...item.activities];
      if (mergeToolResult(acts, msg)) {
        items[i] = { kind: "activity-group", activities: acts };
        return true;
      }
      if (msg.toolUseId && !msg.permissionDenied && !msg.resolution) {
        continue;
      }
      // Permission denied / interactive — append as separate entry in the group
      items[i] = { kind: "activity-group", activities: [...item.activities, msg] };
      return true;
    }
    // Only skip past assistant and thinking items
    if (item.kind !== "assistant" && item.kind !== "thinking-block") break;
  }
  return false;
}

function buildModelSwitchItem(
  payload: Record<string, unknown> | undefined,
  timestamp?: number,
): Extract<ChatItem, { kind: "model-switch" }> {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    kind: "model-switch",
    fromModel: str(payload?.fromModel),
    toModel: str(payload?.toModel),
    fromModelLabel: str(payload?.fromModelLabel),
    toModelLabel: str(payload?.toModelLabel),
    timestamp,
  };
}

function buildUserChatItem(
  text: string,
  timestamp?: number,
  queued?: boolean,
  queuedMeta?: {
    queuedId?: string;
    queuedSourceText?: string;
    queuedImages?: string[];
    queuedAttachments?: string[];
  },
): Extract<ChatItem, { kind: "user" }> {
  return {
    kind: "user",
    text,
    timestamp,
    queued,
    ...queuedMeta,
    renderMode: classifyLargeUserText(text),
  };
}

function buildAgentNoteItem(
  text: string,
  author: MessageAuthor,
  timestamp?: number,
): Extract<ChatItem, { kind: "agent-note" }> {
  return {
    kind: "agent-note",
    text,
    name: author.name,
    agentId: author.agentId,
    timestamp,
  };
}

// ── Per-stream append helpers (live) ─────────────────────────────────
// Each takes an item list and returns a new list. They are shared by the main
// stream and every nested agent stream so attributed messages accumulate with
// exactly the same rules (activity grouping, tool-result pairing by id, output
// concatenation) without ever touching the main list.

function appendThinkingItem(items: ChatItem[], text: string): ChatItem[] {
  return [...items, { kind: "thinking-block", text }];
}

/**
 * Append streamed assistant text. Returns `null` when the chunk is a duplicate
 * of the tail of the current assistant message (JSONL watcher re-emits).
 */
function appendOutputText(items: ChatItem[], text: string, now: number): ChatItem[] | null {
  const next = [...items];
  const lastIdx = next.length - 1;
  if (lastIdx >= 0 && next[lastIdx].kind === "assistant") {
    const prev = next[lastIdx] as { kind: "assistant"; text: string; timestamp?: number };
    if (prev.text.endsWith(text)) return null;
    next[lastIdx] = {
      kind: "assistant",
      text: prev.text + text,
      timestamp: prev.timestamp,
    };
  } else {
    next.push({ kind: "assistant", text, timestamp: now });
  }
  return next;
}

/** Append a non-list activity (tool_use, tool_result, thinking) to a stream. */
function appendActivityItem(items: ChatItem[], msg: ActivityMessage): ChatItem[] {
  const next = [...items];
  if (msg.activity === "thinking") {
    next.push({ kind: "thinking-block", text: msg.detail || "" });
    return next;
  }
  if (msg.activity === "tool_result") {
    // The tool_use might be in the last activity group, or in an earlier group
    // (if assistant text streamed between use and result).
    if (!mergeToolResultIntoItems(next, msg)) {
      // No activity group found — create one (shouldn't normally happen)
      next.push({ kind: "activity-group", activities: [msg] });
    }
    return next;
  }
  // tool_use or other non-result activity — append to current group or create new
  const lastIdx = next.length - 1;
  if (lastIdx >= 0 && next[lastIdx].kind === "activity-group") {
    const group = next[lastIdx] as { kind: "activity-group"; activities: MergedActivity[] };
    next[lastIdx] = { kind: "activity-group", activities: [...group.activities, msg] };
  } else {
    next.push({ kind: "activity-group", activities: [msg] });
  }
  return next;
}

// ── Replay stream accumulator ────────────────────────────────────────

interface ReplayStream {
  output(msg: OutputMessage, timestamp?: number): void;
  user(msg: UserMessage, timestamp?: number): void;
  activity(msg: ActivityMessage): void;
  /** Flush pending text/activities and push a standalone item. */
  push(item: ChatItem): void;
  /**
   * Flush pending text/activities without pushing anything. A process exit
   * (clean or not) ends whatever was streaming; without this, a restarted
   * session's first response would be glued onto the interrupted one.
   */
  flush(): void;
  /** Whether a tool_use with this id has been seen (flushed or pending). */
  hasToolUse(toolUseId: string): boolean;
  finish(): ChatItem[];
}

/**
 * One conversation stream during replay. The main stream and each agent's
 * nested transcript get their own instance so pending assistant text and
 * activity groups can never bleed between them.
 */
function createReplayStream(): ReplayStream {
  const items: ChatItem[] = [];
  let assistantText = "";
  let assistantTimestamp: number | undefined;
  let assistantAborted: boolean | undefined;
  let currentActivities: MergedActivity[] = [];

  const flushActivities = () => {
    if (currentActivities.length > 0) {
      items.push({ kind: "activity-group", activities: [...currentActivities] });
      currentActivities = [];
    }
  };

  const flushAssistant = (aborted?: boolean) => {
    if (assistantText) {
      items.push({
        kind: "assistant",
        text: assistantText,
        timestamp: assistantTimestamp,
        aborted: aborted || assistantAborted || undefined,
      });
      assistantText = "";
      assistantTimestamp = undefined;
      assistantAborted = undefined;
    }
  };

  return {
    output(msg, timestamp) {
      if (msg.thinking) {
        items.push({ kind: "thinking-block", text: msg.thinking });
      } else if (msg.text && msg.text.trim()) {
        if (!assistantText.endsWith(msg.text)) {
          flushActivities();
          if (!assistantText) assistantTimestamp = timestamp;
          assistantText += msg.text;
        }
      }
      if (msg.isWaiting) {
        flushActivities();
        if (msg.modelTimestamp && assistantText) assistantTimestamp = msg.modelTimestamp;
        flushAssistant(msg.aborted);
      }
    },
    user(msg, timestamp) {
      flushActivities();
      flushAssistant();
      const lastItem = items[items.length - 1];
      if (
        isImageOnly(msg.text) &&
        !msg.queued &&
        lastItem?.kind === "user" &&
        !lastItem.queued &&
        lastItem.timestamp &&
        timestamp &&
        Math.abs(timestamp - lastItem.timestamp) < 60_000
      ) {
        items[items.length - 1] = {
          ...lastItem,
          text: lastItem.text + "\n" + msg.text,
        };
      } else {
        items.push(
          buildUserChatItem(msg.text, timestamp, msg.queued, {
            queuedId: msg.queuedId,
            queuedSourceText: msg.queuedSourceText,
            queuedImages: msg.queued ? msg.images : undefined,
            queuedAttachments: msg.queued ? msg.attachments : undefined,
          }),
        );
      }
    },
    activity(msg) {
      if (msg.activity === "task_list" && msg.tasks) {
        // skip — task lists don't produce chat items
      } else if (msg.activity === "file_list" && msg.files) {
        // skip — file lists don't produce chat items
      } else if (msg.activity === "thinking") {
        flushAssistant();
        flushActivities();
        items.push({ kind: "thinking-block", text: msg.detail || "" });
      } else if (msg.activity === "tool_result") {
        // Merge result into the matching tool_use
        flushAssistant();
        if (!mergeToolResult(currentActivities, msg)) {
          // Couldn't merge into unflushed activities — scan backwards through
          // flushed items (past assistant/thinking rows) to find the activity group.
          if (!mergeToolResultIntoItems(items, msg)) {
            currentActivities.push(msg);
          }
        }
      } else {
        flushAssistant();
        currentActivities.push(msg);
      }
    },
    push(item) {
      flushActivities();
      flushAssistant();
      items.push(item);
    },
    flush() {
      flushActivities();
      flushAssistant();
    },
    hasToolUse(toolUseId) {
      if (
        currentActivities.some((act) => act.activity === "tool_use" && act.toolUseId === toolUseId)
      ) {
        return true;
      }
      return hasAnchorInItems(items, toolUseId);
    },
    finish() {
      flushActivities();
      flushAssistant();
      return items;
    },
  };
}

export interface ReplayResult {
  /** Main conversation (never contains agent-attributed messages). */
  items: ChatItem[];
  /** Delegated agents keyed by Relay agent key, after sparse upsert of every `agent_update`. */
  agents: Record<string, AgentInfo>;
  /** Nested transcripts keyed by Relay agent key. */
  agentItems: Record<string, ChatItem[]>;
}

/**
 * Process raw history entries into the main `ChatItem[]` plus delegated-agent
 * state. Messages carrying `agentId` are routed to that agent's nested stream
 * and never enter `items`; `agent_update`s upsert `agents` and, on first
 * sighting without a visible origin tool_use, insert an `agent-card` item.
 */
export function replayHistory(history: HistoryEntry[]): ReplayResult {
  const main = createReplayStream();
  const agentStreams = new Map<string, ReplayStream>();
  const agents: Record<string, AgentInfo> = {};
  const streamFor = (agentId: string): ReplayStream => {
    let stream = agentStreams.get(agentId);
    if (!stream) {
      stream = createReplayStream();
      agentStreams.set(agentId, stream);
    }
    return stream;
  };
  // Nested delegation (a provider-declared parent, or an origin tool_use that
  // lives in another agent's transcript) renders inside the parent's detail
  // view and never gets a main-stream card — see `isMainStreamAgent`.
  const isNested = (agent: AgentInfo): boolean => {
    if (agent.parentAgentId) return true;
    const origin = agent.originToolUseId;
    if (!origin) return false;
    for (const stream of agentStreams.values()) {
      if (stream.hasToolUse(origin)) return true;
    }
    return false;
  };

  for (const entry of history) {
    const msg = entry.message;
    switch (msg.type) {
      case "output":
        if (msg.agentId) {
          streamFor(msg.agentId).output(msg, entry.timestamp);
          break;
        }
        main.output(msg, entry.timestamp);
        break;
      case "user": {
        if (msg.internal) break;
        if (msg.agentId) {
          streamFor(msg.agentId).user(msg, entry.timestamp);
          break;
        }
        if (msg.author?.kind === "agent") {
          main.push(buildAgentNoteItem(msg.text, msg.author, entry.timestamp));
          break;
        }
        main.user(msg, entry.timestamp);
        break;
      }
      case "activity":
        if (msg.agentId) {
          streamFor(msg.agentId).activity(msg);
          break;
        }
        main.activity(msg);
        break;
      case "agent_update": {
        const id = msg.agent.agentId;
        const previous = agents[id];
        agents[id] = mergeAgentInfo(previous, msg.agent);
        if (!previous && !isNested(msg.agent)) {
          const origin = msg.agent.originToolUseId;
          if (!origin || !main.hasToolUse(origin)) {
            main.push({ kind: "agent-card", agentId: id, timestamp: entry.timestamp });
          }
        }
        break;
      }
      case "system_event": {
        if (msg.event === "compact_boundary") {
          main.push({ kind: "compact-boundary", timestamp: entry.timestamp });
        } else if (msg.event === "model_switched") {
          main.push(buildModelSwitchItem(msg.payload, entry.timestamp));
        }
        break;
      }
      case "exit":
        // Any exit ends the in-flight response, clean or not.
        main.flush();
        if (msg.code !== 0) {
          let text = msg.signal
            ? `Chat process killed by ${msg.signal}`
            : `Chat process exited with code ${msg.code}`;
          if (msg.stderr) text += `\n${msg.stderr}`;
          main.push({ kind: "system", text, isError: true });
        }
        break;
      case "error":
        main.push({ kind: "system", text: `Error: ${msg.message}`, isError: true });
        break;
    }
  }

  const agentItems: Record<string, ChatItem[]> = {};
  for (const [agentId, stream] of agentStreams) {
    agentItems[agentId] = stream.finish();
  }

  return { items: main.finish(), agents, agentItems };
}

/**
 * Process raw history entries into ChatItem[] for display.
 * Extracted so it can be reused outside the hook (e.g. space debug modal).
 */
export function replayHistoryToItems(history: HistoryEntry[]): ChatItem[] {
  return replayHistory(history).items;
}

interface State {
  items: ChatItem[];
  /** Delegated agents keyed by Relay agent key (sparse-upserted from `agent_update`). */
  agents: Record<string, AgentInfo>;
  /**
   * Nested transcripts keyed by Relay agent key. Attributed messages land here,
   * never in `items`. Both maps are replaced (never mutated) on change, so
   * consumers memoize on reference equality.
   */
  agentItems: Record<string, ChatItem[]>;
  hasLoadedHistory: boolean;
  /** True once the active selection has been refreshed from WS replay or REST fallback. */
  hasSyncedHistory: boolean;
  isProcessing: boolean;
  showThinkingIndicator: boolean;
  currentTasks: TaskItem[] | null;
  currentFiles: FileChange[] | null;
  /** Most recent activity for the live status strip */
  lastActivity: LiveActivity | null;
  /** When the current processing turn started (user sent a message) */
  processingStartedAt: number | null;
  /**
   * True once rawHistory has been initialized for this instance. The entries
   * themselves live in an out-of-band mutable buffer (see rawHistoryStore) to
   * avoid O(n) array clones on every live event — the reducer only tracks
   * whether it exists.
   */
  hasRawHistory: boolean;
  /** Last replay cursor seen for this instance */
  lastSeenSequence: number;
  /** Server replay epoch tied to the current buffered event stream */
  replayEpoch?: number;
}

type Action =
  | { type: "reset" }
  | { type: "restore"; cached: State }
  | {
      type: "replay";
      history: HistoryEntry[];
      replayMode?: "full" | "delta";
      latestSequence?: number;
      replayEpoch?: number;
    }
  | {
      type: "output";
      text: string;
      isWaiting: boolean;
      thinking?: string;
      modelTimestamp?: number;
      aborted?: boolean;
      eventSequence?: number;
      /** Delegated-agent attribution — routes to `agentItems[agentId]`. */
      agentId?: string;
    }
  | { type: "activity"; message: ActivityMessage }
  | {
      type: "user";
      text: string;
      internal?: boolean;
      queued?: boolean;
      queuedId?: string;
      queuedSourceText?: string;
      queuedImages?: string[];
      queuedAttachments?: string[];
      eventSequence?: number;
      author?: MessageAuthor;
      /** Delegated-agent attribution — routes to `agentItems[agentId]`. */
      agentId?: string;
    }
  | { type: "agent_update"; agent: AgentInfo; eventSequence?: number }
  | { type: "clear_queued" }
  | { type: "remove_queued"; queuedId: string; eventSequence?: number }
  | { type: "exit"; code: number; signal?: string; stderr?: string; eventSequence?: number }
  | { type: "error"; message: string }
  | { type: "notification"; message: string }
  | { type: "system_event"; message: SystemEventMessage }
  | { type: "reconcile_status"; status: InstanceStatus }
  | { type: "show_thinking" };

// Module-level cache — persists across mounts/unmounts within a page session.
// Switching between sessions restores cached state instantly instead of showing
// a loading spinner while the WS history replay arrives.
const MAX_CACHE_SIZE = 30;

/**
 * Per-instance buffer of raw HistoryEntry objects. Kept outside the reducer
 * `State` so we can append in place (O(1)) instead of cloning the whole array
 * on every live event. React re-renders are still driven by the reducer's
 * state updates that accompany each append, so consumers read a fresh
 * `rawHistory?.length` on every render triggered by a live message.
 *
 * Mutation happens only in `handleMessage`, which runs once per WS message
 * (not inside the reducer), so React strict-mode double-dispatch can't cause
 * duplicate appends.
 */
const rawHistoryStore = new Map<string, HistoryEntry[]>();

const stateCache = new Map<string, State>();

function setCacheEntry(id: string, state: State) {
  // Evict oldest entries when cache exceeds limit. Also drop the matching
  // rawHistory buffer so it doesn't outlive the state snapshot.
  if (stateCache.size >= MAX_CACHE_SIZE && !stateCache.has(id)) {
    const oldest = stateCache.keys().next().value;
    if (oldest) {
      stateCache.delete(oldest);
      rawHistoryStore.delete(oldest);
    }
  }
  stateCache.set(id, state);
}

const EMPTY_STATE: State = {
  items: [],
  agents: {},
  agentItems: {},
  hasLoadedHistory: false,
  hasSyncedHistory: false,
  isProcessing: false,
  showThinkingIndicator: false,
  currentTasks: null,
  currentFiles: null,
  lastActivity: null,
  processingStartedAt: null,
  hasRawHistory: false,
  lastSeenSequence: 0,
  replayEpoch: undefined,
};

function canApplyDeltaReplay(
  state: Pick<State, "hasLoadedHistory" | "hasRawHistory" | "lastSeenSequence" | "replayEpoch">,
  replayMode: "full" | "delta" | undefined,
  replayEpoch: number | undefined,
  latestSequence: number | undefined,
): boolean {
  return (
    replayMode === "delta" &&
    state.hasLoadedHistory &&
    state.hasRawHistory &&
    state.replayEpoch !== undefined &&
    replayEpoch === state.replayEpoch &&
    (latestSequence ?? state.lastSeenSequence) >= state.lastSeenSequence
  );
}

export function primeInstanceMessagesCache(instanceId: string): void {
  rawHistoryStore.set(instanceId, []);
  setCacheEntry(instanceId, {
    ...EMPTY_STATE,
    hasLoadedHistory: true,
    hasSyncedHistory: true,
    hasRawHistory: true,
  });
}

/** Replace one agent's nested stream (new `agentItems` reference). */
function withAgentItems(state: State, agentId: string, items: ChatItem[]): State {
  return {
    ...state,
    agentItems: { ...state.agentItems, [agentId]: items },
  };
}

function coreReducer(state: State, action: Action): State {
  switch (action.type) {
    case "reset":
      return EMPTY_STATE;

    case "restore":
      return {
        ...action.cached,
        // Cached state is renderable, but not authoritative for the newly
        // selected chat until we re-sync via WS replay or REST fallback.
        hasSyncedHistory: false,
      };

    case "replay": {
      const isSafeDelta = canApplyDeltaReplay(
        state,
        action.replayMode,
        action.replayEpoch,
        action.latestSequence,
      );

      if (isSafeDelta) {
        return {
          ...state,
          hasLoadedHistory: true,
          hasSyncedHistory: true,
          replayEpoch: action.replayEpoch ?? state.replayEpoch,
          lastSeenSequence: action.latestSequence ?? state.lastSeenSequence,
        };
      }

      const { items, agents, agentItems } = replayHistory(action.history);

      // Extract latest task/file lists from activity messages
      let currentTasks: TaskItem[] | null = null;
      let currentFiles: FileChange[] | null = null;
      for (const entry of action.history) {
        const msg = entry.message;
        if (msg.type === "activity" && !msg.agentId) {
          if (msg.activity === "task_list" && msg.tasks) currentTasks = msg.tasks;
          else if (msg.activity === "file_list" && msg.files)
            currentFiles = mergeFileLists(currentFiles, msg.files);
        }
      }

      return {
        items,
        agents,
        agentItems,
        hasLoadedHistory: true,
        hasSyncedHistory: true,
        isProcessing: false,
        showThinkingIndicator: false,
        currentTasks,
        currentFiles,
        lastActivity: null,
        processingStartedAt: null,
        hasRawHistory: true,
        replayEpoch: action.replayEpoch,
        lastSeenSequence: action.latestSequence ?? 0,
      };
    }

    case "output": {
      // Attributed output belongs to a child agent's nested transcript. It never
      // touches `items` or the main turn's processing flags — a child's
      // `isWaiting` does not end the orchestrator's turn.
      if (action.agentId) {
        const stream = state.agentItems[action.agentId] ?? [];
        if (action.thinking) {
          return withAgentItems(state, action.agentId, appendThinkingItem(stream, action.thinking));
        }
        if (action.text) {
          const next = appendOutputText(stream, action.text, Date.now());
          if (!next) return state;
          return withAgentItems(state, action.agentId, next);
        }
        return state;
      }

      if (action.thinking) {
        return {
          ...state,
          items: appendThinkingItem(state.items, action.thinking),
          isProcessing: true,
          showThinkingIndicator: true,
          lastActivity: buildLiveActivity(
            {
              phase: "thinking",
              presentation: "generic",
              description: "Thinking...",
            },
            state.lastActivity,
          ),
        };
      }

      if (action.text) {
        // Append to existing assistant message or create new one. Dedup: skip if
        // the incoming text is already at the end of the current message (can
        // happen when JSONL watcher re-emits content after the live stream).
        const appended = appendOutputText(state.items, action.text, Date.now());
        const items = appended ?? state.items;
        if (!appended && !action.isWaiting) return state;

        if (action.isWaiting) {
          return {
            ...state,
            items,
            isProcessing: false,
            showThinkingIndicator: false,
            lastActivity: null,
            processingStartedAt: null,
          };
        }

        return {
          ...state,
          items,
          isProcessing: true,
          showThinkingIndicator: false,
          lastActivity: buildLiveActivity(
            {
              phase: "responding",
              presentation: "generic",
              description: "Responding...",
            },
            state.lastActivity,
          ),
        };
      }

      if (action.isWaiting) {
        return {
          ...state,
          isProcessing: false,
          showThinkingIndicator: false,
          lastActivity: null,
          processingStartedAt: null,
        };
      }

      return { ...state, isProcessing: true };
    }

    case "activity": {
      const msg = action.message;

      // Attributed activity → the agent's nested stream only. Child task/file
      // lists are not surfaced (the sidecar panels describe the main chat).
      if (msg.agentId) {
        if (msg.activity === "task_list" || msg.activity === "file_list") return state;
        const stream = state.agentItems[msg.agentId] ?? [];
        return withAgentItems(state, msg.agentId, appendActivityItem(stream, msg));
      }

      if (msg.activity === "task_list" && msg.tasks) {
        return {
          ...state,
          isProcessing: true,
          showThinkingIndicator: true,
          currentTasks: msg.tasks,
          lastActivity: buildLiveActivity(
            {
              phase: "task_list",
              presentation: "generic",
              description: "Updating tasks...",
            },
            state.lastActivity,
          ),
        };
      } else if (msg.activity === "file_list" && msg.files) {
        return {
          ...state,
          isProcessing: true,
          showThinkingIndicator: true,
          currentFiles: mergeFileLists(state.currentFiles, msg.files),
          lastActivity: buildLiveActivity(
            {
              phase: "file_list",
              presentation: "generic",
              description: "Writing files...",
            },
            state.lastActivity,
          ),
        };
      } else if (msg.activity === "thinking") {
        return {
          ...state,
          items: appendActivityItem(state.items, msg),
          isProcessing: true,
          showThinkingIndicator: true,
          lastActivity: buildLiveActivity(
            {
              phase: "thinking",
              presentation: "generic",
              description: "Thinking...",
            },
            state.lastActivity,
          ),
        };
      } else {
        // Build a contextual description from the activity
        return {
          ...state,
          items: appendActivityItem(state.items, msg),
          isProcessing: true,
          showThinkingIndicator: true,
          lastActivity: buildLiveActivity(classifyActivityForStrip(msg), state.lastActivity),
        };
      }
    }

    case "agent_update": {
      const id = action.agent.agentId;
      const previous = state.agents[id];
      const agents = { ...state.agents, [id]: mergeAgentInfo(previous, action.agent) };
      let items = state.items;
      if (!previous && isMainStreamAgent(action.agent, state.agentItems)) {
        // First sighting: anchored agents render in place of their delegation
        // tool_use; anything else gets one inserted card, keyed by agentId.
        // Nested agents (see `isMainStreamAgent`) render inside their parent's
        // detail instead and never get a main-stream card.
        const origin = action.agent.originToolUseId;
        if (!origin || !hasAnchorInItems(state.items, origin)) {
          items = [...state.items, { kind: "agent-card", agentId: id, timestamp: Date.now() }];
        }
      }
      return { ...state, items, agents };
    }

    case "user": {
      // Hide programmatically-injected messages (e.g. auto-continue after restart)
      if (action.internal) return state;
      const now = Date.now();

      // Attributed user-role messages (e.g. a child's assignment prompt) belong
      // to the child's transcript, never the main stream.
      if (action.agentId) {
        const stream = state.agentItems[action.agentId] ?? [];
        return withAgentItems(state, action.agentId, [
          ...stream,
          buildUserChatItem(action.text, now),
        ]);
      }

      // Agent-authored inbound messages are notes, never human bubbles.
      if (action.author?.kind === "agent") {
        return {
          ...state,
          items: [...state.items, buildAgentNoteItem(action.text, action.author, now)],
        };
      }

      const items = [...state.items];

      // When the queue drains, the server sends one coalesced non-queued user
      // message that replaces all the queued placeholders.  Strip the old
      // placeholders so we don't show duplicates.
      if (!action.queued) {
        const hadQueued = items.some((i) => i.kind === "user" && i.queued);
        if (hadQueued) {
          // Remove all queued placeholders — the real message replaces them
          for (let i = items.length - 1; i >= 0; i--) {
            if (items[i].kind === "user" && (items[i] as { queued?: boolean }).queued) {
              items.splice(i, 1);
            }
          }
        }
      }

      const lastItem = items[items.length - 1];
      // Never merge queued placeholders — they must stay distinct bubbles so
      // their edit/remove/send-now actions can target them.
      if (
        isImageOnly(action.text) &&
        !action.queued &&
        lastItem?.kind === "user" &&
        !lastItem.queued &&
        lastItem.timestamp &&
        now - lastItem.timestamp < 60_000
      ) {
        items[items.length - 1] = {
          ...lastItem,
          text: lastItem.text + "\n" + action.text,
        };
        return {
          ...state,
          items,
          showThinkingIndicator: false,
        };
      }
      items.push(
        buildUserChatItem(action.text, now, action.queued, {
          queuedId: action.queuedId,
          queuedSourceText: action.queuedSourceText,
          queuedImages: action.queuedImages,
          queuedAttachments: action.queuedAttachments,
        }),
      );
      return {
        ...state,
        items,
        showThinkingIndicator: false,
        processingStartedAt: action.queued ? state.processingStartedAt : now,
      };
    }

    case "clear_queued": {
      const hadQueued = state.items.some((i) => i.kind === "user" && i.queued);
      if (!hadQueued) return state;
      return {
        ...state,
        items: state.items.filter((i) => !(i.kind === "user" && i.queued)),
      };
    }

    case "remove_queued": {
      const hadMatch = state.items.some(
        (i) => i.kind === "user" && i.queued && i.queuedId === action.queuedId,
      );
      if (!hadMatch) return state;
      return {
        ...state,
        items: state.items.filter(
          (i) => !(i.kind === "user" && i.queued && i.queuedId === action.queuedId),
        ),
      };
    }

    case "exit": {
      if (action.code !== 0) {
        const items = [...state.items];
        let text = action.signal
          ? `Session process killed by ${action.signal}`
          : `Session process exited with code ${action.code}`;
        if (action.stderr) text += `\n${action.stderr}`;
        items.push({ kind: "system", text, isError: true });
        return {
          ...state,
          items,
          isProcessing: false,
          showThinkingIndicator: false,
          lastActivity: null,
          processingStartedAt: null,
        };
      }
      return {
        ...state,
        isProcessing: false,
        showThinkingIndicator: false,
        lastActivity: null,
        processingStartedAt: null,
      };
    }

    case "error": {
      const items = [...state.items];
      items.push({ kind: "system", text: `Error: ${action.message}`, isError: true });
      return {
        ...state,
        items,
        isProcessing: false,
        showThinkingIndicator: false,
        lastActivity: null,
        processingStartedAt: null,
      };
    }

    case "notification": {
      const items = [...state.items];
      items.push({ kind: "system", text: action.message });
      return { ...state, items };
    }

    case "system_event": {
      if (action.message.event === "model_switched") {
        const items = [...state.items];
        items.push(buildModelSwitchItem(action.message.payload, Date.now()));
        return { ...state, items };
      }
      if (action.message.event !== "compact_boundary") return state;
      const items = [...state.items];
      items.push({ kind: "compact-boundary", timestamp: Date.now() });
      return {
        ...state,
        items,
        isProcessing: false,
        showThinkingIndicator: false,
        lastActivity: null,
        processingStartedAt: null,
      };
    }

    case "reconcile_status": {
      // The server's instance status is authoritative for whether a turn is
      // running. When it reports the turn is no longer active (idle/error/
      // stopped) but we still think we're processing, clear the stuck flag.
      // This is the recovery path for mobile/flaky links: if the turn-ending
      // `output { isWaiting: true }` event was missed during a disconnect, the
      // chat would otherwise stay wedged in "Working..." until a manual
      // refresh. Only ever clears — never sets — so it can't race the
      // optimistic just-sent indicator (the server reports "processing" after
      // a send, not idle).
      if (action.status === "processing" || !state.isProcessing) return state;
      return {
        ...state,
        isProcessing: false,
        showThinkingIndicator: false,
        lastActivity: null,
        processingStartedAt: null,
      };
    }

    case "show_thinking": {
      return {
        ...state,
        isProcessing: true,
        showThinkingIndicator: true,
        processingStartedAt: state.processingStartedAt ?? Date.now(),
        lastActivity:
          state.lastActivity ??
          buildLiveActivity({
            phase: "starting",
            presentation: "generic",
            description: "Thinking...",
          }),
      };
    }

    default:
      return state;
  }
}

function getActionSequence(action: Action): number | undefined {
  switch (action.type) {
    case "output":
    case "user":
    case "remove_queued":
    case "exit":
    case "agent_update":
      return action.eventSequence;
    case "activity":
      return action.message.eventSequence;
    default:
      return undefined;
  }
}

/**
 * Convert a live action into a ServerMessage so we can append it to rawHistory
 * (keeping raw history in sync with live WS events, not just replay snapshots).
 */
function actionToHistoryEntry(action: Action): HistoryEntry | null {
  const now = Date.now();
  switch (action.type) {
    case "activity":
      return { timestamp: now, message: action.message };
    case "system_event":
      return { timestamp: now, message: action.message };
    case "agent_update":
      return {
        timestamp: now,
        message: { type: "agent_update", agent: action.agent } as ServerMessage,
      };
    case "output":
      return {
        timestamp: now,
        message: {
          type: "output",
          instanceId: "",
          text: action.text,
          isWaiting: action.isWaiting,
          thinking: action.thinking,
          modelTimestamp: action.modelTimestamp,
          aborted: action.aborted,
          agentId: action.agentId,
        } as ServerMessage,
      };
    case "user":
      return {
        timestamp: now,
        message: {
          type: "user",
          instanceId: "",
          text: action.text,
          internal: action.internal,
          queued: action.queued,
          queuedId: action.queuedId,
          queuedSourceText: action.queuedSourceText,
          images: action.queuedImages,
          attachments: action.queuedAttachments,
          author: action.author,
          agentId: action.agentId,
        } as ServerMessage,
      };
    case "exit":
      return {
        timestamp: now,
        message: {
          type: "exit",
          instanceId: "",
          code: action.code,
          signal: action.signal,
          stderr: action.stderr,
        } as ServerMessage,
      };
    default:
      return null;
  }
}

function reducer(state: State, action: Action): State {
  const seq = getActionSequence(action);
  if (seq !== undefined && seq <= state.lastSeenSequence) {
    return state;
  }
  const next = coreReducer(state, action);
  // Note: rawHistory entries are appended out-of-band in handleMessage so the
  // reducer stays pure and we avoid O(n) array clones on every live event.
  if (seq === undefined) return next;
  return {
    ...next,
    lastSeenSequence: seq,
  };
}

export function useInstanceMessages() {
  const [state, dispatch] = useReducer(reducer, EMPTY_STATE);
  const instanceIdRef = useRef<string | null>(null);
  // Ref tracks latest state so cache saves in setInstanceId aren't stale
  const stateRef = useRef(state);
  stateRef.current = state;
  const historyReadyRef = useRef(false);

  /**
   * Dispatch an action while mirroring its history entry (if any) into the
   * out-of-band rawHistoryStore in place. The reducer's sequence-dedup gate is
   * replicated here so stale messages don't produce duplicate entries in the
   * buffer.
   */
  const dispatchAndRecord = useCallback((instanceId: string, action: Action) => {
    const seq = getActionSequence(action);
    if (seq !== undefined && seq <= stateRef.current.lastSeenSequence) {
      return;
    }
    const entry = actionToHistoryEntry(action);
    if (entry) {
      const buffer = rawHistoryStore.get(instanceId);
      if (buffer) buffer.push(entry);
    }
    dispatch(action);
  }, []);

  const handleMessage = useCallback(
    (instanceId: string, message: ServerMessage) => {
      if (instanceIdRef.current !== instanceId) return;

      switch (message.type) {
        case "instance_history":
          if (message.instanceId === instanceId) {
            // Only replace the rawHistory buffer on a full replay. Safe deltas
            // leave existing entries in place (the reducer ignores action.history
            // in that branch), so we must too.
            const isSafeDelta = canApplyDeltaReplay(
              stateRef.current,
              message.replayMode,
              message.replayEpoch,
              message.latestSequence,
            );
            if (!isSafeDelta) {
              if (message.replayMode === "delta") {
                break;
              }
              rawHistoryStore.set(instanceId, [...message.history]);
            } else if (!rawHistoryStore.has(instanceId)) {
              rawHistoryStore.set(instanceId, [...message.history]);
            }
            historyReadyRef.current = true;
            dispatch({
              type: "replay",
              history: message.history,
              replayMode: message.replayMode,
              latestSequence: message.latestSequence,
              replayEpoch: message.replayEpoch,
            });
          }
          break;
        case "output":
          if (message.instanceId === instanceId) {
            dispatchAndRecord(instanceId, {
              type: "output",
              text: message.text,
              isWaiting: message.isWaiting,
              thinking: message.thinking,
              modelTimestamp: message.modelTimestamp,
              aborted: message.aborted,
              eventSequence: message.eventSequence,
              agentId: message.agentId,
            });
          }
          break;
        case "activity":
          if (message.instanceId === instanceId) {
            dispatchAndRecord(instanceId, { type: "activity", message });
          }
          break;
        case "user":
          if (message.instanceId === instanceId) {
            dispatchAndRecord(instanceId, {
              type: "user",
              text: message.text,
              internal: message.internal,
              queued: message.queued,
              queuedId: message.queuedId,
              queuedSourceText: message.queuedSourceText,
              queuedImages: message.queued ? message.images : undefined,
              queuedAttachments: message.queued ? message.attachments : undefined,
              eventSequence: message.eventSequence,
              author: message.author,
              agentId: message.agentId,
            });
          }
          break;
        case "agent_update":
          if (!message.instanceId || message.instanceId === instanceId) {
            dispatchAndRecord(instanceId, {
              type: "agent_update",
              agent: message.agent,
              eventSequence: message.eventSequence,
            });
          }
          break;
        case "queued_removed":
          if (message.instanceId === instanceId) {
            dispatchAndRecord(instanceId, {
              type: "remove_queued",
              queuedId: message.queuedId,
              eventSequence: message.eventSequence,
            });
          }
          break;
        case "exit":
          if (message.instanceId === instanceId) {
            dispatchAndRecord(instanceId, {
              type: "exit",
              code: message.code,
              signal: message.signal,
              stderr: message.stderr,
              eventSequence: message.eventSequence,
            });
          }
          break;
        case "error":
          if (!message.instanceId || message.instanceId === instanceId) {
            dispatch({ type: "error", message: message.message });
          }
          break;
        case "notification":
          if (!message.instanceId || message.instanceId === instanceId) {
            dispatch({ type: "notification", message: message.message });
          }
          break;
        case "system_event":
          if (message.instanceId === instanceId) {
            dispatchAndRecord(instanceId, { type: "system_event", message });
          }
          break;
        case "instance_status":
          if (message.instanceId === instanceId) {
            // When the server clears the message queue (turn ended or stop
            // pressed), remove any queued placeholder bubbles still visible.
            if (!message.instance.queuedMessageCount) {
              dispatch({ type: "clear_queued" });
            }
            // Reconcile a stuck local processing flag against the authoritative
            // server status (recovers from a missed turn-end event on reconnect).
            dispatch({ type: "reconcile_status", status: message.instance.status });
          }
          break;
      }
    },
    [dispatchAndRecord],
  );

  const setInstanceId = useCallback((id: string | null) => {
    // Save outgoing instance's state to cache. The rawHistory buffer is
    // already keyed by instance id in rawHistoryStore, so it persists across
    // the switch without any explicit save — it only gets evicted when the
    // matching stateCache entry is evicted (see setCacheEntry).
    const prevId = instanceIdRef.current;
    if (prevId && stateRef.current.hasLoadedHistory) {
      setCacheEntry(prevId, stateRef.current);
    }

    instanceIdRef.current = id;

    // Restore from cache if available (instant), otherwise reset.
    // The WS history replay still arrives and silently updates to the latest.
    if (id) {
      const cached = stateCache.get(id);
      if (cached) {
        historyReadyRef.current = false;
        dispatch({ type: "restore", cached });
        return;
      }
    }
    historyReadyRef.current = false;
    dispatch({ type: "reset" });
  }, []);

  const showThinking = useCallback(() => {
    dispatch({ type: "show_thinking" });
  }, []);

  const hydrateFromHistorySnapshot = useCallback((instanceId: string, history: HistoryEntry[]) => {
    if (
      instanceIdRef.current !== instanceId ||
      stateRef.current.hasSyncedHistory ||
      historyReadyRef.current
    ) {
      return;
    }
    historyReadyRef.current = true;
    rawHistoryStore.set(instanceId, [...history]);
    dispatch({
      type: "replay",
      history,
      replayMode: "full",
      latestSequence: 0,
    });
  }, []);

  const getReplayCursor = useCallback((instanceId: string) => {
    const source =
      stateCache.get(instanceId) ??
      (instanceIdRef.current === instanceId ? stateRef.current : undefined);
    if (!source || source.lastSeenSequence <= 0 || source.replayEpoch === undefined) {
      return undefined;
    }
    return {
      lastSeenSequence: source.lastSeenSequence,
      replayEpoch: source.replayEpoch,
    };
  }, []);

  // Read rawHistory from the out-of-band store. The array reference is stable
  // across renders for a given instance (mutated in place); consumers should
  // depend on `rawHistory?.length` rather than the reference when reacting to
  // appends. Reducer dispatches that accompany each append drive the re-render
  // that surfaces the new length.
  const currentId = instanceIdRef.current;
  const rawHistory =
    state.hasRawHistory && currentId ? (rawHistoryStore.get(currentId) ?? null) : null;

  return {
    items: state.items,
    agents: state.agents,
    agentItems: state.agentItems,
    hasLoadedHistory: state.hasLoadedHistory,
    hasSyncedHistory: state.hasSyncedHistory,
    isProcessing: state.isProcessing,
    showThinkingIndicator: state.showThinkingIndicator,
    currentTasks: state.currentTasks,
    currentFiles: state.currentFiles,
    lastActivity: state.lastActivity,
    processingStartedAt: state.processingStartedAt,
    rawHistory,
    getReplayCursor,
    handleMessage,
    setInstanceId,
    showThinking,
    hydrateFromHistorySnapshot,
  };
}
