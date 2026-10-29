import type { AgentInfo, InstanceInfo } from "@shared/types";

/**
 * Relay-delegated child chats (`delegate_task`). They never get their own
 * inbox/sidebar/Home row: the way into a child is its parent's agent card and
 * Agents sidecar row.
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

/** Walk `delegation.parentInstanceId` to the nearest non-delegated ancestor (cycle-safe). */
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
