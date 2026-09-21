/**
 * SidebarActionsContext — Centralizes sidebar action handlers so leaf
 * components can call them directly without prop drilling through
 * intermediary layout components.
 *
 * Owns all confirmation dialog state and renders the dialog JSX so
 * the sidebar component stays purely structural.
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastAsync } from "../lib/async-toast";
import type { InstanceInfo, Project } from "@shared/types";
import { useWSMethods, useWSState } from "./websocket-context";
import { useActionToasts } from "./action-toast-context";
import {
  completeSpace as apiCompleteSpace,
  markSpaceMerged as apiMarkSpaceMerged,
  deleteSpace as apiDeleteSpace,
  removeProject as apiRemoveProject,
  setInstancePinned as apiSetInstancePinned,
  setSpacePinned as apiSetSpacePinned,
  setInstanceDone as apiSetInstanceDone,
} from "../lib/api";
import { type RemoveProjectTarget } from "../lib/project-route";
import { ConfirmActionDialog } from "../components/ui/confirm-action-dialog";
import { ConfirmMergeDialog } from "../components/spaces/confirm-merge-dialog";
import { CreateSpaceDialog, useCreateSpaceDialog } from "../components/spaces/create-space-dialog";

interface SidebarActions {
  // Instance
  deleteInstance(instance: Pick<InstanceInfo, "id" | "name">): void;
  renameInstance(id: string, name: string): void;
  pinInstance(id: string, pinned: boolean): void;
  markInstanceDone(id: string, done: boolean): void;
  mergeInstance(id: string): void;

  // Space
  completeSpace(spaceId: string): void;
  pinSpace(spaceId: string, pinned: boolean): void;
  markSpaceMerged(spaceId: string): void;
  deleteSpace(spaceId: string): void;
  renameSpace(spaceId: string, name: string): void;
  createSpace(dir: string): void;

  // Project
  removeProject(target: RemoveProjectTarget): void;

  // Chat
  quickCreate(dir: string): void;
}

const SidebarActionsContext = createContext<SidebarActions | null>(null);

export function useSidebarActions(): SidebarActions {
  const ctx = useContext(SidebarActionsContext);
  if (!ctx) throw new Error("useSidebarActions must be used within SidebarActionsProvider");
  return ctx;
}

interface SidebarActionsProviderProps {
  children: ReactNode;
  currentProjectId?: string;
  currentSpaceId?: string;
  projectByDir: Map<string, Project>;
  createNewChat: (dir: string) => void;
}

export function SidebarActionsProvider({
  children,
  currentProjectId,
  currentSpaceId,
  projectByDir,
  createNewChat,
}: SidebarActionsProviderProps) {
  const { send } = useWSMethods();
  const { instances } = useWSState();
  const { trackInstanceMerge, trackInstanceRemove } = useActionToasts();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // ── Confirmation dialog state ──────────────────────────────────────
  const [confirmRemoveInstance, setConfirmRemoveInstance] = useState<Pick<
    InstanceInfo,
    "id" | "name"
  > | null>(null);
  const [confirmRemoveProject, setConfirmRemoveProject] = useState<RemoveProjectTarget | null>(
    null,
  );
  const [confirmCompleteSpaceId, setConfirmCompleteSpaceId] = useState<string | null>(null);
  const [confirmDeleteSpaceId, setConfirmDeleteSpaceId] = useState<string | null>(null);
  const [deleteSpacePending, setDeleteSpacePending] = useState(false);
  const spaceDialog = useCreateSpaceDialog();

  // ── Confirmation actions ───────────────────────────────────────────
  const confirmDeleteInstanceAction = () => {
    const instance = confirmRemoveInstance;
    if (!instance) return;
    trackInstanceRemove(instance);
    send({ type: "remove_instance", instanceId: instance.id });
    setConfirmRemoveInstance(null);
  };

  const confirmRemoveAction = async () => {
    const project = confirmRemoveProject;
    const projectId = project?.id;
    if (!projectId) return;

    try {
      await apiRemoveProject(projectId);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      if (currentProjectId === projectId) {
        navigate({ to: "/" });
      }
      toast.success(`Removed "${project.name}"`);
      setConfirmRemoveProject(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove project");
    }
  };

  const confirmCompleteSpaceAction = async () => {
    if (!confirmCompleteSpaceId) return;
    const spaceId = confirmCompleteSpaceId;
    setConfirmCompleteSpaceId(null);
    try {
      await apiCompleteSpace(spaceId);
      toast.success("Space merged");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to complete space");
    }
  };

  const confirmDeleteSpaceAction = async () => {
    if (!confirmDeleteSpaceId) return;
    const spaceId = confirmDeleteSpaceId;
    setDeleteSpacePending(true);
    try {
      await apiDeleteSpace(spaceId);
      setConfirmDeleteSpaceId(null);
      if (currentSpaceId === spaceId && currentProjectId) {
        navigate({ to: "/projects/$projectId", params: { projectId: currentProjectId } });
      }
      toast.success("Space archived");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to archive space");
      setDeleteSpacePending(false);
    }
  };

  // ── Actions (memoized to prevent re-renders) ──────────────────────
  const actions = useMemo<SidebarActions>(
    () => ({
      // Instance
      deleteInstance: (instance) => setConfirmRemoveInstance(instance),
      renameInstance: (id, name) => send({ type: "rename_instance", instanceId: id, name }),
      pinInstance: (id, pinned) => {
        // Pins persist even for chats without a live instance, so the REST
        // summaries are the source of truth — refetch them after the write.
        apiSetInstancePinned(id, pinned)
          .then(() => queryClient.invalidateQueries({ queryKey: ["projectChats"] }))
          .catch((err) => {
            toast.error(err instanceof Error ? err.message : "Failed to pin chat");
          });
      },
      markInstanceDone: (id, done) => {
        // Same story as pins: done chats are usually stopped and have no live
        // instance, so the REST summaries are the source of truth.
        apiSetInstanceDone(id, done)
          .then(() => queryClient.invalidateQueries({ queryKey: ["projectChats"] }))
          .catch((err) => {
            toast.error(err instanceof Error ? err.message : "Failed to update chat");
          });
      },
      mergeInstance: (id) => {
        const instance = instances.find((entry) => entry.id === id);
        if (instance) trackInstanceMerge(instance);
        send({ type: "merge_instance", instanceId: id });
      },

      // Space
      completeSpace: (spaceId) => setConfirmCompleteSpaceId(spaceId),
      pinSpace: (spaceId, pinned) => {
        apiSetSpacePinned(spaceId, pinned)
          .then(() => queryClient.invalidateQueries({ queryKey: ["spaces"] }))
          .catch((err) => {
            toast.error(err instanceof Error ? err.message : "Failed to pin space");
          });
      },
      markSpaceMerged: (spaceId) => {
        void toastAsync(apiMarkSpaceMerged(spaceId), {
          loading: "Marking space as merged...",
          success: "Space marked as merged",
          error: (err) => (err instanceof Error ? err.message : "Failed to mark space as merged"),
        });
      },
      deleteSpace: (spaceId) => setConfirmDeleteSpaceId(spaceId),
      renameSpace: (spaceId, name) => send({ type: "rename_space", spaceId, name }),
      createSpace: (dir) => spaceDialog.open(dir),

      // Project
      removeProject: (target) => {
        const project = projectByDir.get(target.directory);
        if (project) {
          setConfirmRemoveProject(project);
          return;
        }
        setConfirmRemoveProject({
          id: target.id,
          name: target.name,
          directory: target.directory,
        });
      },

      // Chat
      quickCreate: (dir) => createNewChat(dir),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      send,
      instances,
      trackInstanceMerge,
      trackInstanceRemove,
      currentProjectId,
      currentSpaceId,
      projectByDir,
      createNewChat,
      navigate,
    ],
  );

  return (
    <SidebarActionsContext.Provider value={actions}>
      {children}

      <ConfirmActionDialog
        open={!!confirmRemoveInstance}
        onOpenChange={(open) => !open && setConfirmRemoveInstance(null)}
        title="Delete chat?"
        description={
          confirmRemoveInstance ? (
            <>
              <span className="font-medium text-text">{confirmRemoveInstance.name}</span> will be
              removed from Relay. Chat history is preserved on disk if it can be recovered later,
              but this sidebar entry will be deleted now.
            </>
          ) : null
        }
        confirmLabel="Delete"
        onConfirm={confirmDeleteInstanceAction}
      />

      <ConfirmActionDialog
        open={!!confirmRemoveProject}
        onOpenChange={(open) => !open && setConfirmRemoveProject(null)}
        title="Remove project?"
        description={
          confirmRemoveProject ? (
            <>
              <span className="font-medium text-text">{confirmRemoveProject.name}</span> will be
              removed from Relay. Session history is preserved but won&apos;t appear in the sidebar
              until the project is re-added.
            </>
          ) : null
        }
        confirmLabel="Remove"
        onConfirm={confirmRemoveAction}
      />

      <ConfirmActionDialog
        open={!!confirmDeleteSpaceId}
        onOpenChange={(open) => !open && setConfirmDeleteSpaceId(null)}
        title="Archive this space?"
        description={
          <>
            This removes this space from active work and deletes its separate working copy without
            merging it into the main workspace. Chats and history remain available in Closed spaces.
          </>
        }
        confirmLabel="Archive space"
        onConfirm={() => void confirmDeleteSpaceAction()}
        isLoading={deleteSpacePending}
      />

      <ConfirmMergeDialog
        open={!!confirmCompleteSpaceId}
        onConfirm={confirmCompleteSpaceAction}
        onCancel={() => setConfirmCompleteSpaceId(null)}
      />

      <CreateSpaceDialog
        dir={spaceDialog.dir}
        mode={spaceDialog.mode}
        preselectedWorktreePath={spaceDialog.preselectedWorktreePath}
        projectName={
          spaceDialog.dir ? (projectByDir.get(spaceDialog.dir)?.name ?? spaceDialog.dir) : ""
        }
        projectId={spaceDialog.dir ? projectByDir.get(spaceDialog.dir)?.id : undefined}
        defaultBaseBranch={
          spaceDialog.dir
            ? (projectByDir.get(spaceDialog.dir)?.defaultSpaceBranch ?? undefined)
            : undefined
        }
        spaceBranchSource={
          spaceDialog.dir
            ? (projectByDir.get(spaceDialog.dir)?.spaceBranchSource ?? undefined)
            : undefined
        }
        onOpenChange={(open) => !open && spaceDialog.close()}
      />
    </SidebarActionsContext.Provider>
  );
}
