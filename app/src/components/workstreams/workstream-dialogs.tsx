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
  const { create, update, remove, setFolder } = useWorkstreamActions();
  const [name, setName] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [savingFolder, setSavingFolder] = useState(false);
  const linking = dialog?.kind === "folder" ? dialog : null;

  const naming = dialog?.kind === "create" || dialog?.kind === "rename" ? dialog : null;

  useEffect(() => {
    if (dialog?.kind === "create") setName("");
    else if (dialog?.kind === "rename") setName(dialog.workstream.name);
    else if (dialog?.kind === "folder") {
      setFolderPath(dialog.workstream.folderPath ?? "");
      setFolderError(null);
    }
  }, [dialog]);

  const commitFolder = () => {
    const path = folderPath.trim();
    if (!linking || !path || savingFolder) return;
    setSavingFolder(true);
    void setFolder(linking.workstream.id, path)
      .then((error) => {
        if (error) setFolderError(error);
        else close();
      })
      .finally(() => setSavingFolder(false));
  };

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

      <Dialog.Root open={!!linking} onOpenChange={(open) => !open && !savingFolder && close()}>
        {linking && (
          <Dialog.Content maxWidth="max-w-md">
            <Dialog.Title>Folder for {linking.workstream.name}</Dialog.Title>
            <p className="text-[0.8125rem] leading-relaxed text-muted">
              Chats in this workstream are told about the folder, given its README and STATUS when
              they start, and can read and write files in it. Relay never changes the folder itself.
            </p>
            <Input
              autoFocus
              value={folderPath}
              placeholder="~/work/projects/graphql-performance"
              spellCheck={false}
              onChange={(e) => {
                setFolderPath(e.target.value);
                setFolderError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitFolder();
                else if (e.key === "Escape") close();
              }}
            />
            {folderError && <p className="text-[0.75rem] text-error">{folderError}</p>}
            <p className="text-[0.75rem] text-muted/80">
              Applies to chats started from now on. A chat that is already running picks it up the
              next time its session starts.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={close} disabled={savingFolder}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!folderPath.trim() || savingFolder}
                onClick={commitFolder}
              >
                {savingFolder ? "Linking..." : "Link folder"}
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
