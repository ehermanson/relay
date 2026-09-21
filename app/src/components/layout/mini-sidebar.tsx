import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { DownloadCloud, Loader2, LogOut, PanelLeftOpen, Plus, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Menu } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { ChatActionsMenuContent } from "@/components/layout/chat-actions-menu";
import { InboxSpaceItem } from "@/components/layout/inbox-space-item";
import { capInboxEntries, isInboxEntryCurrent, type InboxChatEntry } from "@/lib/inbox";
import { InboxAvatar, InboxChatSummary } from "@/components/layout/inbox-item";
import { NewChatMenu } from "@/components/layout/new-chat-menu";
import { SidebarItem } from "@/components/layout/sidebar-item";
import { useAuthContext } from "@/context/auth-context";
import { SidebarActionsProvider, useSidebarActions } from "@/context/sidebar-actions-context";
import { useSidebarLayout } from "@/hooks/use-global-settings";
import {
  useInboxNavigationModel,
  type InboxEntry,
  type InboxProjectOption,
} from "@/hooks/use-inbox-navigation-model";
import { useSystemUpdate } from "@/hooks/use-system-update";
import { getInstanceProjectRouteId, getProjectName, getSpaceRoute } from "@/lib/project-route";
import { useUnreadStore, selectHasUnread } from "@/stores/unread-store";
import type { InstanceInfo, SpaceInfo } from "@shared/types";
// The rail can be the only sidebar mounted (app booted collapsed), so it has
// to pull in the shared sidebar styles itself rather than rely on Sidebar.
import "./sidebar.css";

// ── Project flyout (sessions for one project) ────────────────────────

function ProjectFlyout({
  dir,
  projectId,
  instances,
  spaces,
  latestChatIdBySpace,
  currentId,
  activeSpaceId,
  onNewChat,
}: {
  dir: string;
  projectId: string;
  instances: InstanceInfo[];
  spaces?: SpaceInfo[];
  latestChatIdBySpace: Record<string, string>;
  currentId?: string;
  activeSpaceId?: string;
  onNewChat: (dir: string) => void;
}) {
  const name = getProjectName(dir);
  const mainInstances = instances.filter((inst) => !inst.spaceId);
  const visibleSpaces =
    spaces?.filter((space) => !space.isDefault && space.status === "active") ?? [];

  return (
    <div className="flex max-h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2.5">
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          className="min-w-0 truncate text-[0.8125rem] font-semibold text-text-bright transition-colors hover:text-accent"
        >
          {name}
        </Link>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onNewChat(dir)}
          className="hover:!bg-accent/10 hover:!text-accent"
        >
          <Plus size={12} strokeWidth={2.5} />
          New
        </Button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-1 py-1">
        {visibleSpaces.length > 0 && (
          <div className="px-2 pb-2">
            <div className="px-2 py-1 text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-muted/70">
              Spaces
            </div>
            <div className="space-y-0.5">
              {visibleSpaces.map((space) => (
                <Link
                  key={space.id}
                  {...getSpaceRoute(projectId, space.id, latestChatIdBySpace[space.id])}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[0.75rem] transition-colors ${
                    activeSpaceId === space.id
                      ? "bg-accent-dim text-accent"
                      : "text-text hover:bg-surface-hover"
                  }`}
                >
                  <span className="truncate font-medium">{space.name}</span>
                  {space.gitBranch && (
                    <span className="truncate text-[0.625rem] text-muted">{space.gitBranch}</span>
                  )}
                </Link>
              ))}
            </div>
          </div>
        )}

        <div className="px-2 pb-1">
          <div className="px-2 py-1 text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-muted/70">
            Chats
          </div>
        </div>

        {mainInstances.length === 0 ? (
          <div className="px-2 py-4 text-center text-[0.75rem] text-muted">No sessions</div>
        ) : (
          mainInstances.map((inst) => (
            <SidebarItem
              key={inst.id}
              instance={inst}
              isActive={inst.id === currentId}
              to="/projects/$projectId/chats/$chatId"
              params={{ projectId: getInstanceProjectRouteId(inst), chatId: inst.id }}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── Inbox chat rail (collapsed sidebar, inbox layout) ────────────────

/** Chats shown in the collapsed rail before it stops listing more. */
const MINI_INBOX_LIMIT = 15;

/**
 * One chat in the collapsed rail, keyed visually by its project rather than
 * its provider — with most chats on the same provider, a column of identical
 * provider marks carries no information, while the project is what varies.
 * Reuses the expanded row's avatar so both surfaces read the same.
 */
function MiniInboxRailItem({
  entry,
  isActive,
  currentId,
  onRename,
}: {
  entry: InboxChatEntry;
  isActive: boolean;
  currentId?: string;
  onRename: () => void;
}) {
  const { instance } = entry;
  const unread = useUnreadStore((s) => selectHasUnread(s, instance.id, instance.lastActivityAt));
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <>
      {/*
        Pin and Mark done are the actions the inbox is built around, and the
        rail has no room for a ⋮ trigger — so the whole item is the trigger,
        opened by right-click (or long-press, which fires contextmenu on touch).
      */}
      <Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <span className="relative flex shrink-0">
          <Link
            to="/projects/$projectId/chats/$chatId"
            params={{ projectId: getInstanceProjectRouteId(instance), chatId: instance.id }}
            onContextMenu={(event: React.MouseEvent) => {
              event.preventDefault();
              setMenuOpen(true);
            }}
            className={`group relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-all duration-150 ${
              isActive ? "bg-accent-dim" : "hover:bg-surface-hover"
            }`}
          >
            <InboxAvatar
              entry={entry}
              unread={unread}
              isActive={isActive}
              size={20}
              className=""
              tooltip={<InboxChatSummary entry={entry} />}
            />
          </Link>
          {/*
            Sibling of the link, not a child: nesting a button inside an anchor
            is invalid and would make the strip both navigate and open the menu.
            It exists only to anchor the popup beside the rail, so it takes no
            pointer events of its own.
          */}
          <Menu.Trigger
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none absolute inset-y-0 right-0 w-px opacity-0"
          >
            <span />
          </Menu.Trigger>
        </span>
        <ChatActionsMenuContent
          instance={instance}
          spaceStatus={entry.space?.status}
          activeChatId={currentId}
          onRename={onRename}
          side="right"
          align="start"
        />
      </Menu.Root>
    </>
  );
}

/**
 * Rename for surfaces with no title to edit in place. The expanded row swaps
 * its title for an input; the rail has only an avatar, so it asks in a dialog.
 */
function RenameChatDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: InboxChatEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const actions = useSidebarActions();
  const [value, setValue] = useState(entry.instance.name);

  // Re-seed each time it opens so a cancelled edit doesn't persist, and so a
  // rename from elsewhere shows up.
  useEffect(() => {
    if (open) setValue(entry.instance.name);
  }, [open, entry.instance.name]);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== entry.instance.name) {
      actions.renameInstance(entry.instance.id, trimmed);
    }
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="max-w-sm">
        <Dialog.Title>Rename chat</Dialog.Title>
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") onOpenChange(false);
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

function MiniInboxRail({
  entries,
  doneEntries,
  projectOptions,
  currentId,
  currentSpaceId,
  onNewChat,
}: {
  entries: InboxEntry[];
  /** Done chats aren't listed, but the open chat must stay reachable. */
  doneEntries: InboxEntry[];
  projectOptions: InboxProjectOption[];
  currentId?: string;
  currentSpaceId?: string;
  onNewChat: (dir: string) => void;
}) {
  const actions = useSidebarActions();
  const visible = useMemo(
    () => capInboxEntries(entries, MINI_INBOX_LIMIT, currentId, currentSpaceId, doneEntries),
    [entries, doneEntries, currentId, currentSpaceId],
  );
  const [renaming, setRenaming] = useState<InboxChatEntry | null>(null);

  return (
    <div className="mini-rail-scroll flex flex-1 flex-col items-center gap-1 overflow-y-auto">
      {/* The rail has no project headers to hang creation off, so it carries
          its own "New" menu (chat + space) the way the flyout does in projects
          mode. Class matches the chat buttons below so the column is one width. */}
      {projectOptions.length > 0 && (
        <NewChatMenu
          projectOptions={projectOptions}
          soleTarget={projectOptions.length === 1 ? projectOptions[0].dir : null}
          onCreate={onNewChat}
          onCreateSpace={actions.createSpace}
          icon={<Plus size={15} strokeWidth={2.5} />}
          tooltipSide="right"
          align="start"
          triggerClassName="mb-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-text"
        />
      )}

      {visible.map((entry) =>
        entry.kind === "space" ? (
          <InboxSpaceItem
            key={entry.id}
            entry={entry}
            compact
            isActive={isInboxEntryCurrent(entry, currentId, currentSpaceId)}
          />
        ) : (
          <MiniInboxRailItem
            key={entry.id}
            entry={entry}
            isActive={isInboxEntryCurrent(entry, currentId, currentSpaceId)}
            currentId={currentId}
            onRename={() => setRenaming(entry)}
          />
        ),
      )}

      {/* One dialog for the whole rail rather than one mounted per item. */}
      {renaming && (
        <RenameChatDialog
          entry={renaming}
          open
          onOpenChange={(open) => {
            if (!open) setRenaming(null);
          }}
        />
      )}
    </div>
  );
}

// ── Project icon button ──────────────────────────────────────────────

function ProjectIcon({
  dir,
  isActive,
  isHovered,
  hasActivity,
  iconPath,
  onHover,
  onLeave,
}: {
  dir: string;
  isActive: boolean;
  isHovered: boolean;
  hasActivity: boolean;
  iconPath?: string;
  onHover: () => void;
  onLeave: () => void;
}) {
  const name = getProjectName(dir);
  const initial = name.charAt(0).toUpperCase();
  const [imgError, setImgError] = useState(false);
  const showIcon = iconPath && !imgError;

  return (
    <button
      type="button"
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      className={`relative flex h-9 w-9 items-center justify-center rounded-lg text-[0.8125rem] font-bold transition-all duration-150 ${
        isActive
          ? "bg-surface-hover text-text"
          : isHovered
            ? "bg-surface-hover/60 text-text"
            : "text-muted hover:bg-surface-hover hover:text-text"
      }`}
    >
      {showIcon ? (
        <img
          src={`/api/file?path=${encodeURIComponent(iconPath)}`}
          alt={name}
          className={`h-6 w-6 rounded object-contain transition-[filter,opacity] duration-150 ${
            isActive || isHovered ? "opacity-100 grayscale-0" : "opacity-60 grayscale"
          }`}
          onError={() => setImgError(true)}
        />
      ) : (
        <span
          className={`flex h-6 w-6 items-center justify-center rounded-md text-[0.8125rem] font-bold uppercase transition-colors ${
            isActive || isHovered
              ? "bg-surface-raised text-text-bright"
              : "bg-surface-hover text-text-bright/75"
          }`}
        >
          {initial}
        </span>
      )}
      {hasActivity && (
        <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 animate-pulse-dot rounded-full bg-warning" />
      )}
    </button>
  );
}

// ── Main component ───────────────────────────────────────────────────

export function MiniSidebar({ onExpand }: { onExpand: () => void }) {
  const { isAuthenticated, logout } = useAuthContext();
  const {
    snapshot: updateSnapshot,
    isInstalling,
    isBusy: isUpdateBusy,
    stageLabel: updateStageLabel,
    install: installUpdateAction,
  } = useSystemUpdate();
  // Keep the button visible throughout the install so the user keeps seeing
  // the busy state — not just when `updateAvailable` is true.
  const showUpdateButton = Boolean(
    (updateSnapshot?.enabled && updateSnapshot.updateAvailable) || isInstalling,
  );
  const layout = useSidebarLayout();
  const {
    latestChatIdBySpace,
    currentChatId,
    currentProjectId,
    currentSpaceId,
    projectByDir,
    projectEntries,
    createNewChat,
    active: inboxEntries,
    done: inboxDoneEntries,
    projectOptions,
  } = useInboxNavigationModel(null, { enabled: layout === "inbox" });
  const location = useLocation();
  const currentId = currentChatId;

  // Which project flyout is open (by dir path), null = none
  const [flyoutDir, setFlyoutDir] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the icon element's vertical position for flyout alignment
  const iconRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [flyoutTop, setFlyoutTop] = useState(0);

  const openFlyout = useCallback((dir: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const el = iconRefs.current.get(dir);
    if (el) {
      setFlyoutTop(el.getBoundingClientRect().top);
    }
    setFlyoutDir(dir);
  }, []);

  const closeFlyout = useCallback(() => {
    timerRef.current = setTimeout(() => setFlyoutDir(null), 200);
  }, []);

  const keepFlyout = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  // Close flyout on navigation
  useEffect(() => {
    setFlyoutDir(null);
  }, [location.pathname]);

  const handleNewChat = (dir: string) => {
    createNewChat(dir);
    setFlyoutDir(null);
  };

  const flyoutEntry = flyoutDir ? projectEntries.find((entry) => entry.dir === flyoutDir) : null;

  return (
    <SidebarActionsProvider
      currentProjectId={currentProjectId}
      currentSpaceId={currentSpaceId}
      projectByDir={projectByDir}
      createNewChat={createNewChat}
    >
      <div className="relative flex h-full shrink-0">
        {/* Narrow icon rail */}
        <aside className="flex h-full w-12 flex-col items-center bg-surface py-3 rounded-xl">
          {/* Logo placeholder — the real logo is rendered persistently in app-layout */}
          <div className="mb-3 h-7 w-7" aria-hidden />

          {/* Expand button */}
          <Tooltip content="Expand sidebar" side="right">
            <Button variant="icon" onClick={onExpand} className="mb-2">
              <PanelLeftOpen size={15} strokeWidth={2} />
            </Button>
          </Tooltip>

          <div className="mx-auto mb-2 h-px w-6 bg-border/60" />

          {/* Chats (inbox layout) or project icons (projects layout) */}
          {layout === "inbox" ? (
            <MiniInboxRail
              entries={inboxEntries}
              doneEntries={inboxDoneEntries}
              projectOptions={projectOptions}
              currentId={currentId}
              currentSpaceId={currentSpaceId}
              onNewChat={handleNewChat}
            />
          ) : (
            <div className="mini-rail-scroll flex flex-1 flex-col items-center gap-1 overflow-y-auto">
              {projectEntries.map((entry) => {
                return (
                  <div
                    key={entry.dir}
                    ref={(el) => {
                      if (el) iconRefs.current.set(entry.dir, el);
                      else iconRefs.current.delete(entry.dir);
                    }}
                  >
                    <ProjectIcon
                      dir={entry.dir}
                      isActive={entry.isActiveProject}
                      isHovered={flyoutDir === entry.dir}
                      hasActivity={entry.hasActivity}
                      iconPath={entry.iconPath}
                      onHover={() => openFlyout(entry.dir)}
                      onLeave={closeFlyout}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {/* Footer icons */}
          <div className="mx-auto mt-2 mb-2 h-px w-6 bg-border/60" />
          <div className="flex flex-col items-center gap-1">
            {showUpdateButton && (
              <Tooltip
                content={
                  isInstalling
                    ? (updateStageLabel ?? "Installing update…")
                    : "Install update and restart Relay"
                }
                side="right"
              >
                <Button
                  variant="icon"
                  disabled={isUpdateBusy}
                  onClick={() => installUpdateAction()}
                  className="relative !text-amber-400 hover:!bg-amber-500/10 hover:!text-amber-300 disabled:!opacity-100"
                  aria-label={
                    isInstalling
                      ? (updateStageLabel ?? "Installing update…")
                      : "Install update and restart Relay"
                  }
                >
                  {isInstalling ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <>
                      <DownloadCloud size={14} />
                      <span className="absolute right-1 top-1 h-1.5 w-1.5 animate-pulse-dot rounded-full bg-amber-400" />
                    </>
                  )}
                </Button>
              </Tooltip>
            )}
            <Tooltip content="Settings" side="right">
              <Link to="/settings">
                <Button variant="icon">
                  <Settings size={14} />
                </Button>
              </Link>
            </Tooltip>
            {isAuthenticated && (
              <Tooltip content="Sign out" side="right">
                <Button variant="icon" onClick={logout}>
                  <LogOut size={13} />
                </Button>
              </Tooltip>
            )}
          </div>
        </aside>

        {/* Per-project flyout */}
        {flyoutEntry && (
          <div
            className="glass fixed left-[58px] z-50 flex w-64 animate-slide-in-left flex-col overflow-hidden rounded-xl border-0"
            style={{
              top: Math.max(8, Math.min(flyoutTop - 8, window.innerHeight - 400)),
              maxHeight: "min(80vh, 500px)",
            }}
            onMouseEnter={keepFlyout}
            onMouseLeave={closeFlyout}
          >
            <ProjectFlyout
              dir={flyoutEntry.dir}
              projectId={flyoutEntry.projectId}
              instances={flyoutEntry.groupInstances}
              spaces={flyoutEntry.spaces}
              latestChatIdBySpace={latestChatIdBySpace}
              currentId={currentId}
              activeSpaceId={currentSpaceId}
              onNewChat={handleNewChat}
            />
          </div>
        )}
      </div>
    </SidebarActionsProvider>
  );
}
