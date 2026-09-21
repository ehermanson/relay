/**
 * Groups the project navigation model into one recency-sorted inbox of
 * standalone chats and named spaces across every project.
 *
 * Deliberately reuses `useSidebarNavigationController` rather than fetching
 * anything of its own: the merged REST-summaries + live-WS instance set, the
 * space lists, and the project icons are already assembled there, so both
 * sidebar layouts render from exactly the same data. The rules themselves live
 * in `@/lib/inbox` so they can be tested without mounting the sidebar.
 */

import { useMemo } from "react";
import { useSidebarNavigationController } from "@/hooks/use-sidebar-navigation-controller";
import {
  buildInboxEntries,
  buildInboxProjectOptions,
  filterInboxEntries,
  partitionInboxEntries,
} from "@/lib/inbox";

export type { InboxEntry, InboxProjectOption } from "@/lib/inbox";

export function useInboxNavigationModel(
  projectFilter: string | null,
  /**
   * `enabled: false` skips the flatten/sort work and returns empty lists —
   * for callers like MiniSidebar that branch on layout but must call the
   * hook unconditionally.
   */
  { enabled = true }: { enabled?: boolean } = {},
) {
  const controller = useSidebarNavigationController();
  const { projectEntries } = controller;

  const allEntries = useMemo(
    () => (enabled ? buildInboxEntries(projectEntries) : []),
    [projectEntries, enabled],
  );

  const { active, done } = useMemo(
    () => partitionInboxEntries(filterInboxEntries(allEntries, projectFilter)),
    [allEntries, projectFilter],
  );

  const projectOptions = useMemo(
    () => (enabled ? buildInboxProjectOptions(projectEntries) : []),
    [projectEntries, enabled],
  );

  return { ...controller, active, done, projectOptions };
}
