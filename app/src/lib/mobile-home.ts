import { buildInboxEntries, type InboxEntry, type InboxSourceGroup } from "@/lib/inbox";
import { getChatSortTimestamp } from "@/lib/utils";
import { isAttachedReviewInstance } from "@/lib/review-session";
import { isDelegatedChildInstance } from "@/lib/delegation";
import type { InstanceInfo } from "@shared/types";

/** How many non-attention destinations Continue shows. */
export const HOME_RECENT_LIMIT = 4;

export interface HomeActivity {
  recencyAt: number;
  attention: number;
  running: number;
}

export type HomeEntry = InboxEntry & HomeActivity;

export function homeActivity(instances: readonly InstanceInfo[]): HomeActivity {
  const eligible = instances.filter(
    (chat) => !isAttachedReviewInstance(chat) && !isDelegatedChildInstance(chat),
  );
  const attention = eligible.filter(
    (chat) =>
      chat.status !== "stopped" &&
      (chat.status === "error" || chat.pendingPermission || chat.pendingPlan || chat.pendingTool),
  );
  const running = eligible.filter(
    (chat) => chat.status === "processing" && !attention.includes(chat),
  );
  return {
    recencyAt: eligible.reduce((latest, chat) => Math.max(latest, getChatSortTimestamp(chat)), 0),
    attention: attention.length,
    running: running.length,
  };
}

const byRecency = (a: HomeEntry, b: HomeEntry) =>
  b.recencyAt - a.recencyAt || a.id.localeCompare(b.id);

/**
 * Home is sorted live — there is no captured order. A row moves when its
 * recency does, and the component animates the move so it reads as activity
 * rather than churn. (An earlier design froze positions on first paint; with
 * the persisted query cache that froze a stale snapshot.)
 *
 * Anything waiting on the user leads in its own section, uncapped — every one
 * of those needs a decision. The next few recent destinations follow.
 */
export function buildMobileHome(groups: readonly InboxSourceGroup[]) {
  const projects = groups
    .map((group) => ({ ...group, ...homeActivity(group.groupInstances) }))
    .sort(
      (a, b) =>
        b.recencyAt - a.recencyAt || a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir),
    );
  const needsInput: HomeEntry[] = [];
  const recent: HomeEntry[] = [];
  for (const entry of buildInboxEntries(groups)) {
    if (entry.done) continue;
    const home: HomeEntry = { ...homeActivity([entry.instance]), ...entry };
    (home.attention > 0 ? needsInput : recent).push(home);
  }
  needsInput.sort(byRecency);
  recent.sort(byRecency);
  return { projects, needsInput, recent: recent.slice(0, HOME_RECENT_LIMIT) };
}
