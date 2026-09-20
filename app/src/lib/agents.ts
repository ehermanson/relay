/**
 * Pure helpers for delegated-agent state (cards + Agents sidecar).
 *
 * Everything here is provider-agnostic: it consumes the shared `AgentInfo`
 * contract from `@shared/types` and Relay's own `ChatItem` stream. Nothing is
 * guessed — unknown metadata stays `undefined` (see the brief: "Unknown stays
 * unknown"). The sparse-upsert merge itself lives in `@shared/agent-info` so
 * the server and the UI can never disagree about how patches fold.
 */

import type { AgentInfo, AgentLifecycle, ProviderKind, ProviderRequest } from "@shared/types";
import { findProviderModelLabel } from "@shared/provider-catalog";
import type { ChatItem } from "@/lib/chat-types";
import { formatElapsed } from "@/lib/utils";

/** Display title: orchestrator-given name → description → provider role → generic. */
export function getAgentTitle(agent: AgentInfo): string {
  const name = agent.name?.trim();
  if (name) return name;
  const description = agent.description?.trim();
  if (description) return description;
  const role = agent.role?.trim();
  if (role) return role;
  return "Agent";
}

/**
 * Secondary line under the title. Avoids repeating whatever the title already
 * shows: when the title is the name, this is the description, assignment, or role.
 */
export function getAgentSubtitle(agent: AgentInfo): string | undefined {
  const title = getAgentTitle(agent);
  const candidates = [agent.description, agent.assignment, agent.role];
  for (const candidate of candidates) {
    const trimmed = candidate?.replace(/\s+/g, " ").trim();
    if (trimmed && trimmed !== title) return trimmed;
  }
  return undefined;
}

/**
 * Human model label for a card/row/detail line, or `null` when the provider
 * never reported the model (callers render "model unknown" — never a default).
 */
export function getAgentModelLabel(
  agent: AgentInfo,
  provider: ProviderKind | undefined,
): string | null {
  if (!agent.model) return null;
  return (provider ? findProviderModelLabel(provider, agent.model) : null) ?? agent.model;
}

/** True for lifecycles where the agent is still doing (or about to do) work. */
export function isAgentActive(status: AgentLifecycle | undefined): boolean {
  return status === "running" || status === "pending" || status === "waiting";
}

/** True once the agent can no longer produce activity — its history is final. */
export function isAgentTerminal(status: AgentLifecycle | undefined): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

/** True for lifecycles that should stay visible while a card is collapsed. */
export function isAgentAttention(agent: AgentInfo): boolean {
  return agent.status === "failed" || agent.status === "waiting" || !!agent.resultIsError;
}

const EMPTY_ANCHOR_INDEX: ReadonlyMap<string, string> = new Map();

/**
 * Anchor index: `toolUseId → agentId` for every agent whose delegation call is
 * present in `items` as a `tool_use` activity. Agents that already own an
 * inserted `agent-card` item are excluded so a late-arriving origin can never
 * produce a second card for the same agent. Returns one shared empty map when
 * no agent has an origin at all, so the common case costs no item scan.
 */
export function buildAgentAnchorIndex(
  items: ChatItem[],
  agents: Record<string, AgentInfo>,
): ReadonlyMap<string, string> {
  let hasOrigin = false;
  for (const agent of Object.values(agents)) {
    if (agent.originToolUseId) {
      hasOrigin = true;
      break;
    }
  }
  if (!hasOrigin) return EMPTY_ANCHOR_INDEX;

  const anchors = new Map<string, string>();
  const carded = new Set<string>();
  const toolUseIds = new Set<string>();
  for (const item of items) {
    if (item.kind === "agent-card") carded.add(item.agentId);
    else if (item.kind === "activity-group") {
      for (const act of item.activities) {
        if (act.activity === "tool_use" && act.toolUseId) toolUseIds.add(act.toolUseId);
      }
    }
  }
  for (const agent of Object.values(agents)) {
    const origin = agent.originToolUseId;
    if (!origin || carded.has(agent.agentId) || !toolUseIds.has(origin)) continue;
    anchors.set(origin, agent.agentId);
  }
  return anchors;
}

/** Whether an origin tool_use for this agent exists anywhere in `items`. */
export function hasAnchorInItems(items: ChatItem[], originToolUseId: string): boolean {
  for (const item of items) {
    if (item.kind !== "activity-group") continue;
    for (const act of item.activities) {
      if (act.activity === "tool_use" && act.toolUseId === originToolUseId) return true;
    }
  }
  return false;
}

/** Whether an origin tool_use exists in any nested agent transcript. */
export function hasAnchorInAnyStream(
  agentItems: Record<string, ChatItem[]>,
  originToolUseId: string,
): boolean {
  for (const items of Object.values(agentItems)) {
    if (hasAnchorInItems(items, originToolUseId)) return true;
  }
  return false;
}

/**
 * Whether an agent belongs to the main conversation's card stream. Nested
 * delegation — a provider-declared `parentAgentId`, or an origin tool_use that
 * lives inside another agent's transcript — renders inside the parent's detail
 * view and must never also get a main-stream card.
 */
export function isMainStreamAgent(
  agent: AgentInfo,
  agentItems: Record<string, ChatItem[]>,
): boolean {
  if (agent.parentAgentId) return false;
  const origin = agent.originToolUseId;
  if (origin && hasAnchorInAnyStream(agentItems, origin)) return false;
  return true;
}

/**
 * Client-side fallback for `AgentInfo.lastActivity`: the description of the
 * most recent attributed tool_use. Used only when the server didn't set one.
 */
export function deriveAgentLastActivity(items: ChatItem[] | undefined): string | undefined {
  if (!items) return undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind !== "activity-group") continue;
    for (let j = item.activities.length - 1; j >= 0; j--) {
      const act = item.activities[j];
      if (act.activity !== "tool_use") continue;
      const label = act.inputDescription || act.description || act.tool;
      if (label) return label;
    }
  }
  return undefined;
}

/** Ignore old transport-only labels still present in hydrated agent state. */
export function getAgentLastActivity(
  agent: AgentInfo,
  items: ChatItem[] | undefined,
): string | undefined {
  const activity = agent.lastActivity?.trim();
  if (activity && activity !== "Message exchanged" && activity !== "Received a message") {
    return activity;
  }
  return deriveAgentLastActivity(items);
}

/**
 * Relay agent key of a pending provider request, when the server tagged it.
 * `relayAgentId` is the documented field; a request that only carries the
 * provider-native `agentId` is matched against `providerAgentId` by callers.
 */
export function getRequestRelayAgentId(
  request: ProviderRequest | null | undefined,
): string | undefined {
  if (!request) return undefined;
  const relay = (request as { relayAgentId?: unknown }).relayAgentId;
  return typeof relay === "string" && relay ? relay : undefined;
}

/**
 * Resolve which agent (if any) a pending request belongs to. Prefers the Relay
 * key; falls back to matching the provider-native id against `providerAgentId`.
 */
export function findRequestAgentId(
  request: ProviderRequest | null | undefined,
  agents: Record<string, AgentInfo>,
): string | undefined {
  const relay = getRequestRelayAgentId(request);
  if (relay && agents[relay]) return relay;
  const native = request?.agentId;
  if (!native) return undefined;
  for (const agent of Object.values(agents)) {
    if (agent.providerAgentId === native || agent.agentId === native) return agent.agentId;
  }
  return undefined;
}

export interface AgentTreeNode {
  agent: AgentInfo;
  depth: number;
}

/**
 * Flatten agents into a display order: roots first (insertion order), each
 * followed by its descendants (depth-first). `parentAgentId` pointing at an
 * unknown agent is treated as a root — never inferred. Cycle-safe: any agent
 * not reachable from a root (a parent cycle, or a chain hanging off one) is
 * emitted as a root in its turn, so every agent appears exactly once and the
 * panel's count always matches the map.
 */
export function buildAgentTree(agents: Record<string, AgentInfo>): AgentTreeNode[] {
  const all = Object.values(agents);
  const byParent = new Map<string | undefined, AgentInfo[]>();
  for (const agent of all) {
    const parent =
      agent.parentAgentId && agents[agent.parentAgentId] ? agent.parentAgentId : undefined;
    const list = byParent.get(parent) ?? [];
    list.push(agent);
    byParent.set(parent, list);
  }
  const out: AgentTreeNode[] = [];
  const visited = new Set<string>();
  const walk = (parent: string | undefined, depth: number) => {
    for (const agent of byParent.get(parent) ?? []) {
      if (visited.has(agent.agentId)) continue;
      visited.add(agent.agentId);
      out.push({ agent, depth });
      walk(agent.agentId, depth + 1);
    }
  };
  walk(undefined, 0);
  for (const agent of all) {
    if (visited.has(agent.agentId)) continue;
    visited.add(agent.agentId);
    out.push({ agent, depth: 0 });
    walk(agent.agentId, 1);
  }
  return out;
}

/** Direct children of an agent (provider-declared `parentAgentId` only). */
export function getChildAgents(agents: Record<string, AgentInfo>, agentId: string): AgentInfo[] {
  return Object.values(agents).filter((a) => a.parentAgentId === agentId);
}

/** Count of agents still active, for header badges. */
export function countActiveAgents(agents: Record<string, AgentInfo>): number {
  let n = 0;
  for (const agent of Object.values(agents)) if (isAgentActive(agent.status)) n++;
  return n;
}

/** `formatElapsed` guarded for the optional/unknown durations on `AgentInfo`. */
export function formatAgentDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  return formatElapsed(ms);
}
