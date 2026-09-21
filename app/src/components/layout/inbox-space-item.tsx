/**
 * The one inbox destination for a named Space.
 *
 * Chats inside a Space deliberately do not render as sibling inbox rows: the
 * Space owns their aggregate activity here, while its own view owns switching
 * between individual chats.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  Archive,
  Check,
  ChevronRight,
  CircleAlert,
  GitBranch,
  GitMerge,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Menu } from "@/components/ui/menu";
import { ProjectAvatar } from "@/components/ui/project-avatar";
import { TerminalRunningIndicator } from "@/components/ui/terminal-running-indicator";
import { Tooltip } from "@/components/ui/tooltip";
import { useSidebarActions } from "@/context/sidebar-actions-context";
import type { InboxSpaceEntry } from "@/lib/inbox";
import { getInboxSpaceRoute } from "@/lib/space-navigation";
import { formatTimeAgo } from "@/lib/utils";
import { selectHasUnread, useUnreadStore } from "@/stores/unread-store";
import type { InstanceInfo } from "@shared/types";

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function attentionLabel(instance: InstanceInfo) {
  if (instance.pendingPlan) return "Plan needs approval";
  if (instance.pendingPermission?.kind === "user_input") return "Needs your answer";
  if (instance.pendingPermission?.kind === "terminal_input") return "Needs terminal input";
  if (instance.pendingPermission || instance.pendingTool) return "Waiting for permission";
  if (instance.status === "error") return "Chat error";
  return "Needs attention";
}

function SpaceGlyph({
  entry,
  unreadCount,
  isActive,
  size = 18,
}: {
  entry: InboxSpaceEntry;
  unreadCount: number;
  isActive: boolean;
  size?: number;
}) {
  const isClosed = entry.space.status === "completed" || entry.space.status === "archived";
  const hasAttention = !isClosed && entry.attentionInstances.length > 0;
  const isWorking = !isClosed && entry.workingCount > 0;
  const quiet = !hasAttention && !isWorking && unreadCount === 0 && !isActive;
  const indicatorClass = hasAttention
    ? "bg-warning animate-pulse-dot"
    : isWorking
      ? "bg-accent animate-pulse-dot"
      : "bg-accent";

  return (
    <Tooltip
      side="right"
      content={
        hasAttention
          ? `${entry.space.name} · ${plural(entry.attentionInstances.length, "chat")} need attention`
          : isWorking
            ? `${entry.space.name} · ${plural(entry.workingCount, "chat")} working`
            : unreadCount > 0
              ? `${entry.space.name} · ${plural(unreadCount, "unread chat")}`
              : `${entry.projectName} · ${entry.space.name} · ${plural(entry.instances.length, "chat")}`
      }
    >
      <span
        className="relative mt-0.5 flex shrink-0 items-center justify-center"
        style={{ height: size, width: size }}
      >
        <ProjectAvatar
          iconPath={entry.iconPath}
          name={entry.projectName}
          size={size}
          className={`rounded-[3px] transition-[filter,opacity] duration-200 ${
            quiet ? "opacity-70 grayscale group-hover:opacity-100 group-hover:grayscale-0" : ""
          }`}
          fallbackClassName="text-muted/70"
        />
        <GitBranch
          size={Math.max(9, Math.round(size * 0.56))}
          strokeWidth={2.75}
          className={`absolute -bottom-1 -left-1 rounded-[2px] bg-surface p-px ${
            isActive ? "text-accent" : "text-text-bright"
          }`}
        />
        {(hasAttention || isWorking || unreadCount > 0) && (
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-[7px] w-[7px] rounded-full ring-2 ring-surface ${indicatorClass}`}
          />
        )}
      </span>
    </Tooltip>
  );
}

function SpaceActionsMenuContent({
  entry,
  onRename,
}: {
  entry: InboxSpaceEntry;
  onRename: () => void;
}) {
  const actions = useSidebarActions();
  const { space } = entry;
  const canManage = space.status === "active" || space.status === "broken";

  return (
    <Menu.Content>
      <Menu.Item
        onClick={(event: React.MouseEvent) => {
          event.stopPropagation();
          actions.pinSpace(space.id, !entry.pinned);
        }}
      >
        {entry.pinned ? (
          <PinOff size={13} className="text-muted" />
        ) : (
          <Pin size={13} className="text-muted" />
        )}
        {entry.pinned ? "Unpin" : "Pin"}
      </Menu.Item>
      {canManage && (
        <>
          <Menu.Item
            onClick={(event: React.MouseEvent) => {
              event.stopPropagation();
              onRename();
            }}
          >
            <Pencil size={13} className="text-muted" />
            Rename
          </Menu.Item>
          {space.status === "active" && (
            <>
              <Menu.Item
                onClick={(event: React.MouseEvent) => {
                  event.stopPropagation();
                  actions.completeSpace(space.id);
                }}
              >
                <GitMerge size={13} className="text-muted" />
                Complete
              </Menu.Item>
              <Menu.Item
                onClick={(event: React.MouseEvent) => {
                  event.stopPropagation();
                  actions.markSpaceMerged(space.id);
                }}
              >
                <Check size={13} className="text-muted" />
                Mark as merged
              </Menu.Item>
            </>
          )}
          <Menu.Separator />
          <Menu.Item
            danger
            onClick={(event: React.MouseEvent) => {
              event.stopPropagation();
              actions.deleteSpace(space.id);
            }}
          >
            <Archive size={13} />
            Archive
          </Menu.Item>
        </>
      )}
    </Menu.Content>
  );
}

function AttentionAction({
  entry,
  compact = false,
}: {
  entry: InboxSpaceEntry;
  compact?: boolean;
}) {
  const navigate = useNavigate();
  const attention = entry.attentionInstances;
  const isClosed = entry.space.status === "completed" || entry.space.status === "archived";
  if (isClosed || attention.length === 0) return null;

  const hasError = attention.some((instance) => instance.status === "error");
  const triggerClass = compact
    ? "absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-warning text-warning-foreground shadow-sm ring-2 ring-surface max-[768px]:static max-[768px]:h-10 max-[768px]:w-10"
    : "flex h-6 shrink-0 items-center gap-1 rounded-md bg-warning/10 px-1.5 text-[0.625rem] font-medium text-warning transition-colors hover:bg-warning/20 max-[768px]:h-10";

  if (attention.length === 1) {
    const instance = attention[0];
    return (
      <Tooltip content={attentionLabel(instance)} side="top">
        <Link
          {...getInboxSpaceRoute(entry, instance.id)}
          aria-label={`Open ${instance.name}: ${attentionLabel(instance)}`}
          onClick={(event: React.MouseEvent) => event.stopPropagation()}
          className={triggerClass}
        >
          <CircleAlert size={compact ? 11 : 12} strokeWidth={2.5} />
          {!compact && <span>{hasError ? "Needs attention" : "Needs input"}</span>}
        </Link>
      </Tooltip>
    );
  }

  return (
    <Menu.Root>
      <Tooltip content={`${plural(attention.length, "chat")} need attention`} side="top">
        <Menu.Trigger
          aria-label={`Choose one of ${attention.length} chats needing attention`}
          onClick={(event: React.MouseEvent) => event.stopPropagation()}
          className={triggerClass}
        >
          <CircleAlert size={compact ? 11 : 12} strokeWidth={2.5} />
          {!compact && (
            <span>
              {attention.length} need {hasError ? "attention" : "input"}
            </span>
          )}
        </Menu.Trigger>
      </Tooltip>
      <Menu.Content
        side={compact ? "right" : "bottom"}
        align={compact ? "start" : "end"}
        className="w-60"
      >
        {attention.map((instance) => (
          <Menu.Item
            key={instance.id}
            className="!items-start !gap-2"
            onClick={() => navigate(getInboxSpaceRoute(entry, instance.id))}
          >
            <CircleAlert size={13} className="mt-0.5 shrink-0 text-warning" />
            <span className="min-w-0">
              <span className="block truncate">{instance.name}</span>
              <span className="block truncate text-[0.6875rem] text-muted">
                {attentionLabel(instance)}
              </span>
            </span>
            <ChevronRight size={13} className="ml-auto mt-0.5 shrink-0 text-muted" />
          </Menu.Item>
        ))}
      </Menu.Content>
    </Menu.Root>
  );
}

function SpaceRowDetails({
  entry,
  isActive,
  unreadCount,
  attentionAction,
}: {
  entry: InboxSpaceEntry;
  isActive: boolean;
  unreadCount: number;
  attentionAction?: ReactNode;
}) {
  const { space } = entry;
  const isClosed = space.status === "completed" || space.status === "archived";
  const chatCount = entry.instances.length;

  return (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-1 pr-10 text-[0.6875rem] leading-tight text-muted">
        <span className="min-w-0 truncate font-medium text-muted/80">{entry.projectName}</span>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5">
        <span
          className={`min-w-0 truncate text-[0.8125rem] leading-snug ${isActive ? "font-semibold text-accent" : "font-medium text-text"}`}
        >
          {space.name}
        </span>
        {entry.pinned && <Pin size={10} className="shrink-0 fill-current text-muted" />}
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
        <TerminalRunningIndicator scope={{ type: "space", spaceId: space.id }} active={isActive} />
      </div>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-[0.6875rem] leading-tight text-muted/70">
        <span className="shrink-0">{plural(chatCount, "chat")}</span>
        {!isClosed && entry.workingCount > 0 && (
          <>
            <span className="text-muted/40">·</span>
            <span className="shrink-0 text-accent">{entry.workingCount} working</span>
          </>
        )}
        {unreadCount > 0 && (
          <>
            <span className="text-muted/40">·</span>
            <span className="shrink-0">{unreadCount} unread</span>
          </>
        )}
        {attentionAction && (
          <span className="pointer-events-auto ml-0.5 shrink-0">{attentionAction}</span>
        )}
      </div>
    </div>
  );
}

function CompactRenameSpaceDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: InboxSpaceEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const actions = useSidebarActions();
  const [value, setValue] = useState(entry.space.name);

  useEffect(() => {
    if (open) setValue(entry.space.name);
  }, [entry.space.name, open]);

  const commit = () => {
    const name = value.trim();
    if (name && name !== entry.space.name) actions.renameSpace(entry.space.id, name);
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="max-w-sm">
        <Dialog.Title>Rename space</Dialog.Title>
        <Input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") onOpenChange(false);
          }}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={commit}>
            Rename
          </Button>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}

export function InboxSpaceItem({
  entry,
  isActive,
  compact = false,
}: {
  entry: InboxSpaceEntry;
  isActive: boolean;
  compact?: boolean;
}) {
  const actions = useSidebarActions();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const unreadCount = useUnreadStore((state) =>
    entry.instances.reduce(
      (count, instance) =>
        count + (selectHasUnread(state, instance.id, instance.lastActivityAt) ? 1 : 0),
      0,
    ),
  );
  const isClosed = entry.space.status === "completed" || entry.space.status === "archived";

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEditing = () => {
    setEditValue(entry.space.name);
    setEditing(true);
  };
  const commitEdit = () => {
    const name = editValue.trim();
    if (name && name !== entry.space.name) actions.renameSpace(entry.space.id, name);
    setEditing(false);
  };

  if (compact) {
    return (
      <>
        <Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <span className="group relative flex h-9 w-9 shrink-0 items-center justify-center max-[768px]:h-auto max-[768px]:w-10 max-[768px]:flex-col">
            <Link
              {...getInboxSpaceRoute(entry)}
              aria-label={`Open space ${entry.space.name}`}
              onContextMenu={(event: React.MouseEvent) => {
                event.preventDefault();
                setMenuOpen(true);
              }}
              className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-150 max-[768px]:h-10 max-[768px]:w-10 ${isActive ? "bg-accent-dim" : "hover:bg-surface-hover"}`}
            >
              <SpaceGlyph entry={entry} unreadCount={unreadCount} isActive={isActive} size={20} />
            </Link>
            <AttentionAction entry={entry} compact />
            <Menu.Trigger
              aria-hidden
              tabIndex={-1}
              className="pointer-events-none absolute inset-y-0 right-0 w-px opacity-0"
            >
              <span />
            </Menu.Trigger>
          </span>
          <SpaceActionsMenuContent entry={entry} onRename={() => setEditing(true)} />
        </Menu.Root>
        <CompactRenameSpaceDialog entry={entry} open={editing} onOpenChange={setEditing} />
      </>
    );
  }

  return (
    <div
      className={`group relative flex items-start gap-2.5 rounded-lg px-2.5 py-2.5 transition-all duration-150 ${isActive ? "bg-accent-dim text-accent" : "text-text hover:bg-surface-hover"} ${entry.done ? "opacity-60 hover:opacity-100" : ""}`}
    >
      <Link
        {...getInboxSpaceRoute(entry)}
        data-space-id={entry.space.id}
        aria-label={`Open space ${entry.space.name}`}
        onClick={(event: React.MouseEvent) => {
          if (editing) event.preventDefault();
        }}
        className="absolute inset-0 rounded-lg"
      />
      <span className="relative z-10 pointer-events-none">
        <SpaceGlyph entry={entry} unreadCount={unreadCount} isActive={isActive} />
      </span>
      <div className="relative z-10 min-w-0 flex-1 pointer-events-none">
        {editing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(event) => setEditValue(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onBlur={commitEdit}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") commitEdit();
              if (event.key === "Escape") setEditing(false);
            }}
            className="pointer-events-auto mt-4 w-full rounded border border-border bg-surface px-1.5 py-1 text-[0.8125rem] font-medium leading-snug text-text-bright outline-none focus:border-accent"
          />
        ) : (
          <SpaceRowDetails
            entry={entry}
            isActive={isActive}
            unreadCount={unreadCount}
            attentionAction={<AttentionAction entry={entry} />}
          />
        )}
      </div>
      <div className="absolute right-2.5 top-2.5 z-10 flex items-start pointer-events-auto">
        <span className="sidebar-slot-has-menu flex h-6 w-6 items-start justify-end">
          {entry.recencyAt > 0 && (
            <span
              className={`sidebar-timestamp-fade pt-0.5 text-[0.625rem] leading-none text-muted/50 transition-opacity duration-150 group-hover:opacity-0${menuOpen ? " !opacity-0" : ""}`}
            >
              {formatTimeAgo(entry.recencyAt)}
            </span>
          )}
          {menuOpen ? (
            <Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
              <Menu.Trigger
                aria-label={`Actions for space ${entry.space.name}`}
                className="absolute flex h-6 w-6 items-start justify-end rounded text-muted hover:!text-text"
              >
                <MoreVertical size={15} />
              </Menu.Trigger>
              <SpaceActionsMenuContent entry={entry} onRename={startEditing} />
            </Menu.Root>
          ) : (
            <button
              type="button"
              aria-label={`Actions for space ${entry.space.name}`}
              onClick={() => setMenuOpen(true)}
              className="sidebar-menu-trigger absolute flex h-6 w-6 items-start justify-end rounded text-muted/60 opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:!text-text max-[768px]:h-10 max-[768px]:w-10"
            >
              <MoreVertical size={15} />
            </button>
          )}
        </span>
      </div>
      {isClosed && entry.space.status === "archived" && (
        <span className="sr-only">Archived space</span>
      )}
      {entry.space.status === "broken" && (
        <AlertTriangle className="sr-only" aria-label="Broken space" />
      )}
    </div>
  );
}
