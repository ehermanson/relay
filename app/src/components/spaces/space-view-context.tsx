import { createContext, useContext } from "react";
import type { ReactNode, RefObject, KeyboardEvent, MouseEvent } from "react";
import type { SidecarTab } from "@/stores/sidecar-store";
import type {
  FileChange,
  InstanceInfo,
  SessionStats,
  SpaceInfo,
  TerminalScope,
} from "@shared/types";
import type { SpaceMergeDialogState } from "@/components/spaces/space-view-dialogs";

type SpaceViewContextValue = {
  shared: {
    projectId: string;
    projectName: string;
    openInPath: string;
    space: SpaceInfo;
    spaceInstances: InstanceInfo[];
    activeTab: string | null;
    activeLiveInstance: InstanceInfo | null;
    pendingNewChatId: string | null;
    aggregatedStats: SessionStats | null;
    fileChanges: FileChange[];
    isActive: boolean;
    isBroken: boolean;
    isMerged: boolean;
    isArchived: boolean;
    isMobile: boolean;
    isResolvingChatSelection: boolean;
    pendingNewChatActive: boolean;
    chatSummariesLoading: boolean;
    showSidebar: boolean;
    sidecarTab: SidecarTab;
    isSidecarOpen: boolean;
    effectiveSidecarTab: SidecarTab | null;
    allContentPanels: ReadonlySet<SidecarTab>;
    sidecarMobileOpen: boolean;
    sidecarContentCount: number;
    showTerminalPanel: boolean;
    isTerminalCollapsed: boolean;
    collapsedTerminalCount: number;
    terminalScope: TerminalScope;
    terminalHeight: number;
    pathCopied: boolean;
    spaceDiff: string | null;
    /** Space diff failed to load (distinct from an empty diff). */
    spaceDiffError: string | null;
    showDiffDrawer: boolean;
    diffScrollToFile?: string;
    mergeDialog: SpaceMergeDialogState;
    closeTabId: string | null;
    confirmDelete: boolean;
    deletePending: boolean;
    showDebug: boolean;
    commitDialogOpen: boolean;
    /** Git action in flight; the header disables git actions until it settles. */
    pendingGitAction: "commit" | "push" | null;
    ghCliDialogOpen: boolean;
    ghCliReason: "not-installed" | "not-authenticated";
    editingSpaceName: boolean;
    spaceNameDraft: string;
    spaceNameInputRef: RefObject<HTMLInputElement | null>;
  };
  actions: {
    setSpaceNameDraft: (value: string) => void;
    handleSpaceNameKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
    commitSpaceRename: () => void;
    startRenamingSpace: () => void;
    setShowDebug: (open: boolean) => void;
    setConfirmDelete: (open: boolean) => void;
    setCommitDialogOpen: (open: boolean) => void;
    setGhCliDialogOpen: (open: boolean) => void;
    setMergeDialog: (value: SpaceMergeDialogState) => void;
    handleCommit: (message: string) => Promise<void>;
    handlePush: (createPR?: boolean) => Promise<void>;
    handleToggleTerminal: () => void;
    selectSidecarTab: (panel: SidecarTab) => void;
    closeSidecar: () => void;
    setSidecarMobileOpen: (open: boolean) => void;
    handleNewChat: () => void;
    navigateToChat: (id: string) => void;
    handleRenameTab: (instanceId: string, name: string) => void;
    setCloseTabId: (id: string | null) => void;
    openDiff: (scrollTo?: string) => void;
    retrySpaceDiff: () => void;
    handleGoToMainWorkspace: () => void;
    handleCopyPath: () => void;
    handleTerminalResizeStart: (e: MouseEvent) => void;
    expandTerminalPanel: () => void;
    handleComplete: (mergeMethod?: string, squashMessage?: string) => Promise<void>;
    handleMarkMerged: () => void;
    handleMergeSuccessDone: () => void;
    confirmCloseTab: () => void;
    confirmDeleteSpace: () => Promise<void>;
    setShowDiffDrawer: (open: boolean) => void;
  };
};

const SpaceViewContext = createContext<SpaceViewContextValue | null>(null);

export function SpaceViewProvider({
  value,
  children,
}: {
  value: SpaceViewContextValue;
  children: ReactNode;
}) {
  return <SpaceViewContext.Provider value={value}>{children}</SpaceViewContext.Provider>;
}

export function useSpaceViewContext() {
  const value = useContext(SpaceViewContext);
  if (!value) {
    throw new Error("useSpaceViewContext must be used within SpaceViewProvider");
  }
  return value;
}
