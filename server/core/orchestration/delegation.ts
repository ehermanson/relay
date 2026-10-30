import { relayChatLink } from "#core/orchestration/instructions.js";
import type {
  AgentInfo,
  AgentLifecycle,
  DelegatedTaskInfo,
  DelegatedTaskStatus,
  InstanceInfo,
  ProviderKind,
  ProviderRuntimeMode,
} from "#core/types.js";

/**
 * Pure rules for Relay-delegated tasks: the child's runtime-mode ceiling, the
 * parent's agent projection, and the wake message that carries results back.
 */

/** The parent's agent key for a delegated task. */
export function relayTaskAgentKey(taskId: string): string {
  return `relay-task:${taskId}`;
}

/** How much a mode lets an agent do without asking. Equal ranks are peers. */
const RUNTIME_MODE_RANK: Record<ProviderRuntimeMode, number> = {
  plan: 0,
  "approval-required": 1,
  "writes-only": 2,
  auto: 2,
  "full-access": 3,
};

export type ChildRuntimeModeResult =
  | { ok: true; mode: ProviderRuntimeMode }
  | { ok: false; code: "mode_escalation_denied" | "runtime_mode_unavailable"; message: string };

/**
 * A child may run at the parent's mode or narrower, never broader. An
 * explicit request outside the target's modes is refused; an inherited mode
 * the target doesn't offer steps down to the broadest one it does.
 */
export function resolveChildRuntimeMode(
  parentMode: ProviderRuntimeMode,
  requested: ProviderRuntimeMode | undefined,
  offered: readonly ProviderRuntimeMode[],
): ChildRuntimeModeResult {
  const ceiling = RUNTIME_MODE_RANK[parentMode] ?? RUNTIME_MODE_RANK["approval-required"];
  if (requested) {
    if ((RUNTIME_MODE_RANK[requested] ?? Infinity) > ceiling) {
      return {
        ok: false,
        code: "mode_escalation_denied",
        message: `A delegate can't run with more access than this chat (${parentMode}).`,
      };
    }
    if (offered.length > 0 && !offered.includes(requested)) {
      return {
        ok: false,
        code: "runtime_mode_unavailable",
        message: `The target provider doesn't offer runtime mode ${requested}.`,
      };
    }
    return { ok: true, mode: requested };
  }
  if (offered.length === 0 || offered.includes(parentMode)) return { ok: true, mode: parentMode };
  const fallback = offered
    .filter((mode) => (RUNTIME_MODE_RANK[mode] ?? Infinity) <= ceiling)
    .sort((a, b) => RUNTIME_MODE_RANK[b] - RUNTIME_MODE_RANK[a])[0];
  if (!fallback) {
    return {
      ok: false,
      code: "runtime_mode_unavailable",
      message: "The target provider offers no runtime mode within this chat's access.",
    };
  }
  return { ok: true, mode: fallback };
}

/** Would directing a chat at `target` let a caller at `caller` do more than it can itself? */
export function exceedsRuntimeModeCeiling(
  caller: ProviderRuntimeMode,
  target: ProviderRuntimeMode,
): boolean {
  const ceiling = RUNTIME_MODE_RANK[caller] ?? RUNTIME_MODE_RANK["approval-required"];
  return (RUNTIME_MODE_RANK[target] ?? Infinity) > ceiling;
}

const AGENT_STATUS: Record<DelegatedTaskStatus, AgentLifecycle> = {
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "stopped",
};

/** The parent-side `AgentInfo` for a task, rendered by the shared agent cards. */
export function agentInfoForTask(
  task: DelegatedTaskInfo & { originToolUseId?: string },
  child?: Pick<InstanceInfo, "provider" | "preferredModel" | "providerStatus" | "stats">,
): AgentInfo {
  const model =
    child?.providerStatus?.effectiveModel ?? child?.stats?.model ?? child?.preferredModel;
  return {
    agentId: relayTaskAgentKey(task.id),
    origin: "relay",
    relation: "child",
    childInstanceId: task.childInstanceId,
    ...(child ? { childProvider: child.provider } : {}),
    name: task.title,
    ...(task.role ? { role: task.role } : {}),
    assignment: task.task,
    ...(model ? { model } : {}),
    status: AGENT_STATUS[task.status],
    // Agent updates merge sparsely, so a running task (possibly reopened)
    // sends empty strings to clear a previous end's detail.
    ...(task.status === "running"
      ? { statusDetail: task.statusDetail ?? "", lastActivity: task.statusDetail ?? "" }
      : task.statusDetail
        ? { statusDetail: task.statusDetail }
        : {}),
    ...(task.result !== undefined ? { result: task.result } : {}),
    ...(task.resultIsError ? { resultIsError: true } : {}),
    startedAt: task.createdAt,
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    ...(task.originToolUseId ? { originToolUseId: task.originToolUseId } : {}),
  };
}

/** Total inline result text one wake may carry; the rest is a `task_status` pointer. */
export const TASK_WAKE_RESULT_BUDGET = 16_000;

/**
 * First-line markers of agent-authored messages Relay delivers into a chat
 * (task wakes, `chat_send`). They survive provider transcripts, so live
 * dispatch and replay both re-attribute them as agent notes.
 */
const TASK_WAKE_PREFIX = "[Relay task update] ";
const CHAT_MESSAGE_PREFIX = "[Relay message] ";
const RELAY_AGENT_MESSAGE_PREFIXES = [TASK_WAKE_PREFIX, CHAT_MESSAGE_PREFIX];

const STATUS_WORDS: Record<DelegatedTaskStatus, string> = {
  running: "is still running",
  completed: "completed",
  failed: "failed",
  cancelled: "was cancelled",
};

/**
 * One message telling the parent its delegated tasks ended. Results are
 * inlined, oldest first, until the budget runs out.
 */
export function buildTaskWakeMessage(tasks: readonly DelegatedTaskInfo[]): string {
  if (tasks.length === 0) {
    return `${TASK_WAKE_PREFIX}Delegated tasks\n\nNo new results: they were already delivered.`;
  }
  const sender = tasks.length === 1 ? tasks[0].title : `${tasks.length} delegated tasks`;
  let budget = TASK_WAKE_RESULT_BUDGET;
  const sections = tasks.map((task) => {
    const head = `Delegated task "${task.title}" (${relayChatLink(task.childInstanceId)}, task ${task.id}) ${STATUS_WORDS[task.status]}${task.statusDetail ? `: ${task.statusDetail}` : ""}.`;
    const result = task.result?.trim();
    if (!result) return head;
    if (result.length <= budget) {
      budget -= result.length;
      return `${head}\n\nResult:\n${result}`;
    }
    budget = 0;
    return `${head}\n\nThe result is long; read it with task_status ${task.id}.`;
  });
  return `${TASK_WAKE_PREFIX}${sender}\n\n${sections.join("\n\n---\n\n")}`;
}

/**
 * `chat_send`'s envelope: names the sending chat by link. The receiver just
 * replies in its own chat; the sender reads that reply through `chat_wait`
 * (a `chat_send` back would usually find the sender busy waiting).
 */
export function buildChatMessage(sender: Pick<InstanceInfo, "id" | "name">, text: string): string {
  return `${CHAT_MESSAGE_PREFIX}${sender.name}\n\nMessage from the chat ${relayChatLink(sender.id)}. Reply here as usual; the sender reads your reply.\n\n${text.trim()}`;
}

/**
 * Display form of a Relay-delivered agent message (task wake or `chat_send`):
 * an agent note from `name`, never a human turn. Null for anything else.
 */
export function parseRelayAgentMessage(text: string): { name: string; body: string } | null {
  const prefix = RELAY_AGENT_MESSAGE_PREFIXES.find((candidate) => text.startsWith(candidate));
  if (!prefix) return null;
  const newline = text.indexOf("\n");
  const name = (newline === -1 ? text : text.slice(0, newline)).slice(prefix.length);
  const body = newline === -1 ? "" : text.slice(newline + 1).trim();
  return { name: name.trim() || "Relay agent", body };
}

/** Bootstrap note telling a child, explicitly, that it is one. */
export function buildDelegatedChildNote(parent: Pick<InstanceInfo, "id" | "name">): string {
  return [
    `You are a delegated child chat. ${relayChatLink(parent.id)} ("${parent.name}") delegated a task to you through Relay; your first message is that task.`,
    "Do the work yourself. Start no delegates unless your task says to.",
    "Your final reply when you finish is returned to the delegating chat as the task result, so make it a complete, self-contained report.",
  ].join("\n");
}

/**
 * The child's final reply — the published task result: the trailing run of
 * assistant messages since its last tool call or user turn.
 */
export function lastAssistantText(
  history: ReadonlyArray<{
    message: { type: string; text?: string; agentId?: string; activity?: string };
  }>,
): string | undefined {
  const parts: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i].message;
    if (message.agentId) continue;
    if (message.type === "output") {
      if (message.text?.trim()) parts.unshift(message.text.trim());
      continue;
    }
    const boundary =
      message.type === "user" || (message.type === "activity" && message.activity === "tool_use");
    if (boundary) break;
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export const DELEGATED_CHILD_BLOCK_KIND = "relay_delegated_child";

/** What a `delegate_task` call asks for, validated by the tool layer. */
export interface DelegateTaskRequest {
  task: string;
  title?: string;
  role?: string;
  provider?: ProviderKind;
  model?: string;
  runtimeMode?: ProviderRuntimeMode;
  clientRequestId?: string;
}

/** A short chat title from a task's first line. */
export function titleFromTask(task: string): string {
  const line = task.trim().split("\n")[0]?.trim() ?? "";
  if (!line) return "Delegated task";
  return line.length <= 60 ? line : `${line.slice(0, 57).trimEnd()}…`;
}
