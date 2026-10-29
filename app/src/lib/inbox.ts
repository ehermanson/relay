/**
 * Pure inbox-model helpers: turning the project-grouped navigation model into
 * one flat, recency-sorted list and partitioning it into active vs done.
 *
 * Kept out of the hook so the rules that decide what appears in the inbox —
 * review-chat and delegated-child exclusion, done state, pinned ordering — are
 * testable without mounting the whole sidebar.
 */

import { isAttachedReviewInstance } from "@/lib/review-session";
import { isDelegatedChildInstance } from "@/lib/delegation";
import { getChatRecencyTimestamp, getChatSortTimestamp, isChatDone } from "@/lib/utils";
import type { InstanceInfo } from "@shared/types";

export interface InboxEntry {
  /** Namespaced destination id, safe to use as a React key. */
  id: string;
  instance: InstanceInfo;
  /** Directory of the owning project — the stable key for filtering. */
  dir: string;
  /** Display name of the owning project. */
  projectName: string;
  /** Route identifier for the owning project (slug, UUID, or basename). */
  projectId: string;
  iconPath?: string;
  done: boolean;
  pinned: boolean;
  recencyAt: number;
}

export interface InboxProjectOption {
  dir: string;
  name: string;
  /** Route identifier (slug, UUID, or basename). */
  projectId: string;
  /** Registered project UUID, when the directory is a registered project. */
  dbId?: string;
  iconPath?: string;
}

/** The subset of a sidebar navigation entry the inbox actually reads. */
export interface InboxSourceGroup {
  dir: string;
  name: string;
  projectId: string;
  iconPath?: string;
  groupInstances: InstanceInfo[];
  project?: { id?: string };
}

/** Why a chat is waiting on the user — one wording for every surface that says so. */
export function getAttentionLabel(instance: InstanceInfo): string {
  if (instance.pendingPlan) return "Plan needs approval";
  if (instance.pendingPermission?.kind === "user_input") return "Needs your answer";
  if (instance.pendingPermission?.kind === "terminal_input") return "Needs terminal input";
  if (instance.pendingPermission || instance.pendingTool) return "Waiting for permission";
  if (instance.status === "error") return "Chat error";
  return "Needs attention";
}

function compareInboxEntries(a: InboxEntry, b: InboxEntry): number {
  const pinnedDelta = Number(b.pinned) - Number(a.pinned);
  if (pinnedDelta !== 0) return pinnedDelta;
  return b.recencyAt - a.recencyAt || a.id.localeCompare(b.id);
}

/** Flatten project groups into one chat list. */
export function buildInboxEntries(groups: readonly InboxSourceGroup[]): InboxEntry[] {
  const entries: InboxEntry[] = [];
  for (const group of groups) {
    for (const instance of group.groupInstances) {
      // Review chats stay attached to the chat they audit — surfacing them as
      // peers in a flat list would double-count the same work.
      // Delegated child chats live behind their parent's card and sidecar row.
      if (isAttachedReviewInstance(instance) || isDelegatedChildInstance(instance)) continue;
      entries.push({
        id: `chat:${instance.id}`,
        instance,
        dir: group.dir,
        projectName: group.name,
        projectId: group.projectId,
        iconPath: group.iconPath,
        done: isChatDone(instance),
        pinned: !!instance.pinned,
        recencyAt: getChatSortTimestamp(instance),
      });
    }
  }
  return entries.sort(compareInboxEntries);
}

export function isInboxEntryCurrent(entry: InboxEntry, chatId?: string): boolean {
  return !!chatId && entry.instance.id === chatId;
}

/** Apply a list cap while retaining the current chat. */
export function capInboxEntries(
  entries: readonly InboxEntry[],
  limit: number,
  chatId?: string,
  extraEntries: readonly InboxEntry[] = [],
): InboxEntry[] {
  const visible = entries.slice(0, limit);
  if (visible.some((entry) => isInboxEntryCurrent(entry, chatId))) return visible;
  const current = [...entries, ...extraEntries].find((entry) => isInboxEntryCurrent(entry, chatId));
  if (current && !visible.some((entry) => entry.id === current.id)) visible.push(current);
  return visible;
}

/** Scope to one project directory; `null` means every project. */
export function filterInboxEntries(
  entries: readonly InboxEntry[],
  projectFilter: string | null,
): InboxEntry[] {
  if (!projectFilter) return [...entries];
  return entries.filter((entry) => entry.dir === projectFilter);
}

export function partitionInboxEntries(entries: readonly InboxEntry[]): {
  active: InboxEntry[];
  done: InboxEntry[];
} {
  const active: InboxEntry[] = [];
  const done: InboxEntry[] = [];
  for (const entry of entries) (entry.done ? done : active).push(entry);
  // Done is an archive: a pin means "keep this in front of me", which a chat
  // marked done no longer needs — so the section orders by recency alone
  // rather than inheriting the active list's pinned-first sort.
  done.sort((a, b) => b.recencyAt - a.recencyAt || a.id.localeCompare(b.id));
  return { active, done };
}

/**
 * How long a chat must sit untouched before the inbox offers to sweep it into
 * Done. Deliberately a manual action, not a rule that runs on its own — nothing
 * marks a chat done behind the user's back.
 */
export const STALE_CHAT_DONE_DAYS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Active chats with no activity for `days` — the ones the sweep would mark
 * done. Chats mid-turn are excluded (staleness is about the backlog, and a
 * working agent is by definition unfinished), as are chats with no recorded
 * activity at all: recency 0 means "unknown", not "ancient", and a chat created
 * seconds ago but never messaged reads that way.
 */
export function selectStaleInboxEntries(
  entries: readonly InboxEntry[],
  now: number,
  days: number = STALE_CHAT_DONE_DAYS,
): InboxEntry[] {
  const cutoff = now - days * DAY_MS;
  return entries.filter((entry) => {
    if (entry.done || entry.instance.status === "processing") return false;
    const recencyAt = getChatRecencyTimestamp(entry.instance);
    return recencyAt > 0 && recencyAt < cutoff;
  });
}

export function buildInboxProjectOptions(
  groups: readonly InboxSourceGroup[],
): InboxProjectOption[] {
  return groups.map((group) => ({
    dir: group.dir,
    name: group.name,
    projectId: group.projectId,
    dbId:
      group.project?.id ?? group.groupInstances.find((instance) => instance.projectId)?.projectId,
    iconPath: group.iconPath,
  }));
}
