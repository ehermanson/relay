/**
 * useTerminal — manages WebSocket lifecycle for a single terminal session.
 *
 * Subscribes to terminal output/exit events, provides write/resize helpers,
 * and accumulates a scrollback buffer ref that xterm.js can consume.
 */

import { useCallback, useEffect, useRef } from "react";
import { useWSMethods, useWSState } from "@/context/websocket-context";
import { useTerminalStore } from "@/stores/terminal-store";
import type { ServerMessage, TerminalScope } from "@shared/types";

interface UseTerminalOptions {
  terminalId: string | null;
  scope: TerminalScope;
  /** Called when new output data arrives (for xterm.write). */
  onData?: (data: string) => void;
  /** Called when scrollback snapshot arrives (for reconnect replay). */
  onScrollback?: (data: string) => void;
  /** Called when the terminal process exits. */
  onExit?: (code: number, signal?: string) => void;
}

export function useTerminal({
  terminalId,
  scope,
  onData,
  onScrollback,
  onExit,
}: UseTerminalOptions) {
  const { send, addMessageHandler } = useWSMethods();
  // `connectionId` increments on every new WS connection. Re-subscribing on
  // change keeps the server-side `terminalSubscriptions` in sync after a
  // reconnect — otherwise the ws would stop receiving `terminal_output` for
  // this terminal even though xterm.js is still mounted and forwarding input.
  const { connectionId } = useWSState();
  const { updateTerminal } = useTerminalStore();
  const onDataRef = useRef(onData);
  const onScrollbackRef = useRef(onScrollback);
  const onExitRef = useRef(onExit);

  // Keep refs current without triggering re-subscriptions
  onDataRef.current = onData;
  onScrollbackRef.current = onScrollback;
  onExitRef.current = onExit;

  // Subscribe to terminal events
  useEffect(() => {
    if (!terminalId) return;

    // Yield one task after each WS connect so the enclosing chat view can
    // re-establish its instance subscription first. The socket preserves send
    // order, so this avoids the reconnect race without widening terminal auth.
    const subscribeTimer = setTimeout(() => {
      send({ type: "terminal_subscribe", terminalId });
    }, 0);

    const cleanup = addMessageHandler((message: ServerMessage) => {
      if (message.type === "terminal_output" && message.terminalId === terminalId) {
        onDataRef.current?.(message.data);
      } else if (message.type === "terminal_scrollback" && message.terminalId === terminalId) {
        onScrollbackRef.current?.(message.data);
      } else if (message.type === "terminal_exit" && message.terminalId === terminalId) {
        updateTerminal(terminalId, { exited: true, exitCode: message.code });
        onExitRef.current?.(message.code, message.signal);
      }
    });

    return () => {
      clearTimeout(subscribeTimer);
      cleanup();
      send({ type: "terminal_unsubscribe", terminalId });
    };
  }, [terminalId, send, addMessageHandler, updateTerminal, connectionId]);

  const write = useCallback(
    (data: string) => {
      if (!terminalId) return;
      send({ type: "terminal_input", terminalId, data });
    },
    [terminalId, send],
  );

  const resize = useCallback(
    (cols: number, rows: number) => {
      if (!terminalId) return;
      send({ type: "terminal_resize", terminalId, cols, rows });
    },
    [terminalId, send],
  );

  const close = useCallback(() => {
    if (!terminalId) return;
    send({ type: "terminal_close", terminalId });
  }, [terminalId, send]);

  const create = useCallback(
    (opts?: { cwd?: string; cols?: number; rows?: number }) => {
      send({
        type: "terminal_create",
        scope,
        ...opts,
      });
    },
    [scope, send],
  );

  return { write, resize, close, create };
}
