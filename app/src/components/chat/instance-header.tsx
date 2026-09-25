/**
 * Header bar for the chat instance view — status dot, title, metadata,
 * and action buttons (open-in, debug, sidecar toggles).
 */

import { useState, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  Bug,
  Columns2,
  EllipsisVertical,
  FileText,
  LayoutGrid,
  ListChecks,
  MessageCircleCode,
  Pencil,
  ScrollText,
  Trash2,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { Tooltip } from "../ui/tooltip";
import { Menu } from "../ui/menu";
import { GitBadge, type GitBadgePendingAction } from "../ui/git-badge";
import {
  ViewHeader,
  ViewHeaderTitle,
  MobileSidebarToggle,
  MobileViewHeader,
} from "../ui/view-header";
import { ProjectBreadcrumb } from "../ui/project-breadcrumb";
import { OpenInMenu } from "../project/open-in-menu";
import { HeaderContextToggle, HeaderIconSkeleton, HeaderTerminalToggle } from "./header-actions";
import { CommitMessageDialog } from "../git/commit-message-dialog";
import { getInstanceProjectRouteId, getProjectName } from "../../lib/project-route";
import {
  fetchInstanceGitStatus,
  gitCommitInstance,
  gitFetchInstance,
  gitPullInstance,
  gitPushInstance,
} from "../../lib/api";
import { deriveInstanceStatusPresentation } from "../../lib/utils";
import { useRepoStatus } from "@/hooks/use-repo-status";
import { useProviderModels } from "@/hooks/use-provider-models";
import { useProviderProfiles } from "@/hooks/use-provider-profiles";
import { resolveChatAccountLabel } from "@/lib/account-profiles";
import type { InstanceInfo, ProviderKind, ProviderNotice, SessionStats } from "@shared/types";
import type { SidecarTab } from "./sidecar";

// ── Sidecar toggle buttons ───────────────────────────────────────────

interface SidecarTogglesProps {
  loading?: boolean;
  isMobile: boolean;
  /** The user's currently selected tab (preserved even when closed). */
  activeTab: SidecarTab;
  /** Whether the sidecar is currently open. */
  isOpen: boolean;
  tasksCount: number;
  filesCount: number;
  /** Delegated agents in this chat; the toggle renders only when the provider supports agent activity. */
  agentsCount?: number;
  hasAgentsContent?: boolean;
  hasPlanContent: boolean;
  hasReviewContent: boolean;
  hasStats: boolean;
  stats?: SessionStats;
  provider?: ProviderKind;
  sidecarContentCount: number;
  onSelectTab: (panel: SidecarTab) => void;
  onOpenMobileSidecar: () => void;
}

function CountBadge({ count }: { count: number }) {
  return (
    <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[0.5625rem] font-semibold leading-none text-white">
      {count}
    </span>
  );
}

function SidecarToggles({
  loading = false,
  isMobile,
  activeTab,
  isOpen,
  tasksCount,
  filesCount,
  agentsCount = 0,
  hasAgentsContent = false,
  hasPlanContent,
  hasReviewContent,
  hasStats,
  stats,
  provider,
  sidecarContentCount,
  onSelectTab,
  onOpenMobileSidecar,
}: SidecarTogglesProps) {
  const hasTasksContent = tasksCount > 0;
  const hasFilesContent = filesCount > 0;
  const hasAny =
    hasTasksContent ||
    hasAgentsContent ||
    hasFilesContent ||
    hasPlanContent ||
    hasReviewContent ||
    hasStats;
  if (!loading && !hasAny) return null;

  // A tab button is "toggled on" when it's the showing tab (active + open).
  const isShowing = (panel: SidecarTab) => isOpen && activeTab === panel;

  return (
    <>
      {/* Desktop: header tab strip — clicking switches; clicking active closes */}
      {!isMobile &&
        (loading ? (
          <>
            <HeaderIconSkeleton />
            <HeaderIconSkeleton />
          </>
        ) : (
          <>
            {hasTasksContent && (
              <Tooltip content={isShowing("tasks") ? "Hide tasks" : "Show tasks"}>
                <Button
                  variant="icon"
                  toggled={isShowing("tasks")}
                  onClick={() => onSelectTab("tasks")}
                  className="relative shrink-0"
                >
                  <ListChecks size={15} strokeWidth={2} />
                  <CountBadge count={tasksCount} />
                </Button>
              </Tooltip>
            )}
            {hasAgentsContent && (
              <Tooltip content={isShowing("agents") ? "Hide agents" : "Show agents"}>
                <Button
                  variant="icon"
                  toggled={isShowing("agents")}
                  onClick={() => onSelectTab("agents")}
                  className="relative shrink-0"
                >
                  <Bot size={15} strokeWidth={2} />
                  {agentsCount > 0 && <CountBadge count={agentsCount} />}
                </Button>
              </Tooltip>
            )}
            {hasFilesContent && (
              <Tooltip content={isShowing("files") ? "Hide files" : "Show files"}>
                <Button
                  variant="icon"
                  toggled={isShowing("files")}
                  onClick={() => onSelectTab("files")}
                  className="relative shrink-0"
                >
                  <FileText size={15} strokeWidth={2} />
                  <CountBadge count={filesCount} />
                </Button>
              </Tooltip>
            )}
            {hasPlanContent && (
              <Tooltip content={isShowing("plan") ? "Hide plan" : "Show plan"}>
                <Button
                  variant="icon"
                  toggled={isShowing("plan")}
                  onClick={() => onSelectTab("plan")}
                  className="shrink-0"
                >
                  <ScrollText size={15} strokeWidth={2} />
                </Button>
              </Tooltip>
            )}
            {hasReviewContent && (
              <Tooltip content={isShowing("review") ? "Hide code review" : "Show code review"}>
                <Button
                  variant="icon"
                  toggled={isShowing("review")}
                  onClick={() => onSelectTab("review")}
                  className="shrink-0"
                >
                  <MessageCircleCode size={15} strokeWidth={2} />
                </Button>
              </Tooltip>
            )}
            {hasStats && (
              <HeaderContextToggle
                stats={stats}
                active={isShowing("context")}
                tooltip={isShowing("context") ? "Hide context" : "Show context"}
                onClick={() => onSelectTab("context")}
                provider={provider}
              />
            )}
          </>
        ))}
      {/* Mobile: single sidecar button */}
      {isMobile &&
        (loading ? (
          <HeaderIconSkeleton />
        ) : (
          sidecarContentCount > 0 && (
            <Tooltip content="Sidecar">
              <Button
                variant="icon"
                onClick={onOpenMobileSidecar}
                className="relative h-9 w-9 shrink-0 rounded-lg"
              >
                <LayoutGrid size={17} strokeWidth={2} />
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-claude px-0.5 text-[0.5625rem] font-semibold leading-none text-white">
                  {sidecarContentCount}
                </span>
              </Button>
            </Tooltip>
          )
        ))}
    </>
  );
}

// ── Header ───────────────────────────────────────────────────────────

interface InstanceHeaderProps {
  instance: InstanceInfo;
  isMobile: boolean;
  /** The user's currently selected sidecar tab. */
  activeTab: SidecarTab;
  /** Whether the sidecar is currently open. */
  isOpen: boolean;
  tasksCount: number;
  filesCount: number;
  agentsCount?: number;
  hasAgentsContent?: boolean;
  hasPlanContent: boolean;
  hasReviewContent: boolean;
  hasStats: boolean;
  sidecarContentCount: number;
  loadingSidecarActions?: boolean;
  onSelectTab: (panel: SidecarTab) => void;
  onOpenDebug: () => void;
  onDelete?: () => void;
  onOpenMobileSidecar: () => void;
  onSplit?: () => void;
  onRename?: (name: string) => void;
  /** Toggle embedded terminal panel. */
  onToggleTerminal?: () => void;
  /** Whether the terminal panel is currently open. */
  terminalOpen?: boolean;
}

/**
 * Which account this chat runs under — shown only when the provider keeps
 * several logins (capability-gated) and more than one profile is registered,
 * so a single-account install never grows an extra chip.
 */
function useChatAccountChip(instance: InstanceInfo): { label: string; detail: string } | null {
  const { capabilities } = useProviderModels(instance.provider);
  const supportsAccountProfiles = !!capabilities.supportsAccountProfiles;
  const { data: profiles } = useProviderProfiles(instance.provider, {
    enabled: supportsAccountProfiles,
  });
  if (!supportsAccountProfiles || !profiles || profiles.length < 2) return null;
  const resolved = resolveChatAccountLabel(profiles, instance.configDir);
  return { label: resolved.label, detail: resolved.detail ?? resolved.label };
}

function shouldPromoteProviderNotice(notice: ProviderNotice | undefined): boolean {
  if (!notice) return false;
  if (notice.code === "auth_required") return false;
  if (notice.source === "account/read") return false;
  return notice.source === "configWarning" || notice.source === "deprecationNotice";
}

type InstanceGitStatus = Awaited<ReturnType<typeof fetchInstanceGitStatus>>;

interface PushBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branch?: string;
  status: InstanceGitStatus | null;
  statusError: string | null;
  pushing: boolean;
  onConfirm: (commitMessage?: string) => void;
}

function PushBranchDialog({
  open,
  onOpenChange,
  branch,
  status,
  statusError,
  pushing,
  onConfirm,
}: PushBranchDialogProps) {
  const [commitMessage, setCommitMessage] = useState("");
  const changeCount = status?.changeCount ?? 0;
  const hasUncommittedChanges = changeCount > 0;
  const canConfirm = !pushing && (!hasUncommittedChanges || commitMessage.trim().length > 0);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) setCommitMessage("");
    onOpenChange(nextOpen);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      {open && (
        <Dialog.Content maxWidth="max-w-md">
          <Dialog.Header>
            <Dialog.Title>Push Branch?</Dialog.Title>
            <Dialog.Close />
          </Dialog.Header>
          <div className="space-y-3 text-[0.8125rem] text-muted">
            <p>
              Push <span className="font-medium text-text">{branch || "the current branch"}</span>{" "}
              to its remote.
            </p>
            {!status && !statusError ? <p>Checking working tree…</p> : null}
            {statusError ? <p className="text-warning">{statusError}</p> : null}
            {status ? (
              <p>
                {hasUncommittedChanges
                  ? `${changeCount} uncommitted ${changeCount === 1 ? "change" : "changes"} will be committed before pushing.`
                  : "No uncommitted changes detected."}
                {status.aheadBehind.ahead > 0
                  ? ` ${status.aheadBehind.ahead} local ${status.aheadBehind.ahead === 1 ? "commit is" : "commits are"} ahead of upstream.`
                  : ""}
              </p>
            ) : null}
            {hasUncommittedChanges ? (
              <div className="space-y-1.5">
                <label
                  className="text-[0.75rem] font-medium text-muted"
                  htmlFor="push-commit-message-input"
                >
                  Commit message
                </label>
                <Input
                  id="push-commit-message-input"
                  autoFocus
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && canConfirm) onConfirm(commitMessage.trim());
                  }}
                  placeholder="Describe changes before pushing"
                />
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!canConfirm || (!status && !statusError)}
                onClick={() => onConfirm(hasUncommittedChanges ? commitMessage.trim() : undefined)}
              >
                {pushing ? "Pushing…" : hasUncommittedChanges ? "Commit & Push" : "Push Branch"}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      )}
    </Dialog.Root>
  );
}

export function InstanceHeader({
  instance,
  isMobile,
  activeTab,
  isOpen,
  tasksCount,
  filesCount,
  agentsCount = 0,
  hasAgentsContent = false,
  hasPlanContent,
  hasReviewContent,
  hasStats,
  sidecarContentCount,
  loadingSidecarActions = false,
  onSelectTab,
  onOpenDebug,
  onDelete,
  onOpenMobileSidecar,
  onSplit,
  onRename,
  onToggleTerminal,
  terminalOpen,
}: InstanceHeaderProps) {
  const displayBranch = instance.gitInfo?.branch || instance.gitBranch;

  const instanceStatus = deriveInstanceStatusPresentation(instance);

  const projectId = getInstanceProjectRouteId(instance);
  const displayBranchName = displayBranch || undefined;
  const providerNotices = instance.providerStatus?.notices ?? [];
  const latestProviderNotice = providerNotices[providerNotices.length - 1];
  const promotedProviderNotice = shouldPromoteProviderNotice(latestProviderNotice)
    ? latestProviderNotice
    : null;
  const reroutedModel = instance.providerStatus?.effectiveModel;
  const rerouteSource = instance.providerStatus?.reroutedFromModel;
  const accountChip = useChatAccountChip(instance);

  const queryClient = useQueryClient();
  const invalidateGitStatus = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["instance-git-status", instance.id] }),
    [queryClient, instance.id],
  );

  // Push-based: the server publishes repo_status when the worktree changes
  // (turn end, Relay git mutations, background fetch). Its fingerprint drives
  // refetches of the badge status and the diff drawer — no polling.
  useRepoStatus(displayBranch ? { kind: "instance", instanceId: instance.id } : null, {
    invalidate: [
      ["instance-git-status", instance.id],
      ["instanceDiff", instance.id],
    ],
  });

  // Lightweight git status query for the badge indicators
  const {
    data: gitStatus,
    isLoading: gitStatusLoading,
    error: gitStatusError,
  } = useQuery({
    queryKey: ["instance-git-status", instance.id],
    queryFn: () => fetchInstanceGitStatus(instance.id),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    // Only fetch when we have a branch (instance is in a git repo)
    enabled: !!displayBranch,
  });
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [pushDialogOpen, setPushDialogOpen] = useState(false);
  const [pushStatus, setPushStatus] = useState<InstanceGitStatus | null>(null);
  const [pushStatusError, setPushStatusError] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  // One git action at a time: the ref blocks same-tick re-entry (double
  // clicks), the state drives the badge's disabled/pending UI.
  const [pendingGitAction, setPendingGitAction] = useState<GitBadgePendingAction | null>(null);
  const pendingGitActionRef = useRef<GitBadgePendingAction | null>(null);
  const runGitAction = async (action: GitBadgePendingAction, fn: () => Promise<void>) => {
    if (pendingGitActionRef.current) return;
    pendingGitActionRef.current = action;
    setPendingGitAction(action);
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Git ${action} failed`);
    } finally {
      pendingGitActionRef.current = null;
      setPendingGitAction(null);
    }
  };

  // Inline rename state
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  const startRenaming = () => {
    setNameDraft(instance.name);
    setEditingName(true);
    // Focus after state update
    setTimeout(() => nameInputRef.current?.focus(), 0);
  };

  const commitRename = () => {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== instance.name) {
      onRename?.(trimmed);
    }
    setEditingName(false);
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") commitRename();
    if (e.key === "Escape") setEditingName(false);
  };

  const handleCommit = (message: string) =>
    runGitAction("commit", async () => {
      const result = await gitCommitInstance(instance.id, { message });
      if (result.success) {
        toast.success("Changes committed");
        invalidateGitStatus();
      } else {
        toast.error(result.error || "Commit failed");
      }
    });

  const handleFetch = () =>
    runGitAction("fetch", async () => {
      const result = await gitFetchInstance(instance.id);
      if (result.success) {
        toast.success("Fetched from remote");
        invalidateGitStatus();
      } else {
        toast.error(result.error || "Fetch failed");
      }
    });

  const handlePull = () =>
    runGitAction("pull", async () => {
      const ahead = gitStatus?.aheadBehind?.ahead ?? 0;
      const behind = gitStatus?.aheadBehind?.behind ?? 0;
      // Diverged (ahead *and* behind) can't fast-forward — rebase onto remote.
      const diverged = ahead > 0 && behind > 0;
      const result = await gitPullInstance(instance.id, { rebase: diverged });
      if (result.success) {
        toast.success(diverged ? "Rebased onto remote" : "Pulled from remote");
        invalidateGitStatus();
      } else {
        toast.error(result.error || "Pull failed");
      }
    });

  const openPushDialog = () => {
    setPushDialogOpen(true);
    setPushStatus(null);
    setPushStatusError(null);
    fetchInstanceGitStatus(instance.id)
      .then(setPushStatus)
      .catch((err) => {
        setPushStatusError(err instanceof Error ? err.message : "Failed to read git status");
      });
  };

  const handlePush = async (commitMessage?: string) => {
    if (pendingGitActionRef.current) return;
    pendingGitActionRef.current = "push";
    setPendingGitAction("push");
    setPushing(true);
    try {
      const result = await gitPushInstance(instance.id, {
        branch: displayBranchName,
        setUpstream: true,
        commitMessage,
      });
      if (!result.success) {
        toast.error(result.error || "Push failed");
        return;
      }
      setPushDialogOpen(false);
      invalidateGitStatus();
      if (result.pushed === false) {
        toast.warning(result.message || "Nothing to push");
        return;
      }
      toast.success(commitMessage ? "Changes committed and branch pushed" : "Branch pushed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Push failed");
    } finally {
      pendingGitActionRef.current = null;
      setPendingGitAction(null);
      setPushing(false);
    }
  };

  const moreMenu = (
    <Menu.Root>
      <Menu.Trigger className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-all duration-150 hover:bg-surface-hover hover:text-text sm:h-7 sm:w-7 sm:rounded-md">
        <EllipsisVertical size={isMobile ? 18 : 14} />
      </Menu.Trigger>
      <Menu.Content>
        {onRename && (
          <Menu.Item onClick={startRenaming}>
            <Pencil size={13} strokeWidth={2} className="text-muted" />
            Rename
          </Menu.Item>
        )}
        {onSplit && !isMobile && (
          <Menu.Item onClick={onSplit}>
            <Columns2 size={13} strokeWidth={2} className="text-muted" />
            Split view
          </Menu.Item>
        )}
        <Menu.Item onClick={onOpenDebug}>
          <Bug size={13} strokeWidth={2} className="text-muted" />
          Debug
        </Menu.Item>
        {onDelete && (
          <>
            <Menu.Separator />
            <Menu.Item danger onClick={onDelete}>
              <Trash2 size={13} />
              Delete chat
            </Menu.Item>
          </>
        )}
      </Menu.Content>
    </Menu.Root>
  );

  if (isMobile) {
    return (
      <MobileViewHeader
        title={instance.name}
        projectId={projectId}
        projectLabel={getProjectName(instance.workingDirectory)}
        gitBranch={displayBranchName}
        actions={
          <SidecarToggles
            loading={loadingSidecarActions}
            isMobile={isMobile}
            activeTab={activeTab}
            isOpen={isOpen}
            tasksCount={tasksCount}
            filesCount={filesCount}
            agentsCount={agentsCount}
            hasAgentsContent={hasAgentsContent}
            hasPlanContent={hasPlanContent}
            hasReviewContent={hasReviewContent}
            hasStats={hasStats}
            stats={instance.stats}
            provider={instance.provider}
            sidecarContentCount={sidecarContentCount}
            onSelectTab={onSelectTab}
            onOpenMobileSidecar={onOpenMobileSidecar}
          />
        }
      >
        <CommitMessageDialog
          open={commitDialogOpen}
          onOpenChange={setCommitDialogOpen}
          onCommit={(msg) => void handleCommit(msg)}
        />
        <PushBranchDialog
          open={pushDialogOpen}
          onOpenChange={setPushDialogOpen}
          branch={displayBranchName}
          status={pushStatus}
          statusError={pushStatusError}
          pushing={pushing}
          onConfirm={(commitMessage) => void handlePush(commitMessage)}
        />
      </MobileViewHeader>
    );
  }

  return (
    <ViewHeader style={{ containerName: "view-header", containerType: "inline-size" }}>
      <MobileSidebarToggle />
      <span className="view-header-breadcrumb contents">
        <ProjectBreadcrumb
          projectId={projectId}
          label={getProjectName(instance.workingDirectory)}
        />
      </span>
      <Tooltip content={instanceStatus.label}>
        <span className={`h-2 w-2 shrink-0 rounded-full ${instanceStatus.dotClass}`} />
      </Tooltip>
      <ViewHeaderTitle>
        {editingName ? (
          <input
            ref={nameInputRef}
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleNameKeyDown}
            className="w-[14rem] max-w-[40vw] rounded border border-border bg-surface px-2 py-0.5 text-sm font-semibold text-text-bright outline-none focus:border-accent"
          />
        ) : (
          <h1 className="truncate text-sm font-semibold tracking-tight text-text-bright">
            {instance.name}
          </h1>
        )}
        <span className="view-header-badge contents">
          {promotedProviderNotice ? (
            <Tooltip
              content={
                <div className="max-w-64">
                  <div className="font-medium">{promotedProviderNotice.message}</div>
                  {promotedProviderNotice.detail ? (
                    <div className="mt-1 text-muted">{promotedProviderNotice.detail}</div>
                  ) : null}
                </div>
              }
            >
              <span className="inline-flex items-center gap-1 rounded-md border border-warning/25 bg-warning/10 px-2 py-0.5 text-[0.6875rem] font-medium text-warning">
                <AlertTriangle size={11} />
                Notice
              </span>
            </Tooltip>
          ) : null}
          {reroutedModel && rerouteSource && reroutedModel !== rerouteSource ? (
            <Tooltip content={`Codex rerouted ${rerouteSource} to ${reroutedModel}`}>
              <span className="inline-flex items-center rounded-md border border-border/70 bg-panel px-2 py-0.5 text-[0.6875rem] font-medium text-muted">
                {reroutedModel}
              </span>
            </Tooltip>
          ) : null}
          {accountChip ? (
            <Tooltip content={accountChip.detail}>
              <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-panel px-2 py-0.5 text-[0.6875rem] font-medium text-muted">
                <UserRound size={11} />
                {accountChip.label}
              </span>
            </Tooltip>
          ) : null}
        </span>
        {moreMenu}
      </ViewHeaderTitle>
      <div className="flex items-center gap-1.5">
        <OpenInMenu path={instance.workingDirectory} className="hidden sm:flex" />
        {displayBranch && !isMobile && (
          <GitBadge
            branch={displayBranch}
            projectId={instance.gitInfo?.isWorktree ? undefined : projectId}
            dirty={gitStatus?.dirty}
            ahead={gitStatus?.aheadBehind?.ahead}
            behind={gitStatus?.aheadBehind?.behind}
            statusLoading={gitStatusLoading}
            statusError={gitStatusError ? gitStatusError.message : null}
            pendingAction={pendingGitAction}
            onCommit={gitStatus?.dirty ? () => setCommitDialogOpen(true) : undefined}
            onFetch={() => void handleFetch()}
            onPull={() => void handlePull()}
            onPush={openPushDialog}
          />
        )}
        {onToggleTerminal && !isMobile && (
          <HeaderTerminalToggle open={!!terminalOpen} onClick={onToggleTerminal} />
        )}
        <CommitMessageDialog
          open={commitDialogOpen}
          onOpenChange={setCommitDialogOpen}
          onCommit={(msg) => void handleCommit(msg)}
        />
        <PushBranchDialog
          open={pushDialogOpen}
          onOpenChange={setPushDialogOpen}
          branch={displayBranchName}
          status={pushStatus}
          statusError={pushStatusError}
          pushing={pushing}
          onConfirm={(commitMessage) => void handlePush(commitMessage)}
        />
        <SidecarToggles
          loading={loadingSidecarActions}
          isMobile={isMobile}
          activeTab={activeTab}
          isOpen={isOpen}
          tasksCount={tasksCount}
          filesCount={filesCount}
          agentsCount={agentsCount}
          hasAgentsContent={hasAgentsContent}
          hasPlanContent={hasPlanContent}
          hasReviewContent={hasReviewContent}
          hasStats={hasStats}
          stats={instance.stats}
          provider={instance.provider}
          sidecarContentCount={sidecarContentCount}
          onSelectTab={onSelectTab}
          onOpenMobileSidecar={onOpenMobileSidecar}
        />
      </div>
    </ViewHeader>
  );
}
