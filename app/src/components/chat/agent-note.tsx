import type { AgentInfo } from "@shared/types";
import { MarkdownContent } from "@/components/chat/markdown-content";
import { AgentAvatar, getAgentAccent } from "@/components/chat/agent-avatar";
import { formatTimestamp } from "@/lib/utils";

interface AgentNoteProps {
  text: string;
  /** Sender display name as reported by the provider. */
  name?: string;
  /** Relay agent key, so the note shares its sender's identity colour. */
  agentId?: string;
  timestamp?: number;
}

/**
 * Inbound agent-to-agent message (a peer or child reporting to the
 * orchestrator). Deliberately left-aligned and framed as reported speech so it
 * can never be mistaken for something the human typed — it does not reuse
 * `UserMessage` styling. Carries the sender's identity avatar/colour so it
 * reads as the same agent shown in the cards and sidecar.
 */
export function AgentNote({ text, name, agentId, timestamp }: AgentNoteProps) {
  const sender = name?.trim() || "an agent";
  const identity: AgentInfo = { agentId: agentId ?? name ?? "agent", name };
  const accent = getAgentAccent(identity);
  return (
    <div className={`flex flex-col gap-1.5 border-l-2 pl-4 max-[768px]:pl-3 ${accent.railBorder}`} data-agent-note>
      <div className="flex items-center gap-1.5 text-[0.6875rem] text-muted">
        <AgentAvatar agent={identity} size={18} />
        <span className="font-medium text-text">Message from {sender}</span>
        {timestamp ? (
          <span className="tabular-nums text-muted/60">· {formatTimestamp(timestamp)}</span>
        ) : null}
      </div>
      <div className="rounded-lg border border-border/60 bg-panel/40 px-3.5 py-2.5 text-[0.8125rem] max-[768px]:text-[16px]">
        <MarkdownContent text={text} />
      </div>
    </div>
  );
}
