import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useActionToasts } from "@/context/action-toast-context";
import { useWSMethods, useWSState } from "@/context/websocket-context";
import { fetchProjectIcons } from "@/lib/api";
import { getInstanceProjectRouteId, getProjectName } from "@/lib/project-route";
import { useActiveAccount } from "@/hooks/use-active-account";
import { useProjectNavigationModel } from "@/hooks/use-project-navigation-model";
import type { InstanceInfo, Project, SpaceInfo } from "@shared/types";

export interface SidebarNavigationEntry {
  dir: string;
  project?: Project;
  projectId: string;
  name: string;
  groupInstances: InstanceInfo[];
  spaces: SpaceInfo[];
  iconPath?: string;
  hasActivity: boolean;
  isActiveProject: boolean;
  loading: boolean;
}

export function useSidebarNavigationController() {
  const navigate = useNavigate();
  const { send } = useWSMethods();
  const { instances } = useWSState();
  const { trackInstanceCreate } = useActionToasts();
  const { accountIdParam } = useActiveAccount();
  const navigation = useProjectNavigationModel();
  const {
    chatId: currentChatId,
    projectId: currentProjectId,
    spaceId: currentSpaceId,
  } = useParams({ strict: false }) as {
    chatId?: string;
    projectId?: string;
    spaceId?: string;
  };

  const { data: projectIcons = {} } = useQuery({
    queryKey: ["projectIcons"],
    queryFn: fetchProjectIcons,
  });
  const prevInstanceIds = useRef(new Set<string>());
  const pendingCreate = useRef(false);

  useEffect(() => {
    const currentIds = new Set(instances.map((instance) => instance.id));
    if (pendingCreate.current && prevInstanceIds.current.size > 0) {
      for (const instance of instances) {
        if (!prevInstanceIds.current.has(instance.id) && !instance.external) {
          pendingCreate.current = false;
          navigate({
            to: "/projects/$projectId/chats/$chatId",
            params: { projectId: getInstanceProjectRouteId(instance), chatId: instance.id },
          });
          break;
        }
      }
    }
    prevInstanceIds.current = currentIds;
  }, [instances, navigate]);

  const projectEntries: SidebarNavigationEntry[] = navigation.groups.map(
    ([dir, groupInstances]) => {
      const project = navigation.projectByDir.get(dir);
      // URL identifier: prefer slug, then UUID (legacy), then directory basename.
      const projectId = project?.slug ?? project?.id ?? getProjectName(dir);
      return {
        dir,
        project,
        projectId,
        name: project?.name ?? getProjectName(dir),
        groupInstances,
        spaces: navigation.projectSpaces[dir] ?? [],
        iconPath: projectIcons[dir],
        hasActivity: groupInstances.some((instance) => instance.status === "processing"),
        isActiveProject: currentProjectId === projectId,
        loading:
          (project?.id ? (navigation.chatsLoadingByProjectId[project.id] ?? false) : false) ||
          (navigation.spacesLoadingByDir[dir] ?? false),
      };
    },
  );

  const createNewChat = (dir: string) => {
    pendingCreate.current = true;
    trackInstanceCreate(dir);
    // New chats bind to the active account (undefined below two accounts).
    send({ type: "create_instance", workingDirectory: dir, accountId: accountIdParam });
  };

  return {
    ...navigation,
    currentChatId,
    currentProjectId,
    currentSpaceId,
    projectEntries,
    projectIcons,
    createNewChat,
  };
}
