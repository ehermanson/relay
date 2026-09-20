import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, ShieldAlert } from "lucide-react";
import type { AgentInfo } from "@shared/types";
import { getAgentLastActivity, getAgentSubtitle, getAgentTitle, isAgentActive } from "@/lib/agents";
import { AgentStatusBadge } from "@/components/chat/agent-status-badge";
import { AgentAvatar } from "@/components/chat/agent-avatar";
import { AgentDetail } from "@/components/chat/agent-detail";
import { useAgentCards } from "@/components/chat/agent-card-context";
import { useAgentModelLabel } from "@/hooks/use-agent-model";

interface AgentCardProps {
  agent: AgentInfo;
  /** Result text when the agent has no `result` yet — e.g. the delegation tool_result detail. */
  fallbackResult?: string;
  defaultExpanded?: boolean;
  /** Nesting depth (0 = top-level). Deeper cards get a flatter frame. */
  depth?: number;
}

/**
 * Collapsed in-chat card for a delegated agent. Two compact lines: identity
 * (avatar · name · model) over a quiet activity/result preview, with the
 * status and a chevron trailing. Failures and attention badges stay visible
 * while collapsed. Expanding mounts `AgentDetail`, which fetches history on
 * demand.
 *
 * Nested transcript, chat id, provider and the pending-request owner all come
 * from `AgentCardsContext` — every surface that renders cards provides it.
 */
export function AgentCard({
  agent,
  fallbackResult,
  defaultExpanded = false,
  depth = 0,
}: AgentCardProps) {
  const ctx = useAgentCards();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasBeenExpanded = useRef(defaultExpanded);
  if (expanded) hasBeenExpanded.current = true;

  const items = ctx?.agentItems[agent.agentId];
  const hasPendingRequest = !!ctx?.pendingAgentId && ctx.pendingAgentId === agent.agentId;
  const title = getAgentTitle(agent);
  const subtitle = getAgentSubtitle(agent);
  const active = isAgentActive(agent.status);
  const modelLabel = useAgentModelLabel(ctx?.instanceId, agent, ctx?.provider);

  // Collapsed second line — the "what's it doing / what was it for" glance.
  // While active it's the live activity; a failure shows why; once finished we
  // show the agent's purpose (its description), never a truncated dump of the
  // report — the full report is one expand away in the Result section.
  const lastActivity = getAgentLastActivity(agent, items);
  let preview: string | undefined;
  let previewIsError = false;
  if (agent.status === "failed") {
    preview = agent.statusDetail ?? subtitle;
    previewIsError = true;
  } else if (agent.status === "waiting") {
    preview = agent.statusDetail ?? lastActivity ?? subtitle;
  } else if (active) {
    preview = lastActivity ?? subtitle;
  } else {
    preview = subtitle ?? agent.statusDetail;
  }
  const previewText = preview;

  const frame =
    depth > 0
      ? "rounded-md border border-border/40 bg-surface/30"
      : "rounded-lg border border-border/50 bg-panel/30";

  return (
    <div className={`flex flex-col ${frame}`} data-agent-card={agent.agentId}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="group/agent flex w-full items-center gap-2.5 rounded-[inherit] px-2.5 py-2 text-left transition-colors hover:bg-panel-content/60"
      >
        <AgentAvatar agent={agent} size={22} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[0.8125rem] font-medium leading-tight text-text">
              {title}
            </span>
            {modelLabel && (
              <span className="shrink-0 whitespace-nowrap rounded bg-surface-hover px-1.5 py-px text-[0.5625rem] font-medium text-muted/80 max-[768px]:hidden">
                {modelLabel}
              </span>
            )}
            {hasPendingRequest && (
              <span
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-warning/10 px-1.5 py-px text-[0.5625rem] font-medium text-warning"
                title="This agent is waiting on a permission decision"
              >
                <ShieldAlert size={9} />
                Needs approval
              </span>
            )}
          </span>
          {previewText && (
            <span
              className={`mt-0.5 block truncate text-[0.6875rem] leading-tight ${
                previewIsError ? "text-error/90" : "text-muted"
              }`}
            >
              {previewText}
            </span>
          )}
        </span>
        <AgentStatusBadge status={agent.status} resultIsError={agent.resultIsError} />
        <ChevronRight
          size={12}
          className={`shrink-0 text-muted/40 transition-transform duration-200 group-hover/agent:text-muted/70 ${
            expanded ? "rotate-90" : ""
          }`}
        />
      </button>
      <AnimatePresence initial={false}>
        {expanded && hasBeenExpanded.current && (
          <motion.div
            key="detail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] },
              opacity: { duration: 0.15 },
            }}
            className="overflow-hidden"
          >
            <div className="border-t border-border/50 px-3 py-2.5">
              <AgentDetail agent={agent} fallbackResult={fallbackResult} depth={depth} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
