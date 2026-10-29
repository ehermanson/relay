import { useEffect, useRef } from "react";
import { useLocation } from "@tanstack/react-router";
import { FolderPlus, Loader2 } from "lucide-react";
import { SidebarActionsProvider } from "../../context/sidebar-actions-context";
import { useWSState } from "../../context/websocket-context";
import { useSidebarNavigationController } from "@/hooks/use-sidebar-navigation-controller";
import { SidebarFooter, SidebarHeader, SidebarSearchTrigger } from "./sidebar-chrome";
import { SidebarProjectGroup } from "./sidebar-project-group";
import "./sidebar.css";

export function Sidebar({
  onCollapse,
  onSearchOpen,
  showLogo = false,
}: { onCollapse?: () => void; onSearchOpen?: () => void; showLogo?: boolean } = {}) {
  const { isSyncing } = useWSState();
  const {
    moveDown,
    moveToBottom,
    moveToTop,
    moveUp,
    projectByDir,
    projects,
    registeredDirs,
    collapsed: collapsedDirs,
    toggleCollapsed: toggleDir,
    currentChatId,
    currentProjectId,
    projectEntries,
    createNewChat,
  } = useSidebarNavigationController();
  const location = useLocation();
  const currentId = currentChatId;

  const scrollRef = useRef<HTMLDivElement>(null);
  const didInitialScrollRef = useRef(false);

  // On reload, scroll the active chat into view if it isn't already.
  // Runs once: waits for projectEntries to populate so the target item exists,
  // then uses block: "nearest" which is a no-op when the item is already visible.
  useEffect(() => {
    if (didInitialScrollRef.current) return;
    if (!currentId) return;
    const container = scrollRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(`[data-chat-id="${CSS.escape(currentId)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    didInitialScrollRef.current = true;
  }, [currentId, projectEntries]);

  const hasProjects = projects.length > 0;

  return (
    <SidebarActionsProvider
      currentProjectId={currentProjectId}
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
        />
        <SidebarSearchTrigger onSearchOpen={onSearchOpen} />

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
              {projectEntries.map((entry, index) => (
                <SidebarProjectGroup
                  key={entry.dir}
                  dir={entry.dir}
                  project={entry.project}
                  groupInstances={entry.groupInstances}
                  currentId={currentId}
                  currentProjectId={currentProjectId}
                  locationPathname={location.pathname}
                  iconPath={entry.iconPath}
                  isOpen={!collapsedDirs.has(entry.dir)}
                  onToggle={() => toggleDir(entry.dir)}
                  isFirst={index === 0}
                  isLast={index === projectEntries.length - 1}
                  onMoveToTop={() => moveToTop(entry.dir)}
                  onMoveUp={() =>
                    moveUp(
                      entry.dir,
                      projectEntries.map((e) => e.dir),
                    )
                  }
                  onMoveDown={() =>
                    moveDown(
                      entry.dir,
                      projectEntries.map((e) => e.dir),
                    )
                  }
                  onMoveToBottom={() => moveToBottom(entry.dir)}
                  loading={entry.loading}
                />
              ))}

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
    </SidebarActionsProvider>
  );
}
