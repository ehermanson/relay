import type { Task } from "@shared/types";

export const TASK_ID_PATTERN_SOURCE =
  "(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?)";

export function isTaskId(value: string): boolean {
  return new RegExp(`^${TASK_ID_PATTERN_SOURCE}$`).test(value);
}

export function buildTaskReference(task: Pick<Task, "id" | "title">): string {
  return `@task:${task.id}:${encodeURIComponent(task.title)} `;
}
