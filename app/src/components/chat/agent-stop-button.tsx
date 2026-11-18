import { Square } from "lucide-react";
import type { AgentInfo } from "@shared/types";
import { isAgentActive } from "@/lib/agents";

/**
 * Stop for one running provider agent (Claude `stopTask`). Renders nothing when
 * the chat's provider can't stop a single agent (no `onStop`), for agents that
 * have finished or have no provider task id yet, and for Relay-delegated tasks,
 * which are stopped through their own card.
 */
export function AgentStopButton({
  agent,
  onStop,
}: {
  agent: AgentInfo;
  onStop?: (providerAgentId: string) => void;
}) {
  const providerAgentId = agent.providerAgentId;
  if (!onStop || !providerAgentId || agent.origin === "relay" || !isAgentActive(agent.status)) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onStop(providerAgentId);
      }}
      title="Stop this agent"
      aria-label="Stop this agent"
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted/50 transition-colors hover:bg-surface-hover hover:text-error max-[768px]:h-10 max-[768px]:w-10"
    >
      <Square size={10} fill="currentColor" />
    </button>
  );
}
