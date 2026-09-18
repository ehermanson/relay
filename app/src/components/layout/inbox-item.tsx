/**
 * A single chat row in the inbox sidebar.
 *
 * Three lines: project + recency, the chat title, then the context needed to
 * tell chats apart once projects are no longer grouping them (branch,
 * provider, model).
 */

import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { GitBranch, MoreVertical, Pin, Terminal } from "lucide-react";
import { Menu } from "@/components/ui/menu";
import { Badge } from "@/components/ui/badge";
import { ProjectAvatar } from "@/components/ui/project-avatar";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { dotClassToTextColor } from "@/components/ui/session-indicator";
import { TerminalRunningIndicator } from "@/components/ui/terminal-running-indicator";
import { Tooltip } from "@/components/ui/tooltip";
import { findProviderModelLabel } from "@shared/provider-catalog";
import type { TerminalScope } from "@shared/types";
import { useSidebarActions } from "@/context/sidebar-actions-context";
import { getInstanceProjectRouteId } from "@/lib/project-route";
import { ChatActionsMenuContent } from "./chat-actions-menu";
import {
  deriveInstanceStatusPresentation,
  formatTimeAgo,
  getChatRecencyTimestamp,
} from "@/lib/utils";
import { useUnreadStore, selectHasUnread } from "@/stores/unread-store";
import type { InboxChatEntry } from "@/lib/inbox";

/**
 * The model this chat is actually running, preferring what the provider last
 * reported over what the user picked. Never falls back to a project or global
 * default — showing a model a chat has never used would be a lie.
 */
function resolveModelLabel(entry: InboxChatEntry): string | null {
  const { instance } = entry;
  const modelId =
    instance.providerStatus?.effectiveModel ?? instance.stats?.model ?? instance.preferredModel;
  if (!modelId) return null;
  return findProviderModelLabel(instance.provider, modelId) ?? modelId;
}

/**
 * The row's single identity + status anchor: the project's favicon with a
 * status badge on its corner.
 *
 * Collapses what used to be two columns (status dot / terminal glyph, then a
 * folder icon beside the project name) into one, so a row carries one glyph
 * per line instead of stacking three on the first. Quiet rows — stopped and
 * already read — desaturate so live and unread chats are the only color in
 * the column; hover and selection restore the favicon, so the row you're
 * pointing at or reading always shows its true colors.
 */
/**
 * The expanded row's content, rendered as hover-card contents for the
 * collapsed rail — where the avatar is all there is, so the hover is the only
 * place project, branch, model, recency and status can appear.
 */
export function InboxChatSummary({ entry }: { entry: InboxChatEntry }) {
  const { instance } = entry;
  const status = deriveInstanceStatusPresentation(instance);
  const modelLabel = resolveModelLabel(entry);
  const branch = instance.gitBranch ?? instance.gitInfo?.branch;
  const recencyAt = getChatRecencyTimestamp(instance);

  return (
    <div className="flex w-[13.5rem] min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-baseline gap-1.5 text-[0.6875rem] text-muted">
        <span className="min-w-0 truncate font-medium">{entry.projectName}</span>
        {recencyAt > 0 && (
          <span className="ml-auto shrink-0 text-muted/60">{formatTimeAgo(recencyAt)}</span>
        )}
      </div>

      <div className="line-clamp-2 text-[0.75rem] font-medium leading-snug text-text-bright">
        {instance.name}
      </div>

      <div className="flex min-w-0 items-center gap-1 text-[0.6875rem] text-muted/80">
        {branch && (
          <>
            <GitBranch size={9} strokeWidth={2.5} className="shrink-0" />
            <span className="min-w-0 truncate">{branch}</span>
            <span className="shrink-0 text-muted/40">·</span>
          </>
        )}
        <ProviderLogo provider={instance.provider} className="h-2.5 w-2.5 shrink-0" />
        {modelLabel && <span className="shrink-0 truncate">{modelLabel}</span>}
      </div>

      <div className="flex items-center gap-1.5 text-[0.6875rem] text-muted">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.dotClass}`} />
        <span className="min-w-0 truncate">{status.label}</span>
        {entry.done && <span className="ml-auto shrink-0 text-muted/60">Done</span>}
        {instance.pinned && !entry.done && (
          <span className="ml-auto shrink-0 text-muted/60">Pinned</span>
        )}
      </div>
    </div>
  );
}

export function InboxAvatar({
  entry,
  unread,
  isActive,
  size = 18,
  tooltip,
  className = "mt-0.5",
}: {
  entry: InboxChatEntry;
  unread: boolean;
  isActive: boolean;
  size?: number;
  /** Defaults to the status label; the collapsed rail passes a full summary. */
  tooltip?: React.ReactNode;
  className?: string;
}) {
  const { instance } = entry;
  const status = deriveInstanceStatusPresentation(instance);
  const isLive = instance.status !== "stopped";
  const quiet = !isLive && !unread && !isActive;
  const badgeColor = unread || isLive ? dotClassToTextColor(status.dotClass) : "text-muted/50";
  const pulse = status.dotClass.includes("animate-pulse-dot") ? "animate-pulse-dot" : "";

  return (
    <Tooltip content={tooltip ?? status.label} side="right">
      <span
        className={`relative flex shrink-0 items-center justify-center ${className}`}
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
        {instance.external ? (
          <Terminal
            size={9}
            strokeWidth={2.5}
            className={`absolute -bottom-1 -right-1 rounded-[2px] bg-surface ${badgeColor} ${pulse}`}
          />
        ) : (
          (isLive || unread) && (
            <span
              className={`absolute -bottom-0.5 -right-0.5 h-[7px] w-[7px] rounded-full ring-2 ring-surface ${status.dotClass}`}
            />
          )
        )}
      </span>
    </Tooltip>
  );
}

interface InboxItemProps {
  entry: InboxChatEntry;
  isActive: boolean;
  /** Currently active chatId — used to offer "Open in split view". */
  activeChatId?: string;
}

export function InboxItem({ entry, isActive, activeChatId }: InboxItemProps) {
  const { instance } = entry;
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
    if (e.key === "Enter") commitEdit();
    else if (e.key === "Escape") setEditing(false);
  };

  const unread = useUnreadStore((s) => selectHasUnread(s, instance.id, instance.lastActivityAt));
  const recencyAt = getChatRecencyTimestamp(instance);
  const modelLabel = resolveModelLabel(entry);
  const branch = instance.gitBranch ?? instance.gitInfo?.branch;

  return (
    <Link
      to="/projects/$projectId/chats/$chatId"
      params={{ projectId: getInstanceProjectRouteId(instance), chatId: instance.id }}
      data-chat-id={instance.id}
      onClick={(e: React.MouseEvent) => {
        if (editing) e.preventDefault();
      }}
      className={`group relative flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2.5 transition-all duration-150 ${
        isActive ? "bg-accent-dim text-accent" : "text-text hover:bg-surface-hover"
      } ${entry.done ? "opacity-60 hover:opacity-100" : ""}`}
    >
      <InboxAvatar entry={entry} unread={unread} isActive={isActive} />

      <div className="min-w-0 flex-1">
        {/* Line 1 — project. Reserves room on the right for the timestamp/menu,
            which is anchored to this line's band; lines 2–3 below get full width. */}
        <div className="flex min-w-0 items-center gap-1 pr-10 text-[0.6875rem] leading-tight text-muted">
          <span className="min-w-0 truncate font-medium text-muted/80">{entry.projectName}</span>
        </div>

        {/* Line 2 — chat title */}
        {editing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleEditKeyDown}
            onBlur={commitEdit}
            onClick={(e) => e.stopPropagation()}
            className="mt-1 w-full rounded border border-border bg-surface px-1.5 py-1 text-[0.8125rem] font-medium leading-snug text-text-bright outline-none focus:border-accent"
          />
        ) : (
          <div className="mt-1 flex min-w-0 items-center gap-1.5">
            <div
              className={`min-w-0 truncate text-[0.8125rem] leading-snug ${
                isActive ? "font-semibold text-accent" : "font-medium text-text"
              }`}
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

        {/* Line 3 — branch, provider, model, status */}
        {!editing && (
          <div className="mt-1 flex min-w-0 items-center gap-1 text-[0.6875rem] leading-tight text-muted/70">
            {branch && (
              <>
                <GitBranch size={9} strokeWidth={2.5} className="shrink-0" />
                <span className="min-w-0 truncate">{branch}</span>
                <span className="shrink-0 text-muted/40">·</span>
              </>
            )}
            <ProviderLogo provider={instance.provider} className="h-2.5 w-2.5 shrink-0" />
            {modelLabel && <span className="shrink-0 truncate">{modelLabel}</span>}
          </div>
        )}
      </div>

      {/*
        Timestamp (default) ↔ menu trigger (hover). Anchored absolutely to the
        top-right corner — the line-1 band — rather than a flex column, so the
        title and branch lines below span the full row width instead of
        reserving the timestamp's column. The menu fades in over the timestamp,
        matching the projects-mode row; shared CSS classes keep touch behavior
        consistent (menu always shown, timestamp hidden).
      */}
      {/* bottom-2.5 stretches the band to the full row height — the visible
          glyph stays on line 1 (items-start) but the tap area doesn't stop there. */}
      {!editing && (
        <span className="sidebar-slot-has-menu absolute bottom-2.5 right-2.5 top-2.5 flex w-10 items-start justify-end">
          {recencyAt > 0 && (
            <span
              className={`sidebar-timestamp-fade text-[0.625rem] leading-none text-muted/50 transition-opacity duration-150 group-hover:opacity-0${
                menuOpen ? " !opacity-0" : ""
              }`}
            >
              {formatTimeAgo(recencyAt)}
            </span>
          )}

          {menuOpen ? (
            <Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
              <Menu.Trigger
                onClick={(e: React.MouseEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                className="absolute inset-0 flex items-start justify-end rounded text-muted hover:!text-text"
              >
                <MoreVertical size={15} />
              </Menu.Trigger>
              <ChatActionsMenuContent
                instance={instance}
                spaceStatus={entry.space?.status}
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
              className="sidebar-menu-trigger absolute inset-0 flex items-start justify-end rounded text-muted/60 opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:!text-text"
            >
              <MoreVertical size={15} />
            </button>
          )}
        </span>
      )}
    </Link>
  );
}
