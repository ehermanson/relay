import { Link } from "@tanstack/react-router";
import { GitBranch, Pin } from "lucide-react";
import { StatusDot } from "@/components/ui/status-dot";
import { getInstanceChatRoute } from "@/lib/project-route";
import {
  deriveInstanceStatusPresentation,
  formatModel,
  formatTimeAgo,
  getChatSortTimestamp,
} from "@/lib/utils";
import type { InstanceInfo } from "@shared/types";

/**
 * Dense chat row for the mobile project chat list.
 * Row 1: status dot · name (truncated) · time-ago. Row 2 (optional): space
 * branch tag · model. Space chats are tagged so the flat list stays legible.
 */
export function ChatListRow({
  instance,
  showModel = false,
  spaceLabel,
}: {
  instance: InstanceInfo;
  showModel?: boolean;
  spaceLabel?: string;
}) {
  const route = getInstanceChatRoute(instance);
  const recencyAt = getChatSortTimestamp(instance);
  const model = instance.stats?.model;
  const showSecondRow = !!spaceLabel || (showModel && !!model);

  return (
    <Link
      to={route.to}
      params={route.params}
      className="flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-surface-hover"
    >
      <StatusDot variant={deriveInstanceStatusPresentation(instance).variant} size={6} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-text">
            {instance.name}
          </span>
          {instance.pinned && <Pin size={10} className="shrink-0 fill-current text-muted" />}
          {recencyAt > 0 && (
            <span className="shrink-0 text-[0.625rem] text-muted">{formatTimeAgo(recencyAt)}</span>
          )}
        </div>
        {showSecondRow && (
          <div className="mt-0.5 flex items-center gap-2 text-[0.625rem] text-muted">
            {spaceLabel && (
              <span className="flex min-w-0 items-center gap-1 text-accent/80">
                <GitBranch size={10} className="shrink-0" />
                <span className="truncate">{spaceLabel}</span>
              </span>
            )}
            {showModel && model && <span className="shrink-0">{formatModel(model)}</span>}
          </div>
        )}
      </div>
    </Link>
  );
}
