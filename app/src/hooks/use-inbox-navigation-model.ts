/**
 * Flattens the project navigation model into one recency-sorted inbox of chats
 * across every project.
 *
 * Deliberately reuses `useSidebarNavigationController` rather than fetching
 * anything of its own: the merged REST-summaries + live-WS instance set and the
 * project icons are already assembled there, so both sidebar layouts render
 * from exactly the same data. The rules themselves live
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

export function useInboxNavigationModel(projectFilter: string | null) {
  const controller = useSidebarNavigationController();
  const { projectEntries } = controller;

  const allEntries = useMemo(() => buildInboxEntries(projectEntries), [projectEntries]);

  const { active, done } = useMemo(
    () => partitionInboxEntries(filterInboxEntries(allEntries, projectFilter)),
    [allEntries, projectFilter],
  );

  const projectOptions = useMemo(() => buildInboxProjectOptions(projectEntries), [projectEntries]);

  return { ...controller, allEntries, active, done, projectOptions };
}
