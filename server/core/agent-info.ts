/**
 * Pure `AgentInfo` helpers shared by the server and the UI (`@shared/agent-info`).
 *
 * Zero runtime imports and no filesystem access: this is the single definition
 * of how sparse `agent_update` patches fold into agent state, so the live
 * reducer, transcript replay, and REST views can never disagree about a merge.
 */

import type { AgentInfo, HistoryEntry } from "#core/types.js";

/** Sparse-upsert merge: omitted/undefined patch fields keep the previous value; `usage` merges field-wise. */
export function mergeAgentInfo(prev: AgentInfo | undefined, patch: AgentInfo): AgentInfo {
  const merged: AgentInfo = { ...(prev ?? { agentId: patch.agentId }) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "usage" && prev?.usage && value && typeof value === "object") {
      merged.usage = { ...prev.usage, ...(value as AgentInfo["usage"]) };
      continue;
    }
    (merged as unknown as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/** Fold every `agent_update` in a history into a key → AgentInfo map. */
export function collectAgentsFromHistory(history: HistoryEntry[]): Map<string, AgentInfo> {
  const agents = new Map<string, AgentInfo>();
  for (const entry of history) {
    if (entry.message.type !== "agent_update") continue;
    const patch = entry.message.agent;
    if (!patch?.agentId) continue;
    agents.set(patch.agentId, mergeAgentInfo(agents.get(patch.agentId), patch));
  }
  return agents;
}

/** Find the Relay key whose provider-native id matches. */
export function findAgentKeyByProviderId(
  agents: ReadonlyMap<string, AgentInfo>,
  providerAgentId: string | undefined,
): string | undefined {
  if (!providerAgentId) return undefined;
  if (agents.has(providerAgentId)) return providerAgentId;
  for (const [key, info] of agents) {
    if (info.providerAgentId === providerAgentId) return key;
  }
  return undefined;
}
