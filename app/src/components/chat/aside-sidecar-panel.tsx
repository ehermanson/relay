import { Suspense, lazy } from "react";
import { Check, ChevronDown, MessageCircleQuestion, Plus, Trash2 } from "lucide-react";
import type { InstanceInfo } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Menu } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { formatTimeAgo } from "@/lib/utils";

const CompactInstanceView = lazy(() =>
  import("./instance-view").then((mod) => ({ default: mod.InstanceView })),
);

function AsideLabel({ aside }: { aside: InstanceInfo }) {
  const age = formatTimeAgo(aside.createdAt);
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs">
      <span className="truncate text-text">{aside.lastMessage ? aside.name : "New aside"}</span>
      {aside.status === "processing" ? <Spinner size={10} /> : null}
      {age ? <span className="shrink-0 text-muted">{age}</span> : null}
    </span>
  );
}

/** What an aside is, shown until its first message. */
function AsideIntro({ sourceName }: { sourceName: string }) {
  return (
    <div className="flex items-start gap-2.5 px-3.5 py-3 text-[0.8125rem] leading-relaxed text-muted">
      <MessageCircleQuestion size={16} className="mt-0.5 shrink-0" />
      <p className="min-w-0">
        <span className="font-medium text-text">Aside. </span>
        It sees everything in “{sourceName}”, but nothing you say here is added to that chat. It's
        read-only: it can look at files, never change them.
      </p>
    </div>
  );
}

export function AsideSidecarPanel({
  asides,
  selectedAsideId,
  sourceChat,
  onSelectAside,
  onNewAside,
  isCreatingAside,
  onDiscardAside,
  onAddToChatDraft,
}: {
  /** Newest first. */
  asides: InstanceInfo[];
  selectedAsideId: string | null;
  sourceChat: { id: string; name: string };
  onSelectAside: (asideId: string) => void;
  /** Create a fresh aside and select it. */
  onNewAside: () => void;
  isCreatingAside: boolean;
  onDiscardAside: (asideId: string) => void;
  /** Quote an aside reply into the source chat's composer (never sends). */
  onAddToChatDraft: (text: string) => void;
}) {
  const active = selectedAsideId
    ? (asides.find((aside) => aside.id === selectedAsideId) ?? null)
    : null;

  if (!active) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-4">
        {isCreatingAside ? (
          <Spinner size={16} />
        ) : (
          <>
            <AsideIntro sourceName={sourceChat.name} />
            <Button variant="primary" size="sm" onClick={onNewAside}>
              <Plus size={13} />
              New aside
            </Button>
          </>
        )}
      </div>
    );
  }

  const activeIndex = asides.findIndex((aside) => aside.id === active.id);

  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner size={16} />
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex items-center gap-1 border-b border-border/80 px-3 py-1.5">
          <div className="min-w-0 flex-1">
            {asides.length > 1 ? (
              <Menu.Root>
                <Menu.Trigger className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-surface-hover">
                  <span className="min-w-0 flex-1">
                    <AsideLabel aside={active} />
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-[0.6875rem] tabular-nums text-muted">
                    {activeIndex + 1}/{asides.length}
                    <ChevronDown size={12} strokeWidth={2} />
                  </span>
                </Menu.Trigger>
                <Menu.Content side="bottom" align="start" className="min-w-[18rem]">
                  {asides.map((aside) => (
                    <Menu.Item key={aside.id} onClick={() => onSelectAside(aside.id)}>
                      <span className="min-w-0 flex-1">
                        <AsideLabel aside={aside} />
                      </span>
                      {aside.id === active.id ? (
                        <Check size={14} strokeWidth={2.5} className="shrink-0" />
                      ) : null}
                    </Menu.Item>
                  ))}
                </Menu.Content>
              </Menu.Root>
            ) : (
              <div className="px-1 py-1">
                <AsideLabel aside={active} />
              </div>
            )}
          </div>
          <Tooltip content="Discard this aside">
            <Button
              variant="icon"
              size="icon-sm"
              className="max-[768px]:h-10 max-[768px]:w-10"
              onClick={() => onDiscardAside(active.id)}
              aria-label="Discard this aside"
            >
              <Trash2 size={13} />
            </Button>
          </Tooltip>
          <Tooltip content="New aside">
            <Button
              variant="icon"
              size="icon-sm"
              className="max-[768px]:h-10 max-[768px]:w-10"
              onClick={onNewAside}
              disabled={isCreatingAside}
              aria-label="New aside"
            >
              <Plus size={14} />
            </Button>
          </Tooltip>
        </div>
        <CompactInstanceView
          key={active.id}
          instanceId={active.id}
          compact
          embeddedSourceChat={{
            id: sourceChat.id,
            name: sourceChat.name,
            sendBackLabel: `Add to “${sourceChat.name}” draft`,
            sendBackToast: "Added to the chat's draft",
            onSendBack: onAddToChatDraft,
            emptyState: <AsideIntro sourceName={sourceChat.name} />,
          }}
        />
      </div>
    </Suspense>
  );
}
