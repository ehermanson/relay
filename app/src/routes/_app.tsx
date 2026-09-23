import { createFileRoute, useParams, useRouter } from "@tanstack/react-router";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { WebSocketProvider } from "../context/websocket-context";
import { OutboxProvider } from "../context/outbox-context";
import { AppLayout } from "../components/layout/app-layout";
import { ProcessLimitDialog } from "../components/process-limit-dialog";
import { ActionToastProvider } from "@/context/action-toast-context";
import { useTerminalPendingToasts } from "../hooks/use-terminal-pending-toasts";
import { useTerminalScopes } from "../hooks/use-terminal-scopes";
import { useTurnEndToasts } from "../hooks/use-turn-end-toasts";
import { usePushPresence } from "../hooks/use-push-presence";

function AppLayoutWithToasts() {
  const { chatId } = useParams({ strict: false }) as { chatId?: string };
  useTerminalPendingToasts(chatId);
  useTerminalScopes();
  useTurnEndToasts(chatId);
  usePushPresence(chatId);
  return <AppLayout />;
}

function AppError({ error }: { error: Error }) {
  const router = useRouter();

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-surface p-8 text-center">
      <AlertTriangle size={28} className="text-warning" />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-text">Something went wrong</p>
        <p className="max-w-md text-xs text-muted">{error.message}</p>
      </div>
      <button
        type="button"
        onClick={() => router.invalidate()}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90"
      >
        <RotateCcw size={12} />
        Try again
      </button>
    </div>
  );
}

export const Route = createFileRoute("/_app")({
  errorComponent: AppError,
  component: () => (
    <WebSocketProvider>
      <OutboxProvider>
        <ActionToastProvider>
          <AppLayoutWithToasts />
          <ProcessLimitDialog />
        </ActionToastProvider>
      </OutboxProvider>
    </WebSocketProvider>
  ),
});
