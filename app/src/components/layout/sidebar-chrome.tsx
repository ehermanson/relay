/**
 * Header, search trigger, and footer shared by both sidebar layouts.
 *
 * Extracted so Projects mode and Inbox mode can't drift on the things that
 * aren't actually part of either layout — logo, add-project, search, settings,
 * update, sign out.
 */

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  DownloadCloud,
  Loader2,
  LogOut,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import { toast } from "sonner";
import { useAuthContext } from "@/context/auth-context";
import { useWSState } from "@/context/websocket-context";
import {
  addProject as apiAddProject,
  createProject as apiCreateProject,
  fetchHealth,
} from "@/lib/api";
import { useActiveAccount } from "@/hooks/use-active-account";
import { useSystemUpdate } from "@/hooks/use-system-update";
import { AccountSwitcher } from "./account-switcher";
import { AddProjectForm } from "../forms/add-project-form";
import { CreateProjectForm } from "../forms/create-project-form";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Popover } from "../ui/popover";
import { RelayLogo } from "../ui/relay-logo";
import { Tabs } from "../ui/tabs";
import { Tooltip } from "../ui/tooltip";

/** Keeps the document title in sync with the worktree/dev state. */
export function useSidebarDocumentTitle() {
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (health?.git?.isWorktree && health.git.spaceName) {
      document.title = health.git.spaceName;
    } else {
      const tags: string[] = [];
      if (import.meta.env.DEV) tags.push("Dev");
      if (health?.git?.isWorktree) tags.push(health.git.branch ?? "Worktree");
      document.title = tags.length > 0 ? `Relay (${tags.join(", ")})` : "Relay";
    }
  }, [health?.git?.isWorktree, health?.git?.branch, health?.git?.spaceName]);

  return health;
}

/**
 * The add/create-project forms themselves, minus any surface. Mounted fresh by
 * each surface (popover, dialog) so tab + error state resets on every open.
 */
function AddProjectPanel({
  registeredDirs,
  onClose,
}: {
  registeredDirs: Set<string>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  // A project added while account X is active registers under X (adds
  // membership if the directory already exists). Undefined below two accounts.
  const { accountIdParam } = useActiveAccount();
  const [projectTab, setProjectTab] = useState<"add" | "create">("add");
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const [createProjectError, setCreateProjectError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const handleAddProject = async (directory: string) => {
    setAddProjectError(null);
    try {
      const project = await apiAddProject(directory, { accountId: accountIdParam });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
      toast.success(`Added "${project.name}"`);
    } catch (err) {
      setAddProjectError(err instanceof Error ? err.message : "Failed to add project");
    }
  };

  const handleCreateProject = async (parentDirectory: string, name: string) => {
    setCreateProjectError(null);
    setIsCreating(true);
    try {
      const project = await apiCreateProject(parentDirectory, name, accountIdParam);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
      toast.success(`Created "${project.name}"`);
    } catch (err) {
      setCreateProjectError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Tabs.Root value={projectTab} onValueChange={(v) => setProjectTab(v as "add" | "create")}>
      <Tabs.List className="mb-3">
        <Tabs.Tab value="add" className="flex-1 text-center">
          Add Existing
        </Tabs.Tab>
        <Tabs.Tab value="create" className="flex-1 text-center">
          Create New
        </Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="add">
        <AddProjectForm
          onSubmit={handleAddProject}
          onCancel={onClose}
          error={addProjectError}
          registeredDirs={registeredDirs}
        />
      </Tabs.Panel>
      <Tabs.Panel value="create">
        <CreateProjectForm
          onSubmit={handleCreateProject}
          onCancel={onClose}
          error={createProjectError}
          isSubmitting={isCreating}
        />
      </Tabs.Panel>
    </Tabs.Root>
  );
}

/**
 * Add/create a project from an icon button. Projects mode keeps this in the
 * header; Inbox mode has no room for a second `+` beside New chat, so it opens
 * the same panel from the project filter menu via `AddProjectDialog`.
 */
export function AddProjectButton({
  registeredDirs,
  tooltipSide = "bottom",
  align = "end",
}: {
  registeredDirs: Set<string>;
  tooltipSide?: "top" | "bottom";
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip content="Add project" side={tooltipSide}>
        <Popover.Trigger render={<Button variant="icon" />}>
          <Plus size={14} strokeWidth={2.5} />
        </Popover.Trigger>
      </Tooltip>
      <Popover.Content className="w-96 max-w-[calc(100vw-2rem)]" align={align}>
        <AddProjectPanel registeredDirs={registeredDirs} onClose={() => setOpen(false)} />
      </Popover.Content>
    </Popover.Root>
  );
}

/** The same panel as a standalone dialog, for triggers inside a menu. */
export function AddProjectDialog({
  open,
  onOpenChange,
  registeredDirs,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registeredDirs: Set<string>;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="max-w-md">
        <Dialog.Header>
          <Dialog.Title>Add project</Dialog.Title>
          <Dialog.Close />
        </Dialog.Header>
        <AddProjectPanel registeredDirs={registeredDirs} onClose={() => onOpenChange(false)} />
      </Dialog.Content>
    </Dialog.Root>
  );
}

export function SidebarHeader({
  onCollapse,
  showLogo = false,
  registeredDirs,
  action,
}: {
  onCollapse?: () => void;
  showLogo?: boolean;
  registeredDirs: Set<string>;
  /** Overrides the default header action (Add project). */
  action?: React.ReactNode;
}) {
  const { isConnected } = useWSState();
  const health = useSidebarDocumentTitle();

  return (
    <>
      <div className="sidebar-header group/header flex shrink-0 items-center justify-between px-4 py-3">
        <Link
          to="/"
          className="flex items-center gap-2 rounded-md transition-opacity hover:opacity-80"
        >
          {showLogo ? (
            <RelayLogo size={28} className="sidebar-logo-icon" connected={isConnected} />
          ) : (
            <div className="h-7 w-7" aria-hidden />
          )}
          <span
            className="sidebar-logo-text text-[1.1rem] text-text-bright"
            style={{
              fontFamily: "'Orbitron', sans-serif",
              fontWeight: 900,
              letterSpacing: "0.04em",
            }}
          >
            Relay
          </span>
          {(import.meta.env.DEV || health?.git?.isWorktree) && (
            <span className="sidebar-logo-text flex items-center gap-1">
              {import.meta.env.DEV && (
                <Badge variant="default" size="xs">
                  Dev
                </Badge>
              )}
              {health?.git?.isWorktree && (
                <Badge variant="accent" size="xs">
                  Worktree
                </Badge>
              )}
            </span>
          )}
        </Link>
        <div className="flex items-center gap-1">
          {onCollapse && (
            <Tooltip content="Collapse sidebar" side="bottom">
              <Button
                variant="icon"
                onClick={onCollapse}
                className="opacity-0 transition-opacity duration-200 ease-in group-hover/header:opacity-100"
              >
                <PanelLeftClose size={15} strokeWidth={2} />
              </Button>
            </Tooltip>
          )}
          {action ?? <AddProjectButton registeredDirs={registeredDirs} />}
        </div>
      </div>
      {/* The account is the top layer of the UI: its pill sits directly under the
        logo row in both layouts (and the mobile drawer, which hosts the same
        sidebar). Renders nothing below two accounts. */}
      <AccountSwitcher />
    </>
  );
}

/**
 * Shared shape for the sidebar's inline controls — the search trigger and the
 * inbox project filter. They sit directly above one another, so they share one
 * class string rather than two hand-matched ones that can drift apart.
 */
export const SIDEBAR_CONTROL_CLASS =
  "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-[0.75rem] text-muted transition-colors hover:bg-bg-2 hover:text-text";

/**
 * Row wrapper for a sidebar control plus its optional trailing icon button.
 * `pr-4` matches the header's `px-4`, so a trailing icon button here lines up
 * with the header's icon column rather than sitting 4px inside it.
 */
export const SIDEBAR_CONTROL_ROW_CLASS = "flex shrink-0 items-center gap-1 pl-3 pr-4 pb-2";

/**
 * Compact search affordance for layouts that put search on a shared control
 * row (e.g. Inbox, beside the project filter) rather than its own full row.
 * The ⌘K hint lives in the tooltip since there's no room for an inline kbd.
 */
export function SidebarSearchIconButton({ onSearchOpen }: { onSearchOpen?: () => void }) {
  return (
    <Tooltip content="Search (⌘K)" side="bottom">
      <Button variant="icon" onClick={() => onSearchOpen?.()} aria-label="Search">
        <Search size={15} strokeWidth={2} />
      </Button>
    </Tooltip>
  );
}

export function SidebarSearchTrigger({ onSearchOpen }: { onSearchOpen?: () => void }) {
  return (
    <div className={SIDEBAR_CONTROL_ROW_CLASS}>
      <button
        type="button"
        onClick={() => onSearchOpen?.()}
        className={`group ${SIDEBAR_CONTROL_CLASS}`}
      >
        <Search size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">Search</span>
        <kbd className="hidden rounded border border-border/70 px-1 py-0.5 font-mono text-[0.5625rem] text-muted/60 opacity-0 transition-opacity group-hover:opacity-100 @[10rem]:inline">
          ⌘K
        </kbd>
      </button>
    </div>
  );
}

export function SidebarFooter() {
  const { isAuthenticated, logout } = useAuthContext();
  const {
    snapshot: updateSnapshot,
    isInstalling: isUpdateInstalling,
    isBusy: isUpdateBusy,
    stageLabel: updateStageLabel,
    install: installUpdateAction,
  } = useSystemUpdate();
  const showUpdateButton = Boolean(
    (updateSnapshot?.enabled && updateSnapshot.updateAvailable) || isUpdateInstalling,
  );

  return (
    <div className="shrink-0 border-t border-border">
      <div className="sidebar-footer flex items-center justify-between gap-1 px-2 py-2">
        <div className="flex items-center gap-0.5">
          <Link to="/settings">
            <Button variant="ghost" size="sm">
              <Settings size={14} />
              Settings
            </Button>
          </Link>
        </div>
        <div className="flex items-center gap-1">
          {showUpdateButton && (
            <Tooltip
              content={
                isUpdateInstalling
                  ? (updateStageLabel ?? "Installing update…")
                  : "Install update and restart Relay"
              }
              side="top"
            >
              <Button
                variant="ghost"
                size="sm"
                disabled={isUpdateBusy}
                onClick={() => installUpdateAction()}
                className="relative !text-amber-400 hover:!bg-amber-500/10 hover:!text-amber-300 disabled:!opacity-100"
                aria-label={
                  isUpdateInstalling
                    ? (updateStageLabel ?? "Installing update…")
                    : "Install update and restart Relay"
                }
              >
                {isUpdateInstalling ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    <span className="max-w-[120px] truncate">
                      {updateStageLabel ?? "Updating…"}
                    </span>
                  </>
                ) : (
                  <>
                    <DownloadCloud size={13} />
                    Update
                    <span className="absolute right-1 top-1 h-1.5 w-1.5 animate-pulse-dot rounded-full bg-amber-400" />
                  </>
                )}
              </Button>
            </Tooltip>
          )}
          {isAuthenticated && (
            <Button variant="ghost" size="sm" onClick={logout}>
              <LogOut size={13} />
              Sign out
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
