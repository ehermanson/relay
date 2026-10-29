import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Square } from "lucide-react";
import { toast } from "sonner";
import type { AgentInfo } from "@shared/types";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { useChatById } from "@/hooks/use-chat-by-id";
import { isAgentActive } from "@/lib/agents";
import { cancelDelegatedTask } from "@/lib/api";
import { relayTaskIdOf } from "@/lib/delegation";
import { getInstanceChatRoute } from "@/lib/project-route";

/** Child-provider logo + "Delegated" marker for a Relay child (`origin: "relay"`). */
export function RelayAgentMarker({ agent }: { agent: AgentInfo }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-surface-hover px-1.5 py-px text-[0.5625rem] font-medium text-muted/80"
      title="Delegated to its own chat"
    >
      {agent.childProvider && (
        <ProviderLogo provider={agent.childProvider} className="h-2.5 w-2.5" />
      )}
      Delegated
    </span>
  );
}

/**
 * "Open chat" and Stop for a Relay child. The child is a full chat, so the way
 * to interact with it is to open it; Stop cancels the delegated task (the
 * server stops the child and its own delegates).
 */
export function RelayAgentActions({ agent }: { agent: AgentInfo }) {
  const child = useChatById(agent.childInstanceId);
  const taskId = relayTaskIdOf(agent);
  const [stopping, setStopping] = useState(false);
  const active = isAgentActive(agent.status);

  const stop = () => {
    if (!taskId || stopping) return;
    setStopping(true);
    cancelDelegatedTask(taskId)
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : "Failed to stop the delegated task"),
      )
      .finally(() => setStopping(false));
  };

  const route = child ? getInstanceChatRoute(child) : null;
  const buttonClass =
    "inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[0.6875rem] font-medium text-text transition-colors hover:bg-surface-hover disabled:opacity-50 max-[768px]:min-h-10 max-[768px]:px-3";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {route ? (
        <Link to={route.to} params={route.params} className={buttonClass}>
          <ArrowUpRight size={12} />
          Open chat
        </Link>
      ) : (
        <button type="button" disabled className={buttonClass} title="Chat not loaded yet">
          <ArrowUpRight size={12} />
          Open chat
        </button>
      )}
      {active && taskId && (
        <button type="button" onClick={stop} disabled={stopping} className={buttonClass}>
          <Square size={10} />
          {stopping ? "Stopping…" : "Stop"}
        </button>
      )}
    </div>
  );
}
