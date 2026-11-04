import { useCallback, useMemo, useState } from "react";
import { LayoutDashboard } from "lucide-react";
import type { UiView, UiViewResponse } from "@shared/ui-render";
import { UiAnswerContext } from "@/components/chat/ui-render/ui-answer-context";
import { resolveUiResponse } from "@shared/ui-render";
import { answerUiView } from "@/lib/api";
import { UiNodeView } from "@/components/chat/ui-render/ui-nodes";

/**
 * A view an agent showed with `ui_render`, rendered with Relay's own
 * components. A button or choice sends the reply the view defines as the
 * user's next message; the server records the answer and broadcasts the
 * updated view, so every device shows it. Without an `instanceId` (the
 * sandbox) answers are kept locally.
 */
export function UiRenderCard({ instanceId, view }: { instanceId?: string; view: UiView }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localResponse, setLocalResponse] = useState<{ at: number; response: UiViewResponse }>();
  // A local answer only applies to the view state it was given for.
  const response =
    view.response ?? (localResponse?.at === view.updatedAt ? localResponse.response : undefined);

  const answer = useCallback(
    (actionId: string, values?: string[]) => {
      if (pending || response) return;
      setError(null);
      if (!instanceId) {
        const resolved = resolveUiResponse(view, actionId, values);
        if (resolved.ok) {
          setLocalResponse({
            at: view.updatedAt,
            response: { actionId, reply: resolved.reply, at: Date.now(), values: resolved.values },
          });
        } else setError(resolved.message);
        return;
      }
      setPending(actionId);
      answerUiView(instanceId, view.id, actionId, values)
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "Couldn't send"))
        .finally(() => setPending(null));
    },
    [instanceId, pending, response, view],
  );

  const state = useMemo(
    () => ({ response, pending, error, answer }),
    [response, pending, error, answer],
  );

  return (
    <div className="my-1 overflow-hidden rounded-lg border border-border bg-surface-raised shadow-(--shadow-surface)">
      <div className="flex min-w-0 items-center gap-1.5 border-b border-border/70 px-3 py-1.5 text-[0.6875rem] text-muted">
        <LayoutDashboard size={12} className="shrink-0" />
        <span className="min-w-0 truncate font-medium text-text">{view.title}</span>
      </div>
      <div className="p-3 text-[0.8125rem]">
        <UiAnswerContext.Provider value={state}>
          <UiNodeView node={view.root} />
        </UiAnswerContext.Provider>
        {error && <p className="mt-2 text-[0.75rem] text-error">{error}</p>}
      </div>
    </div>
  );
}
