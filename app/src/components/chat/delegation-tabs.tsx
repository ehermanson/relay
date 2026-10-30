import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, CornerDownRight, X } from "lucide-react";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { dotClassToTextColor } from "@/components/ui/session-indicator";
import { splitDelegationTabs, type DelegationTab } from "@/lib/delegation";
import { getAttentionLabel } from "@/lib/inbox";
import { deriveInstanceStatusPresentation } from "@/lib/utils";

/**
 * Tab strip for a delegation family: the root chat followed by the chats it
 * delegated work to (depth-first). Presentational — the caller builds `tabs`
 * with `buildDelegationFamily` and decides what selecting one does. Children
 * whose task completed or was cancelled fold into a trailing "done" chip
 * (`splitDelegationTabs`); the expansion is in-memory, per family. Renders
 * nothing for an empty family.
 */
export function DelegationTabs({
  tabs,
  activeId,
  onSelect,
}: {
  tabs: DelegationTab[];
  activeId: string | null;
  onSelect: (instanceId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  // Keyed by the family's root, so another family starts collapsed.
  const rootId = tabs[0]?.instance.id ?? null;
  const [expansion, setExpansion] = useState<{ rootId: string | null; expanded: boolean }>({
    rootId,
    expanded: false,
  });
  const expanded = expansion.rootId === rootId && expansion.expanded;
  const { visible, folded } = splitDelegationTabs(tabs, activeId, expanded);
  const toggleExpanded = useCallback(
    () => setExpansion({ rootId, expanded: !expanded }),
    [rootId, expanded],
  );

  const updateOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setOverflow((prev) => {
      const next = { left: scrollLeft > 2, right: scrollLeft + clientWidth < scrollWidth - 2 };
      return prev.left === next.left && prev.right === next.right ? prev : next;
    });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateOverflow();
    el.addEventListener("scroll", updateOverflow, { passive: true });
    const ro = new ResizeObserver(updateOverflow);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    // A vertical wheel scrolls the strip sideways when it overflows.
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("scroll", updateOverflow);
      el.removeEventListener("wheel", onWheel);
      ro.disconnect();
    };
  }, [updateOverflow, visible.length, folded.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeId) return;
    el.querySelector<HTMLElement>(`[data-chat-tab-id="${CSS.escape(activeId)}"]`)?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeId, visible.length]);

  if (tabs.length === 0) return null;

  return (
    <div className="flex shrink-0 items-stretch border-b border-border/70">
      <div className="relative flex min-w-0 flex-1 items-stretch">
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-gradient-to-r from-bg via-bg/60 to-transparent transition-opacity duration-150 ${overflow.left ? "opacity-100" : "opacity-0"}`}
        />
        <div
          ref={scrollRef}
          role="tablist"
          aria-label="Delegated chats"
          className="scrollbar-none flex min-w-0 flex-1 items-stretch overflow-x-auto px-2 max-[768px]:px-1"
        >
          {visible.map((tab, index) => (
            <DelegationTabButton
              key={tab.instance.id}
              tab={tab}
              isActive={tab.instance.id === activeId}
              onSelect={onSelect}
              showDivider={index === 0}
            />
          ))}
        </div>
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-bg via-bg/60 to-transparent transition-opacity duration-150 ${overflow.right ? "opacity-100" : "opacity-0"}`}
        />
      </div>
      {/* Outside the scroller, so it stays in reach however long the strip is. */}
      {folded.length > 0 && (
        <DoneChip count={folded.length} expanded={expanded} onToggle={toggleExpanded} />
      )}
    </div>
  );
}

/** Trailing chip that folds/unfolds the finished children. */
function DoneChip({
  count,
  expanded,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const label = `${count} done`;
  return (
    <div className="flex shrink-0 items-center pl-1 pr-2 max-[768px]:min-h-10 max-[768px]:pr-1">
      <button
        type="button"
        aria-expanded={expanded}
        title={
          expanded
            ? "Hide finished chats"
            : `Show ${count} finished ${count === 1 ? "chat" : "chats"}`
        }
        onClick={onToggle}
        className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium transition-colors max-[768px]:min-h-9 max-[768px]:px-3 ${
          expanded
            ? "border-border-hover bg-surface-hover text-text"
            : "border-border/80 text-muted hover:border-border-hover hover:bg-surface-hover hover:text-text"
        }`}
      >
        <Check size={11} strokeWidth={2.5} aria-hidden className="shrink-0 text-success" />
        <span>{label}</span>
        <ChevronRight
          size={11}
          strokeWidth={2}
          aria-hidden
          className={`-mr-0.5 shrink-0 transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
        />
      </button>
    </div>
  );
}

function DelegationTabButton({
  tab,
  isActive,
  onSelect,
  showDivider,
}: {
  tab: DelegationTab;
  isActive: boolean;
  onSelect: (instanceId: string) => void;
  showDivider: boolean;
}) {
  const { instance, depth } = tab;
  const isRoot = depth === 0;
  const status = deriveInstanceStatusPresentation(instance);
  const needsInput = !!(instance.pendingPermission || instance.pendingTool || instance.pendingPlan);
  // The task's state (not the chat's process state) decides how a child reads.
  const taskStatus = isRoot || needsInput ? undefined : instance.delegation?.taskStatus;
  const isFailed = taskStatus === "failed";
  const isCompleted = taskStatus === "completed";
  const isCancelled = taskStatus === "cancelled";
  const isEnded = isFailed || isCompleted || isCancelled;
  const statusLabel = needsInput
    ? getAttentionLabel(instance)
    : isFailed
      ? "Failed"
      : isCompleted
        ? "Complete"
        : isCancelled
          ? "Cancelled"
          : status.label;
  const dotClass = needsInput ? "animate-pulse-dot bg-warning" : status.dotClass;
  // An ended task's chat may still have a live process; the badge says the task.
  const showDot = needsInput || (!isEnded && instance.status !== "stopped");

  return (
    <>
      <button
        type="button"
        role="tab"
        aria-selected={isActive}
        data-chat-tab-id={instance.id}
        title={`${instance.name} — ${isRoot ? "Parent chat · " : ""}${statusLabel}`}
        onClick={() => onSelect(instance.id)}
        className={`group/tab relative flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-[0.75rem] transition-colors max-[768px]:min-h-10 max-[768px]:px-2.5 ${
          isActive
            ? "text-text-bright shadow-[inset_0_-2px_0_0_var(--color-accent)]"
            : isCancelled
              ? "text-muted/70 hover:bg-surface-hover hover:text-text"
              : "text-muted hover:bg-surface-hover hover:text-text"
        }`}
      >
        {depth > 1 && (
          <CornerDownRight
            size={11}
            strokeWidth={2}
            aria-hidden
            className="-mr-0.5 shrink-0 text-muted/60"
            style={depth > 2 ? { marginLeft: (depth - 2) * 6 } : undefined}
          />
        )}
        <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <ProviderLogo
            provider={instance.provider}
            className={`h-3.5 w-3.5 transition-opacity ${
              isCancelled
                ? "opacity-50 group-hover/tab:opacity-80"
                : isActive
                  ? ""
                  : "opacity-80 group-hover/tab:opacity-100"
            }`}
          />
          {showDot && (
            <span
              aria-hidden
              className={`absolute -bottom-0.5 -right-0.5 h-[7px] w-[7px] rounded-full ring-2 ring-bg ${dotClass}`}
            />
          )}
          {(isFailed || isCompleted) && (
            <span
              aria-hidden
              className={`absolute -bottom-1 -right-1 flex h-[11px] w-[11px] items-center justify-center rounded-full ring-2 ring-bg ${
                isFailed ? "bg-error" : "bg-success"
              }`}
            >
              {isFailed ? (
                <X size={8} strokeWidth={3.5} className="text-bg" />
              ) : (
                <Check size={8} strokeWidth={3.5} className="text-bg" />
              )}
            </span>
          )}
        </span>
        <span
          className={`min-w-0 truncate ${isActive ? "max-w-[13rem]" : "max-w-[11rem]"} max-[768px]:max-w-[11rem] ${isRoot ? "font-semibold" : "font-medium"}`}
        >
          {instance.name}
        </span>
        {needsInput && (
          <span className={`shrink-0 text-[0.625rem] font-medium ${dotClassToTextColor(dotClass)}`}>
            Needs input
          </span>
        )}
        {isFailed && (
          <span className="shrink-0 text-[0.625rem] font-medium text-error">Failed</span>
        )}
        {isCompleted && (
          <span className="shrink-0 rounded-sm bg-success/12 px-1 py-px text-[0.625rem] font-medium text-success">
            Complete
          </span>
        )}
        {isCancelled && (
          <span className="shrink-0 rounded-sm bg-muted/10 px-1 py-px text-[0.625rem] font-medium text-muted">
            Cancelled
          </span>
        )}
        <span className="sr-only">
          {isRoot ? ", parent chat" : ""}, {statusLabel}
        </span>
      </button>
      {showDivider && (
        <span aria-hidden className="mx-1 my-2 w-px shrink-0 self-stretch bg-border/80" />
      )}
    </>
  );
}
