import { useCallback, useContext, useSyncExternalStore } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { useOptionalWSState } from "@/context/websocket-context";
import type { InstanceInfo } from "@shared/types";

/**
 * Look up one chat by id: the live WS instance first, then any cached project
 * chat summary. Used for links between chats (a delegated child and its
 * parent, chat-link chips) where the other chat may not be the one on screen.
 * Subscribes to the query cache, so a summary that loads later re-renders the
 * caller. Outside the app's providers (bare markdown in tests) it finds nothing.
 */
export function useChatById(id: string | undefined): InstanceInfo | undefined {
  const instances = useOptionalWSState()?.instances;
  const queryClient = useContext(QueryClientContext);
  const live = id ? instances?.find((instance) => instance.id === id) : undefined;

  const subscribe = useCallback(
    (onChange: () => void) => queryClient?.getQueryCache().subscribe(onChange) ?? (() => {}),
    [queryClient],
  );
  const getCached = useCallback((): InstanceInfo | undefined => {
    if (!id || !queryClient) return undefined;
    for (const [, chats] of queryClient.getQueriesData<InstanceInfo[]>({
      queryKey: ["projectChats"],
    })) {
      const match = chats?.find((chat) => chat.id === id);
      if (match) return match;
    }
    return undefined;
  }, [id, queryClient]);
  // Cached rows are stable references, so the snapshot only changes when the data does.
  const cached = useSyncExternalStore(subscribe, getCached, getCached);

  return live ?? cached;
}
