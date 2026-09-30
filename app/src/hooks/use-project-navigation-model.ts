import { useEffect } from "react";
import { useWSState } from "@/context/websocket-context";
import { groupInstancesByProject } from "@/lib/project-groups";
import { chatBelongsToAccount, projectBelongsToAccount } from "@/lib/account-scope";
import { useActiveAccount } from "./use-active-account";
import { useProjectChatSummaries } from "./use-project-chat-summaries";
import { useProjectOrder } from "../stores/project-order-store";
import { useProjectOrderHydration } from "./use-project-order-hydration";
import { useProjectsQuery } from "./use-projects-query";
import { useProjectSpaces } from "./use-project-spaces";
import { getChatRecencyTimestamp } from "@/lib/utils";
import type { InstanceInfo, Project } from "@shared/types";

/**
 * The one data model behind the sidebar, the collapsed rail, mobile Home, the
 * dashboard, and search: REST chat summaries merged with live WS instances.
 *
 * With two or more accounts registered it is scoped to the active account —
 * only projects whose membership includes it and only chats bound to it
 * (terminal chats included). With a single account nothing is filtered.
 */
export function useProjectNavigationModel() {
  const { instances } = useWSState();
  const { data: allProjects = [], isLoading: projectsLoading } = useProjectsQuery();
  const account = useActiveAccount();
  const projects = account.isMulti
    ? allProjects.filter((project) =>
        projectBelongsToAccount(project, account.activeId, account.isMulti),
      )
    : allProjects;
  const { spacesByDir: projectSpaces, spacesLoadingByDir } = useProjectSpaces(projects);
  const { chatsByProjectId, chatsLoadingByProjectId } = useProjectChatSummaries(projects);
  const projectOrder = useProjectOrder();
  const { syncVisibleDirs } = projectOrder;
  useProjectOrderHydration();

  const inActiveAccount = (instance: InstanceInfo) =>
    !account.isMulti || chatBelongsToAccount(instance, account.activeId, account.accounts);

  const mergedInstances = new Map<string, InstanceInfo>();
  for (const project of projects) {
    const chats = chatsByProjectId[project.id] ?? [];
    for (const chat of chats) {
      if (!inActiveAccount(chat)) continue;
      mergedInstances.set(chat.id, chat);
    }
  }
  for (const instance of instances) {
    if (!inActiveAccount(instance)) {
      // A live update for a chat outside the account must not resurrect a
      // summary row that was filtered above.
      mergedInstances.delete(instance.id);
      continue;
    }
    mergedInstances.set(instance.id, instance);
  }

  const groups = projectOrder.sortEntries(
    groupInstancesByProject(Array.from(mergedInstances.values()), projects),
  );
  const groupDirs = groups.map(([dir]) => dir);
  const groupDirsKey = groupDirs.join("\0");

  const latestChatIdBySpace: Record<string, string> = {};
  const latestActivityBySpace = new Map<string, number>();
  for (const instance of mergedInstances.values()) {
    if (!instance.spaceId) continue;
    const activityAt = getChatRecencyTimestamp(instance);
    const previous = latestActivityBySpace.get(instance.spaceId) ?? Number.NEGATIVE_INFINITY;
    if (activityAt >= previous) {
      latestActivityBySpace.set(instance.spaceId, activityAt);
      latestChatIdBySpace[instance.spaceId] = instance.id;
    }
  }

  useEffect(() => {
    syncVisibleDirs(groupDirs);
  }, [groupDirs, groupDirsKey, syncVisibleDirs]);

  const projectByDir = new Map<string, Project>();
  for (const project of projects) {
    projectByDir.set(project.directory, project);
  }
  const registeredDirs = new Set(projects.map((project) => project.directory));

  return {
    chatsLoadingByProjectId,
    spacesLoadingByDir,
    groups,
    latestChatIdBySpace,
    projectByDir,
    projectSpaces,
    projects,
    projectsLoading,
    registeredDirs,
    ...projectOrder,
  };
}
