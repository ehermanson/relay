/**
 * The per-chat action menu shared by the inbox row's ⋮ trigger and the
 * collapsed rail's right-click context menu.
 *
 * Only the menu *contents* live here — each surface owns its own trigger and
 * decides how Rename works, since the expanded row edits its title in place
 * while the rail has no title to edit and opens a dialog instead.
 */

import { useNavigate } from "@tanstack/react-router";
import { Check, Columns2, GitMerge, Pencil, Pin, PinOff, Trash2, Undo2 } from "lucide-react";
import { Menu } from "@/components/ui/menu";
import { useSidebarActions } from "@/context/sidebar-actions-context";
import { useSidebarLayout } from "@/hooks/use-global-settings";
import { isChatDone } from "@/lib/utils";
import type { InstanceInfo } from "@shared/types";

export function ChatActionsMenuContent({
  instance,
  activeChatId,
  onRename,
  side,
  align,
}: {
  instance: InstanceInfo;
  /** Currently open chat — used to offer "Open in split view". */
  activeChatId?: string;
  onRename: () => void;
  /** Defaults suit a ⋮ trigger; the vertical rail flies out to the side. */
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
}) {
  const navigate = useNavigate({ from: "/projects/$projectId/chats/$chatId" });
  const actions = useSidebarActions();
  const done = isChatDone(instance);
  // Done is an inbox concept: Projects mode has no Done section, so the item
  // would take effect with no visible response there. Hide it instead.
  const showMarkDone = useSidebarLayout() === "inbox";

  const canMerge = !!instance.gitBranch && !!instance.hasChanges;
  const canSplit = !!activeChatId && activeChatId !== instance.id;
  const deleteDisabled = instance.external === true && instance.status !== "stopped";

  const stop = (fn: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    fn();
  };

  return (
    <Menu.Content side={side} align={align}>
      {showMarkDone && (
        <Menu.Item onClick={stop(() => actions.markInstanceDone(instance.id, !done))}>
          {done ? (
            <Undo2 size={13} strokeWidth={2} className="text-muted" />
          ) : (
            <Check size={13} strokeWidth={2} className="text-muted" />
          )}
          {done ? "Move back to inbox" : "Mark done"}
        </Menu.Item>
      )}
      <Menu.Item onClick={stop(() => actions.pinInstance(instance.id, !instance.pinned))}>
        {instance.pinned ? (
          <PinOff size={13} strokeWidth={2} className="text-muted" />
        ) : (
          <Pin size={13} strokeWidth={2} className="text-muted" />
        )}
        {instance.pinned ? "Unpin" : "Pin"}
      </Menu.Item>
      <Menu.Item onClick={stop(onRename)}>
        <Pencil size={13} strokeWidth={2} className="text-muted" />
        Rename
      </Menu.Item>
      {canMerge && (
        <Menu.Item onClick={stop(() => actions.mergeInstance(instance.id))}>
          <GitMerge size={13} strokeWidth={2} className="text-muted" />
          Merge to main
        </Menu.Item>
      )}
      {canSplit && (
        <Menu.Item onClick={stop(() => navigate({ search: { split: instance.id } }))}>
          <Columns2 size={13} strokeWidth={2} className="text-muted" />
          Open in split view
        </Menu.Item>
      )}
      <Menu.Item
        danger
        disabled={deleteDisabled}
        onClick={stop(() => actions.deleteInstance({ id: instance.id, name: instance.name }))}
      >
        <Trash2 size={13} strokeWidth={2} />
        Delete
      </Menu.Item>
    </Menu.Content>
  );
}
