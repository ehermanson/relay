import type { AgentInfo, InstanceInfo } from "@shared/types";

/**
 * Relay-delegated child chats (`delegate_task`) sharing their parent's
 * checkout. They never get their own inbox/sidebar/Home row: the way into a
 * child is its parent's agent card and Agents sidecar row.
 */
export function isDelegatedChildInstance(instance: Pick<InstanceInfo, "delegation">): boolean {
  return !!instance.delegation;
}

/** An agent backed by a Relay child chat rather than a provider-native subagent. */
export function isRelayAgent(agent: Pick<AgentInfo, "origin">): boolean {
  return agent.origin === "relay";
}

/** Agent key prefix of a Relay child on its parent: `relay-task:<taskId>`. */
export const RELAY_TASK_AGENT_PREFIX = "relay-task:";

/** The delegated task id behind a Relay agent, or undefined for native subagents. */
export function relayTaskIdOf(agent: Pick<AgentInfo, "agentId" | "origin">): string | undefined {
  if (agent.origin !== "relay" || !agent.agentId.startsWith(RELAY_TASK_AGENT_PREFIX)) {
    return undefined;
  }
  return agent.agentId.slice(RELAY_TASK_AGENT_PREFIX.length) || undefined;
}

/**
 * Walk `delegation.parentInstanceId` to the nearest non-delegated ancestor
 * (cycle-safe).
 */
export function findDelegationRoot(
  instance: InstanceInfo,
  byId: ReadonlyMap<string, InstanceInfo>,
): InstanceInfo {
  let current = instance;
  const seen = new Set<string>([current.id]);
  while (current.delegation) {
    const parent = byId.get(current.delegation.parentInstanceId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
  }
  return current;
}

/** One tab in a delegation family strip: a chat and how deep it sits under the root. */
export interface DelegationTab {
  instance: InstanceInfo;
  /** 0 = the root (the chat that started delegating), 1 = its children, … */
  depth: number;
}

/**
 * The delegation family the current chat belongs to, as tabs: the root
 * followed by its descendants depth-first, siblings in delegation order
 * (creation time — a child chat is created when its task is delegated).
 * Empty when the chat has no family (no parent and no children) or isn't in
 * the list, so the strip renders nothing for an ordinary chat. Cycle-safe.
 */
export function buildDelegationFamily(
  instances: ReadonlyArray<InstanceInfo>,
  currentId: string,
): DelegationTab[] {
  const byId = new Map(instances.map((instance) => [instance.id, instance] as const));
  const current = byId.get(currentId);
  if (!current) return [];

  const childrenOf = new Map<string, InstanceInfo[]>();
  for (const instance of instances) {
    const parentId = instance.delegation?.parentInstanceId;
    if (!parentId || parentId === instance.id || !byId.has(parentId)) continue;
    const siblings = childrenOf.get(parentId);
    if (siblings) siblings.push(instance);
    else childrenOf.set(parentId, [instance]);
  }
  for (const siblings of childrenOf.values()) {
    siblings.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  const root = findDelegationRoot(current, byId);
  const tabs: DelegationTab[] = [];
  const seen = new Set<string>();
  const visit = (instance: InstanceInfo, depth: number) => {
    if (seen.has(instance.id)) return;
    seen.add(instance.id);
    tabs.push({ instance, depth });
    for (const child of childrenOf.get(instance.id) ?? []) visit(child, depth + 1);
  };
  visit(root, 0);
  return tabs.length > 1 ? tabs : [];
}

/** A delegated child whose task ended quietly (completed or cancelled): foldable in the strip. */
export function isFinishedDelegationTab(tab: DelegationTab): boolean {
  if (tab.depth === 0) return false;
  const status = tab.instance.delegation?.taskStatus;
  return status === "completed" || status === "cancelled";
}

/** The strip after folding finished children into one trailing chip. */
export interface DelegationTabSplit {
  /** Tabs to render, in family order (root first). */
  visible: DelegationTab[];
  /** Finished children the chip folds away while collapsed (the same set when expanded). */
  folded: DelegationTab[];
}

/**
 * Split a family into the tabs to show and the finished children folded into
 * the "done" chip. Running and failed children always show; completed and
 * cancelled ones fold unless `expanded`. Never folded: the root, the chat on
 * screen, and a finished chat with a visible descendant (a nested tab keeps
 * its parent). `folded` is what the chip counts and toggles; empty means no
 * chip. A reopened child (running again) leaves the fold by itself.
 */
export function splitDelegationTabs(
  tabs: readonly DelegationTab[],
  activeId: string | null,
  expanded: boolean,
): DelegationTabSplit {
  const pinned = tabs.map((tab) => !isFinishedDelegationTab(tab) || tab.instance.id === activeId);
  const shown = tabs.map((tab, i) => {
    if (pinned[i]) return true;
    // Descendants follow a tab in depth-first order until the depth returns.
    for (let j = i + 1; j < tabs.length && tabs[j].depth > tab.depth; j++) {
      if (pinned[j]) return true;
    }
    return false;
  });
  const folded = tabs.filter((_, i) => !shown[i]);
  return { visible: expanded ? [...tabs] : tabs.filter((_, i) => shown[i]), folded };
}
