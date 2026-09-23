/**
 * SidebarSpaceGroup — A space entry in the project sidebar.
 *
 * Shows the space name + branch badge, and a context menu for
 * Complete, Mark as merged, Archive, and Rename actions.
 */

import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { getSpaceRoute } from "@/lib/project-route";
import {
  AlertTriangle,
  Archive,
  Check,
  GitBranch,
  GitMerge,
  MoreVertical,
  Pencil,
} from "lucide-react";
import { useSidebarActions } from "../../context/sidebar-actions-context";
import { Menu } from "../ui/menu";
import { Badge } from "../ui/badge";
import { Tooltip } from "../ui/tooltip";
import { TerminalRunningIndicator } from "../ui/terminal-running-indicator";
import { SpacePrStateChip } from "@/components/spaces/space-pr-badge";
import { dotClassToTextColor } from "../ui/session-indicator";
import { deriveInstanceStatusPresentation } from "@/lib/utils";
import { useUnreadStore, selectHasUnread } from "@/stores/unread-store";
import type { InstanceInfo, SpaceInfo } from "@shared/types";

interface SidebarSpaceGroupProps {
  space: SpaceInfo;
  projectId: string;
  latestChatId?: string;
  isActive: boolean;
  /** Chats belonging to this space — drives the aggregate branch-icon state. */
  chats?: InstanceInfo[];
}

export function SidebarSpaceGroup({
  space,
  projectId,
  latestChatId,
  isActive,
  chats,
}: SidebarSpaceGroupProps) {
  const actions = useSidebarActions();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const hasMenu = !space.isDefault;
  const isSpaceActive = space.status === "active";
  const isSpaceBroken = space.status === "broken";
  const isClosed = space.status === "completed" || space.status === "archived";
  const spaceRoute = getSpaceRoute(projectId, space.id, latestChatId);

  // Aggregate the live state of the space's chats onto the branch icon so
  // activity is visible without opening the space. Precedence (highest wins):
  // running (processing / waiting-on-permission) > error > unread > none.
  // Closed spaces stay on the baseline color.
  const members = chats ?? [];
  const pendingCount = members.filter((c) => c.status !== "stopped" && !!c.pendingTool).length;
  const runningCount = members.filter(
    (c) => c.status === "processing" || (c.status !== "stopped" && !!c.pendingTool),
  ).length;
  const errorCount = members.filter((c) => c.status === "error").length;
  const unreadCount = useUnreadStore((s) =>
    members.reduce((n, c) => n + (selectHasUnread(s, c.id, c.lastActivityAt) ? 1 : 0), 0),
  );

  let aggSynthetic: Pick<InstanceInfo, "status" | "external" | "pendingTool"> | null = null;
  let aggTooltip = "";
  if (!isClosed) {
    if (runningCount > 0) {
      aggSynthetic = {
        status: "processing",
        external: false,
        pendingTool: pendingCount > 0 ? "pending" : undefined,
      };
      aggTooltip =
        pendingCount > 0
          ? `${pendingCount} chat${pendingCount === 1 ? "" : "s"} waiting for permission`
          : `${runningCount} chat${runningCount === 1 ? "" : "s"} running`;
    } else if (errorCount > 0) {
      aggSynthetic = { status: "error", external: false, pendingTool: undefined };
      aggTooltip = `${errorCount} chat${errorCount === 1 ? "" : "s"} errored`;
    } else if (unreadCount > 0) {
      aggSynthetic = { status: "idle", external: false, pendingTool: undefined };
      aggTooltip = `${unreadCount} unread chat${unreadCount === 1 ? "" : "s"}`;
    }
  }
  const aggPresentation = aggSynthetic ? deriveInstanceStatusPresentation(aggSynthetic) : null;
  // Activity color overrides the active-space accent baseline.
  const branchColorClass = aggPresentation
    ? dotClassToTextColor(aggPresentation.dotClass)
    : isActive
      ? "text-accent"
      : "text-muted";
  const branchAnimate = aggPresentation?.dotClass.includes("animate-pulse-dot")
    ? "animate-pulse-dot"
    : "";

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEditing = () => {
    setEditValue(space.name);
    setEditing(true);
  };

  const commitEdit = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== space.name) {
      actions.renameSpace(space.id, trimmed);
    }
    setEditing(false);
  };

  return (
    <Link
      to={spaceRoute.to}
      params={spaceRoute.params}
      onClick={(e: React.MouseEvent) => {
        if (editing) e.preventDefault();
      }}
      className={`group relative flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 transition-all duration-150 ${
        isActive
          ? "bg-accent-dim text-accent"
          : isClosed
            ? "text-muted hover:bg-surface-hover"
            : "text-text hover:bg-surface-hover"
      }`}
    >
      {/* Branch icon — reflects the aggregate state of the space's chats */}
      <span className="absolute left-2 top-2 flex h-4 w-4 items-center justify-center">
        {aggTooltip ? (
          <Tooltip content={aggTooltip} side="right">
            <GitBranch
              size={12}
              strokeWidth={2.5}
              className={`${branchColorClass} ${branchAnimate}`}
            />
          </Tooltip>
        ) : (
          <GitBranch size={12} strokeWidth={2.5} className={branchColorClass} />
        )}
      </span>

      {/* Name + branch */}
      <div className="min-w-0 flex-1 pl-5">
        {editing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commitEdit();
              if (e.key === "Escape") setEditing(false);
            }}
            className="w-full rounded border border-border bg-surface px-1.5 py-1 text-[0.8125rem] font-medium leading-snug text-text-bright outline-none focus:border-accent"
          />
        ) : (
          <div className="flex items-center gap-1.5">
            <span
              className={`min-w-0 truncate text-[0.8125rem] leading-snug ${
                isActive
                  ? "font-semibold text-accent"
                  : isClosed
                    ? "font-medium text-muted"
                    : "font-medium text-text"
              }`}
            >
              {space.name}
            </span>
            {space.status === "broken" && (
              <Badge variant="warning" size="xs">
                Broken
              </Badge>
            )}
            {space.status === "completed" && (
              <Badge variant="success" size="xs">
                Merged
              </Badge>
            )}
            {space.status === "archived" && (
              <Badge variant="default" size="xs">
                Archived
              </Badge>
            )}
            <SpacePrStateChip space={space} />
            <TerminalRunningIndicator
              scope={{ type: "space", spaceId: space.id }}
              active={isActive}
            />
          </div>
        )}
        {!editing && space.gitBranch && (
          <div className="mt-0.5 flex items-center gap-1 truncate text-[0.6875rem] leading-tight text-muted">
            {isSpaceBroken && <AlertTriangle size={10} className="shrink-0 text-warning" />}
            <span className="truncate">{space.gitBranch}</span>
          </div>
        )}
      </div>

      {/* Context menu — active and broken spaces can still be renamed/archived */}
      {hasMenu && (isSpaceActive || isSpaceBroken) && (
        <span className="relative ml-auto flex w-10 shrink-0 items-center justify-end self-start">
          {menuOpen ? (
            <Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
              <Menu.Trigger
                onClick={(e: React.MouseEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                className="absolute inset-0 flex items-start justify-end rounded pt-px text-muted hover:!text-text"
              >
                <MoreVertical size={16} />
              </Menu.Trigger>
              <Menu.Content>
                <Menu.Item
                  onClick={(e: React.MouseEvent) => {
                    e.stopPropagation();
                    startEditing();
                  }}
                >
                  <Pencil size={13} strokeWidth={2} className="text-muted" />
                  Rename
                </Menu.Item>
                {isSpaceActive && (
                  <>
                    <Menu.Item
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        actions.completeSpace(space.id);
                      }}
                    >
                      <GitMerge size={13} strokeWidth={2} className="text-muted" />
                      Complete
                    </Menu.Item>
                    <Menu.Item
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        actions.markSpaceMerged(space.id);
                      }}
                    >
                      <Check size={13} strokeWidth={2} className="text-muted" />
                      Mark as merged
                    </Menu.Item>
                    <Menu.Separator />
                  </>
                )}
                <Menu.Item
                  danger
                  onClick={(e: React.MouseEvent) => {
                    e.stopPropagation();
                    actions.deleteSpace(space.id);
                  }}
                >
                  <Archive size={13} strokeWidth={2} />
                  Archive
                </Menu.Item>
              </Menu.Content>
            </Menu.Root>
          ) : (
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenuOpen(true);
              }}
              className="sidebar-menu-trigger absolute inset-0 flex items-start justify-end rounded pt-px text-muted/60 opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:!text-text"
            >
              <MoreVertical size={16} />
            </button>
          )}
        </span>
      )}
    </Link>
  );
}
