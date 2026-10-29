import { useEffect } from "react";
import { useWSMethods, useWSState } from "@/context/websocket-context";
import { scopeKey as terminalScopeKey, useTerminalStore } from "@/stores/terminal-store";
import type { ServerMessage, TerminalScope } from "@shared/types";

/**
 * Subscribes to terminal lifecycle messages at the view level so the store
 * stays in sync even when the terminal panel itself isn't mounted. Without
 * this, a `terminal_create` fired from the header toggle would never hear
 * its `terminal_created` response, and the panel would never open.
 *
 * Also requests the initial `terminal_list` for the current scope so
 * pre-existing terminals populate the store on navigation, which lets
 * `isPanelOpen(scope)` correctly report visibility without needing the
 * panel itself to mount first.
 *
 * TerminalPanel still subscribes for its own purposes (tracking list
 * responses via its local `listReceived` state) — having both subscribers
 * is safe because the store actions are idempotent.
 */
export function useTerminalMessages(scope: TerminalScope | null) {
  const { addMessageHandler, send } = useWSMethods();
  const { connectionId } = useWSState();
  const addTerminal = useTerminalStore((s) => s.addTerminal);
  const removeTerminal = useTerminalStore((s) => s.removeTerminal);
  const updateTerminal = useTerminalStore((s) => s.updateTerminal);
  const setTerminalsForScope = useTerminalStore((s) => s.setTerminalsForScope);

  useEffect(() => {
    return addMessageHandler((message: ServerMessage) => {
      if (message.type === "terminal_created") {
        addTerminal(message.terminal);
      } else if (message.type === "terminal_removed") {
        removeTerminal(message.terminalId);
      } else if (message.type === "terminal_list_response") {
        setTerminalsForScope(message.scope, message.terminals);
      } else if (message.type === "terminal_exit") {
        updateTerminal(message.terminalId, { exited: true, exitCode: message.code });
      }
    });
  }, [addMessageHandler, addTerminal, removeTerminal, setTerminalsForScope, updateTerminal]);

  // Fetch the initial terminal list for this scope so the store is populated
  // before the user interacts with the terminal toggle. Also refires after
  // every WS reconnect (connectionId change) so the store reflects any
  // terminal lifecycle that happened while the socket was disconnected (e.g.
  // dev-server restart, mobile tab suspend).
  //
  // Key on a primitive scope identifier rather than the object itself so that
  // unmemoized callers (e.g. `{ type: "instance", instanceId }` recreated each render)
  // don't trip an infinite re-fetch loop. The list response updates the
  // terminal store, which triggers re-renders, which would otherwise produce a
  // fresh scope reference and re-fire the effect indefinitely.
  const scopeKey = scope ? terminalScopeKey(scope) : null;
  useEffect(() => {
    if (!scope) return;
    // Yield one task after each WS connect so enclosing instance subscriptions
    // are restored before the scope-scoped terminal list request is sent.
    const listTimer = setTimeout(() => {
      send({ type: "terminal_list", scope });
    }, 0);
    return () => clearTimeout(listTimer);
    // scope is intentionally excluded — we key on the primitive scopeKey above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, send, connectionId]);
}
