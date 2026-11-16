/**
 * Pure Workstream helpers: which chats a sidebar folder shows, its roll-up
 * counts, and the accent each Workstream is drawn in. Kept out of the
 * components so the rules are testable without mounting the sidebar.
 *
 * A Workstream is a folder in the sidebar and a chip on each member chat; a
 * member chat also stays in the normal lists. See `plans/workstreams.md`.
 */

import { capInboxEntries, type InboxEntry } from "@/lib/inbox";
import { homeActivity } from "@/lib/mobile-home";
import type { Workstream } from "@shared/types";

/** Active chats a folder shows before "Show all". */
export const WORKSTREAM_FOLDER_LIMIT = 8;

export interface WorkstreamAccent {
  /** Text/glyph colour. */
  text: string;
  /** Solid dot colour (background utility). */
  dot: string;
  /** Tinted chip background. */
  softBg: string;
}

// chart-5 is red (reads as an error) and is skipped, like agent accents.
const WORKSTREAM_ACCENTS: WorkstreamAccent[] = [
  { text: "text-chart-1", dot: "bg-chart-1", softBg: "bg-chart-1/15" },
  { text: "text-chart-2", dot: "bg-chart-2", softBg: "bg-chart-2/15" },
  { text: "text-chart-3", dot: "bg-chart-3", softBg: "bg-chart-3/15" },
  { text: "text-chart-4", dot: "bg-chart-4", softBg: "bg-chart-4/15" },
  { text: "text-chart-6", dot: "bg-chart-6", softBg: "bg-chart-6/15" },
  { text: "text-chart-7", dot: "bg-chart-7", softBg: "bg-chart-7/15" },
  { text: "text-chart-8", dot: "bg-chart-8", softBg: "bg-chart-8/15" },
];

function hashKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) >>> 0;
  return h;
}

/** Deterministic accent, keyed by id so a rename keeps the colour. */
export function getWorkstreamAccent(workstream: Pick<Workstream, "id">): WorkstreamAccent {
  return WORKSTREAM_ACCENTS[hashKey(workstream.id) % WORKSTREAM_ACCENTS.length];
}

export interface WorkstreamFolder {
  workstream: Workstream;
  /** Member chats that aren't done, in inbox order (pinned first, then recency). */
  active: InboxEntry[];
  /** Done member chats, newest first. */
  done: InboxEntry[];
  /** Chats waiting on the user. */
  attention: number;
  /** Chats working, excluding those waiting on the user. */
  running: number;
}

/**
 * One folder per Workstream that isn't done, ordered by name so folders never
 * shuffle under the cursor as chats come and go. `entries` must already be in
 * inbox order; a chat whose Workstream is unknown (another account, deleted)
 * simply belongs to no folder.
 */
export function buildWorkstreamFolders(
  workstreams: readonly Workstream[],
  members: Readonly<Record<string, string>>,
  entries: readonly InboxEntry[],
): WorkstreamFolder[] {
  const byWorkstream = new Map<string, InboxEntry[]>();
  for (const entry of entries) {
    const workstreamId = members[entry.instance.id];
    if (!workstreamId) continue;
    const list = byWorkstream.get(workstreamId);
    if (list) list.push(entry);
    else byWorkstream.set(workstreamId, [entry]);
  }

  return workstreams
    .filter((workstream) => workstream.status !== "done")
    .map((workstream) => {
      const all = byWorkstream.get(workstream.id) ?? [];
      const active = all.filter((entry) => !entry.done);
      const done = all
        .filter((entry) => entry.done)
        .sort((a, b) => b.recencyAt - a.recencyAt || a.id.localeCompare(b.id));
      const { attention, running } = homeActivity(active.map((entry) => entry.instance));
      return { workstream, active, done, attention, running };
    })
    .sort(
      (a, b) =>
        a.workstream.name.localeCompare(b.workstream.name, undefined, { sensitivity: "base" }) ||
        a.workstream.id.localeCompare(b.workstream.id),
    );
}

/** The folder's visible active rows; the open chat is never hidden by the cap. */
export function capWorkstreamEntries(
  folder: Pick<WorkstreamFolder, "active">,
  expanded: boolean,
  currentChatId?: string,
): InboxEntry[] {
  if (expanded) return folder.active;
  return capInboxEntries(folder.active, WORKSTREAM_FOLDER_LIMIT, currentChatId);
}

/**
 * Drop the chats that live in a sidebar folder. A chat in a Workstream shows
 * in its folder only; listing it in the inbox as well read as clutter. Chats
 * of a done Workstream (whose folder is hidden) and of an unknown one stay, so
 * no chat is ever left without a row.
 */
export function excludeFolderedEntries(
  entries: readonly InboxEntry[],
  members: Readonly<Record<string, string>>,
  workstreams: readonly Workstream[],
): InboxEntry[] {
  const foldered = new Set(
    workstreams.filter((workstream) => workstream.status !== "done").map((w) => w.id),
  );
  return entries.filter((entry) => !foldered.has(members[entry.instance.id] ?? ""));
}
