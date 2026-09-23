import { lazy, Suspense } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { ConfirmMergeDialog } from "@/components/spaces/confirm-merge-dialog";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import { SpaceDebug } from "@/components/spaces/space-debug";
import { useSpaceViewContext } from "@/components/spaces/space-view-context";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

const DiffDrawer = lazy(() =>
  import("@/components/chat/diff-drawer").then((m) => ({ default: m.DiffDrawer })),
);

export type SpaceMergeDialogState =
  | { phase: "confirm" }
  | { phase: "merging" }
  | { phase: "success"; targetBranch: string; mergeCommit?: string; mergeMethod?: string }
  | {
      phase: "error";
      message: string;
      /** Conflicting paths when Complete was refused for merge conflicts. */
      conflicts?: string[];
      targetBranch?: string;
    }
  | null;

export function SpaceViewDialogs() {
  const { shared, actions } = useSpaceViewContext();
  const mergeTarget = shared.space.baseBranch || shared.space.targetBranch || undefined;
  const conflictState =
    shared.mergeDialog?.phase === "error" && shared.mergeDialog.conflicts?.length
      ? shared.mergeDialog
      : null;

  return (
    <>
      {shared.showDiffDrawer && (shared.spaceDiff != null || shared.spaceDiffError) && (
        <Suspense fallback={null}>
          <DiffDrawer
            rawDiff={shared.spaceDiff ?? undefined}
            rawError={shared.spaceDiff == null ? shared.spaceDiffError : null}
            onRetry={actions.retrySpaceDiff}
            onClose={() => actions.setShowDiffDrawer(false)}
            scrollToFile={shared.diffScrollToFile}
          />
        </Suspense>
      )}

      <ConfirmMergeDialog
        open={shared.mergeDialog?.phase === "confirm"}
        spaceName={shared.space.name}
        targetBranch={mergeTarget}
        onConfirm={(mergeMethod, squashMessage) =>
          void actions.handleComplete(mergeMethod, squashMessage)
        }
        onCancel={() => actions.setMergeDialog(null)}
      />

      <Dialog.Root
        open={shared.mergeDialog !== null && shared.mergeDialog.phase !== "confirm"}
        onOpenChange={(open) => {
          if (!open && shared.mergeDialog?.phase !== "merging") {
            if (shared.mergeDialog?.phase === "success") {
              actions.handleMergeSuccessDone();
              return;
            }
            actions.setMergeDialog(null);
          }
        }}
      >
        <Dialog.Content maxWidth="max-w-md">
          {shared.mergeDialog?.phase === "merging" && (
            <div className="flex flex-col items-center gap-3 py-4">
              <Spinner size={18} />
              <p className="text-sm text-muted">
                Merging space into {mergeTarget ?? "its target branch"}...
              </p>
            </div>
          )}
          {shared.mergeDialog?.phase === "success" && (
            <>
              <div className="flex flex-col items-center gap-3 py-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/10">
                  <Check size={20} className="text-accent" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-semibold text-text-bright">
                    Space merged successfully
                  </p>
                  <p className="mt-1 text-[0.8125rem] text-muted">
                    Merged into{" "}
                    <span className="font-medium text-text">{shared.mergeDialog.targetBranch}</span>
                  </p>
                  {shared.mergeDialog.mergeCommit && (
                    <p className="mt-0.5 font-mono text-[0.75rem] text-muted/60">
                      {shared.mergeDialog.mergeCommit.slice(0, 8)}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex justify-center pt-1">
                <Button variant="primary" size="sm" onClick={actions.handleMergeSuccessDone}>
                  Done
                </Button>
              </div>
            </>
          )}
          {conflictState && (
            <>
              <div className="flex flex-col gap-3 py-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle size={18} className="shrink-0 text-warning" />
                  <p className="text-sm font-semibold text-text-bright">
                    Merge conflicts with {conflictState.targetBranch ?? mergeTarget ?? "the target"}
                  </p>
                </div>
                <p className="text-[0.8125rem] text-muted">
                  Nothing was merged. {conflictState.conflicts!.length} file
                  {conflictState.conflicts!.length === 1 ? "" : "s"} changed on both sides:
                </p>
                <ul className="max-h-40 overflow-y-auto rounded-md border border-border bg-surface px-3 py-2 font-mono text-[0.75rem] text-text">
                  {conflictState.conflicts!.map((file) => (
                    <li key={file} className="truncate">
                      {file}
                    </li>
                  ))}
                </ul>
                <p className="text-[0.8125rem] text-muted">
                  Merge {conflictState.targetBranch ?? mergeTarget ?? "the target branch"} into this
                  space and resolve the conflicts there (or ask a chat in this space to do it), then
                  complete the space again.
                </p>
              </div>
              <div className="flex justify-center pt-1">
                <Button variant="ghost" size="sm" onClick={() => actions.setMergeDialog(null)}>
                  Close
                </Button>
              </div>
            </>
          )}
          {shared.mergeDialog?.phase === "error" && !conflictState && (
            <>
              <div className="flex flex-col items-center gap-3 py-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-error/10">
                  <AlertTriangle size={20} className="text-error" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-semibold text-text-bright">Merge failed</p>
                  <p className="mt-1 whitespace-pre-wrap text-left text-[0.8125rem] text-muted">
                    {shared.mergeDialog.message}
                  </p>
                </div>
              </div>
              <div className="flex justify-center pt-1">
                <Button variant="ghost" size="sm" onClick={() => actions.setMergeDialog(null)}>
                  Close
                </Button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Root>

      <ConfirmActionDialog
        open={shared.closeTabId !== null}
        onOpenChange={(open) => {
          if (!open) actions.setCloseTabId(null);
        }}
        title="Remove chat?"
        description={
          <>
            <span className="font-medium text-text">
              {shared.spaceInstances.find((instance) => instance.id === shared.closeTabId)?.name ||
                "This chat"}
            </span>{" "}
            will be permanently deleted from this space and Relay.
          </>
        }
        confirmLabel="Delete"
        onConfirm={actions.confirmCloseTab}
      />

      <ConfirmActionDialog
        open={shared.confirmDelete}
        onOpenChange={actions.setConfirmDelete}
        title="Archive this space?"
        description={
          <>
            This removes <span className="font-medium text-text">{shared.space.name}</span> from
            active work and deletes its separate working copy without merging it into the main
            workspace. Chats and history remain available in Closed spaces.
          </>
        }
        confirmLabel="Archive space"
        onConfirm={() => void actions.confirmDeleteSpace()}
        isLoading={shared.deletePending}
      />

      {shared.showDebug && (
        <SpaceDebug
          space={shared.space}
          instances={shared.spaceInstances}
          defaultInstanceId={shared.activeTab ?? undefined}
          onClose={() => actions.setShowDebug(false)}
        />
      )}
    </>
  );
}
