import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { InstanceInfo } from "@shared/types";
import { DelegationTabs } from "@/components/chat/delegation-tabs";
import { useOptionalWSState } from "@/context/websocket-context";
import { useActiveAccount } from "@/hooks/use-active-account";
import { chatBelongsToAccount } from "@/lib/account-scope";
import { buildDelegationFamily } from "@/lib/delegation";
import { getInstanceChatRoute } from "@/lib/project-route";

const EMPTY: InstanceInfo[] = [];

/**
 * The delegation family strip for the chat on screen: its root and every chat
 * delegated under it. Renders nothing for an ordinary chat. Members come from
 * live WS instances, falling back to the project's cached chat summaries (a
 * stopped child may not be live yet), and are scoped to the active account —
 * except the chat on screen, which the account-mismatch banner identifies.
 */
export function DelegationFamilyTabs({ instance }: { instance: InstanceInfo }) {
  const live = useOptionalWSState()?.instances ?? EMPTY;
  const cached = useCachedProjectChats(instance.projectId);
  const account = useActiveAccount();
  const navigate = useNavigate();

  const tabs = useMemo(() => {
    const byId = new Map<string, InstanceInfo>();
    for (const chat of cached) byId.set(chat.id, chat);
    for (const chat of live) byId.set(chat.id, chat);
    byId.set(instance.id, instance);
    let members = Array.from(byId.values());
    if (account.isMulti) {
      members = members.filter(
        (chat) =>
          chat.id === instance.id || chatBelongsToAccount(chat, account.activeId, account.accounts),
      );
    }
    return buildDelegationFamily(members, instance.id);
  }, [cached, live, instance, account.isMulti, account.activeId, account.accounts]);

  const onSelect = useCallback(
    (id: string) => {
      if (id === instance.id) return;
      const target = tabs.find((tab) => tab.instance.id === id)?.instance;
      if (!target) return;
      const route = getInstanceChatRoute(target);
      void navigate({ to: route.to, params: route.params });
    },
    [instance.id, navigate, tabs],
  );

  return <DelegationTabs tabs={tabs} activeId={instance.id} onSelect={onSelect} />;
}

/** The project's cached chat summaries (`["projectChats", projectId]`), subscribed. */
function useCachedProjectChats(projectId: string | undefined): InstanceInfo[] {
  const queryClient = useContext(QueryClientContext);
  const subscribe = useCallback(
    (onChange: () => void) => queryClient?.getQueryCache().subscribe(onChange) ?? (() => {}),
    [queryClient],
  );
  const getSnapshot = useCallback(
    (): InstanceInfo[] =>
      (projectId && queryClient?.getQueryData<InstanceInfo[]>(["projectChats", projectId])) ||
      EMPTY,
    [projectId, queryClient],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
