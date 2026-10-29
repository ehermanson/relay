import { useEffect } from "react";
import { useWSMethods } from "@/context/websocket-context";
import { useTerminalStore } from "@/stores/terminal-store";
import type { ServerMessage } from "@shared/types";

/**
 * App-level subscriber for the global `terminal_scopes` broadcast. Keeps the
 * terminal store's per-scope live-terminal counts in sync regardless of which
 * view is mounted, so sidebar indicators can flag chats with running
 * terminals without opening each scope first.
 *
 * Mount once near the app root.
 */
export function useTerminalScopes(): void {
  const { addMessageHandler } = useWSMethods();
  const setActiveScopes = useTerminalStore((s) => s.setActiveScopes);

  useEffect(() => {
    return addMessageHandler((message: ServerMessage) => {
      if (message.type === "terminal_scopes") {
        setActiveScopes(message.scopes);
      }
    });
  }, [addMessageHandler, setActiveScopes]);
}
