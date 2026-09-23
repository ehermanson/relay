import { useMemo } from "react";
import { ContextPanel } from "@/components/chat/context-panel";
import { Button } from "@/components/ui/button";
import { FilesPanel } from "@/components/chat/files-panel";
import { SidecarShell, type SidecarTabDef } from "@/components/chat/sidecar-shell";
import { SpaceContextPanel } from "@/components/spaces/space-context-panel";
import type { SidecarTab } from "@/stores/sidecar-store";
import type { FileChange, InstanceInfo, SessionStats, SpaceInfo } from "@shared/types";

const TAB_LABELS: Record<SidecarTab, string> = {
  tasks: "Tasks",
  agents: "Agents",
  files: "Files",
  plan: "Plan",
  context: "Context",
  brief: "Brief",
  review: "Review",
};

export function SpaceSidebar({
  space,
  instances,
  tabs,
  activeTab,
  onSelectTab,
  onClose,
  stats,
  fileChanges,
  diffError,
  onRetryDiff,
  onOpenDiff,
  isMobileOverlay,
}: {
  space: SpaceInfo;
  instances: InstanceInfo[];
  /** Tab keys to render in the strip. */
  tabs: ReadonlyArray<SidecarTab>;
  /** The tab whose content is currently shown. */
  activeTab: SidecarTab;
  onSelectTab?: (tab: SidecarTab) => void;
  onClose?: () => void;
  stats: SessionStats | null;
  fileChanges: FileChange[];
  /** The space diff failed to load — shown instead of "No files changed". */
  diffError?: string | null;
  onRetryDiff?: () => void;
  onOpenDiff: (scrollToFile?: string) => void;
  isMobileOverlay?: boolean;
}) {
  const activeCount = instances.filter(
    (instance) => instance.status === "idle" || instance.status === "processing",
  ).length;
  const stoppedCount = instances.filter((instance) => instance.status === "stopped").length;

  const tabDefs = useMemo<SidecarTabDef[]>(() => {
    return tabs.map((tab) => {
      const def: SidecarTabDef = { key: tab, label: TAB_LABELS[tab] };
      if (tab === "files") def.count = fileChanges.length;
      return def;
    });
  }, [tabs, fileChanges.length]);

  const hasFiles = tabs.includes("files");
  const hasStatsTab = tabs.includes("context");
  const hasStats = hasStatsTab && !!stats && (stats.inputTokens > 0 || stats.outputTokens > 0);

  const renderTabContent = (key: string) => {
    if (key === "brief" && !space.isDefault) {
      return (
        <div className="flex-1 overflow-y-auto">
          <SpaceContextPanel spaceId={space.id} />
        </div>
      );
    }
    if (key === "files" && hasFiles) {
      if (fileChanges.length === 0 && diffError) {
        return (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-10 text-center">
            <p className="text-sm text-error">Couldn't load changes</p>
            <p className="text-[0.75rem] text-muted">{diffError}</p>
            {onRetryDiff && (
              <Button variant="ghost" size="sm" onClick={onRetryDiff}>
                Retry
              </Button>
            )}
          </div>
        );
      }
      if (fileChanges.length === 0) {
        return (
          <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 text-center text-muted">
            <p className="text-sm">No files changed</p>
          </div>
        );
      }
      return (
        <FilesPanel
          files={fileChanges}
          cwd=""
          onViewChanges={() => onOpenDiff()}
          onFileClick={(path) => onOpenDiff(path)}
        />
      );
    }
    if (key === "context" && hasStats) {
      return (
        <ContextPanel
          mode="space"
          stats={stats}
          instances={instances}
          branch={space.gitBranch ?? null}
          status={space.status}
          activeCount={activeCount}
          stoppedCount={stoppedCount}
          createdAt={space.createdAt}
        />
      );
    }
    return null;
  };

  return (
    <SidecarShell
      tabs={tabDefs}
      activeTab={activeTab}
      onActiveTabChange={(key) => onSelectTab?.(key as SidecarTab)}
      renderTabContent={renderTabContent}
      isMobileOverlay={isMobileOverlay}
      onClose={onClose}
    />
  );
}
