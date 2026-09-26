import { useState, useRef, useEffect } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { GitBranch, MoreVertical, Pin } from "lucide-react";
import { Menu } from "@/components/ui/menu";
import { Badge } from "@/components/ui/badge";
import { SessionIndicator } from "@/components/ui/session-indicator";
import { TerminalRunningIndicator } from "@/components/ui/terminal-running-indicator";
import { Tooltip } from "@/components/ui/tooltip";
import type { TerminalScope } from "@shared/types";
import { useSidebarActions } from "../../context/sidebar-actions-context";
import { getInstanceProjectRouteId } from "@/lib/project-route";
import { formatTimeAgo, getChatSortTimestamp } from "@/lib/utils";
import { useUnreadStore, selectHasUnread } from "@/stores/unread-store";
import { ChatActionsMenuContent } from "./chat-actions-menu";
import type { InstanceInfo, SpaceInfo } from "@shared/types";

interface SidebarItemProps {
  instance: InstanceInfo;
  isActive: boolean;
  isChild?: boolean;
  parentInstance?: { id: string; name: string };
  to: string;
  params: Record<string, string>;
  /** Currently active chatId — used to offer "Open in split view". */
  activeChatId?: string;
  /** Status of the owning space, when the chat belongs to one. */
  spaceStatus?: SpaceInfo["status"];
}

export function SidebarItem({
  instance,
  isActive,
  isChild,
  parentInstance,
  to,
  params,
  activeChatId,
  spaceStatus,
}: SidebarItemProps) {
  const navigate = useNavigate({ from: "/projects/$projectId/chats/$chatId" });
  const actions = useSidebarActions();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Terminals attach to the space when the chat belongs to one, else to the
  // chat itself — mirror the scope the chat view uses to open terminals.
  const terminalScope: TerminalScope = instance.spaceId
    ? { type: "space", spaceId: instance.spaceId }
    : { type: "instance", instanceId: instance.id };
  const hasMenu = true; // always show menu for rename/delete

  // Focus input when entering edit mode
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEditing = () => {
    setEditValue(instance.name);
    setEditing(true);
  };

  const commitEdit = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== instance.name) {
      actions.renameInstance(instance.id, trimmed);
    }
    setEditing(false);
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      commitEdit();
    } else if (e.key === "Escape") {
      setEditing(false);
    }
  };

  const unread = useUnreadStore((s) => selectHasUnread(s, instance.id, instance.lastActivityAt));
  const recencyAt = getChatSortTimestamp(instance);

  // For non-external sessions the indicator mounts/unmounts; fade it out gracefully.
  const showIndicator = unread || !!instance.external;
  const [indicatorMounted, setIndicatorMounted] = useState(showIndicator);
  const [indicatorFading, setIndicatorFading] = useState(false);
  useEffect(() => {
    if (showIndicator) {
      setIndicatorMounted(true);
      setIndicatorFading(false);
    } else if (indicatorMounted) {
      setIndicatorFading(true);
      const timer = setTimeout(() => {
        setIndicatorMounted(false);
        setIndicatorFading(false);
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [showIndicator]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Link
      to={to}
      params={params}
      data-chat-id={instance.id}
      onClick={(e: React.MouseEvent) => {
        if (editing) e.preventDefault();
      }}
      className={`group relative flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 transition-all duration-150 ${
        isChild ? "pl-7" : ""
      } ${isActive ? "bg-accent-dim text-accent" : "text-text hover:bg-surface-hover"}`}
    >
      {/* Session indicator — always reserves space; content fades in/out */}
      <SessionIndicator
        instance={instance}
        unread={unread}
        visible={indicatorMounted}
        fading={indicatorFading}
      />
      {/* Name + preview */}
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleEditKeyDown}
            onBlur={commitEdit}
            onClick={(e) => e.stopPropagation()}
            className="w-full rounded border border-border bg-surface px-1.5 py-1 text-[0.8125rem] font-medium leading-snug text-text-bright outline-none focus:border-accent"
          />
        ) : (
          <div className="flex min-w-0 items-center gap-1.5">
            <div
              className={`min-w-0 truncate text-[0.8125rem] leading-snug ${isActive ? "font-semibold text-accent" : "font-medium text-text"}`}
            >
              {instance.name}
            </div>
            {instance.pinned ? (
              <Pin size={10} className="shrink-0 fill-current text-muted" />
            ) : null}
            {instance.review ? (
              <Badge size="xs" variant={isActive ? "accent" : "default"}>
                Review
              </Badge>
            ) : null}
            <TerminalRunningIndicator scope={terminalScope} active={isActive} />
          </div>
        )}
        {!editing && instance.gitBranch && (
          <div className="mt-0.5 flex items-center gap-1 truncate text-[0.6875rem] leading-tight text-muted">
            <GitBranch size={10} strokeWidth={2.5} className="shrink-0" />
            <span className="truncate">{instance.gitBranch}</span>
          </div>
        )}
        {!editing && isChild && parentInstance && (
          <Tooltip content={`Continued from "${parentInstance.name}"`} side="bottom">
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigate({
                  to: "/projects/$projectId/chats/$chatId",
                  params: {
                    projectId: getInstanceProjectRouteId(instance),
                    chatId: parentInstance.id,
                  },
                });
              }}
              className="mt-0.5 max-w-full truncate text-[0.6875rem] leading-tight text-muted transition-colors hover:text-accent"
            >
              <span className="mr-0.5">{"\u21B3"}</span> from {parentInstance.name}
            </button>
          </Tooltip>
        )}
      </div>

      {/* Right slot: timestamp (default) ↔ menu trigger (hover) */}
      {!editing && (
        <span
          className={`relative ml-auto flex w-10 shrink-0 items-center justify-end self-start${hasMenu ? " sidebar-slot-has-menu" : ""}`}
        >
          {/* Timestamp — fades out on hover (kept visible on touch via CSS) */}
          {recencyAt > 0 && (
            <span
              className={`sidebar-timestamp-fade pt-px text-[0.625rem] text-muted/50 transition-opacity duration-150${hasMenu ? " group-hover:opacity-0" : ""}${menuOpen ? " !opacity-0" : ""}`}
            >
              {formatTimeAgo(recencyAt)}
            </span>
          )}

          {/* Menu trigger — fades in on hover (always visible on touch via CSS) */}
          {hasMenu &&
            (menuOpen ? (
              <Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
                <Menu.Trigger
                  onClick={(e: React.MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  className="absolute inset-0 flex items-start justify-end rounded pt-0.5 text-muted hover:!text-text"
                >
                  <MoreVertical size={16} />
                </Menu.Trigger>
                <ChatActionsMenuContent
                  instance={instance}
                  spaceStatus={spaceStatus}
                  activeChatId={activeChatId}
                  onRename={startEditing}
                />
              </Menu.Root>
            ) : (
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenuOpen(true);
                }}
                className="sidebar-menu-trigger absolute inset-0 flex items-start justify-end rounded pt-0.5 text-muted/60 opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:!text-text"
              >
                <MoreVertical size={16} />
              </button>
            ))}
        </span>
      )}
    </Link>
  );
}
