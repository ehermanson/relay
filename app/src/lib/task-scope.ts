import type { Task, TaskStatus, TasksChangedMessage } from "@shared/types";

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

export function taskQueryKey(projectId: string, view: TaskListView = "unfinished") {
  return ["tasks", projectId, view] as const;
}

/** Tasks are read from the Project's main checkout. */
export function taskChangeMatchesScope(
  message: Pick<TasksChangedMessage, "projectId">,
  projectId: string,
): boolean {
  return message.projectId === projectId;
}
