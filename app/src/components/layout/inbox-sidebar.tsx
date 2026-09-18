/**
 * InboxSidebar — sidebar v2.
 *
 * One mixed list of standalone chats and named spaces across projects, sorted
 * by activity. Finished chats and closed spaces collapse into a
 * "Done" section; project-level actions move into a "Projects" section at the
 * bottom, since there are no project headers to hang them off.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  GitBranch,
  Inbox,
  Loader2,
  MessageSquarePlus,
  MoreVertical,
  Plus,
} from "lucide-react";
import { SidebarActionsProvider, useSidebarActions } from "../../context/sidebar-actions-context";
import { useWSState } from "../../context/websocket-context";
import {
  useInboxNavigationModel,
  type InboxEntry,
  type InboxProjectOption,
} from "@/hooks/use-inbox-navigation-model";
import { useDoneSectionDisclosure, useDoneTransitionPulse } from "@/hooks/use-done-section";
import { setInstancesDone } from "@/lib/api";
import {
  capInboxEntries,
  isInboxEntryCurrent,
  selectStaleInboxEntries,
  STALE_CHAT_DONE_DAYS,
} from "@/lib/inbox";
import { Button } from "../ui/button";
import { Collapsible } from "../ui/collapsible";
import { ConfirmActionDialog } from "../ui/confirm-action-dialog";
import { Menu } from "../ui/menu";
import { ProjectAvatar } from "../ui/project-avatar";
import { Tooltip } from "../ui/tooltip";
import { InboxItem } from "./inbox-item";
import { InboxSpaceItem } from "./inbox-space-item";
import { NewChatMenu } from "./new-chat-menu";
import { ProjectActionsMenuContent } from "./project-actions-menu";
import {
  AddProjectDialog,
  SIDEBAR_CONTROL_CLASS,
  SIDEBAR_CONTROL_ROW_CLASS,
  SidebarFooter,
  SidebarHeader,
  SidebarSearchIconButton,
  SidebarSearchTrigger,
} from "./sidebar-chrome";
import "./sidebar.css";

/** Rows shown before the list truncates behind a "Show all". */
const ACTIVE_VISIBLE_LIMIT = 15;
const DONE_VISIBLE_LIMIT = 20;

function ShowAllButton({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-1 rounded-md px-2.5 py-1.5 text-left text-xs text-muted transition-colors hover:bg-surface-hover hover:text-accent"
    >
      Show all ({hidden} more)
      <ChevronDown size={10} strokeWidth={2.5} />
    </button>
  );
}

/**
 * Renders a capped list with a "Show all" escape hatch. The cap exists so a
 * long backlog can't push live chats off-screen, never to silently hide them.
 */
function CappedInboxList({
  entries,
  limit,
  currentId,
  currentSpaceId,
}: {
  entries: InboxEntry[];
  limit: number;
  currentId?: string;
  currentSpaceId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = useMemo(
    () => (expanded ? entries : capInboxEntries(entries, limit, currentId, currentSpaceId)),
    [entries, expanded, limit, currentId, currentSpaceId],
  );
  const hidden = entries.length - visible.length;

  return (
    <div className="space-y-0.5">
      {visible.map((entry) =>
        entry.kind === "space" ? (
          <InboxSpaceItem
            key={entry.id}
            entry={entry}
            isActive={isInboxEntryCurrent(entry, currentId, currentSpaceId)}
          />
        ) : (
          <InboxItem
            key={entry.id}
            entry={entry}
            isActive={isInboxEntryCurrent(entry, currentId, currentSpaceId)}
            activeChatId={currentId}
          />
        ),
      )}
      {hidden > 0 && <ShowAllButton hidden={hidden} onClick={() => setExpanded(true)} />}
    </div>
  );
}

/**
 * Offers to sweep the inbox's stale tail into Done. Sits directly under the
 * active list — where the backlog actually is — and only renders when there is
 * one, so a small inbox never sees it. Deliberately a button rather than an
 * automatic rule: nothing marks a chat done without the user asking.
 */
function SweepStaleRow({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-0.5 flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-xs text-muted transition-colors hover:bg-surface-hover hover:text-accent"
    >
      <CheckCheck size={12} strokeWidth={2.5} className="shrink-0" />
      Mark {count} inactive {count === 1 ? "chat" : "chats"} done
    </button>
  );
}

/**
 * Top-level "New" menu, occupying the header slot that Projects mode gives to
 * Add project. In a flat list there are no project headers to hang creation
 * off, so it becomes the layout's primary action — and Add project moves into
 * the project filter menu, since two plus glyphs side by side were
 * indistinguishable.
 *
 * It offers both New chat and New space: spaces have no other discoverable home
 * in the flat inbox layout (the per-project "New Space" lives in the collapsed
 * "Projects" section behind a hover-only affordance). With a project filter
 * applied (or one project registered) the target is unambiguous, so the menu
 * acts on it directly; otherwise each action opens a project picker.
 */
function NewChatHeaderButton({
  projectOptions,
  projectFilter,
}: {
  projectOptions: InboxProjectOption[];
  projectFilter: string | null;
}) {
  const actions = useSidebarActions();

  const soleTarget =
    (projectFilter && projectOptions.some((option) => option.dir === projectFilter)
      ? projectFilter
      : null) ?? (projectOptions.length === 1 ? projectOptions[0].dir : null);

  return (
    <NewChatMenu
      projectOptions={projectOptions}
      soleTarget={soleTarget}
      onCreate={actions.quickCreate}
      onCreateSpace={actions.createSpace}
      icon={<Plus size={15} strokeWidth={2.5} />}
      tooltipSide="bottom"
      align="end"
      triggerClassName="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-text"
    />
  );
}

function ProjectRow({
  dir,
  name,
  projectId,
  dbId,
  iconPath,
  isFirst,
  isLast,
  onMoveToTop,
  onMoveUp,
  onMoveDown,
  onMoveToBottom,
}: {
  dir: string;
  name: string;
  projectId: string;
  dbId?: string;
  iconPath?: string;
  isFirst: boolean;
  isLast: boolean;
  onMoveToTop: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMoveToBottom: () => void;
}) {
  const actions = useSidebarActions();
  const [menuOpen, setMenuOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);

  return (
    <div className="group/project flex items-center rounded-lg pl-2.5 pr-1 transition-colors hover:bg-surface-hover">
      <Link
        to="/projects/$projectId"
        params={{ projectId }}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          <ProjectAvatar iconPath={iconPath} name={name} size={16} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[0.75rem] font-medium text-text">{name}</span>
      </Link>

      <div className="flex shrink-0 items-center gap-0.5">
        <Menu.Root open={newMenuOpen} onOpenChange={setNewMenuOpen}>
          <Tooltip content="New" side="top">
            <Menu.Trigger
              onClick={(event: React.MouseEvent) => event.stopPropagation()}
              className="sidebar-menu-trigger flex h-6 w-6 items-center justify-center rounded-md text-muted opacity-0 transition-all group-hover/project:opacity-100 hover:bg-surface-hover hover:text-text"
            >
              <Plus size={14} strokeWidth={2.5} />
            </Menu.Trigger>
          </Tooltip>
          <Menu.Content align="start">
            <Menu.Item
              className="!items-start"
              onClick={(event: React.MouseEvent) => {
                event.stopPropagation();
                actions.quickCreate(dir);
              }}
            >
              <MessageSquarePlus size={13} strokeWidth={2} className="mt-1 text-muted" />
              <div>
                <div>New Chat</div>
                <div className="text-[0.6875rem] text-muted">Work with an agent on this branch</div>
              </div>
            </Menu.Item>
            <Menu.Item
              className="!items-start"
              onClick={(event: React.MouseEvent) => {
                event.stopPropagation();
                actions.createSpace(dir);
              }}
            >
              <GitBranch size={13} strokeWidth={2} className="mt-1 text-muted" />
              <div>
                <div>New Space</div>
                <div className="text-[0.6875rem] text-muted">
                  Start an isolated worktree and merge back later
                </div>
              </div>
            </Menu.Item>
          </Menu.Content>
        </Menu.Root>

        {menuOpen ? (
          <Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
            <Menu.Trigger
              onClick={(event: React.MouseEvent) => event.stopPropagation()}
              className="flex h-6 w-6 items-center justify-center rounded text-muted hover:text-text"
            >
              <MoreVertical size={15} />
            </Menu.Trigger>
            <ProjectActionsMenuContent
              routeProjectId={projectId}
              removeProjectTarget={{ id: dbId, name, directory: dir }}
              reorder={{ isFirst, isLast, onMoveToTop, onMoveUp, onMoveDown, onMoveToBottom }}
            />
          </Menu.Root>
        ) : (
          <Button
            variant="icon"
            size="icon-sm"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(true);
            }}
            className="sidebar-menu-trigger !h-6 !w-6 text-muted/60 opacity-0 transition-opacity duration-150 group-hover/project:opacity-100"
          >
            <MoreVertical size={15} />
          </Button>
        )}
      </div>
    </div>
  );
}

export function InboxSidebar({
  onCollapse,
  onSearchOpen,
  showLogo = false,
}: { onCollapse?: () => void; onSearchOpen?: () => void; showLogo?: boolean } = {}) {
  const { isSyncing } = useWSState();
  // Deliberately not persisted: the filter is a momentary scoping tool, and a
  // sticky one would silently hide chats after a reload.
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [sweepOpen, setSweepOpen] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const queryClient = useQueryClient();

  const {
    active,
    done,
    projectOptions,
    projects,
    projectByDir,
    registeredDirs,
    currentChatId,
    currentProjectId,
    currentSpaceId,
    createNewChat,
    moveDown,
    moveToBottom,
    moveToTop,
    moveUp,
  } = useInboxNavigationModel(projectFilter);

  const currentId = currentChatId;
  const currentEntry = [...active, ...done].find((entry) =>
    isInboxEntryCurrent(entry, currentChatId, currentSpaceId),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const didInitialScrollRef = useRef(false);

  // Drop a filter that no longer matches a registered project (e.g. the
  // project was removed while it was selected) so the list can't go empty.
  useEffect(() => {
    if (!projectFilter) return;
    if (!projectOptions.some((option) => option.dir === projectFilter)) setProjectFilter(null);
  }, [projectFilter, projectOptions]);

  // Expand Done only when arriving on an already-done chat; acknowledge chats
  // moving into Done with a header pulse instead. Both live in `use-done-section`
  // so the transition rules can be tested without mounting the sidebar.
  const [doneOpen, setDoneOpen] = useDoneSectionDisclosure({
    chatId: currentEntry?.id,
    isActive: active.some((entry) => entry.id === currentEntry?.id),
    isDone: done.some((entry) => entry.id === currentEntry?.id),
  });
  const donePulse = useDoneTransitionPulse(active, done);

  useEffect(() => {
    if (didInitialScrollRef.current) return;
    if (!currentEntry) return;
    const container = scrollRef.current;
    if (!container) return;
    const selector =
      currentEntry.kind === "space"
        ? `[data-space-id="${CSS.escape(currentEntry.space.id)}"]`
        : `[data-chat-id="${CSS.escape(currentEntry.instance.id)}"]`;
    const el = container.querySelector<HTMLElement>(selector);
    if (!el) return;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    didInitialScrollRef.current = true;
  }, [currentEntry, active, done, doneOpen]);

  // Scoped to `active`, which the project filter has already narrowed — the
  // sweep marks exactly what the list in front of the user shows.
  const staleEntries = useMemo(() => selectStaleInboxEntries(active, Date.now()), [active]);

  const runSweep = () => {
    setSweeping(true);
    setInstancesDone(
      staleEntries.map((entry) => entry.instance.id),
      true,
    )
      .then(async (updated) => {
        await queryClient.invalidateQueries({ queryKey: ["projectChats"] });
        setSweepOpen(false);
        toast.success(`Marked ${updated} ${updated === 1 ? "chat" : "chats"} done`);
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Failed to update chats");
      })
      .finally(() => setSweeping(false));
  };

  const hasProjects = projects.length > 0;
  const selectedProject = projectOptions.find((option) => option.dir === projectFilter);
  const filterLabel = selectedProject?.name ?? "All projects";
  const orderedDirs = projectOptions.map((option) => option.dir);

  return (
    <SidebarActionsProvider
      currentProjectId={currentProjectId}
      currentSpaceId={currentSpaceId}
      projectByDir={projectByDir}
      createNewChat={createNewChat}
    >
      <aside
        className="flex h-full w-full flex-col bg-surface rounded-xl"
        style={{ containerName: "sidebar", containerType: "inline-size" }}
      >
        <SidebarHeader
          onCollapse={onCollapse}
          showLogo={showLogo}
          registeredDirs={registeredDirs}
          // With no projects yet there is nothing to start a chat in, and the
          // filter menu that normally holds Add project is hidden — so fall back
          // to the default header action or there'd be no way to add one.
          action={
            projectOptions.length > 0 ? (
              <NewChatHeaderButton projectOptions={projectOptions} projectFilter={projectFilter} />
            ) : undefined
          }
        />
        {/* One control row: project filter (flex) + search. Add project is a
            menu item inside the filter rather than a button here — it and the
            header's New chat are both plus glyphs, and stacked in the same
            corner they were a coin flip. With no projects there's no filter at
            all, so Add project falls back to the header slot. */}
        {hasProjects ? (
          <div className={SIDEBAR_CONTROL_ROW_CLASS}>
            <Menu.Root open={filterOpen} onOpenChange={setFilterOpen}>
              <Menu.Trigger className={SIDEBAR_CONTROL_CLASS}>
                {selectedProject ? (
                  <ProjectAvatar iconPath={selectedProject.iconPath} name={selectedProject.name} />
                ) : (
                  <Inbox size={13} className="shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate text-left">{filterLabel}</span>
                <ChevronDown size={12} strokeWidth={2.5} className="shrink-0 opacity-60" />
              </Menu.Trigger>
              <Menu.Content align="start">
                <Menu.Item onClick={() => setProjectFilter(null)}>
                  <Inbox size={13} strokeWidth={2} className="text-muted" />
                  All projects
                  {projectFilter === null && <Check size={12} className="ml-auto text-accent" />}
                </Menu.Item>
                <Menu.Separator />
                {projectOptions.map((option) => (
                  <Menu.Item key={option.dir} onClick={() => setProjectFilter(option.dir)}>
                    <ProjectAvatar iconPath={option.iconPath} name={option.name} />
                    <span className="min-w-0 truncate">{option.name}</span>
                    {projectFilter === option.dir && (
                      <Check size={12} className="ml-auto text-accent" />
                    )}
                  </Menu.Item>
                ))}
                <Menu.Separator />
                {/* Add project lives here rather than as a second icon button on
                    this row — it and the header's New chat are both plus glyphs,
                    indistinguishable at icon size. */}
                <Menu.Item onClick={() => setAddProjectOpen(true)}>
                  <FolderPlus size={13} strokeWidth={2} className="text-muted" />
                  Add project
                </Menu.Item>
              </Menu.Content>
            </Menu.Root>
            <SidebarSearchIconButton onSearchOpen={onSearchOpen} />
          </div>
        ) : (
          <SidebarSearchTrigger onSearchOpen={onSearchOpen} />
        )}

        <div ref={scrollRef} className="flex-1 overflow-y-auto pb-2">
          {!hasProjects && isSyncing ? (
            <div className="flex flex-1 flex-col items-center justify-center p-10 text-center">
              <Loader2 className="mx-auto mb-3 h-5 w-5 animate-spin text-muted" />
              <p className="text-sm text-muted">Syncing...</p>
            </div>
          ) : !hasProjects ? (
            <div className="flex flex-1 flex-col items-center justify-center p-10 text-center">
              <FolderPlus className="mx-auto mb-3 h-8 w-8 text-muted/40" />
              <p className="mb-1 text-sm text-muted">No projects registered</p>
              <span className="text-xs text-muted opacity-60">Add a git repo to get started</span>
            </div>
          ) : (
            <>
              <div className="px-2">
                {active.length > 0 ? (
                  <>
                    <CappedInboxList
                      entries={active}
                      limit={ACTIVE_VISIBLE_LIMIT}
                      currentId={currentId}
                      currentSpaceId={currentSpaceId}
                    />
                    {staleEntries.length > 0 && (
                      <SweepStaleRow
                        count={staleEntries.length}
                        onClick={() => setSweepOpen(true)}
                      />
                    )}
                  </>
                ) : (
                  <div className="flex flex-col items-center gap-1 px-3 py-8 text-center">
                    <Check size={18} className="text-muted/40" />
                    <p className="text-[0.75rem] text-muted">Inbox zero</p>
                    <span className="text-[0.6875rem] text-muted/60">
                      {done.length > 0 ? "All chats and spaces are done" : "No chats or spaces yet"}
                    </span>
                  </div>
                )}
              </div>

              {done.length > 0 && (
                <Collapsible.Root open={doneOpen} onOpenChange={setDoneOpen}>
                  <Collapsible.Trigger className="flex w-full items-center gap-1 px-3 pb-1 pt-3 text-[0.625rem] font-semibold uppercase tracking-wider text-muted/60 transition-colors hover:text-muted">
                    {doneOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    {/* Remounted on each pulse so the animation restarts; the
                        key-0 mount renders without the animating class. */}
                    <span
                      key={donePulse}
                      className={`inline-flex items-center${donePulse > 0 ? " inbox-done-label" : ""}`}
                    >
                      Done
                      <span className="inbox-done-count ml-1 font-normal normal-case tracking-normal text-muted/40">
                        {done.length}
                      </span>
                    </span>
                  </Collapsible.Trigger>
                  <Collapsible.Content>
                    <div className="px-2">
                      <CappedInboxList
                        entries={done}
                        limit={DONE_VISIBLE_LIMIT}
                        currentId={currentId}
                        currentSpaceId={currentSpaceId}
                      />
                    </div>
                  </Collapsible.Content>
                </Collapsible.Root>
              )}

              <Collapsible.Root open={projectsOpen} onOpenChange={setProjectsOpen}>
                <Collapsible.Trigger className="flex w-full items-center gap-1 px-3 pb-1 pt-3 text-[0.625rem] font-semibold uppercase tracking-wider text-muted/60 transition-colors hover:text-muted">
                  {projectsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  Projects
                  <span className="ml-1 font-normal normal-case tracking-normal text-muted/40">
                    {projectOptions.length}
                  </span>
                </Collapsible.Trigger>
                <Collapsible.Content>
                  <div className="px-2">
                    {projectOptions.map((option, index) => (
                      <ProjectRow
                        key={option.dir}
                        dir={option.dir}
                        name={option.name}
                        projectId={option.projectId}
                        dbId={option.dbId}
                        iconPath={option.iconPath}
                        isFirst={index === 0}
                        isLast={index === projectOptions.length - 1}
                        onMoveToTop={() => moveToTop(option.dir)}
                        onMoveUp={() => moveUp(option.dir, orderedDirs)}
                        onMoveDown={() => moveDown(option.dir, orderedDirs)}
                        onMoveToBottom={() => moveToBottom(option.dir)}
                      />
                    ))}
                  </div>
                </Collapsible.Content>
              </Collapsible.Root>

              {isSyncing && (
                <div className="flex items-center justify-center gap-1.5 py-3 text-muted/60">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span className="text-[0.6875rem]">Syncing...</span>
                </div>
              )}
            </>
          )}
        </div>

        <SidebarFooter />
      </aside>

      <ConfirmActionDialog
        open={sweepOpen}
        onOpenChange={setSweepOpen}
        title="Mark inactive chats done"
        description={
          <>
            {staleEntries.length} {staleEntries.length === 1 ? "chat" : "chats"}
            {selectedProject ? ` in ${selectedProject.name}` : ""} with no activity in{" "}
            {STALE_CHAT_DONE_DAYS} days will move to Done. Any new activity brings a chat back to
            the inbox.
          </>
        }
        confirmLabel={sweeping ? "Marking..." : "Mark done"}
        confirmVariant="primary"
        onConfirm={runSweep}
        isLoading={sweeping}
        maxWidth="max-w-sm"
      />

      <AddProjectDialog
        open={addProjectOpen}
        onOpenChange={setAddProjectOpen}
        registeredDirs={registeredDirs}
      />
    </SidebarActionsProvider>
  );
}
