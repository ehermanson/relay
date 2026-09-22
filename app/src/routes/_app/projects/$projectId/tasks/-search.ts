interface TasksRouteSearch {
  task?: string;
  sort?: string;
  space?: string;
  view?: "unfinished" | "history";
}

export function validateTasksSearch(search: Record<string, unknown>): TasksRouteSearch {
  return {
    task: typeof search.task === "string" ? search.task : undefined,
    sort: typeof search.sort === "string" ? search.sort : undefined,
    space: typeof search.space === "string" ? search.space : undefined,
    view: search.view === "history" ? "history" : undefined,
  };
}

export function patchTasksSearch(patch: Partial<TasksRouteSearch>) {
  return (prev: TasksRouteSearch): TasksRouteSearch => ({
    ...prev,
    ...patch,
  });
}
