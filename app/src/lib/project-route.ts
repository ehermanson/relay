import type { InstanceInfo } from "@shared/types";

export type RemoveProjectTarget = {
  id?: string;
  name: string;
  directory: string;
};

type StandaloneChatRoute = {
  to: "/projects/$projectId/chats/$chatId";
  params: {
    projectId: string;
    chatId: string;
  };
};

export function getProjectName(directory: string): string {
  return directory.split("/").pop() || directory;
}

export function getInstanceProjectRouteId(
  instance: Pick<
    InstanceInfo,
    "projectId" | "projectSlug" | "workingDirectory" | "originalDirectory"
  >,
): string {
  // Prefer the sticky human-readable slug. Fall back to the UUID (legacy URLs)
  // or to the directory basename for projects that aren't yet registered.
  return (
    instance.projectSlug ??
    instance.projectId ??
    getProjectName(instance.originalDirectory ?? instance.workingDirectory)
  );
}

export function getInstanceChatRoute(
  instance: Pick<
    InstanceInfo,
    "id" | "projectId" | "projectSlug" | "workingDirectory" | "originalDirectory"
  >,
): StandaloneChatRoute {
  return {
    to: "/projects/$projectId/chats/$chatId",
    params: {
      projectId: getInstanceProjectRouteId(instance),
      chatId: instance.id,
    },
  };
}

export function instanceMatchesProject(
  instance: Pick<
    InstanceInfo,
    "projectId" | "projectSlug" | "workingDirectory" | "originalDirectory"
  >,
  projectId: string,
): boolean {
  // Accept match on slug, UUID, or directory-basename fallback — any of these
  // can legitimately be the current URL param depending on registration state.
  return (
    instance.projectSlug === projectId ||
    instance.projectId === projectId ||
    getInstanceProjectRouteId(instance) === projectId
  );
}
