import { createContext, useContext } from "react";
import type { MouseEvent, ReactNode, RefObject } from "react";
import type { ChatItem, LiveActivity } from "@/hooks/use-instance-messages";
import type { QueuedRestore, UserRow } from "@/lib/chat-types";
import type { SidecarTab } from "@/stores/sidecar-store";
import type {
  AgentInfo,
  FileChange,
  HistoryEntry,
  InstanceInfo,
  ProviderKind,
  ProviderModelOptions,
  ProviderRequest,
  ProviderRuntimeMode,
  ReviewSessionInfo,
  TaskItem,
  TerminalScope,
  UserInputAnswer,
} from "@shared/types";

type ConnectionBannerState = {
  kind: "reconnecting" | "resyncing" | "running" | "interrupted";
  onDismiss?: () => void;
  onContinue?: () => void;
  onRetry?: () => void;
} | null;

export type InstanceViewContextValue = {
  shared: {
    id: string;
    compact: boolean;
    instance: InstanceInfo;
    embeddedSourceChat?: { id: string; name: string };
    attachedReviews: InstanceInfo[];
    planChild?: InstanceInfo;
    items: ChatItem[];
    /**
     * Delegated agents keyed by Relay agent key. Already capability-gated:
     * EMPTY when the provider doesn't advertise `supportsAgentActivity`.
     */
    agents: Record<string, AgentInfo>;
    /** Nested transcripts keyed by Relay agent key (gated like `agents`). */
    agentItems: Record<string, ChatItem[]>;
    /** `agents` is non-empty — gates the Agents tab/toggle. */
    hasAgentsContent: boolean;
    rawHistory: HistoryEntry[] | null;
    searchFocus: { query: string; snippet?: string } | null;
    currentTasks: TaskItem[] | null;
    currentFiles: FileChange[] | null;
    lastActivity: LiveActivity | null;
    processingStartedAt: number | null;
    isConnected: boolean;
    isSyncing: boolean;
    isActive: boolean;
    hasLoadedHistory: boolean;
    showThinkingIndicator: boolean;
    isMobile: boolean;
    isStopped: boolean;
    hasStats: boolean;
    hasTasksContent: boolean;
    hasFilesContent: boolean;
    tasksCount: number;
    filesCount: number;
    hasPlanContent: boolean;
    showDesktopSidecar: boolean;
    /** The user's currently selected sidecar tab (preserved even when closed). */
    activeTab: SidecarTab;
    /** Whether the sidecar is currently open. */
    isSidecarOpen: boolean;
    /** Effective tab: activeTab if it has content, else first content-bearing tab, else null. */
    effectiveTab: SidecarTab | null;
    allContentPanels: ReadonlySet<SidecarTab>;
    sidecarMobileOpen: boolean;
    sidecarContentCount: number;
    sidecarWidth: number | null;
    isResizing: boolean;
    showTerminalPanel: boolean;
    isTerminalCollapsed: boolean;
    collapsedTerminalCount: number;
    terminalScope: TerminalScope;
    terminalHeight: number;
    terminalContexts: Array<{ id: string; terminalName: string; text: string }>;
    pendingUserInput: ProviderRequest | null;
    pendingTerminalInput: ProviderRequest | null;
    isPendingApproval: boolean;
    pendingApprovalRequest: ProviderRequest | null;
    pendingPermissionTool: string | null;
    pendingPermissionRequestId: string | null;
    pendingPermissionDesc?: string;
    pendingTerminalTool: string | null;
    approvedTools: Set<string>;
    showDebugPaste: boolean;
    confirmDelete: boolean;
    isLoadingSession: boolean;
    showBranchChangeBanner: boolean;
    branchChangeKey: string | null;
    connectionBanner: ConnectionBannerState;
    containerRef: RefObject<HTMLDivElement | null>;
    sidecarRef: RefObject<HTMLDivElement | null>;
    /** Set when an edited queued message should be restored into the composer. */
    queuedRestore: QueuedRestore | null;
  };
  actions: {
    navigateToSplitPicker: () => void;
    navigateAfterDelete: () => void;
    sendRemoveInstance: () => void;
    handleRename: (name: string) => void;
    handleSend: (
      text: string,
      images?: string[],
      internal?: boolean,
      attachments?: string[],
    ) => void;
    handleAnswerUserInput: (requestId: string, answers: Record<string, UserInputAnswer>) => void;
    handleTakeover: () => void;
    handleCancel: () => void;
    handleInterruptAndSend: () => void;
    handleEditQueued: (row: UserRow) => void;
    handleRemoveQueued: (queuedId: string) => void;
    /** Called by the composer after it has applied a queuedRestore. */
    clearQueuedRestore: () => void;
    handleSwitchProvider: (
      targetProvider: ProviderKind,
      carryContext: boolean,
      model?: string | null,
    ) => Promise<void>;
    setShowDebugPaste: (open: boolean) => void;
    setConfirmDelete: (open: boolean) => void;
    handleRespondToRequest: (
      requestId: string,
      tool: string,
      decision?: "accept" | "decline",
      text?: string,
    ) => void;
    handleApproveTool: (tool: string) => void;
    dismissBranchChangeBanner: () => void;
    selectTab: (panel: SidecarTab) => void;
    closeSidecar: () => void;
    setSidecarMobileOpen: (open: boolean) => void;
    handleToggleTerminal: () => void;
    handleCreateReview: (selection: {
      scope: ReviewSessionInfo["scope"];
      provider: ProviderKind;
      model?: string;
      modelOptions?: ProviderModelOptions;
      runtimeMode?: ProviderRuntimeMode;
    }) => Promise<void>;
    isCreatingReview: boolean;
    handleSelectReview: (reviewInstanceId: string) => void;
    handleSendReviewToChat: (reviewInstanceId: string) => void;
    handleReReview: (reviewInstanceId: string) => void;
    showReReview: boolean;
    expandTerminalPanel: () => void;
    handleTerminalResizeStart: (e: MouseEvent) => void;
    handleResizeStart: (e: MouseEvent) => void;
    removeTerminalContext: (attachmentId: string) => void;
  };
};

const InstanceViewContext = createContext<InstanceViewContextValue | null>(null);

export function InstanceViewProvider({
  value,
  children,
}: {
  value: InstanceViewContextValue;
  children: ReactNode;
}) {
  return <InstanceViewContext.Provider value={value}>{children}</InstanceViewContext.Provider>;
}

export function useInstanceViewContext() {
  const value = useContext(InstanceViewContext);
  if (!value) {
    throw new Error("useInstanceViewContext must be used within InstanceViewProvider");
  }
  return value;
}
