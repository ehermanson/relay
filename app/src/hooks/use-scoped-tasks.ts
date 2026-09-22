import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Task, TasksChangedMessage } from "@shared/types";
import { useWSMethods } from "@/context/websocket-context";
import { fetchTasks } from "@/lib/api";
import {
  taskChangeMatchesScope,
  taskQueryKey,
  taskScopeKey,
  type TaskListView,
} from "@/lib/task-scope";

export function useScopedTasks(
  projectId: string | undefined,
  spaceId: string | undefined,
  options: { view?: TaskListView; initialData?: Task[] | null } = {},
) {
  const queryClient = useQueryClient();
  const { addMessageHandler } = useWSMethods();
  const view = options.view ?? "unfinished";
  const queryKey = taskQueryKey(projectId ?? "", spaceId, view);

  useEffect(() => {
    if (!projectId) return;
    return addMessageHandler((message) => {
      if (
        message.type === "tasks_changed" &&
        taskChangeMatchesScope(message as TasksChangedMessage, projectId, spaceId)
      ) {
        void queryClient.invalidateQueries({
          queryKey: ["tasks", projectId, taskScopeKey(spaceId)],
        });
        void queryClient.invalidateQueries({
          queryKey: ["task", projectId, taskScopeKey(spaceId)],
        });
        void queryClient.invalidateQueries({
          queryKey: ["taskComments", projectId, taskScopeKey(spaceId)],
        });
      }
    });
  }, [addMessageHandler, projectId, queryClient, spaceId]);

  return useQuery({
    queryKey,
    queryFn: () =>
      fetchTasks(projectId!, {
        spaceId,
        includeArchived: view === "history",
      }),
    enabled: Boolean(projectId),
    initialData: options.initialData,
  });
}
