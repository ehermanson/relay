/**
 * Combined git status badge + actions menu.
 * Replaces the separate BranchBadge + GitMenu pair in chat/space headers.
 *
 * Trigger shows: branch name, dirty dot, ahead/behind counts.
 * Menu shows: status summary, branch switcher (submenu), action items.
 */

import { useCallback, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronRight,
  Cloud,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Menu } from "./menu";
import { ErrorBoundary } from "./error-boundary";
import { fetchBranches, checkoutBranch, type WorktreeBranchInfo } from "@/lib/api";
import { useProjectsQuery } from "@/hooks/use-projects-query";
import { CreateSpaceDialog, useCreateSpaceDialog } from "@/components/spaces/create-space-dialog";

// ── Types ────────────────────────────────────────────────────────────

interface GitBadgeAction {
  label: string;
  icon: ReactNode;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
}

/** Projects with a branch checkout in flight (guards double selection). */
const checkoutsInFlight = new Set<string>();

export type GitBadgePendingAction = "commit" | "fetch" | "pull" | "push";

interface GitBadgeProps {
  branch: string;

  /** Project ID — enables branch switching submenu when provided */
  projectId?: string;

  /** Uncommitted changes present */
  dirty?: boolean;
  /** Commits ahead of remote */
  ahead?: number;
  /** Commits behind remote */
  behind?: number;
  /** Whether status data is still loading */
  statusLoading?: boolean;
  /** Status could not be read — shown instead of counts (never as "up to date") */
  statusError?: string | null;
  /** A git action is running — all actions are disabled until it settles */
  pendingAction?: GitBadgePendingAction | null;

  // ── Actions (each optional — only rendered if provided) ──

  onCommit?: () => void | Promise<void>;
  /** Fetch remote refs (refreshes ahead/behind without merging) */
  onFetch?: () => void | Promise<void>;
  /** Pull from remote (ff-only, or rebase when diverged) */
  onPull?: () => void | Promise<void>;
  onPush?: () => void | Promise<void>;
  onPushAndCreatePR?: () => void | Promise<void>;
  onMerge?: () => void | Promise<void>;
  mergeDisabled?: boolean;
  /** Path to copy (worktree directory) */
  worktreePath?: string;
  /** Extra actions appended at the end */
  extraActions?: GitBadgeAction[];
}

// ── Branch submenu content ───────────────────────────────────────────

function BranchSubmenu({
  projectId,
  current,
  onBranchChanged,
  onConvertWorktree,
}: {
  projectId: string;
  current: string;
  onBranchChanged: () => void;
  onConvertWorktree: (worktreePath: string) => void;
}) {
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ["branches", projectId],
    queryFn: () => fetchBranches(projectId),
    staleTime: 5000,
  });

  const worktreesByBranch = useMemo(() => {
    const map = new Map<string, WorktreeBranchInfo>();
    for (const w of data?.worktrees ?? []) map.set(w.branch, w);
    return map;
  }, [data?.worktrees]);

  const handleSelect = useCallback(
    async (branch: string) => {
      if (branch === current) return;
      const worktree = worktreesByBranch.get(branch);
      if (worktree?.spaceId) {
        navigate({
          to: "/projects/$projectId/spaces/$spaceId",
          params: { projectId, spaceId: worktree.spaceId },
        });
        return;
      }
      if (worktree) {
        onConvertWorktree(worktree.path);
        return;
      }
      // The menu unmounts on click, so the in-flight guard is module-level.
      if (checkoutsInFlight.has(projectId)) return;
      checkoutsInFlight.add(projectId);
      try {
        await checkoutBranch(projectId, branch);
        toast.success(`Switched to ${branch}`);
        onBranchChanged();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to switch branch");
      } finally {
        checkoutsInFlight.delete(projectId);
      }
    },
    [projectId, current, onBranchChanged, worktreesByBranch, navigate, onConvertWorktree],
  );

  const localBranches = data?.local ?? [];
  const remoteBranches = (data?.remote ?? []).filter((b) => !localBranches.includes(b));

  if (isLoading) {
    return (
      <Menu.Item disabled>
        <Loader2 size={13} className="animate-spin text-muted" />
        Loading...
      </Menu.Item>
    );
  }

  return (
    <>
      {localBranches.map((b) => {
        const worktree = worktreesByBranch.get(b);
        const isUnconvertedWorktree = !!worktree && !worktree.spaceId;
        return (
          <Menu.Item key={b} onClick={() => void handleSelect(b)}>
            {worktree ? (
              <FolderGit2 size={13} className="text-muted" />
            ) : (
              <GitBranch size={13} className="text-muted" />
            )}
            <span className="flex-1 truncate">{b}</span>
            {isUnconvertedWorktree && (
              <span className="ml-1 text-[0.625rem] uppercase tracking-wide text-muted">
                convert
              </span>
            )}
            {b === current && <Check size={13} className="ml-auto shrink-0 text-accent" />}
          </Menu.Item>
        );
      })}
      {remoteBranches.length > 0 && (
        <>
          <Menu.Separator />
          <div className="px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted">
            Remote
          </div>
          {remoteBranches.map((b) => (
            <Menu.Item key={`remote-${b}`} onClick={() => void handleSelect(b)}>
              <Cloud size={13} className="text-muted" />
              <span className="truncate">{b}</span>
            </Menu.Item>
          ))}
        </>
      )}
    </>
  );
}

// ── Component ────────────────────────────────────────────────────────

export function GitBadge({
  branch,
  projectId,
  dirty,
  ahead = 0,
  behind = 0,
  statusLoading,
  statusError,
  pendingAction,
  onCommit,
  onFetch,
  onPull,
  onPush,
  onPushAndCreatePR,
  onMerge,
  mergeDisabled,
  worktreePath,
  extraActions,
}: GitBadgeProps) {
  const queryClient = useQueryClient();
  const spaceDialog = useCreateSpaceDialog();
  const { data: projects = [] } = useProjectsQuery();
  const project = projectId
    ? projects.find((p) => p.slug === projectId || p.id === projectId)
    : undefined;

  const hasStatus =
    dirty !== undefined || ahead > 0 || behind > 0 || statusLoading || !!statusError;
  const busy = !!pendingAction;

  const handleBranchChanged = useCallback(() => {
    if (projectId) {
      queryClient.invalidateQueries({ queryKey: ["branches", projectId] });
    }
  }, [queryClient, projectId]);

  const handleConvertWorktree = useCallback(
    (path: string) => {
      if (!project) {
        toast.error("Project not found");
        return;
      }
      spaceDialog.open(project.directory, { mode: "convert", worktreePath: path });
    },
    [project, spaceDialog],
  );

  return (
    <Menu.Root>
      {/* ── Trigger badge ────────────────────────────────────── */}
      <Menu.Trigger className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted transition-all duration-150 hover:bg-surface-hover hover:text-text">
        {busy ? <Loader2 size={13} className="animate-spin" /> : <GitBranch size={13} />}
        <span className="max-w-[140px] truncate">{branch}</span>

        {statusError && <AlertTriangle size={10} className="text-amber-400" />}
        {dirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />}

        {ahead > 0 && (
          <span className="flex items-center gap-0.5 tabular-nums text-[0.625rem]">
            <ArrowUpFromLine size={9} />
            {ahead}
          </span>
        )}
        {behind > 0 && (
          <span className="flex items-center gap-0.5 tabular-nums text-[0.625rem]">
            <ArrowDownToLine size={9} />
            {behind}
          </span>
        )}
      </Menu.Trigger>

      {/* ── Menu content ─────────────────────────────────────── */}
      <Menu.Content side="bottom" align="end" sideOffset={4}>
        {/* Status section */}
        {hasStatus && (
          <>
            <div className="px-3 py-1.5">
              {statusLoading ? (
                <div className="flex items-center gap-2 text-[0.75rem] text-muted">
                  <Loader2 size={11} className="animate-spin" />
                  Checking...
                </div>
              ) : statusError ? (
                <div className="flex max-w-64 items-start gap-2 text-[0.75rem] text-muted">
                  <AlertTriangle size={11} className="mt-0.5 shrink-0 text-amber-400" />
                  <span className="break-words">Git status unavailable: {statusError}</span>
                </div>
              ) : (
                <div className="flex flex-col gap-0.5 text-[0.75rem] text-muted">
                  {dirty && (
                    <div className="flex items-center gap-2">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                      Uncommitted changes
                    </div>
                  )}
                  {ahead > 0 && (
                    <div className="flex items-center gap-2">
                      <ArrowUpFromLine size={11} />
                      {ahead} commit{ahead !== 1 ? "s" : ""} ahead
                    </div>
                  )}
                  {behind > 0 && (
                    <div className="flex items-center gap-2">
                      <ArrowDownToLine size={11} />
                      {behind} commit{behind !== 1 ? "s" : ""} behind
                    </div>
                  )}
                  {!dirty && ahead === 0 && behind === 0 && (
                    <div className="text-muted/70">Up to date</div>
                  )}
                </div>
              )}
            </div>
            <Menu.Separator />
          </>
        )}

        {/* Branch switcher submenu */}
        {projectId && (
          <Menu.Sub>
            <Menu.SubTrigger>
              <GitBranch size={13} className="text-muted" />
              <span className="flex-1">Switch branch</span>
              <ChevronRight size={12} className="text-muted" />
            </Menu.SubTrigger>
            <Menu.SubContent className="max-h-[300px] w-56 overflow-y-auto">
              <ErrorBoundary inline name="Branch picker">
                <BranchSubmenu
                  projectId={projectId}
                  current={branch}
                  onBranchChanged={handleBranchChanged}
                  onConvertWorktree={handleConvertWorktree}
                />
              </ErrorBoundary>
            </Menu.SubContent>
          </Menu.Sub>
        )}

        {/* Actions */}
        {projectId && (onCommit || onFetch || onPull || onPush || onPushAndCreatePR || onMerge) && (
          <Menu.Separator />
        )}

        {onMerge && (
          <>
            <Menu.Item onClick={() => void onMerge()} disabled={mergeDisabled}>
              <GitMerge size={13} className="text-muted" />
              Complete
            </Menu.Item>
            <Menu.Separator />
          </>
        )}
        {onCommit && (
          <Menu.Item onClick={() => void onCommit()} disabled={busy}>
            <GitCommitHorizontal size={13} className="text-muted" />
            Commit changes
          </Menu.Item>
        )}
        {onFetch && (
          <Menu.Item onClick={() => void onFetch()} disabled={busy}>
            <RefreshCw
              size={13}
              className={pendingAction === "fetch" ? "animate-spin text-muted" : "text-muted"}
            />
            {pendingAction === "fetch" ? "Fetching…" : "Fetch"}
          </Menu.Item>
        )}
        {onPull && (
          <Menu.Item onClick={() => void onPull()} disabled={busy || behind === 0}>
            <ArrowDownToLine size={13} className="text-muted" />
            {pendingAction === "pull"
              ? "Pulling…"
              : ahead > 0 && behind > 0
                ? "Pull (rebase)"
                : "Pull"}
          </Menu.Item>
        )}
        {onPush && (
          <Menu.Item onClick={() => void onPush()} disabled={busy}>
            <Upload size={13} className="text-muted" />
            {pendingAction === "push" ? "Pushing…" : "Push branch"}
          </Menu.Item>
        )}
        {onPushAndCreatePR && (
          <Menu.Item onClick={() => void onPushAndCreatePR()} disabled={busy}>
            <GitPullRequest size={13} className="text-muted" />
            Push & create PR
          </Menu.Item>
        )}
        {worktreePath && (
          <>
            <Menu.Separator />
            <Menu.Item
              onClick={() => {
                navigator.clipboard.writeText(worktreePath).then(() => {
                  toast.success("Copied to clipboard");
                });
              }}
            >
              <FolderOpen size={13} className="text-muted" />
              Copy working directory
            </Menu.Item>
          </>
        )}
        {extraActions?.map((action, i) => (
          <Menu.Item key={i} onClick={() => void action.onClick()} disabled={action.disabled}>
            {action.icon}
            {action.label}
          </Menu.Item>
        ))}
      </Menu.Content>

      <CreateSpaceDialog
        dir={spaceDialog.dir}
        mode={spaceDialog.mode}
        preselectedWorktreePath={spaceDialog.preselectedWorktreePath}
        projectName={project?.name ?? spaceDialog.dir ?? ""}
        projectId={project?.id}
        defaultBaseBranch={project?.defaultSpaceBranch ?? undefined}
        spaceBranchSource={project?.spaceBranchSource ?? undefined}
        onOpenChange={(open) => !open && spaceDialog.close()}
      />
    </Menu.Root>
  );
}
