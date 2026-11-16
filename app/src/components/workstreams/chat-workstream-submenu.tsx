/**
 * "Workstream" submenu for the per-chat action menu: move the chat into a
 * Workstream, start a new one with it, or take it out.
 */

import { Check, FolderPlus, Layers, X } from "lucide-react";
import { Menu } from "@/components/ui/menu";
import { useWorkstreamActions, useWorkstreams } from "@/hooks/use-workstreams";
import { useWorkstreamUiStore } from "@/stores/workstream-ui-store";
import { WorkstreamDot } from "./workstream-chip";

export function ChatWorkstreamSubmenu({ instanceId }: { instanceId: string }) {
  const { workstreams, workstreamFor } = useWorkstreams();
  const { assign } = useWorkstreamActions();
  const openDialog = useWorkstreamUiStore((s) => s.openDialog);
  const current = workstreamFor(instanceId);
  // Done workstreams are hidden from the sidebar, so adding to one would make
  // the chat's grouping invisible. The chat's own workstream always shows.
  const options = workstreams
    .filter((workstream) => workstream.status !== "done" || workstream.id === current?.id)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const stop = (fn: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    fn();
  };

  return (
    <Menu.Sub>
      <Menu.SubTrigger onClick={(event) => event.stopPropagation()}>
        <Layers size={13} strokeWidth={2} className="text-muted" />
        Workstream
        {current && (
          <span className="ml-auto max-w-[7rem] truncate pl-3 text-[0.6875rem] text-muted">
            {current.name}
          </span>
        )}
      </Menu.SubTrigger>
      <Menu.SubContent>
        {options.map((workstream) => (
          <Menu.Item
            key={workstream.id}
            onClick={stop(() => {
              if (workstream.id !== current?.id) void assign(instanceId, workstream.id);
            })}
          >
            <span className="flex w-[13px] shrink-0 justify-center">
              <WorkstreamDot workstream={workstream} />
            </span>
            <span className="min-w-0 max-w-[12rem] truncate">{workstream.name}</span>
            {workstream.id === current?.id && <Check size={12} className="ml-auto text-accent" />}
          </Menu.Item>
        ))}
        {options.length > 0 && <Menu.Separator />}
        <Menu.Item onClick={stop(() => openDialog({ kind: "create", instanceId }))}>
          <FolderPlus size={13} strokeWidth={2} className="text-muted" />
          New workstream…
        </Menu.Item>
        {current && (
          <Menu.Item onClick={stop(() => void assign(instanceId, null))}>
            <X size={13} strokeWidth={2} className="text-muted" />
            Remove from {current.name}
          </Menu.Item>
        )}
      </Menu.SubContent>
    </Menu.Sub>
  );
}
