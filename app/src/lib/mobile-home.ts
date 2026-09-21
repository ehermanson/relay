import { buildInboxEntries, type InboxSourceGroup } from "@/lib/inbox";
import { getChatRecencyTimestamp } from "@/lib/utils";
import { isAttachedReviewInstance } from "@/lib/review-session";
import type { InstanceInfo } from "@shared/types";

export function homeActivity(instances: readonly InstanceInfo[]) {
  const eligible = instances.filter((chat) => !isAttachedReviewInstance(chat));
  const attention = eligible.filter(
    (chat) =>
      chat.status !== "stopped" &&
      (chat.status === "error" || chat.pendingPermission || chat.pendingPlan || chat.pendingTool),
  );
  const running = eligible.filter(
    (chat) => chat.status === "processing" && !attention.includes(chat),
  );
  return {
    recencyAt: eligible.reduce(
      (latest, chat) => Math.max(latest, getChatRecencyTimestamp(chat)),
      0,
    ),
    attention: attention.length,
    running: running.length,
  };
}

export function buildMobileHome(groups: readonly InboxSourceGroup[]) {
  const projects = groups
    .map((group) => ({ ...group, ...homeActivity(group.groupInstances) }))
    .sort(
      (a, b) =>
        b.recencyAt - a.recencyAt || a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir),
    );
  const recent = buildInboxEntries(groups)
    .filter((entry) => !entry.done && (entry.kind === "chat" || entry.instances.length > 0))
    .sort((a, b) => b.recencyAt - a.recencyAt || a.id.localeCompare(b.id));
  return { projects, recent };
}

/** Preserve existing positions during live updates; append new destinations. */
export function keepHomeOrder<T>(
  items: readonly T[],
  order: readonly string[],
  key: (item: T) => string,
): T[] {
  const positions = new Map(order.map((id, index) => [id, index]));
  return [...items].sort(
    (a, b) => (positions.get(key(a)) ?? Infinity) - (positions.get(key(b)) ?? Infinity),
  );
}
