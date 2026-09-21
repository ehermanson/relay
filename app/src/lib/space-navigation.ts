import type { InstanceInfo } from "@shared/types";
import type { InboxSpaceEntry } from "@/lib/inbox";
import { getSpaceRoute } from "@/lib/project-route";
import { isAttachedReviewInstance } from "@/lib/review-session";
import { getChatRecencyTimestamp } from "@/lib/utils";

const STORAGE_PREFIX = "relay:space:last-chat:";

export function readLastSpaceChat(spaceId: string): string | null {
  try {
    return localStorage.getItem(STORAGE_PREFIX + spaceId);
  } catch {
    return null;
  }
}

export function rememberSpaceChat(spaceId: string, chatId: string): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + spaceId, chatId);
  } catch {
    // Navigation still works when browser storage is unavailable.
  }
}

/** Ignore stale selections and attached review chats; never mutate the source list. */
export function selectSpaceChat(
  spaceId: string,
  instances: readonly InstanceInfo[],
  rememberedId: string | null,
): string | undefined {
  const eligible = instances.filter(
    (chat) => chat.spaceId === spaceId && !isAttachedReviewInstance(chat),
  );
  if (rememberedId && eligible.some((chat) => chat.id === rememberedId)) return rememberedId;
  return eligible.sort(
    (a, b) =>
      getChatRecencyTimestamp(b) - getChatRecencyTimestamp(a) ||
      b.createdAt - a.createdAt ||
      a.id.localeCompare(b.id),
  )[0]?.id;
}

export function getInboxSpaceRoute(entry: InboxSpaceEntry, chatId?: string) {
  return getSpaceRoute(
    entry.projectId,
    entry.space.id,
    chatId ?? selectSpaceChat(entry.space.id, entry.instances, readLastSpaceChat(entry.space.id)),
  );
}
