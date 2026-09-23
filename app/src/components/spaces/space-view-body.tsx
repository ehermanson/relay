import type { ComponentProps } from "react";
import { Check, Copy, FolderOpen, GitBranch, Plus } from "lucide-react";
import { motion } from "motion/react";
import { InstanceView } from "@/components/chat/instance-view";
import { SpaceChatTabs } from "@/components/spaces/space-chat-tabs";
import { SpaceSidebar } from "@/components/spaces/space-sidebar";
import { useSpaceViewContext } from "@/components/spaces/space-view-context";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { Button } from "@/components/ui/button";
import { MobileSidecarOverlay } from "@/components/ui/mobile-sidecar-overlay";
import { RelayLogo } from "@/components/ui/relay-logo";
import { Spinner } from "@/components/ui/spinner";
import { CollapsedTerminalBar } from "@/components/terminal/terminal-collapsed-bar";
import { LazyTerminalPanel } from "@/components/terminal/lazy-terminal-panel";
import { useFirstPaint } from "@/hooks/use-first-paint";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { useSidecarStore } from "@/stores/sidecar-store";
import type { InstanceInfo } from "@shared/types";

const MotionLogo = motion.create(RelayLogo);
const TERMINAL_ANIM_TRANSITION = { duration: 0.22, ease: [0.22, 1, 0.36, 1] } as const;

export function SpaceViewBody() {
  const { shared, actions } = useSpaceViewContext();
  const firstPaint = useFirstPaint();
  const mountTerminalPanel =
    (shared.showTerminalPanel || shared.isTerminalCollapsed) && !shared.isMobile;
  const chatTabsProps: ComponentProps<typeof SpaceChatTabs> = {
    instances: shared.spaceInstances,
    activeTab: shared.activeTab,
    pendingNewChatId: shared.pendingNewChatId,
    pendingNewChat: shared.pendingNewChatActive,
    onNavigateToChat: actions.navigateToChat,
    onRenameTab: actions.handleRenameTab,
    onCloseTab: (id) => actions.setCloseTabId(id),
    onNewChat: actions.handleNewChat,
    disableNewChat: shared.isBroken,
  };

  const storedSidebarWidth = useSidecarStore((s) => s.sidebarWidth);
  const setStoredSidebarWidth = useSidecarStore((s) => s.setSidebarWidth);
  const {
    panelRef: sidebarPanelRef,
    containerRef: sidebarContainerRef,
    width: sidebarWidth,
    isResizing: sidebarResizing,
    onResizeStart: handleSidebarResizeStart,
  } = useResizablePanel({
    side: "right",
    minWidth: 260,
    maxWidth: (cw) => cw * 0.45,
    defaultWidth: storedSidebarWidth,
    onResizeEnd: setStoredSidebarWidth,
  });

  const showSidebar = shared.showSidebar && !shared.isMobile;

  const openDiffAndCloseMobile = (scrollTo?: string) => {
    actions.openDiff(scrollTo);
    actions.setSidecarMobileOpen(false);
  };

  return (
    <>
      {shared.isMerged && (
        <div className="flex items-center gap-2 border-b border-border bg-surface-dim px-4 py-2 text-xs text-text-muted">
          <span>
            This space has been merged into{" "}
            <span className="font-medium text-text">
              {shared.space.targetBranch || "the main branch"}
            </span>
            .
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={actions.handleGoToMainWorkspace}
            className="ml-auto text-xs"
          >
            Go to main workspace
          </Button>
        </div>
      )}
      {shared.isArchived && (
        <div className="flex items-center gap-2 border-b border-border bg-surface-dim px-4 py-2 text-xs text-text-muted">
          This space has been archived. Chats and history are still available.
        </div>
      )}
      {shared.isBroken && (
        <div className="flex items-center gap-3 border-b border-warning/30 bg-warning/8 px-4 py-2 text-xs text-text-muted">
          <div className="min-w-0 flex-1">
            This space is missing its worktree. Chats and history remain available, but new work is
            blocked. To repair it, restore the missing worktree at{" "}
            <code className="font-mono text-[0.6875rem] text-text">
              {shared.space.missingWorktreePath ??
                shared.space.worktreePath ??
                "(path unavailable)"}
            </code>{" "}
            or archive the space if you no longer need it.
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => actions.setConfirmDelete(true)}
            className="shrink-0"
          >
            Archive space
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {(shared.activeTab || shared.pendingNewChatActive) && <SpaceChatTabs {...chatTabsProps} />}
        <div ref={sidebarContainerRef} className="flex min-h-0 flex-1 overflow-hidden">
          {shared.activeTab || shared.pendingNewChatActive ? (
            <>
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <SpaceChatArea
                  activeTab={shared.activeTab}
                  activeLiveInstance={shared.activeLiveInstance}
                  pendingNewChat={shared.pendingNewChatActive}
                />
              </div>
              {!shared.isMobile && (
                <div
                  ref={sidebarPanelRef}
                  className={`relative flex h-full shrink-0 overflow-hidden ${
                    sidebarResizing || firstPaint
                      ? ""
                      : "transition-[width,opacity] duration-200 ease-out"
                  } ${showSidebar ? "opacity-100 py-2 pl-2 pr-2" : "w-0 opacity-0"}`}
                  style={showSidebar ? { width: sidebarWidth ?? "max(280px, 30%)" } : undefined}
                >
                  <div
                    onMouseDown={handleSidebarResizeStart}
                    className="absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize bg-transparent"
                  />
                  <div className="app-sidecar-panel h-full flex-1 overflow-hidden">
                    <SpaceSidebar
                      space={shared.space}
                      instances={shared.spaceInstances}
                      tabs={shared.effectiveSidecarTab ? [shared.effectiveSidecarTab] : []}
                      activeTab={shared.sidecarTab}
                      onSelectTab={actions.selectSidecarTab}
                      onClose={actions.closeSidecar}
                      stats={shared.aggregatedStats}
                      fileChanges={shared.fileChanges}
                      diffError={shared.spaceDiffError}
                      onRetryDiff={actions.retrySpaceDiff}
                      onOpenDiff={actions.openDiff}
                    />
                  </div>
                </div>
              )}
            </>
          ) : shared.isResolvingChatSelection ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
              <Spinner size={18} />
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium text-text-bright">Opening space</p>
                <p className="max-w-xs text-[0.8125rem] text-muted">
                  Resolving the most recent chat in this space.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
              <GitBranch size={32} className="text-muted/30" />
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium text-text-bright">Space ready</p>
                <p className="max-w-xs text-[0.8125rem] text-muted">
                  This space has its own branch and working copy. Start a chat to begin working.
                </p>
              </div>
              {shared.space.worktreePath && (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-hover/50 px-3 py-2 text-xs">
                  <FolderOpen size={13} className="shrink-0 text-muted/70" />
                  <code
                    className="max-w-[20rem] truncate font-mono text-[0.6875rem] text-muted"
                    title={shared.space.worktreePath}
                  >
                    {shared.space.worktreePath}
                  </code>
                  <button
                    type="button"
                    onClick={actions.handleCopyPath}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.6875rem] text-muted transition-colors hover:bg-surface-hover hover:text-text"
                  >
                    {shared.pathCopied ? <Check size={11} /> : <Copy size={11} />}
                    {shared.pathCopied ? "Copied" : "Copy"}
                  </button>
                </div>
              )}
              <Button
                variant="primary"
                size="sm"
                onClick={actions.handleNewChat}
                className="gap-1.5"
              >
                <Plus size={14} />
                New Chat
              </Button>
            </div>
          )}
        </div>
        {mountTerminalPanel && (
          <motion.div
            key="terminal"
            initial={false}
            animate={{
              height: shared.showTerminalPanel ? shared.terminalHeight : 0,
              opacity: shared.showTerminalPanel ? 1 : 0,
            }}
            transition={TERMINAL_ANIM_TRANSITION}
            className={`shrink-0 overflow-hidden ${
              shared.showTerminalPanel ? "" : "pointer-events-none"
            }`}
            aria-hidden={!shared.showTerminalPanel}
          >
            <ErrorBoundary name="Terminal panel">
              <LazyTerminalPanel
                scope={shared.terminalScope}
                height={shared.terminalHeight}
                onResizeStart={actions.handleTerminalResizeStart}
                activeInstanceId={shared.activeTab}
              />
            </ErrorBoundary>
          </motion.div>
        )}
        {shared.isTerminalCollapsed && !shared.isMobile && shared.collapsedTerminalCount > 0 && (
          <CollapsedTerminalBar
            terminalCount={shared.collapsedTerminalCount}
            onExpand={actions.expandTerminalPanel}
          />
        )}
      </div>

      {shared.isMobile && shared.sidecarMobileOpen && shared.sidecarContentCount > 0 && (
        <MobileSidecarOverlay onClose={() => actions.setSidecarMobileOpen(false)}>
          <SpaceSidebar
            space={shared.space}
            instances={shared.spaceInstances}
            tabs={Array.from(shared.allContentPanels)}
            activeTab={shared.sidecarTab}
            onSelectTab={actions.selectSidecarTab}
            stats={shared.aggregatedStats}
            fileChanges={shared.fileChanges}
            diffError={shared.spaceDiffError}
            onRetryDiff={actions.retrySpaceDiff}
            onOpenDiff={openDiffAndCloseMobile}
            isMobileOverlay
            onClose={() => actions.setSidecarMobileOpen(false)}
          />
        </MobileSidecarOverlay>
      )}
    </>
  );
}

const pendingChatLoadingContent = (
  <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
    <div className="flex w-full max-w-md flex-col items-center px-6 py-8 text-center">
      <MotionLogo
        size={112}
        connected
        showPulseRings
        animated
        className="mb-5"
        initial={{ opacity: 0, scale: 0.82 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: "spring", duration: 0.9, bounce: 0.25 }}
      />
      <p className="text-[0.875rem] font-medium text-text-bright">Creating chat</p>
      <p className="mt-1 text-[0.75rem] text-muted">Setting up a fresh chat in this space...</p>
    </div>
  </div>
);

function SpaceChatArea({
  activeTab,
  activeLiveInstance,
  pendingNewChat,
}: {
  activeTab: string | null;
  activeLiveInstance: InstanceInfo | null;
  pendingNewChat?: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {pendingNewChat ? (
        pendingChatLoadingContent
      ) : activeTab && activeLiveInstance ? (
        <InstanceView key={activeTab} instanceId={activeTab} compact />
      ) : activeTab ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
          <div className="flex w-full max-w-md flex-col items-center px-6 py-8 text-center">
            <Spinner size={18} />
            <p className="mt-4 text-[0.875rem] font-medium text-text-bright">Restoring chat</p>
            <p className="mt-1 text-[0.75rem] text-muted">
              Waiting for the live chat state to reconnect.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
