import { useState } from "react";
import { GitMerge } from "lucide-react";
import { Dialog } from "../ui/dialog";
import { Button } from "../ui/button";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import type { MergeMethod } from "@shared/types";

interface ConfirmMergeDialogProps {
  open: boolean;
  spaceName?: string;
  targetBranch?: string;
  onConfirm: (mergeMethod: MergeMethod, squashMessage?: string) => void;
  onCancel: () => void;
}

const MERGE_OPTIONS: { value: MergeMethod; label: string; description: string }[] = [
  {
    value: "squash",
    label: "Squash and merge",
    description:
      "Combine the space into one commit on the target branch. Best default for focused AI-assisted work.",
  },
  {
    value: "merge-commit",
    label: "Merge commit",
    description:
      "Keep the branch history and add a merge commit. Best when the commit history is meaningful.",
  },
];

export function ConfirmMergeDialog({
  open,
  spaceName,
  targetBranch,
  onConfirm,
  onCancel,
}: ConfirmMergeDialogProps) {
  const [mergeMethod, setMergeMethod] = useState<MergeMethod>("squash");
  const [squashMessage, setSquashMessage] = useState(`Space: ${spaceName || "unnamed"}`);

  // Reset state when dialog opens
  const handleOpenChange = (o: boolean) => {
    if (!o) {
      onCancel();
    } else {
      setMergeMethod("squash");
      setSquashMessage(`Space: ${spaceName || "unnamed"}`);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Content maxWidth="max-w-lg">
        <Dialog.Header>
          <Dialog.Title>Complete this space?</Dialog.Title>
          <Dialog.Close />
        </Dialog.Header>
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex flex-col gap-1.5 text-text-muted">
            <p>
              Relay will merge this space into{" "}
              {targetBranch ? (
                <span className="font-medium text-text">{targetBranch}</span>
              ) : (
                "its target branch"
              )}
              , even if your main workspace has a different branch checked out.
            </p>
            <p>
              Running chats in this space are stopped, and uncommitted changes in the space are
              committed before merging. Untracked files in your main workspace never block the merge
              and are never deleted.
            </p>
            <p>
              After merge, this space becomes read-only and its separate working copy is removed.
            </p>
          </div>

          <div className="flex flex-col gap-2 pt-1">
            <span className="text-xs font-medium text-text">Merge method</span>
            <RadioGroup
              value={mergeMethod}
              onValueChange={(v) => setMergeMethod(v as MergeMethod)}
              className="flex-col gap-2"
            >
              {MERGE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-3 py-2 transition-colors hover:bg-surface-hover data-[selected]:border-accent"
                  data-selected={mergeMethod === opt.value ? "" : undefined}
                >
                  <RadioGroupItem value={opt.value} className="mt-0.5" />
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium text-text">{opt.label}</span>
                    <span className="text-xs text-text-muted">{opt.description}</span>
                  </div>
                </label>
              ))}
            </RadioGroup>
          </div>

          {mergeMethod === "squash" && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="squash-message" className="text-xs font-medium text-text">
                Commit message
              </label>
              <textarea
                id="squash-message"
                value={squashMessage}
                onChange={(e) => setSquashMessage(e.target.value)}
                rows={2}
                className="resize-y rounded-md border border-border bg-surface px-3 py-2 text-xs text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
                placeholder="Describe the changes..."
              />
            </div>
          )}

          <p className="text-xs text-text-muted">
            If the space conflicts with the target branch, nothing is merged and Relay lists the
            conflicting files so you can resolve them in the space.
          </p>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() =>
              onConfirm(mergeMethod, mergeMethod === "squash" ? squashMessage : undefined)
            }
            className="gap-1.5"
          >
            <GitMerge className="size-4" />
            Complete
          </Button>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
