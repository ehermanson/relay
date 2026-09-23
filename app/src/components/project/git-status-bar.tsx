import { useState, useCallback, useRef, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  GitBranch,
  ArrowDownToLine,
  ArrowUpFromLine,
  RefreshCw,
  Check,
  Cloud,
  Loader2,
  FolderGit2,
  AlertTriangle,
} from "lucide-react";
import {
  fetchBranches,
  checkoutBranch,
  gitFetch,
  gitPull,
  gitPush,
  type WorktreeBranchInfo,
} from "../../lib/api";
import { Popover } from "../ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "../ui/command";
import { Tooltip } from "../ui/tooltip";
import { ErrorBoundary } from "../ui/error-boundary";
import { useProjectsQuery } from "../../hooks/use-projects-query";
import { useRepoStatus } from "../../hooks/use-repo-status";
import { CreateSpaceDialog, useCreateSpaceDialog } from "../spaces/create-space-dialog";

// ─── Types ──────────────────────────────────────────────────────────────────

interface GitStatusBarProps {
  projectId: string;
}

// ─── Branch Selector ────────────────────────────────────────────────────────

function BranchSelector({
  projectId,
  current,
  onBranchChanged,
  onConvertWorktree,
}: {
  projectId: string;
  current: string | null;
  onBranchChanged: () => void;
  onConvertWorktree: (worktreePath: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);
  const navigate = useNavigate();

  const { data } = useQuery({
    queryKey: ["branches", projectId],
    queryFn: () => fetchBranches(projectId),
    enabled: open,
    staleTime: 5000,
  });

  const worktreesByBranch = useMemo(() => {
    const map = new Map<string, WorktreeBranchInfo>();
    for (const w of data?.worktrees ?? []) map.set(w.branch, w);
    return map;
  }, [data?.worktrees]);

  const handleSelect = useCallback(
    async (branch: string) => {
      if (branch === current) {
        setOpen(false);
        return;
      }
      const worktree = worktreesByBranch.get(branch);
      if (worktree?.spaceId) {
        navigate({
          to: "/projects/$projectId/spaces/$spaceId",
          params: { projectId, spaceId: worktree.spaceId },
        });
        setOpen(false);
        return;
      }
      if (worktree) {
        onConvertWorktree(worktree.path);
        setOpen(false);
        return;
      }
      // One checkout at a time — a second click while one runs is ignored.
      if (switchingRef.current) return;
      switchingRef.current = true;
      setSwitching(true);
      try {
        await checkoutBranch(projectId, branch);
        toast.success(`Switched to ${branch}`);
        onBranchChanged();
        setOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to switch branch");
      } finally {
        switchingRef.current = false;
        setSwitching(false);
      }
    },
    [projectId, current, onBranchChanged, worktreesByBranch, navigate, onConvertWorktree],
  );

  const localBranches = data?.local ?? [];
  const remoteBranches = (data?.remote ?? []).filter((b) => !localBranches.includes(b));

  const renderBranchRow = (b: string) => {
    const worktree = worktreesByBranch.get(b);
    const isWorktree = !!worktree;
    const isUnconvertedWorktree = isWorktree && !worktree.spaceId;
    return (
      <CommandItem key={b} disabled={switching} onSelect={() => void handleSelect(b)}>
        {isWorktree ? (
          <FolderGit2 size={13} className="shrink-0 text-muted" />
        ) : (
          <GitBranch size={13} className="shrink-0 text-muted" />
        )}
        <span className="truncate">{b}</span>
        {isUnconvertedWorktree && (
          <span className="ml-1 text-[0.625rem] uppercase tracking-wide text-muted">convert</span>
        )}
        {b === current && <Check size={13} className="ml-auto shrink-0 text-accent" />}
      </CommandItem>
    );
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[0.75rem] font-medium text-muted transition-colors hover:bg-surface-hover hover:text-text">
        {switching ? <Loader2 size={13} className="animate-spin" /> : <GitBranch size={13} />}
        <span className="max-w-[180px] truncate">{current || "HEAD"}</span>
      </Popover.Trigger>
      <Popover.Content side="bottom" align="start" sideOffset={4} className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Search branches..." />
          <CommandList>
            <CommandEmpty>No branches found</CommandEmpty>
            {localBranches.length > 0 && (
              <CommandGroup heading="Local">{localBranches.map(renderBranchRow)}</CommandGroup>
            )}
            {remoteBranches.length > 0 && (
              <CommandGroup heading="Remote">
                {remoteBranches.map((b) => (
                  <CommandItem key={`remote-${b}`} onSelect={() => void handleSelect(b)}>
                    <Cloud size={13} className="shrink-0 text-muted" />
                    <span className="truncate">{b}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </Popover.Content>
    </Popover.Root>
  );
}

// ─── Icon Button ────────────────────────────────────────────────────────────

function GitAction({
  icon: Icon,
  tooltip,
  loading,
  disabled,
  onClick,
}: {
  icon: typeof ArrowDownToLine;
  tooltip: string;
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip content={tooltip}>
      <button
        type="button"
        disabled={disabled || loading}
        onClick={onClick}
        className="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {loading ? <Loader2 size={13} className="animate-spin" /> : <Icon size={13} />}
      </button>
    </Tooltip>
  );
}

// ─── Git Status Bar ─────────────────────────────────────────────────────────

export function GitStatusBar({ projectId }: GitStatusBarProps) {
  const queryClient = useQueryClient();
  // Only one remote operation at a time: the ref blocks re-entry within the
  // same tick (double clicks), the state drives the disabled/pending UI.
  const [pendingOp, setPendingOp] = useState<"fetch" | "pull" | "push" | null>(null);
  const pendingOpRef = useRef<"fetch" | "pull" | "push" | null>(null);
  const runExclusive = useCallback(
    async (op: "fetch" | "pull" | "push", fn: () => Promise<void>) => {
      if (pendingOpRef.current) return;
      pendingOpRef.current = op;
      setPendingOp(op);
      try {
        await fn();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : `Git ${op} failed`);
      } finally {
        pendingOpRef.current = null;
        setPendingOp(null);
      }
    },
    [],
  );
  const spaceDialog = useCreateSpaceDialog();
  const { data: projects = [] } = useProjectsQuery();
  const project = projects.find((p) => p.slug === projectId || p.id === projectId);

  const handleConvertWorktree = useCallback(
    (worktreePath: string) => {
      if (!project) {
        toast.error("Project not found");
        return;
      }
      spaceDialog.open(project.directory, { mode: "convert", worktreePath });
    },
    [project, spaceDialog],
  );

  // Branch/ahead/behind/dirty refetch when the server's repo_status
  // fingerprint changes (Relay git ops, agent turn end, background fetch);
  // focus refetch stays as a fallback. No interval polling.
  useRepoStatus({ kind: "project", projectId }, { invalidate: [["branches", projectId]] });
  const { data, error } = useQuery({
    queryKey: ["branches", projectId],
    queryFn: () => fetchBranches(projectId),
    refetchOnWindowFocus: true,
    staleTime: 15000,
  });

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["branches", projectId] });
  }, [queryClient, projectId]);

  const handleFetch = useCallback(
    () =>
      runExclusive("fetch", async () => {
        const result = await gitFetch(projectId);
        if (result.success) {
          toast.success("Fetched from remote");
          invalidate();
        } else {
          toast.error(result.error || "Fetch failed");
        }
      }),
    [projectId, invalidate, runExclusive],
  );

  const current = data?.current ?? null;
  const ahead = data?.aheadBehind?.ahead ?? 0;
  const behind = data?.aheadBehind?.behind ?? 0;
  // Older servers omit hasUpstream; treat that as "has upstream" (old behavior).
  const hasUpstream = data?.hasUpstream ?? true;
  const dirty = data?.dirty ?? false;
  // Diverged (local ahead *and* behind) can't fast-forward — rebase local
  // commits onto the remote instead.
  const diverged = ahead > 0 && behind > 0;

  const handlePull = useCallback(
    () =>
      runExclusive("pull", async () => {
        const result = await gitPull(projectId, { rebase: diverged });
        if (result.success) {
          toast.success(diverged ? "Rebased onto remote" : "Pulled from remote");
          invalidate();
        } else {
          toast.error(result.error || "Pull failed");
        }
      }),
    [projectId, invalidate, diverged, runExclusive],
  );

  const handlePush = useCallback(
    () =>
      runExclusive("push", async () => {
        const result = await gitPush(projectId, {
          branch: current ?? undefined,
          setUpstream: true,
        });
        if (result.success) {
          if (result.pushed === false) {
            toast.warning(result.message || "Nothing to push");
            invalidate();
            return;
          }
          toast.success("Pushed to remote");
          invalidate();
        } else {
          toast.error(result.error || "Push failed");
        }
      }),
    [projectId, invalidate, current, runExclusive],
  );
  const busy = pendingOp !== null;

  return (
    <div className="flex items-center gap-1">
      <ErrorBoundary inline name="Branch picker">
        <BranchSelector
          projectId={projectId}
          current={current}
          onBranchChanged={invalidate}
          onConvertWorktree={handleConvertWorktree}
        />
      </ErrorBoundary>

      {error && (
        <Tooltip
          content={`Git status unavailable: ${error instanceof Error ? error.message : "unknown error"}`}
        >
          <span className="flex items-center text-amber-400">
            <AlertTriangle size={12} />
          </span>
        </Tooltip>
      )}

      {dirty && (
        <Tooltip content="Uncommitted changes">
          <span className="h-2 w-2 rounded-full bg-amber-400" />
        </Tooltip>
      )}

      {(ahead > 0 || behind > 0) && (
        <div className="flex items-center gap-1.5 px-1 text-[0.6875rem] tabular-nums text-muted">
          {ahead > 0 && (
            <Tooltip content={`${ahead} commit${ahead !== 1 ? "s" : ""} ahead of remote`}>
              <span className="flex items-center gap-0.5">
                <ArrowUpFromLine size={11} />
                {ahead}
              </span>
            </Tooltip>
          )}
          {behind > 0 && (
            <Tooltip content={`${behind} commit${behind !== 1 ? "s" : ""} behind remote`}>
              <span className="flex items-center gap-0.5">
                <ArrowDownToLine size={11} />
                {behind}
              </span>
            </Tooltip>
          )}
        </div>
      )}

      <GitAction
        icon={RefreshCw}
        tooltip="Fetch"
        loading={pendingOp === "fetch"}
        disabled={busy}
        onClick={() => void handleFetch()}
      />
      <GitAction
        icon={ArrowDownToLine}
        tooltip={diverged ? "Pull (rebase — diverged from remote)" : "Pull"}
        loading={pendingOp === "pull"}
        disabled={busy || behind === 0}
        onClick={() => void handlePull()}
      />
      <GitAction
        icon={ArrowUpFromLine}
        tooltip={
          !hasUpstream
            ? "Push and set upstream"
            : behind > 0
              ? "Pull before pushing — behind remote"
              : "Push"
        }
        loading={pendingOp === "push"}
        disabled={busy || !current || (hasUpstream && (ahead === 0 || behind > 0))}
        onClick={() => void handlePush()}
      />

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
    </div>
  );
}
