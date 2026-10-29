import { Link } from "@tanstack/react-router";
import { CornerUpLeft } from "lucide-react";
import type { InstanceInfo } from "@shared/types";
import { useChatById } from "@/hooks/use-chat-by-id";
import { getInstanceChatRoute } from "@/lib/project-route";

/**
 * Breadcrumb at the top of a Relay-delegated child chat: "Delegated by
 * <parent>", linking back. A child has no inbox/sidebar row of its own, so
 * this is the way back to the chat that owns it. Renders the same on desktop
 * and mobile.
 */
export function DelegatedChildBanner({ instance }: { instance: Pick<InstanceInfo, "delegation"> }) {
  const parentId = instance.delegation?.parentInstanceId;
  const parent = useChatById(parentId);
  if (!parentId) return null;
  const route = parent ? getInstanceChatRoute(parent) : null;
  const label = parent?.name ?? "another chat";
  return (
    <div
      role="note"
      className="flex shrink-0 items-center gap-2 border-b border-border/50 bg-panel/40 px-4 py-1.5 text-[0.75rem] text-muted max-[768px]:px-3"
    >
      <CornerUpLeft size={13} className="shrink-0 text-muted/70" />
      <span className="min-w-0 truncate">
        Delegated by{" "}
        {route ? (
          <Link
            to={route.to}
            params={route.params}
            className="font-medium text-text hover:underline max-[768px]:inline-flex max-[768px]:min-h-10 max-[768px]:items-center"
          >
            {label}
          </Link>
        ) : (
          <span className="font-medium text-text">{label}</span>
        )}
      </span>
    </div>
  );
}
