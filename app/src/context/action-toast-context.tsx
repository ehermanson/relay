import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import type { InstanceInfo, ServerMessage } from "@shared/types";
import { useWSMethods, useWSState } from "../context/websocket-context";
import { useProcessLimitStore } from "@/stores/process-limit-store";

// HTTP mutations can toast directly at the call site because they resolve or
// reject locally. These websocket mutations are fire-and-forget: the caller
// only knows it sent a message, while the real success/error arrives later via
// instance_created / instance_removed / notification / error events. This
// provider lets call sites register "we started a create/remove/merge" so the
// matching websocket confirmation can drive navigation and toast state.
interface ActionToastContextValue {
  trackInstanceCreate: (workingDirectory: string) => void;
  trackInstanceRemove: (instance: Pick<InstanceInfo, "id" | "name">) => void;
  trackInstanceMerge: (instance: Pick<InstanceInfo, "id" | "name">) => void;
}

const ActionToastContext = createContext<ActionToastContextValue | null>(null);

export function ActionToastProvider({ children }: { children: ReactNode }) {
  const { instances } = useWSState();
  const { addMessageHandler, send } = useWSMethods();
  const pendingCreatesRef = useRef(new Map<string, number>());
  const pendingRemovalsRef = useRef(new Map<string, string>());
  const pendingMergesRef = useRef(new Map<string, string>());
  const prevInstanceIdsRef = useRef(new Set<string>());

  const trackInstanceCreate = useCallback((workingDirectory: string) => {
    pendingCreatesRef.current.set(
      workingDirectory,
      (pendingCreatesRef.current.get(workingDirectory) ?? 0) + 1,
    );
  }, []);

  useEffect(() => {
    const currentIds = new Set(instances.map((instance) => instance.id));

    for (const instance of instances) {
      if (prevInstanceIdsRef.current.has(instance.id) || instance.external) continue;

      const pendingCount = pendingCreatesRef.current.get(instance.workingDirectory) ?? 0;
      if (pendingCount <= 0) continue;

      if (pendingCount === 1) pendingCreatesRef.current.delete(instance.workingDirectory);
      else pendingCreatesRef.current.set(instance.workingDirectory, pendingCount - 1);
    }

    for (const [instanceId, name] of pendingRemovalsRef.current) {
      if (!prevInstanceIdsRef.current.has(instanceId) || currentIds.has(instanceId)) continue;
      pendingRemovalsRef.current.delete(instanceId);
      toast.success(`Deleted "${name}"`);
    }

    prevInstanceIdsRef.current = currentIds;
  }, [instances]);

  useEffect(
    () =>
      addMessageHandler((message: ServerMessage) => {
        if (message.type === "notification") {
          if (message.instanceId) pendingMergesRef.current.delete(message.instanceId);
          toast.success(message.message);
          return;
        }

        if (message.type !== "error") return;

        // Concurrent-session cap hit on the WS create path: open the capacity
        // dialog (and auto-retry this exact create once a slot frees) instead of
        // a dead-end toast. The original create's pending state stays armed, so
        // navigation to the new chat still fires once the retry succeeds.
        if (message.code === "max_processes") {
          pendingCreatesRef.current.clear();
          const createRequest = message.createRequest;
          useProcessLimitStore.getState().openDialog({
            limit: message.limit ?? 0,
            retry: createRequest
              ? () => {
                  if (createRequest.workingDirectory) {
                    trackInstanceCreate(createRequest.workingDirectory);
                  }
                  send({ type: "create_instance", ...createRequest });
                }
              : undefined,
          });
          return;
        }

        // The active account has no login for the requested provider: nothing
        // to retry, so say why (the server's message names the provider).
        if (message.code === "provider_unavailable_in_account") {
          pendingCreatesRef.current.clear();
          toast.error(message.message);
          return;
        }

        if (message.instanceId && pendingMergesRef.current.has(message.instanceId)) {
          pendingMergesRef.current.delete(message.instanceId);
          toast.error(message.message);
          return;
        }

        if (message.instanceId && pendingRemovalsRef.current.has(message.instanceId)) {
          pendingRemovalsRef.current.delete(message.instanceId);
          toast.error(message.message);
          return;
        }

        if (!message.instanceId && pendingCreatesRef.current.size > 0) {
          pendingCreatesRef.current.clear();
          toast.error(message.message);
          return;
        }

        if (!message.instanceId && pendingRemovalsRef.current.size > 0) {
          pendingRemovalsRef.current.clear();
          toast.error(message.message);
        }
      }),
    [addMessageHandler, send, trackInstanceCreate],
  );

  return (
    <ActionToastContext.Provider
      value={{
        trackInstanceCreate,
        trackInstanceRemove: (instance: Pick<InstanceInfo, "id" | "name">) => {
          pendingRemovalsRef.current.set(instance.id, instance.name);
        },
        trackInstanceMerge: (instance: Pick<InstanceInfo, "id" | "name">) => {
          pendingMergesRef.current.set(instance.id, instance.name);
        },
      }}
    >
      {children}
    </ActionToastContext.Provider>
  );
}

export function useActionToasts() {
  const ctx = useContext(ActionToastContext);
  if (!ctx) throw new Error("useActionToasts must be used within ActionToastProvider");
  return ctx;
}
