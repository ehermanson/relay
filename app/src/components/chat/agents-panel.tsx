import { memo, useMemo, useState } from "react";
import { ChevronRight, ShieldAlert } from "lucide-react";
import type { AgentInfo, AgentLifecycle, ProviderKind } from "@shared/types";
import type { ChatItem } from "@/lib/chat-types";
import {
  buildAgentAnchorIndex,
  buildAgentTree,
  getAgentLastActivity,
  getAgentSubtitle,
  getAgentTitle,
  isAgentActive,
} from "@/lib/agents";
import { AgentStatusBadge } from "@/components/chat/agent-status-badge";
import { AgentAvatar } from "@/components/chat/agent-avatar";
import { AgentDetail } from "@/components/chat/agent-detail";
import { AgentCardsProvider, useAgentCards } from "@/components/chat/agent-card-context";
import { useAgentModelLabel } from "@/hooks/use-agent-model";

interface AgentsPanelProps {
  agents: Record<string, AgentInfo>;
  agentItems: Record<string, ChatItem[]>;
  /** Main-stream items, used to compute anchors for nested rendering. */
  items?: ChatItem[];
  instanceId?: string;
  provider?: ProviderKind;
  pendingAgentId?: string;
}

interface SummaryChip {
  label: string;
  count: number;
  color: string;
  dot: string;
  pulse?: boolean;
}

/** Status roll-up shown above the list — the at-a-glance "who needs me" bar. */
function buildSummary(agents: Record<string, AgentInfo>): SummaryChip[] {
  const counts: Record<string, number> = {};
  for (const a of Object.values(agents)) {
    let key: string = a.status ?? "unknown";
    if (a.resultIsError && (a.status === "completed" || a.status === undefined)) key = "failed";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const order: {
    key: AgentLifecycle | "unknown";
    label: string;
    color: string;
    dot: string;
    pulse?: boolean;
  }[] = [
    { key: "running", label: "running", color: "text-claude", dot: "bg-claude", pulse: true },
    { key: "waiting", label: "needs input", color: "text-warning", dot: "bg-warning", pulse: true },
    { key: "failed", label: "failed", color: "text-error", dot: "bg-error" },
    { key: "pending", label: "queued", color: "text-muted", dot: "bg-muted" },
    { key: "completed", label: "done", color: "text-accent/80", dot: "bg-accent" },
    { key: "stopped", label: "stopped", color: "text-muted", dot: "bg-muted" },
    { key: "unknown", label: "unknown", color: "text-muted", dot: "bg-muted" },
  ];
  return order
    .filter((o) => counts[o.key] > 0)
    .map((o) => ({
      label: o.label,
      count: counts[o.key],
      color: o.color,
      dot: o.dot,
      pulse: o.pulse,
    }));
}

function AgentRow({
  agent,
  depth,
  items,
  provider,
  hasPendingRequest,
}: {
  agent: AgentInfo;
  depth: number;
  items?: ChatItem[];
  provider?: ProviderKind;
  hasPendingRequest: boolean;
}) {
  const [open, setOpen] = useState(false);
  const title = getAgentTitle(agent);
  const subtitle = getAgentSubtitle(agent);
  const ctx = useAgentCards();
  const modelLabel = useAgentModelLabel(ctx?.instanceId, agent, provider);
  const active = isAgentActive(agent.status);
  const lastActivity = getAgentLastActivity(agent, items);
  // Live activity while working; purpose (not a report dump) once finished.
  let detailLine: string | undefined;
  if (agent.status === "failed") detailLine = agent.statusDetail ?? subtitle;
  else if (agent.status === "waiting") detailLine = agent.statusDetail ?? lastActivity ?? subtitle;
  else if (active) detailLine = lastActivity ?? subtitle;
  else detailLine = subtitle ?? agent.statusDetail;
  const detailIsError = agent.status === "failed" || !!agent.resultIsError;

  return (
    <div className="flex flex-col" style={{ paddingLeft: depth * 16 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group/row flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-hover"
      >
        <AgentAvatar agent={agent} size={24} className="mt-px" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[0.8125rem] font-medium text-text">{title}</span>
            {hasPendingRequest && (
              <ShieldAlert
                size={11}
                className="shrink-0 text-warning"
                aria-label="Needs approval"
              />
            )}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[0.6875rem]">
            {modelLabel && <span className="shrink-0 text-muted/70">{modelLabel}</span>}
            {modelLabel && detailLine && <span className="shrink-0 text-muted/30">·</span>}
            {detailLine && (
              <span className={`truncate ${detailIsError ? "text-error/90" : "text-muted"}`}>
                {detailLine}
              </span>
            )}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
          <AgentStatusBadge status={agent.status} resultIsError={agent.resultIsError} />
          <ChevronRight
            size={12}
            className={`text-muted/40 transition-transform duration-200 group-hover/row:text-muted/70 ${open ? "rotate-90" : ""}`}
          />
        </span>
      </button>
      {open && (
        <div className="mb-1.5 ml-[30px] rounded-lg border border-border/50 bg-panel/30 px-3 py-2.5">
          <AgentDetail agent={agent} depth={depth} />
        </div>
      )}
    </div>
  );
}

/**
 * Agents sidecar tab: a status roll-up bar over an overview of every delegated
 * agent in the chat (nested by provider-declared parent); tap a row to expand
 * the same detail as the in-chat card.
 */
export const AgentsPanel = memo(function AgentsPanel({
  agents,
  agentItems,
  items = [],
  instanceId,
  provider,
  pendingAgentId,
}: AgentsPanelProps) {
  const tree = useMemo(() => buildAgentTree(agents), [agents]);
  const summary = useMemo(() => buildSummary(agents), [agents]);
  const anchors = useMemo(() => buildAgentAnchorIndex(items, agents), [items, agents]);
  const contextValue = useMemo(
    () => ({ agents, agentItems, anchoredAgents: anchors, instanceId, provider, pendingAgentId }),
    [agents, agentItems, anchors, instanceId, provider, pendingAgentId],
  );

  return (
    <AgentCardsProvider value={contextValue}>
      {summary.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 px-3.5 py-2.5">
          {summary.map((chip) => (
            <span
              key={chip.label}
              className={`inline-flex items-center gap-1.5 text-[0.6875rem] ${chip.color}`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${chip.dot} ${chip.pulse ? "animate-pulse-dot" : ""}`}
              />
              <span className="tabular-nums font-medium">{chip.count}</span>
              <span className="text-muted/70">{chip.label}</span>
            </span>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        <div className="flex flex-col gap-0.5">
          {tree.map(({ agent, depth }) => (
            <AgentRow
              key={agent.agentId}
              agent={agent}
              depth={depth}
              items={agentItems[agent.agentId]}
              provider={provider}
              hasPendingRequest={pendingAgentId === agent.agentId}
            />
          ))}
        </div>
      </div>
    </AgentCardsProvider>
  );
});
