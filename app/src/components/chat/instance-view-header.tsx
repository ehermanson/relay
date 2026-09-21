import { InstanceHeader } from "@/components/chat/instance-header";
import { useInstanceViewContext } from "@/components/chat/instance-view-context";

export function InstanceViewHeader() {
  const { shared, actions } = useInstanceViewContext();

  if (shared.compact) {
    return null;
  }

  return (
    <InstanceHeader
      instance={shared.instance}
      isMobile={shared.isMobile}
      activeTab={shared.activeTab}
      isOpen={shared.isSidecarOpen}
      tasksCount={shared.tasksCount}
      filesCount={shared.filesCount}
      agentsCount={Object.keys(shared.agents).length}
      hasAgentsContent={shared.hasAgentsContent}
      hasPlanContent={shared.hasPlanContent}
      hasReviewContent={!!shared.instance.reviewInstanceId || shared.hasFilesContent}
      hasStats={shared.hasStats}
      sidecarContentCount={shared.sidecarContentCount}
      loadingSidecarActions={shared.isLoadingSession}
      onSelectTab={actions.selectTab}
      onOpenDebug={() => actions.setShowDebugPaste(true)}
      onDelete={() => actions.setConfirmDelete(true)}
      onOpenMobileSidecar={() => actions.setSidecarMobileOpen(true)}
      onSplit={actions.navigateToSplitPicker}
      onRename={actions.handleRename}
      onToggleTerminal={actions.handleToggleTerminal}
      terminalOpen={shared.showTerminalPanel || shared.isTerminalCollapsed}
    />
  );
}
