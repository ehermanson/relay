/**
 * Visual identity for a delegated agent, shared by every surface that renders
 * one (in-chat card, Agents sidecar row, agent note, expanded detail).
 *
 * A monogram chip tinted with a deterministic accent picked from the shared
 * categorical `--color-chart-*` palette, keyed by the agent's name (so the same
 * agent keeps its colour everywhere and concurrent agents are told apart at a
 * glance) and falling back to the opaque agent key. Active agents get a soft
 * "alive" ring. Colour is decoration only — status is never inferred from it.
 */

import { Bot } from "lucide-react";
import type { AgentInfo } from "@shared/types";
import { isAgentActive } from "@/lib/agents";

export interface AgentAccent {
  /** Foreground text/glyph colour. */
  text: string;
  /** Tinted avatar background. */
  softBg: string;
  /** Inset ring around the avatar. */
  ring: string;
  /** Solid connector colour for grouped cards (background utility). */
  rail: string;
  /** Left-border colour for the agent-note rail (border utility). */
  railBorder: string;
}

// chart-5 is red (reads as an error state) and is deliberately skipped so an
// agent's identity colour can never be mistaken for a failure.
const AGENT_ACCENTS: AgentAccent[] = [
  { text: "text-chart-1", softBg: "bg-chart-1/15", ring: "ring-chart-1/30", rail: "bg-chart-1/50", railBorder: "border-chart-1/45" },
  { text: "text-chart-2", softBg: "bg-chart-2/15", ring: "ring-chart-2/30", rail: "bg-chart-2/50", railBorder: "border-chart-2/45" },
  { text: "text-chart-3", softBg: "bg-chart-3/15", ring: "ring-chart-3/30", rail: "bg-chart-3/50", railBorder: "border-chart-3/45" },
  { text: "text-chart-4", softBg: "bg-chart-4/15", ring: "ring-chart-4/30", rail: "bg-chart-4/50", railBorder: "border-chart-4/45" },
  { text: "text-chart-6", softBg: "bg-chart-6/15", ring: "ring-chart-6/30", rail: "bg-chart-6/50", railBorder: "border-chart-6/45" },
  { text: "text-chart-7", softBg: "bg-chart-7/15", ring: "ring-chart-7/30", rail: "bg-chart-7/50", railBorder: "border-chart-7/45" },
  { text: "text-chart-8", softBg: "bg-chart-8/15", ring: "ring-chart-8/30", rail: "bg-chart-8/50", railBorder: "border-chart-8/45" },
];

function hashKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) >>> 0;
  return h;
}

/** Deterministic accent for an agent, stable across surfaces and renders. */
export function getAgentAccent(agent: AgentInfo): AgentAccent {
  const key = agent.name?.trim() || agent.role?.trim() || agent.agentId;
  return AGENT_ACCENTS[hashKey(key) % AGENT_ACCENTS.length];
}

/** First letter of the agent's display name, or undefined (→ Bot glyph). */
function getAgentInitial(agent: AgentInfo): string | undefined {
  const source = agent.name?.trim() || agent.role?.trim() || agent.description?.trim();
  const match = source?.match(/[a-z0-9]/i);
  return match?.[0]?.toUpperCase();
}

interface AgentAvatarProps {
  agent: AgentInfo;
  size?: number;
  className?: string;
}

/** Monogram identity chip. Pulses a soft ring while the agent is active. */
export function AgentAvatar({ agent, size = 22, className = "" }: AgentAvatarProps) {
  const accent = getAgentAccent(agent);
  const initial = getAgentInitial(agent);
  const active = isAgentActive(agent.status);
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.5)) }}
      className={`relative inline-flex shrink-0 items-center justify-center rounded-md font-semibold leading-none ${accent.softBg} ${accent.text} ring-1 ring-inset ${accent.ring} ${
        active ? "animate-ring-pulse" : ""
      } ${className}`}
    >
      {initial ?? <Bot size={Math.round(size * 0.6)} strokeWidth={2} />}
    </span>
  );
}
