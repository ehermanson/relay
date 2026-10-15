import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { InstanceInfo } from "@shared/types";
import { useWSState } from "@/context/websocket-context";
import { getDesktop } from "@/lib/desktop";
import { getInstanceChatRoute } from "@/lib/project-route";

const needsInput = (instance: InstanceInfo) =>
  !!(instance.pendingPermission || instance.pendingTool || instance.pendingPlan);

/** Shares the existing instance stream. Snapshot/reconnect updates never replay notifications. */
export function useDesktopAttention() {
  const desktop = getDesktop();
  const { instances, isConnected, isSyncing, connectionId } = useWSState();
  const previous = useRef<Map<string, InstanceInfo>>(new Map());
  const connection = useRef<number | undefined>(undefined);
  const activityKey = useRef<string | undefined>(undefined);
  const badge = useRef<number | undefined>(undefined);
  const { data: preferences } = useQuery({
    queryKey: ["desktop-preferences"],
    queryFn: () => desktop!.getPreferences(),
    enabled: !!desktop,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (!desktop || !isConnected || isSyncing) return;
    const freshConnection = connection.current !== connectionId;
    connection.current = connectionId;
    const attention = instances.filter(
      (instance) => needsInput(instance) || instance.status === "error",
    ).length;
    if (badge.current !== attention) {
      badge.current = attention;
      void desktop.setBadge(attention).catch(() => {
        badge.current = undefined;
      });
    }
    const activity = {
      running: instances.filter(
        (instance) => instance.status === "processing" && !needsInput(instance),
      ).length,
      needsInput: instances.filter(needsInput).length,
      failed: instances.filter((instance) => instance.status === "error").length,
    };
    const key = `${activity.running}:${activity.needsInput}:${activity.failed}`;
    if (key !== activityKey.current) {
      activityKey.current = key;
      void desktop.setActivity(activity).catch(() => {
        activityKey.current = undefined;
      });
    }
    for (const instance of instances) {
      const prev = previous.current.get(instance.id);
      if (
        !prev ||
        freshConnection ||
        !preferences?.notifications ||
        (document.visibilityState === "visible" && document.hasFocus())
      )
        continue;
      const input = needsInput(instance) && !needsInput(prev);
      const completed =
        prev.status === "processing" &&
        (instance.status === "idle" || instance.status === "error") &&
        !needsInput(instance) &&
        !instance.external;
      if (!input && !completed) continue;
      const route = getInstanceChatRoute(instance);
      const path = route.to.replace(/\$(\w+)/g, (_, key: string) =>
        encodeURIComponent(route.params[key as keyof typeof route.params]),
      );
      void desktop
        .notify({
          title: instance.name,
          body: input
            ? "Chat needs your input"
            : instance.status === "error"
              ? "Chat stopped with an error"
              : "Chat finished responding",
          path,
        })
        .catch(() => {});
    }
    previous.current = new Map(instances.map((instance) => [instance.id, instance]));
  }, [desktop, instances, isConnected, isSyncing, connectionId, preferences]);
}
