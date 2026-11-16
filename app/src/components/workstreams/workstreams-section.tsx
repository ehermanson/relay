/**
 * The Inbox sidebar's Workstreams section: one collapsible folder per
 * Workstream, listing its chats. A folder is where its chats live: they are
 * left out of the inbox lists.
 *
 * Inbox layout only. The Projects layout groups by repo and stays that way: a
 * member chat sits under its project there, carrying the Workstream's label.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
  Undo2,
} from "lucide-react";
import { Collapsible } from "@/components/ui/collapsible";
import { Menu } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { InboxItem } from "@/components/layout/inbox-item";
import { useWorkstreamActions, useWorkstreams } from "@/hooks/use-workstreams";
import { isInboxEntryCurrent, type InboxEntry } from "@/lib/inbox";
import {
  buildWorkstreamFolders,
  capWorkstreamEntries,
  getWorkstreamAccent,
  type WorkstreamFolder,
} from "@/lib/workstreams";
import { useWorkstreamUiStore } from "@/stores/workstream-ui-store";
import type { Workstream } from "@shared/types";

const SECTION_LABEL_CLASS =
  "flex min-w-0 flex-1 items-center gap-1 text-[0.625rem] font-semibold uppercase tracking-wider text-muted/60 transition-colors hover:text-muted";

function FolderMenu({ workstream }: { workstream: Workstream }) {
  const [open, setOpen] = useState(false);
  const openDialog = useWorkstreamUiStore((s) => s.openDialog);
  const { update } = useWorkstreamActions();
  const done = workstream.status === "done";

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        aria-label={`${workstream.name} actions`}
        onClick={(event: React.MouseEvent) => event.stopPropagation()}
        className={`sidebar-menu-trigger flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted/60 transition-opacity duration-150 hover:text-text ${
          open ? "opacity-100" : "opacity-0 group-hover/workstream:opacity-100"
        }`}
      >
        <MoreVertical size={15} />
      </Menu.Trigger>
      <Menu.Content align="end">
        <Menu.Item onClick={() => openDialog({ kind: "rename", workstream })}>
          <Pencil size={13} strokeWidth={2} className="text-muted" />
          Rename
        </Menu.Item>
        <Menu.Item onClick={() => void update(workstream.id, { status: done ? "active" : "done" })}>
          {done ? (
            <Undo2 size={13} strokeWidth={2} className="text-muted" />
          ) : (
            <Check size={13} strokeWidth={2} className="text-muted" />
          )}
          {done ? "Reopen" : "Mark done"}
        </Menu.Item>
        <Menu.Item danger onClick={() => openDialog({ kind: "delete", workstream })}>
          <Trash2 size={13} strokeWidth={2} />
          Delete
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}

function ShowAllButton({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-1 rounded-md px-2.5 py-1.5 text-left text-xs text-muted transition-colors hover:bg-surface-hover hover:text-accent"
    >
      Show all ({hidden} more)
      <ChevronDown size={10} strokeWidth={2.5} />
    </button>
  );
}

function FolderRows({
  folder,
  currentChatId,
}: {
  folder: WorkstreamFolder;
  currentChatId?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const currentIsDone = folder.done.some((entry) => isInboxEntryCurrent(entry, currentChatId));
  // Open on arrival at a done chat, so the open chat is never hidden.
  const [doneOpen, setDoneOpen] = useState(currentIsDone);
  useEffect(() => {
    if (currentIsDone) setDoneOpen(true);
  }, [currentIsDone]);

  const visible = capWorkstreamEntries(folder, showAll, currentChatId);
  const hidden = folder.active.length - visible.length;

  if (folder.active.length === 0 && folder.done.length === 0) {
    return (
      <p className="px-2.5 py-2 text-[0.6875rem] leading-snug text-muted/70">
        No chats yet. Add one from a chat's menu, under Workstream.
      </p>
    );
  }

  return (
    <div className="space-y-0.5">
      {visible.map((entry) => (
        <InboxItem
          key={entry.id}
          entry={entry}
          isActive={isInboxEntryCurrent(entry, currentChatId)}
          activeChatId={currentChatId}
          hideWorkstream
        />
      ))}
      {hidden > 0 && <ShowAllButton hidden={hidden} onClick={() => setShowAll(true)} />}
      {folder.done.length > 0 && (
        <Collapsible.Root open={doneOpen} onOpenChange={setDoneOpen}>
          <Collapsible.Trigger className="flex w-full items-center gap-1 rounded-md px-2.5 py-1.5 text-left text-[0.6875rem] text-muted/70 transition-colors hover:text-muted">
            {doneOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            Done
            <span className="text-muted/40">{folder.done.length}</span>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div className="space-y-0.5">
              {folder.done.map((entry) => (
                <InboxItem
                  key={entry.id}
                  entry={entry}
                  isActive={isInboxEntryCurrent(entry, currentChatId)}
                  activeChatId={currentChatId}
                  hideWorkstream
                />
              ))}
            </div>
          </Collapsible.Content>
        </Collapsible.Root>
      )}
    </div>
  );
}

function Folder({ folder, currentChatId }: { folder: WorkstreamFolder; currentChatId?: string }) {
  const { workstream } = folder;
  const open = useWorkstreamUiStore((s) => !!s.expanded[workstream.id]);
  const setExpanded = useWorkstreamUiStore((s) => s.setExpanded);
  const revealId = useWorkstreamUiStore((s) => s.revealId);
  const clearReveal = useWorkstreamUiStore((s) => s.clearReveal);
  const ref = useRef<HTMLDivElement>(null);
  const accent = getWorkstreamAccent(workstream);
  const total = folder.active.length + folder.done.length;
  // A collapsed folder still says where the open chat is.
  const holdsCurrent =
    !open &&
    [...folder.active, ...folder.done].some((entry) => isInboxEntryCurrent(entry, currentChatId));

  // The folder is the only place its chats are listed, so arriving on one
  // opens it. Keyed on the chat, so collapsing it afterwards sticks.
  const holdsCurrentChat = [...folder.active, ...folder.done].some((entry) =>
    isInboxEntryCurrent(entry, currentChatId),
  );
  useEffect(() => {
    if (holdsCurrentChat) setExpanded(workstream.id, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChatId, holdsCurrentChat, workstream.id]);

  useEffect(() => {
    if (revealId !== workstream.id) return;
    ref.current?.scrollIntoView({ block: "nearest" });
    clearReveal();
  }, [revealId, workstream.id, clearReveal]);

  return (
    <div ref={ref} data-workstream-id={workstream.id}>
      <Collapsible.Root open={open} onOpenChange={(next) => setExpanded(workstream.id, next)}>
        <div
          className={`group/workstream flex items-center rounded-lg pr-1 transition-colors hover:bg-surface-hover ${
            holdsCurrent ? "bg-accent-dim/60" : ""
          }`}
        >
          <Collapsible.Trigger className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2.5 text-left">
            <span className="flex h-4 w-3 shrink-0 items-center justify-center text-muted/60">
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </span>
            <span className={`h-2 w-2 shrink-0 rounded-[3px] ${accent.dot}`} />
            <span className="min-w-0 flex-1 truncate text-[0.75rem] font-medium text-text">
              {workstream.name}
            </span>
            {folder.attention > 0 && (
              <Tooltip
                content={`${folder.attention} ${folder.attention === 1 ? "chat needs" : "chats need"} you`}
                side="top"
              >
                <span className="shrink-0 rounded-full bg-warning/15 px-1.5 text-[0.625rem] font-semibold leading-4 text-warning">
                  {folder.attention}
                </span>
              </Tooltip>
            )}
            {folder.attention === 0 && folder.running > 0 && (
              <Tooltip content={`${folder.running} working`} side="top">
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse-dot rounded-full bg-warning" />
              </Tooltip>
            )}
            <span className="shrink-0 text-[0.625rem] tabular-nums text-muted/50">{total}</span>
          </Collapsible.Trigger>
          <FolderMenu workstream={workstream} />
        </div>
        <Collapsible.Content>
          {/* The rail ties the rows to their folder, in the folder's colour. */}
          <div className="relative ml-[0.9rem] mt-0.5 pl-1.5">
            <span
              aria-hidden
              className={`absolute bottom-1 left-0 top-1 w-px rounded-full opacity-40 ${accent.dot}`}
            />
            <FolderRows folder={folder} currentChatId={currentChatId} />
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </div>
  );
}

function DoneWorkstreams({ workstreams }: { workstreams: Workstream[] }) {
  const [open, setOpen] = useState(false);
  if (workstreams.length === 0) return null;
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger className="flex w-full items-center gap-1 rounded-md px-2.5 py-1.5 text-left text-[0.6875rem] text-muted/70 transition-colors hover:text-muted">
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        Done
        <span className="text-muted/40">{workstreams.length}</span>
      </Collapsible.Trigger>
      <Collapsible.Content>
        {workstreams.map((workstream) => (
          <div
            key={workstream.id}
            className="group/workstream flex items-center rounded-lg pl-2.5 pr-1 opacity-70 transition-colors hover:bg-surface-hover hover:opacity-100"
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5">
              <span className="w-3 shrink-0" />
              <span
                className={`h-2 w-2 shrink-0 rounded-[3px] ${getWorkstreamAccent(workstream).dot}`}
              />
              <span className="min-w-0 flex-1 truncate text-[0.75rem] text-muted">
                {workstream.name}
              </span>
            </span>
            <FolderMenu workstream={workstream} />
          </div>
        ))}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

export function WorkstreamsSection({
  entries,
  currentChatId,
}: {
  /** Every chat in inbox order, unfiltered: a folder shows its chats whatever the inbox filter. */
  entries: readonly InboxEntry[];
  currentChatId?: string;
}) {
  const { workstreams, members } = useWorkstreams();
  const sectionOpen = useWorkstreamUiStore((s) => s.sectionOpen);
  const setSectionOpen = useWorkstreamUiStore((s) => s.setSectionOpen);
  const openDialog = useWorkstreamUiStore((s) => s.openDialog);

  const folders = useMemo(
    () => buildWorkstreamFolders(workstreams, members, entries),
    [workstreams, members, entries],
  );
  const doneWorkstreams = useMemo(
    () => workstreams.filter((workstream) => workstream.status === "done"),
    [workstreams],
  );

  return (
    <Collapsible.Root open={sectionOpen} onOpenChange={setSectionOpen}>
      <div className="flex items-center pb-1 pl-3 pr-3 pt-1">
        <Collapsible.Trigger className={SECTION_LABEL_CLASS}>
          {sectionOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          Workstreams
          {folders.length > 0 && (
            <span className="ml-1 font-normal normal-case tracking-normal text-muted/40">
              {folders.length}
            </span>
          )}
        </Collapsible.Trigger>
        <Tooltip content="New workstream" side="top">
          <button
            type="button"
            aria-label="New workstream"
            onClick={() => openDialog({ kind: "create" })}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted/60 transition-colors hover:bg-surface-hover hover:text-text"
          >
            <Plus size={13} strokeWidth={2.5} />
          </button>
        </Tooltip>
      </div>
      <Collapsible.Content>
        <div className="px-2 pb-2">
          {folders.length === 0 && doneWorkstreams.length === 0 ? (
            <p className="px-2.5 pb-1 text-[0.6875rem] leading-snug text-muted/60">
              Group the chats of a long-running effort, across projects.
            </p>
          ) : (
            <>
              {folders.map((folder) => (
                <Folder key={folder.workstream.id} folder={folder} currentChatId={currentChatId} />
              ))}
              <DoneWorkstreams workstreams={doneWorkstreams} />
            </>
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
