/**
 * The create / rename / delete dialogs for Workstreams, mounted once in the
 * app layout and driven by `useWorkstreamUiStore.dialog`.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useWorkstreamActions } from "@/hooks/use-workstreams";
import { useWorkstreamUiStore } from "@/stores/workstream-ui-store";

export function WorkstreamDialogs() {
  const dialog = useWorkstreamUiStore((s) => s.dialog);
  const close = useWorkstreamUiStore((s) => s.closeDialog);
  const reveal = useWorkstreamUiStore((s) => s.reveal);
  const { create, update, remove } = useWorkstreamActions();
  const [name, setName] = useState("");

  const naming = dialog?.kind === "create" || dialog?.kind === "rename" ? dialog : null;

  useEffect(() => {
    if (dialog?.kind === "create") setName("");
    else if (dialog?.kind === "rename") setName(dialog.workstream.name);
  }, [dialog]);

  const trimmed = name.trim();

  const commit = () => {
    if (!naming || !trimmed) return;
    if (naming.kind === "create") {
      void create(trimmed, naming.instanceId).then((workstream) => {
        // Open the new folder so the result of the action is visible.
        if (workstream) reveal(workstream.id);
      });
    } else if (trimmed !== naming.workstream.name) {
      void update(naming.workstream.id, { name: trimmed });
    }
    close();
  };

  return (
    <>
      <Dialog.Root open={!!naming} onOpenChange={(open) => !open && close()}>
        {naming && (
          <Dialog.Content maxWidth="max-w-sm">
            <Dialog.Title>
              {naming.kind === "create" ? "New workstream" : "Rename workstream"}
            </Dialog.Title>
            {naming.kind === "create" && (
              <p className="text-[0.8125rem] text-muted">
                A workstream groups the chats of one long-running effort, across projects.
              </p>
            )}
            <Input
              autoFocus
              value={name}
              maxLength={80}
              placeholder="e.g. GraphQL performance"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                else if (e.key === "Escape") close();
              }}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" disabled={!trimmed} onClick={commit}>
                {naming.kind === "create" ? "Create" : "Rename"}
              </Button>
            </div>
          </Dialog.Content>
        )}
      </Dialog.Root>

      <ConfirmActionDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(open) => !open && close()}
        title="Delete workstream"
        description={
          dialog?.kind === "delete" ? (
            <>
              <span className="font-medium text-text">{dialog.workstream.name}</span> will be
              removed. Its chats are kept and stay in the inbox.
            </>
          ) : null
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (dialog?.kind === "delete") void remove(dialog.workstream.id);
          close();
        }}
        maxWidth="max-w-sm"
      />
    </>
  );
}
