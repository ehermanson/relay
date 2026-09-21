import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate, useParams } from "@tanstack/react-router";
import { toast } from "sonner";
import { useWSMethods, useWSState } from "@/context/websocket-context";
import { useProjectContext } from "@/context/project-context";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useTerminalMessages } from "@/hooks/use-terminal-messages";
import { useTerminalShortcut } from "@/hooks/use-terminal-shortcut";
import { useVerticalResize } from "@/hooks/use-vertical-resize";
import { useSidecarPanels } from "@/stores/sidecar-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { primeInstanceMessagesCache } from "@/hooks/use-instance-messages";
import { SpaceViewBody } from "@/components/spaces/space-view-body";
import {
  SpaceViewDialogs,
  type SpaceMergeDialogState,
} from "@/components/spaces/space-view-dialogs";
import { SpaceViewHeader } from "@/components/spaces/space-view-header";
import { SpaceViewProvider } from "@/components/spaces/space-view-context";
import {
  commitSpace,
  completeSpace,
  markSpaceMerged,
  createInstance,
  deleteSpace,
  fetchSpaceChats,
  fetchSpaceDetail,
  fetchSpaceDiff,
  pushSpace,
  markSpinOffSent,
} from "@/lib/api";
import { getProjectName } from "@/lib/project-route";
import { reportCreateInstanceError } from "@/stores/process-limit-store";
import { aggregateSpaceStats, buildSpaceInstances, parseSpaceDiffFiles } from "@/lib/space-view";
import { toastAsync } from "@/lib/async-toast";
import { readLastSpaceChat, rememberSpaceChat, selectSpaceChat } from "@/lib/space-navigation";
import "@/components/chat/sidecar.css";
import type { TerminalScope } from "@shared/types";

const PENDING_NEW_CHAT_TAB_ID = "__pending_space_new_chat__";

export function SpaceView() {
  const {
    projectId: routeProjectId,
    spaceId,
    chatId,
  } = useParams({ strict: false }) as {
    projectId: string;
    spaceId: string;
    chatId?: string;
  };
  const { artifacts } = useProjectContext();
  const { instances } = useWSState();
  const { addMessageHandler, send } = useWSMethods();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const projectId = artifacts.projectSlug ?? routeProjectId ?? artifacts.projectId;
  const projectName = getProjectName(artifacts.directory);
  const spaceQueryKey = ["space", spaceId] as const;

  const [spaceDiff, setSpaceDiff] = useState<string | null>(null);
  const [showDiffDrawer, setShowDiffDrawer] = useState(false);
  const [diffScrollToFile, setDiffScrollToFile] = useState<string | undefined>();
  const [closeTabId, setCloseTabId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const [editingSpaceName, setEditingSpaceName] = useState(false);
  const [spaceNameDraft, setSpaceNameDraft] = useState("");
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [ghCliDialogOpen, setGhCliDialogOpen] = useState(false);
  const [ghCliReason, setGhCliReason] = useState<"not-installed" | "not-authenticated">(
    "not-installed",
  );
  const [mergeDialog, setMergeDialog] = useState<SpaceMergeDialogState>(null);
  const spaceNameInputRef = useRef<HTMLInputElement>(null);
  const [pendingNewChatActive, setPendingNewChatActive] = useState(false);
  const [pendingNewChatId, setPendingNewChatId] = useState<string | null>(null);
  const pendingCreatedChatIdRef = useRef<string | null>(null);

  // Memoized so useTerminalMessages doesn't see a new object identity every
  // render — without this, the store-update → re-render → fresh-scope-literal
  // chain becomes an infinite loop and pegs the tab at 100% CPU.
  const terminalScope = useMemo<TerminalScope>(() => ({ type: "space", spaceId }), [spaceId]);
  const {
    isPanelOpen: isTerminalPanelOpen,
    isPanelCollapsed: isTerminalPanelCollapsed,
    openPanel: openTerminalPanel,
    closePanel: closeTerminalPanel,
    expandPanel: expandTerminalPanel,
    getTerminalsForScope,
  } = useTerminalStore();
  const showTerminalPanel = isTerminalPanelOpen(terminalScope);
  const isTerminalCollapsed = isTerminalPanelCollapsed(terminalScope);
  const collapsedTerminalCount = isTerminalCollapsed
    ? getTerminalsForScope(terminalScope).length
    : 0;
  const { height: terminalHeight, onResizeStart: handleTerminalResizeStart } = useVerticalResize();
  // Global subscriber so terminal_created responses land in the store even
  // when the panel isn't mounted.
  useTerminalMessages(terminalScope);

  const handleToggleTerminal = () => {
    if (showTerminalPanel) {
      closeTerminalPanel();
      return;
    }
    if (getTerminalsForScope(terminalScope).length === 0) {
      send({ type: "terminal_create", scope: terminalScope, ifEmpty: true });
    }
    openTerminalPanel();
  };
  useTerminalShortcut(handleToggleTerminal);

  const { data: space } = useQuery({
    queryKey: spaceQueryKey,
    queryFn: () => fetchSpaceDetail(spaceId),
  });
  const { data: chatSummaries = [], isLoading: chatSummariesLoading } = useQuery({
    queryKey: ["spaceChats", spaceId],
    queryFn: () => fetchSpaceChats(spaceId),
    enabled: !!spaceId,
  });

  useEffect(() => {
    return addMessageHandler((message) => {
      if (message.type === "instance_removed") {
        void queryClient.invalidateQueries({ queryKey: ["spaceChats", spaceId] });
        return;
      }
      if (message.type === "instance_created") {
        void queryClient.invalidateQueries({ queryKey: ["spaceChats", spaceId] });
        if (message.instance.spaceId === spaceId) {
          // Match by exact ID, or if the WS message arrived before the REST
          // response set the ref (race condition), match any creation for this
          // space while we're actively waiting for one.
          const isOurPendingChat =
            message.instance.id === pendingCreatedChatIdRef.current ||
            (creatingChatRef.current && !pendingCreatedChatIdRef.current);
          if (isOurPendingChat) {
            pendingCreatedChatIdRef.current = message.instance.id;
            setPendingNewChatId(message.instance.id);
            primeInstanceMessagesCache(message.instance.id);
            creatingChatRef.current = false;
            setPendingNewChatActive(false);
          }
        }
        return;
      }
      if (message.type === "error" && pendingNewChatActive) {
        creatingChatRef.current = false;
        setPendingNewChatActive(false);
        pendingCreatedChatIdRef.current = null;
        setPendingNewChatId(null);
        return;
      }
      if (message.type === "space_list" && message.projectDirectory === artifacts.directory) {
        const nextSpace = message.spaces.find((entry) => entry.id === spaceId);
        if (nextSpace) {
          queryClient.setQueryData(spaceQueryKey, nextSpace);
        } else {
          void queryClient.invalidateQueries({ queryKey: spaceQueryKey });
        }
        return;
      }
      if (message.type === "space_removed" && message.spaceId === spaceId) {
        navigate({
          to: "/projects/$projectId",
          params: { projectId },
          replace: true,
        });
        return;
      }
      if (message.type === "space_completed" && message.spaceId === spaceId) {
        void queryClient.invalidateQueries({ queryKey: spaceQueryKey });
      }
    });
  }, [
    addMessageHandler,
    artifacts.directory,
    navigate,
    pendingNewChatActive,
    projectId,
    queryClient,
    spaceId,
    spaceQueryKey,
  ]);

  const spaceInstances = buildSpaceInstances(spaceId, chatSummaries, instances);
  const hasActiveChats = spaceInstances.some(
    (instance) => instance.status === "idle" || instance.status === "processing",
  );

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchSpaceDiff(spaceId)
        .then((diff) => {
          if (!cancelled) setSpaceDiff(diff);
        })
        .catch(() => {
          if (!cancelled) setSpaceDiff("");
        });
    };
    load();
    const interval = hasActiveChats ? setInterval(load, 5_000) : undefined;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [spaceId, hasActiveChats]);

  // If we just created a new chat and know its ID, use that as activeTab immediately
  // (the route loader may not have the new chat in REST data yet, so chatId from URL may be stale)
  const activeTab = pendingNewChatId
    ? pendingNewChatId
    : chatId && spaceInstances.find((instance) => instance.id === chatId)
      ? chatId
      : null;
  const firstSpaceChatId =
    selectSpaceChat(spaceId, spaceInstances, readLastSpaceChat(spaceId)) ?? null;

  useEffect(() => {
    if (
      activeTab &&
      activeTab !== PENDING_NEW_CHAT_TAB_ID &&
      spaceInstances.some((chat) => chat.id === activeTab)
    ) {
      rememberSpaceChat(spaceId, activeTab);
    }
  }, [spaceId, activeTab, spaceInstances]);
  const activeLiveInstance = activeTab
    ? (instances.find((instance) => instance.id === activeTab) ?? null)
    : null;
  const isResolvingChatSelection = chatSummariesLoading && !activeTab;

  useEffect(() => {
    if (
      !chatSummariesLoading &&
      firstSpaceChatId &&
      !activeTab &&
      !pendingNewChatActive &&
      !pendingNewChatId &&
      chatId !== firstSpaceChatId
    ) {
      navigate({
        to: "/projects/$projectId/spaces/$spaceId/$chatId",
        params: { projectId, spaceId, chatId: firstSpaceChatId },
        replace: true,
      });
    }
  }, [
    activeTab,
    chatId,
    chatSummariesLoading,
    firstSpaceChatId,
    pendingNewChatActive,
    pendingNewChatId,
    navigate,
    projectId,
    spaceId,
  ]);

  const navigateToChat = (id: string) => {
    navigate({
      to: "/projects/$projectId/spaces/$spaceId/$chatId",
      params: { projectId, spaceId, chatId: id },
    });
  };

  const aggregatedStats = aggregateSpaceStats(spaceInstances);
  const fileChanges = parseSpaceDiffFiles(spaceDiff);
  const isMobile = useMediaQuery("(max-width: 768px)");
  const hasStats =
    !!aggregatedStats && (aggregatedStats.inputTokens > 0 || aggregatedStats.outputTokens > 0);
  const hasFilesContent = fileChanges.length > 0;
  const {
    activeTab: sidecarTab,
    isOpen: isSidecarOpen,
    effectiveTab: effectiveSidecarTab,
    mobileOpen: sidecarMobileOpen,
    setMobileOpen: setSidecarMobileOpen,
    selectTab: selectSidecarTab,
    closeSidecar,
    sidecarContentCount,
    allContentPanels,
    showDesktopSidecar: showSidebar,
  } = useSidecarPanels({
    scope: "space",
    isMobile,
    hasTasksContent: false,
    hasFilesContent,
    hasPlanContent: false,
    hasStats,
    hasBriefContent: !space?.isDefault,
    contentLoading: chatSummariesLoading || spaceDiff === null,
  });

  // Once chatSummaries includes the pending new chat, sync the URL so the route
  // and the derived activeTab agree. Keep the pending override until the URL
  // has caught up and the new chat is present in spaceInstances.
  useEffect(() => {
    if (
      pendingNewChatId &&
      pendingNewChatId !== PENDING_NEW_CHAT_TAB_ID &&
      chatSummaries.some((chat) => chat.id === pendingNewChatId)
    ) {
      navigateToChat(pendingNewChatId);
      if (
        !pendingNewChatActive &&
        chatId === pendingNewChatId &&
        spaceInstances.some((instance) => instance.id === pendingNewChatId)
      ) {
        setPendingNewChatId(null);
        pendingCreatedChatIdRef.current = null;
      }
    }
  }, [pendingNewChatActive, pendingNewChatId, chatSummaries, chatId, spaceInstances]);

  useEffect(() => {
    if (editingSpaceName) {
      spaceNameInputRef.current?.focus();
      spaceNameInputRef.current?.select();
    }
  }, [editingSpaceName]);

  const isActive = space?.status === "active";
  const isBroken = space?.status === "broken";
  const isMerged = space?.status === "completed";
  const isArchived = space?.status === "archived";

  // Ref-based guard prevents double-creation even if the callback closure
  // captures a stale `pendingNewChatActive` value (e.g. rapid double-click).
  const creatingChatRef = useRef(false);

  const handleCreateChat = useCallback(
    async (options?: {
      initialPrompt?: string;
      spinOffId?: string;
      spinOffSourceName?: string;
      /** If true, prefill the composer draft instead of sending immediately */
      prefill?: boolean;
    }) => {
      if (creatingChatRef.current) return;
      creatingChatRef.current = true;
      setPendingNewChatActive(true);
      setPendingNewChatId(PENDING_NEW_CHAT_TAB_ID);
      try {
        const created = await createInstance({ spaceId });
        // If the WS `instance_created` already resolved (race), the ref is
        // already set and pendingNewChatActive is already false — just ensure
        // the ID is correct without re-entering the pending state.
        if (!pendingCreatedChatIdRef.current) {
          pendingCreatedChatIdRef.current = created.id;
        }
        setPendingNewChatId(created.id);
        navigateToChat(created.id);
        // Store spin-off metadata for the styled composer bar
        if (options?.spinOffId && options.spinOffSourceName) {
          try {
            sessionStorage.setItem(
              `relay:spin-off-meta:${created.id}`,
              JSON.stringify({
                sourceName: options.spinOffSourceName,
                spinOffId: options.spinOffId,
              }),
            );
          } catch {
            // ignore
          }
        }
        if (options?.initialPrompt) {
          if (options.prefill) {
            // Seed the composer draft so the user can review/edit before sending
            try {
              sessionStorage.setItem(`relay:draft:${created.id}`, options.initialPrompt);
            } catch {
              // sessionStorage unavailable — fall back to sending directly
              send({
                type: "instance_message",
                instanceId: created.id,
                text: options.initialPrompt,
              });
            }
          } else {
            send({
              type: "instance_message",
              instanceId: created.id,
              text: options.initialPrompt,
            });
          }
        }
        // Mark the spin-off as sent now that we have the target chat
        if (options?.spinOffId) {
          markSpinOffSent(options.spinOffId, created.id).catch(() => {
            // Non-fatal — the spin-off packet was already delivered as a message.
          });
        }
      } catch (err) {
        creatingChatRef.current = false;
        setPendingNewChatActive(false);
        setPendingNewChatId(null);
        pendingCreatedChatIdRef.current = null;
        if (!reportCreateInstanceError(err, () => handleCreateChat(options))) {
          toast.error(err instanceof Error ? err.message : "Failed to create chat");
        }
      }
    },
    [send, spaceId],
  );

  // Listen for "Send to new chat" relay events from child instance views
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        spaceId: string;
        message: string;
        spinOffId?: string;
        spinOffSourceName?: string;
      };
      if (detail.spaceId !== spaceId) return;
      if (detail.spinOffId) {
        // Spin-off: prefill draft so the user can review/edit before sending
        void handleCreateChat({
          initialPrompt: detail.message,
          spinOffId: detail.spinOffId,
          spinOffSourceName: detail.spinOffSourceName,
          prefill: true,
        });
      } else {
        // Regular send-to-new-chat: send immediately
        void handleCreateChat({ initialPrompt: detail.message });
      }
    };
    window.addEventListener("relay:send-to-new-chat", handler);
    return () => window.removeEventListener("relay:send-to-new-chat", handler);
  }, [handleCreateChat, spaceId]);

  const handleNewChat = () => {
    void handleCreateChat();
  };

  const handleRenameTab = (instanceId: string, name: string) => {
    send({ type: "rename_instance", instanceId, name });
  };

  const confirmCloseTab = () => {
    if (!closeTabId) return;
    send({ type: "purge_instance", instanceId: closeTabId });
    if (activeTab === closeTabId) {
      const remaining = spaceInstances.filter((instance) => instance.id !== closeTabId);
      if (remaining.length > 0) {
        navigateToChat(remaining[0].id);
      } else {
        navigate({
          to: "/projects/$projectId/spaces/$spaceId",
          params: { projectId, spaceId },
        });
      }
    }
    setCloseTabId(null);
  };

  const startRenamingSpace = () => {
    if (!space || space.isDefault) return;
    setSpaceNameDraft(space.name);
    setEditingSpaceName(true);
  };

  const commitSpaceRename = () => {
    if (!space) return;
    const trimmed = spaceNameDraft.trim();
    if (trimmed && trimmed !== space.name) {
      send({ type: "rename_space", spaceId: space.id, name: trimmed });
    }
    setEditingSpaceName(false);
  };

  const handleComplete = async (mergeMethod?: string, squashMessage?: string) => {
    setMergeDialog({ phase: "merging" });
    try {
      const result = await completeSpace(spaceId, {
        mergeMethod: mergeMethod as "squash" | "merge-commit" | "rebase-ff" | undefined,
        squashMessage,
      });
      setMergeDialog({
        phase: "success",
        targetBranch: result.targetBranch,
        mergeCommit: result.mergeCommit,
        mergeMethod: result.mergeMethod,
      });
      toast.success(`Merged "${space?.name}" into ${result.targetBranch}`);
    } catch (err) {
      setMergeDialog({
        phase: "error",
        message: err instanceof Error ? err.message : "Merge failed",
      });
    }
  };

  const handleMarkMerged = () => {
    void toastAsync(markSpaceMerged(spaceId), {
      loading: "Marking space as merged...",
      success: "Space marked as merged",
      error: (err) => (err instanceof Error ? err.message : "Failed to mark space as merged"),
    });
  };

  const handleCommit = async (message: string) => {
    try {
      const result = await commitSpace(spaceId, { message });
      if (!result.success) {
        toast.error(result.error || "Commit failed");
        return;
      }
      toast.success("Changes committed");
      fetchSpaceDiff(spaceId)
        .then((diff) => setSpaceDiff(diff))
        .catch(() => setSpaceDiff(""));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to commit");
    }
  };

  const handlePush = async (createPR?: boolean) => {
    try {
      const result = await pushSpace(spaceId, { createPR });
      if (!result.pushed) {
        if (result.error?.includes("Nothing to push")) {
          toast.warning(result.error);
          return;
        }
        toast.error(result.error || "Push failed");
        return;
      }
      if (result.prUrl) {
        toast.success(
          <span>
            PR created:{" "}
            <a href={result.prUrl} target="_blank" rel="noopener noreferrer" className="underline">
              {result.prUrl}
            </a>
          </span>,
        );
        return;
      }
      if (result.ghNotFound) {
        setGhCliReason("not-installed");
        setGhCliDialogOpen(true);
        return;
      }
      if (result.ghNotAuthenticated) {
        setGhCliReason("not-authenticated");
        setGhCliDialogOpen(true);
        return;
      }
      if (result.error) {
        toast.warning(result.error);
        return;
      }
      toast.success("Branch pushed to remote");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to push");
    }
  };

  const confirmDeleteSpace = async () => {
    setDeletePending(true);
    try {
      await deleteSpace(spaceId);
      navigate({ to: "/projects/$projectId", params: { projectId } });
    } catch {
      setDeletePending(false);
    }
  };

  const handleCopyPath = () => {
    if (!space?.worktreePath) return;
    navigator.clipboard.writeText(space.worktreePath).then(() => {
      setPathCopied(true);
      setTimeout(() => setPathCopied(false), 1500);
      toast.success("Copied to clipboard");
    });
  };

  const handleSpaceNameKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commitSpaceRename();
    if (e.key === "Escape") setEditingSpaceName(false);
  };

  const handleMergeSuccessDone = () => {
    setMergeDialog(null);
    navigate({ to: "/projects/$projectId", params: { projectId } });
  };

  const handleGoToMainWorkspace = () => {
    navigate({ to: "/projects/$projectId", params: { projectId } });
  };

  if (!space) {
    return (
      <div className="flex h-full items-center justify-center text-muted">Loading space...</div>
    );
  }

  const contextValue = {
    shared: {
      projectId,
      projectName,
      openInPath: space.worktreePath || artifacts.directory,
      space,
      spaceInstances,
      activeTab,
      activeLiveInstance,
      pendingNewChatId,
      aggregatedStats,
      fileChanges,
      isActive,
      isBroken,
      isMerged,
      isArchived,
      isMobile,
      isResolvingChatSelection,
      pendingNewChatActive,
      chatSummariesLoading,
      showSidebar,
      sidecarTab,
      isSidecarOpen,
      effectiveSidecarTab,
      allContentPanels,
      sidecarMobileOpen,
      sidecarContentCount,
      showTerminalPanel,
      isTerminalCollapsed,
      collapsedTerminalCount,
      terminalScope,
      terminalHeight,
      pathCopied,
      spaceDiff,
      showDiffDrawer,
      diffScrollToFile,
      mergeDialog,
      closeTabId,
      confirmDelete,
      deletePending,
      showDebug,
      commitDialogOpen,
      ghCliDialogOpen,
      ghCliReason,
      editingSpaceName,
      spaceNameDraft,
      spaceNameInputRef,
    },
    actions: {
      setSpaceNameDraft,
      handleSpaceNameKeyDown,
      commitSpaceRename,
      startRenamingSpace,
      setShowDebug,
      setConfirmDelete,
      setCommitDialogOpen,
      setGhCliDialogOpen,
      setMergeDialog,
      handleCommit,
      handlePush,
      handleToggleTerminal,
      selectSidecarTab,
      closeSidecar,
      setSidecarMobileOpen,
      handleNewChat,
      navigateToChat,
      handleRenameTab,
      setCloseTabId,
      openDiff: (scrollTo?: string) => {
        setDiffScrollToFile(scrollTo);
        setShowDiffDrawer(true);
      },
      handleGoToMainWorkspace,
      handleCopyPath,
      handleTerminalResizeStart,
      expandTerminalPanel: () => expandTerminalPanel(),
      handleComplete,
      handleMarkMerged,
      handleMergeSuccessDone,
      confirmCloseTab,
      confirmDeleteSpace,
      setShowDiffDrawer,
    },
  } as const;

  return (
    <SpaceViewProvider value={contextValue}>
      <div className="flex h-full flex-col overflow-hidden">
        <SpaceViewHeader />
        {/* Key on spaceId so the body remounts on space switch — resets
            AnimatePresence and the first-paint suppression. */}
        <SpaceViewBody key={spaceId} />
        <SpaceViewDialogs />
      </div>
    </SpaceViewProvider>
  );
}

export const Route = createFileRoute("/_app/projects/$projectId/spaces/$spaceId/")({
  loader: async ({ params }) => {
    const chats = await fetchSpaceChats(params.spaceId);
    const fallbackChatId = selectSpaceChat(
      params.spaceId,
      chats,
      readLastSpaceChat(params.spaceId),
    );

    if (fallbackChatId) {
      throw redirect({
        to: "/projects/$projectId/spaces/$spaceId/$chatId",
        params: {
          projectId: params.projectId,
          spaceId: params.spaceId,
          chatId: fallbackChatId,
        },
        replace: true,
      });
    }
  },
  component: SpaceView,
});
