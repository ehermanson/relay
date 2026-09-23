import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Menu } from "@/components/ui/menu";
import { GitBadge } from "@/components/ui/git-badge";
import {
  ViewHeader,
  ViewHeaderTitle,
  MobileSidebarToggle,
  MobileViewHeader,
} from "@/components/ui/view-header";
import { ProjectBreadcrumb } from "@/components/ui/project-breadcrumb";
import {
  HeaderContextToggle,
  HeaderIconSkeleton,
  HeaderTerminalToggle,
} from "@/components/chat/header-actions";
import { OpenInMenu } from "@/components/project/open-in-menu";
import { GhCliRequiredDialog } from "@/components/git/gh-cli-required-dialog";
import { CommitMessageDialog } from "@/components/git/commit-message-dialog";
import { useSpaceViewContext } from "@/components/spaces/space-view-context";
import { SpacePrBadge } from "@/components/spaces/space-pr-badge";
import {
  Archive,
  BookOpen,
  Bug,
  Check,
  EllipsisVertical,
  FileText,
  GitBranch,
  LayoutGrid,
  Pencil,
} from "lucide-react";

export function SpaceViewHeader() {
  const { shared, actions } = useSpaceViewContext();
  const isShowing = (panel: "brief" | "files" | "context") =>
    shared.isSidecarOpen && shared.sidecarTab === panel;

  // ── Mobile layout ──────────────────────────────────────────────────
  if (shared.isMobile) {
    return (
      <MobileViewHeader
        title={shared.space.name}
        projectId={shared.projectId}
        projectLabel={shared.projectName}
        gitBranch={shared.space.gitBranch ?? undefined}
        actions={
          shared.sidecarContentCount > 0 ? (
            <Button
              variant="icon"
              onClick={() => actions.setSidecarMobileOpen(true)}
              className="relative h-9 w-9 shrink-0 rounded-lg"
            >
              <LayoutGrid size={17} strokeWidth={2} />
              <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-claude px-0.5 text-[0.5625rem] font-semibold leading-none text-white">
                {shared.sidecarContentCount}
              </span>
            </Button>
          ) : null
        }
      >
        <CommitMessageDialog
          open={shared.commitDialogOpen}
          onOpenChange={actions.setCommitDialogOpen}
          onCommit={(message) => void actions.handleCommit(message)}
        />
        <GhCliRequiredDialog
          open={shared.ghCliDialogOpen}
          onOpenChange={actions.setGhCliDialogOpen}
          reason={shared.ghCliReason}
        />
      </MobileViewHeader>
    );
  }

  // ── Desktop layout ─────────────────────────────────────────────────
  return (
    <ViewHeader style={{ containerName: "view-header", containerType: "inline-size" }}>
      <MobileSidebarToggle />
      <span className="view-header-breadcrumb contents">
        <ProjectBreadcrumb projectId={shared.projectId} label={shared.projectName} />
      </span>
      <GitBranch size={14} className="shrink-0 text-accent" />
      <ViewHeaderTitle>
        {shared.editingSpaceName ? (
          <input
            ref={shared.spaceNameInputRef}
            value={shared.spaceNameDraft}
            onChange={(e) => actions.setSpaceNameDraft(e.target.value)}
            onBlur={actions.commitSpaceRename}
            onKeyDown={actions.handleSpaceNameKeyDown}
            className="w-[12rem] max-w-[40vw] rounded border border-border bg-surface px-2 py-0.5 text-sm font-semibold text-text-bright outline-none focus:border-accent"
          />
        ) : (
          <span className="truncate text-sm font-semibold text-text-bright">
            {shared.space.name}
          </span>
        )}
        <span className="view-header-badge contents">
          {shared.isMerged && (
            <Badge variant="success" size="sm">
              Merged
            </Badge>
          )}
          {shared.isBroken && (
            <Badge variant="warning" size="sm">
              Broken
            </Badge>
          )}
          {shared.isArchived && (
            <Badge variant="default" size="sm">
              Archived
            </Badge>
          )}
          {shared.isActive && <SpacePrBadge space={shared.space} />}
        </span>
        <Menu.Root>
          <Menu.Trigger className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-all duration-150 hover:bg-surface-hover hover:text-text">
            <EllipsisVertical size={14} />
          </Menu.Trigger>
          <Menu.Content>
            {!shared.space.isDefault && (shared.isActive || shared.isBroken) && (
              <Menu.Item onClick={actions.startRenamingSpace}>
                <Pencil size={13} strokeWidth={2} className="text-muted" />
                Rename
              </Menu.Item>
            )}
            <Menu.Item onClick={() => actions.setShowDebug(true)}>
              <Bug size={13} strokeWidth={2} className="text-muted" />
              Debug
            </Menu.Item>
            {!shared.space.isDefault && shared.isActive && (
              <Menu.Item onClick={actions.handleMarkMerged}>
                <Check size={13} strokeWidth={2} className="text-muted" />
                Mark as merged
              </Menu.Item>
            )}
            {!shared.space.isDefault && (shared.isActive || shared.isBroken) && (
              <>
                <Menu.Separator />
                <Menu.Item danger onClick={() => actions.setConfirmDelete(true)}>
                  <Archive size={13} />
                  Archive space
                </Menu.Item>
              </>
            )}
          </Menu.Content>
        </Menu.Root>
      </ViewHeaderTitle>

      <div className="flex items-center gap-1.5">
        {shared.isActive && (
          <>
            <OpenInMenu path={shared.openInPath} className="hidden sm:flex" />
            {shared.space.gitBranch && (
              <GitBadge
                branch={shared.space.gitBranch}
                onCommit={() => actions.setCommitDialogOpen(true)}
                onPush={() => void actions.handlePush(false)}
                onPushAndCreatePR={() => void actions.handlePush(true)}
                onMerge={() => actions.setMergeDialog({ phase: "confirm" })}
                mergeDisabled={shared.spaceInstances.length === 0}
                worktreePath={shared.space.worktreePath || undefined}
                pendingAction={shared.pendingGitAction}
              />
            )}
            <HeaderTerminalToggle
              open={shared.showTerminalPanel || shared.isTerminalCollapsed}
              onClick={actions.handleToggleTerminal}
            />
          </>
        )}
        <CommitMessageDialog
          open={shared.commitDialogOpen}
          onOpenChange={actions.setCommitDialogOpen}
          onCommit={(message) => void actions.handleCommit(message)}
        />
        <GhCliRequiredDialog
          open={shared.ghCliDialogOpen}
          onOpenChange={actions.setGhCliDialogOpen}
          reason={shared.ghCliReason}
        />

        {!shared.space.isDefault && (
          <Tooltip content={isShowing("brief") ? "Hide brief" : "Show brief"}>
            <Button
              variant="icon"
              toggled={isShowing("brief")}
              onClick={() => actions.selectSidecarTab("brief")}
              className="shrink-0"
            >
              <BookOpen size={15} strokeWidth={2} />
            </Button>
          </Tooltip>
        )}

        {(shared.spaceInstances.length > 0 || shared.chatSummariesLoading) && (
          <>
            {shared.chatSummariesLoading && shared.spaceInstances.length === 0 ? (
              <>
                <HeaderIconSkeleton />
                <HeaderIconSkeleton />
              </>
            ) : (
              <>
                {shared.fileChanges.length > 0 && (
                  <Tooltip content={isShowing("files") ? "Hide files" : "Show files"}>
                    <Button
                      variant="icon"
                      toggled={isShowing("files")}
                      onClick={() => actions.selectSidecarTab("files")}
                      className="relative shrink-0"
                    >
                      <FileText size={15} strokeWidth={2} />
                      <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[0.5625rem] font-semibold leading-none text-white">
                        {shared.fileChanges.length}
                      </span>
                    </Button>
                  </Tooltip>
                )}
                <HeaderContextToggle
                  stats={shared.activeLiveInstance?.stats}
                  active={isShowing("context")}
                  tooltip={isShowing("context") ? "Hide context" : "Show context"}
                  onClick={() => actions.selectSidecarTab("context")}
                />
              </>
            )}
          </>
        )}
      </div>
    </ViewHeader>
  );
}
