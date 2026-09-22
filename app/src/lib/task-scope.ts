import type { SpaceInfo, Task, TaskStatus, TasksChangedMessage } from "@shared/types";

export type TaskListView = "unfinished" | "history";

export const TASK_VIEW_STATUSES: Record<TaskListView, TaskStatus[]> = {
  unfinished: ["open", "in_progress", "blocked"],
  history: ["done", "cancelled"],
};

export function filterTasksForView(tasks: Task[], view: TaskListView): Task[] {
  const statuses = TASK_VIEW_STATUSES[view];
  return tasks.filter((task) => statuses.includes(task.status));
}

export function hasRevisionedTaskShape(tasks: Task[] | null | undefined): tasks is Task[] {
  return Boolean(
    tasks &&
    tasks.every(
      (task) =>
        typeof task.revision === "string" &&
        typeof task.archived === "boolean" &&
        (task.closedAt === null || typeof task.closedAt === "string"),
    ),
  );
}

export function taskScopeKey(spaceId?: string | null): string {
  return spaceId || "main";
}

export function normalizeTaskSpaceId(
  spaceId: string | null | undefined,
  spaces: Pick<SpaceInfo, "id" | "isDefault">[] | null | undefined,
): string | undefined {
  if (!spaceId) return undefined;
  return spaces?.some((space) => space.id === spaceId && space.isDefault) ? undefined : spaceId;
}

export function taskQueryKey(
  projectId: string,
  spaceId?: string,
  view: TaskListView = "unfinished",
) {
  return ["tasks", projectId, taskScopeKey(spaceId), view] as const;
}

export function taskChangeMatchesScope(
  message: Pick<TasksChangedMessage, "projectId" | "spaceId">,
  projectId: string,
  spaceId?: string,
): boolean {
  return message.projectId === projectId && taskScopeKey(message.spaceId) === taskScopeKey(spaceId);
}
