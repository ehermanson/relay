/**
 * The mark a chat carries when it belongs to a Workstream: a coloured dot and
 * the Workstream's name. Colour is identity only (keyed by id), never status.
 */

import { useSidebarLayout } from "@/hooks/use-global-settings";
import { useWorkstreams } from "@/hooks/use-workstreams";
import { getWorkstreamAccent } from "@/lib/workstreams";
import { useWorkstreamUiStore } from "@/stores/workstream-ui-store";
import type { Workstream } from "@shared/types";

export function WorkstreamDot({
  workstream,
  className = "",
}: {
  workstream: Pick<Workstream, "id">;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${getWorkstreamAccent(workstream).dot} ${className}`}
    />
  );
}

/** Inline label for dense rows: dot + name in the accent colour, no chip chrome. */
export function WorkstreamLabel({ workstream }: { workstream: Workstream }) {
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1 ${getWorkstreamAccent(workstream).text}`}
    >
      <WorkstreamDot workstream={workstream} />
      <span className="min-w-0 truncate">{workstream.name}</span>
    </span>
  );
}

/** A chat row's Workstream label, or nothing when the chat has none. */
export function ChatWorkstreamLabel({ instanceId }: { instanceId: string }) {
  const { workstreamFor } = useWorkstreams();
  const workstream = workstreamFor(instanceId);
  if (!workstream) return null;
  return (
    <>
      <span className="shrink-0 text-muted/40">·</span>
      <WorkstreamLabel workstream={workstream} />
    </>
  );
}

/** A Projects-layout row's Workstream label on its own line, or nothing. */
export function ChatWorkstreamLine({ instanceId }: { instanceId: string }) {
  const { workstreamFor } = useWorkstreams();
  const workstream = workstreamFor(instanceId);
  if (!workstream) return null;
  return (
    <div className="mt-0.5 flex min-w-0 text-[0.6875rem] leading-tight">
      <WorkstreamLabel workstream={workstream} />
    </div>
  );
}

/**
 * Chat-header chip. In the Inbox layout, clicking it opens the Workstream's
 * folder in the sidebar, which is where its other chats are. The Projects
 * layout has no folders, so there it is a plain label.
 */
export function ChatWorkstreamChip({ instanceId }: { instanceId: string }) {
  const { workstreamFor } = useWorkstreams();
  const reveal = useWorkstreamUiStore((s) => s.reveal);
  const hasFolders = useSidebarLayout() === "inbox";
  const workstream = workstreamFor(instanceId);
  if (!workstream) return null;
  const accent = getWorkstreamAccent(workstream);
  const className = `inline-flex min-w-0 max-w-[12rem] shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-[0.6875rem] font-medium ${accent.softBg} ${accent.text}`;
  const content = (
    <>
      <WorkstreamDot workstream={workstream} />
      <span className="min-w-0 truncate">{workstream.name}</span>
    </>
  );
  if (!hasFolders) {
    return (
      <span title={`Workstream: ${workstream.name}`} className={className}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => reveal(workstream.id)}
      title={`Workstream: ${workstream.name}`}
      className={`${className} transition-opacity hover:opacity-80`}
    >
      {content}
    </button>
  );
}
