import { useState } from "react";
import { motion } from "motion/react";
import { CollapsedTerminalBar } from "@/components/terminal/terminal-collapsed-bar";
import { LazyTerminalPanel } from "@/components/terminal/lazy-terminal-panel";
import { Sidecar } from "@/components/chat/sidecar";
import { ReviewSidecarPanel } from "@/components/chat/review-sidecar-panel";
import { ReviewSetupPanel } from "@/components/chat/review-setup-panel";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { InstanceViewContent } from "@/components/chat/instance-view-content";
import { InstanceViewHeader } from "@/components/chat/instance-view-header";
import { useInstanceViewContext } from "@/components/chat/instance-view-context";
import { useFirstPaint } from "@/hooks/use-first-paint";
import { useProviderRuntimeStore } from "@/stores/provider-runtime-store";
import { useRateLimitWarning } from "@/hooks/use-rate-limit-warning";

const TERMINAL_ANIM_TRANSITION = { duration: 0.22, ease: [0.22, 1, 0.36, 1] } as const;

export function InstanceViewShell() {
  const { shared, actions } = useInstanceViewContext();
  const providerGlobalState = useProviderRuntimeStore((s) => s.providerGlobalState);
  const currentProviderGlobalState = providerGlobalState[shared.instance.provider];
  const firstPaint = useFirstPaint();

  useRateLimitWarning(shared.instance.provider, () => {
    if (!shared.isSidecarOpen || shared.activeTab !== "context") {
      actions.selectTab("context");
    }
  });
  const mountTerminalPanel =
    (shared.showTerminalPanel || shared.isTerminalCollapsed) && !shared.isMobile;

  const [showingSetup, setShowingSetup] = useState(false);
  const hasFiles = shared.currentFiles && shared.currentFiles.length > 0;

  const hasExistingReview = !!shared.instance.reviewInstanceId;

  const setupPanel = hasFiles ? (
    <ReviewSetupPanel
      initialProvider={shared.instance.provider}
      initialModel={shared.instance.preferredModel}
      initialModelOptions={shared.instance.modelOptions}
      initialRuntimeMode={shared.instance.runtimeMode}
      sourceFileCount={shared.currentFiles!.length}
      onStartReview={async (selection) => {
        await actions.handleCreateReview(selection);
        setShowingSetup(false);
      }}
      isSubmitting={actions.isCreatingReview}
      onCancel={hasExistingReview ? () => setShowingSetup(false) : undefined}
    />
  ) : undefined;

  const reviewContent =
    showingSetup && setupPanel ? (
      setupPanel
    ) : hasExistingReview ? (
      <ReviewSidecarPanel
        key={shared.instance.reviewInstanceId}
        reviewInstanceId={shared.instance.reviewInstanceId}
        reviews={shared.attachedReviews}
        sourceChat={{ id: shared.instance.id, name: shared.instance.name }}
        onSelectReview={actions.handleSelectReview}
        onSendToChat={actions.handleSendReviewToChat}
        onReReview={actions.handleReReview}
        showReReview={actions.showReReview}
        onNewReview={() => setShowingSetup(true)}
      />
    ) : (
      setupPanel
    );

  if (shared.compact) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col">
          <InstanceViewContent />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <InstanceViewHeader />

      <div ref={shared.containerRef} className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <InstanceViewContent />
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
                  activeInstanceId={shared.id}
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
        {!shared.isMobile && (
          <div
            className={`relative flex h-full shrink-0 overflow-hidden ${
              shared.isResizing || firstPaint
                ? ""
                : "transition-[width,opacity] duration-200 ease-out"
            } ${shared.showDesktopSidecar ? "opacity-100 py-2 pl-2 pr-2" : "w-0 opacity-0"}`}
            ref={shared.sidecarRef}
            style={
              shared.showDesktopSidecar
                ? { width: shared.sidecarWidth ?? "max(280px, 30%)" }
                : undefined
            }
          >
            <div
              onMouseDown={actions.handleResizeStart}
              className="absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize bg-transparent"
            />
            <div className="app-sidecar-panel h-full flex-1">
              <ErrorBoundary name="Sidecar">
                <Sidecar
                  tasks={shared.currentTasks}
                  files={shared.currentFiles}
                  planContent={shared.instance.planContent}
                  reviewContent={reviewContent}
                  stats={shared.instance.stats}
                  items={shared.items}
                  agents={shared.agents}
                  agentItems={shared.agentItems}
                  pendingRequest={shared.instance.pendingPermission ?? null}
                  provider={shared.instance.provider}
                  providerStatus={shared.instance.providerStatus}
                  providerGlobalState={currentProviderGlobalState}
                  instanceId={shared.id}
                  createdAt={shared.instance.createdAt}
                  lastActivityAt={shared.instance.lastActivityAt}
                  workingDirectory={shared.instance.workingDirectory}
                  tabs={shared.effectiveTab ? [shared.effectiveTab] : []}
                  activeTab={shared.activeTab}
                  onSelectTab={actions.selectTab}
                  onClose={actions.closeSidecar}
                />
              </ErrorBoundary>
            </div>
          </div>
        )}
      </div>
      {shared.isMobile && shared.sidecarMobileOpen && shared.sidecarContentCount > 0 && (
        <ErrorBoundary name="Sidecar">
          <Sidecar
            tasks={shared.currentTasks}
            files={shared.currentFiles}
            planContent={shared.instance.planContent}
            reviewContent={reviewContent}
            stats={shared.instance.stats}
            items={shared.items}
            agents={shared.agents}
            agentItems={shared.agentItems}
            pendingRequest={shared.instance.pendingPermission ?? null}
            provider={shared.instance.provider}
            providerStatus={shared.instance.providerStatus}
            providerGlobalState={currentProviderGlobalState}
            instanceId={shared.id}
            createdAt={shared.instance.createdAt}
            lastActivityAt={shared.instance.lastActivityAt}
            workingDirectory={shared.instance.workingDirectory}
            tabs={Array.from(shared.allContentPanels)}
            activeTab={shared.activeTab}
            onSelectTab={actions.selectTab}
            onClose={() => actions.setSidecarMobileOpen(false)}
            isMobileOverlay
          />
        </ErrorBoundary>
      )}
    </div>
  );
}
