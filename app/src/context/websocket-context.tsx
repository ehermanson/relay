import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";
import { useWebSocket, type MessageHandler } from "../hooks/use-web-socket";
import type { InstanceInfo, ClientMessage } from "@shared/types";

// Stable methods that never change — components consuming only this won't re-render
interface WSMethodsContextValue {
  /** Returns true if the message was actually written to the socket. */
  send: (message: ClientMessage) => boolean;
  subscribe: (instanceId: string, lastSeenSequence?: number, replayEpoch?: number) => void;
  unsubscribe: (instanceId: string) => void;
  addMessageHandler: (handler: MessageHandler) => () => void;
  reconnectNow: () => void;
  /**
   * If the user explicitly sent a (non-internal) message to this instance and
   * we haven't yet observed a turn end, returns true and clears the flag.
   * Used by the turn-end toast hook so we only notify after user-driven turns,
   * not for incidental processing→idle transitions.
   */
  consumeUserAwaitingReply: (instanceId: string) => boolean;
  /** Clear the awaiting-reply flag without consuming it as a turn end. */
  clearUserAwaitingReply: (instanceId: string) => void;
  markUserAwaitingReply: (instanceId: string) => void;
}

// State that changes over time
interface WSStateContextValue {
  isConnected: boolean;
  isSyncing: boolean;
  connectionId: number;
  instances: InstanceInfo[];
}

const WSMethodsContext = createContext<WSMethodsContextValue | null>(null);
const WSStateContext = createContext<WSStateContextValue | null>(null);

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const {
    isConnected,
    isSyncing,
    connectionId,
    instances,
    send: rawSend,
    subscribe,
    unsubscribe,
    addMessageHandler,
    reconnectNow,
  } = useWebSocket();

  // Tracks instances where the user has sent an explicit (non-internal) message
  // and we are awaiting the turn end. Consumed by the turn-end toast hook.
  const awaitingReplyRef = useRef<Set<string>>(new Set());

  const send = useCallback(
    (message: ClientMessage): boolean => {
      // Cancellation supersedes any pending awaiting-reply state — the user
      // explicitly stopped the turn, so a future idle transition should not
      // surface a "Ready" toast tied to the previous send.
      if (message.type === "instance_cancel") {
        awaitingReplyRef.current.delete(message.instanceId);
      }
      const sent = rawSend(message);
      // Only arm the flag if the message actually went out. If the socket is
      // closed, rawSend is a no-op; arming would let an unrelated future idle
      // transition fire a bogus toast.
      if (sent && message.type === "instance_message" && !message.internal) {
        awaitingReplyRef.current.add(message.instanceId);
      }
      return sent;
    },
    [rawSend],
  );

  const consumeUserAwaitingReply = useCallback((instanceId: string) => {
    return awaitingReplyRef.current.delete(instanceId);
  }, []);

  const clearUserAwaitingReply = useCallback((instanceId: string) => {
    awaitingReplyRef.current.delete(instanceId);
  }, []);

  const markUserAwaitingReply = useCallback((instanceId: string) => {
    awaitingReplyRef.current.add(instanceId);
  }, []);

  const methods = useMemo(
    () => ({
      send,
      subscribe,
      unsubscribe,
      addMessageHandler,
      reconnectNow,
      consumeUserAwaitingReply,
      clearUserAwaitingReply,
      markUserAwaitingReply,
    }),
    [
      send,
      subscribe,
      unsubscribe,
      addMessageHandler,
      reconnectNow,
      consumeUserAwaitingReply,
      clearUserAwaitingReply,
      markUserAwaitingReply,
    ],
  );
  const state = useMemo(
    () => ({ isConnected, isSyncing, connectionId, instances }),
    [isConnected, isSyncing, connectionId, instances],
  );

  return (
    <WSMethodsContext.Provider value={methods}>
      <WSStateContext.Provider value={state}>{children}</WSStateContext.Provider>
    </WSMethodsContext.Provider>
  );
}

/** Stable methods only — never triggers re-renders */
export function useWSMethods() {
  const ctx = useContext(WSMethodsContext);
  if (!ctx) throw new Error("useWSMethods must be used within WebSocketProvider");
  return ctx;
}

/** Connection + instance state — re-renders when instances or connection changes */
export function useWSState() {
  const ctx = useContext(WSStateContext);
  if (!ctx) throw new Error("useWSState must be used within WebSocketProvider");
  return ctx;
}
