import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { AgentCard } from "@/components/chat/agent-card";
import { AgentCardsProvider } from "@/components/chat/agent-card-context";
import { AgentNote } from "@/components/chat/agent-note";
import { ChatTimeline } from "@/components/chat/chat-timeline";
import { ChatTOC } from "@/components/chat/chat-toc";
import { AgentMessage } from "@/components/chat/agent-message";
import { CompactBoundary } from "@/components/chat/compact-boundary";
import { ModelSwitchDivider } from "@/components/chat/model-switch-divider";
import { LiveStatusStrip } from "@/components/chat/live-status-strip";
import { ResponseDivider } from "@/components/chat/response-divider";
import { SystemMessage } from "@/components/chat/system-message";
import { ThinkingBlock } from "@/components/chat/thinking-block";
import { ToolContainer } from "@/components/chat/tool-container";
import { UserMessage } from "@/components/chat/user-message";
import { buildRows, estimateRowHeight } from "@/components/chat/build-rows";
import { useAutoScroll } from "@/hooks/use-auto-scroll";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { ChatItem, LiveActivity, RenderRow, UserRow } from "@/lib/chat-types";
import type { AgentInfo, ProviderKind, ProviderRequest, UserInputAnswer } from "@shared/types";
import { buildAgentAnchorIndex, findRequestAgentId } from "@/lib/agents";
import { computeBubbleShrinkwrap, onFontReady } from "@/lib/pretext";

const EMPTY_AGENTS: Record<string, AgentInfo> = {};
const EMPTY_AGENT_ITEMS: Record<string, ChatItem[]> = {};

// Always keep the last N rows non-virtualized so the bottom of the chat
// is real DOM with accurate measurements — reduces virtualizer churn
// near the scroll edge and makes stick-to-bottom more reliable.
const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;

// ── Component ────────────────────────────────────────────────────────

interface MessageListProps {
  items: ChatItem[];
  /** Stable per-chat id used to persist and restore scroll position on reopen. */
  persistKey?: string;
  searchFocus?: {
    query: string;
    snippet?: string;
  } | null;
  isProcessing?: boolean;
  showThinkingIndicator?: boolean;
  instanceStatus?: string;
  lastActivity?: LiveActivity | null;
  processingStartedAt?: number | null;
  onSendMessage?: (text: string) => void;
  onAnswerUserInput?: (
    requestId: string,
    answers: Record<string, UserInputAnswer>,
    text?: string,
  ) => void;
  isInteractive?: boolean;
  onApproveTool?: (tool: string) => void;
  approvedTools?: Set<string>;
  isExternal?: boolean;
  pendingInteraction?: boolean;
  planChildId?: string;
  planChildName?: string;
  onInterruptAndSend?: () => void;
  /** Pull a queued message back into the composer for editing. */
  onEditQueued?: (row: UserRow) => void;
  /** Remove a queued message without sending it. */
  onRemoveQueued?: (queuedId: string) => void;
  /** Delegated agents (Relay key → info) for in-chat cards. */
  agents?: Record<string, AgentInfo>;
  /** Nested transcripts keyed by Relay agent key. */
  agentItems?: Record<string, ChatItem[]>;
  /** Chat id, for on-demand agent history fetches. */
  instanceId?: string;
  /** Provider, for model label formatting on cards. */
  provider?: ProviderKind;
  /** Pending permission request — badges the owning agent's card when tagged. */
  pendingRequest?: ProviderRequest | null;
}

export function MessageList({
  items,
  persistKey,
  searchFocus,
  isProcessing,
  showThinkingIndicator,
  instanceStatus,
  lastActivity,
  processingStartedAt,
  onSendMessage,
  onAnswerUserInput,
  isInteractive,
  onApproveTool,
  approvedTools,
  isExternal,
  pendingInteraction,
  planChildId,
  planChildName,
  onInterruptAndSend,
  onEditQueued,
  onRemoveQueued,
  agents = EMPTY_AGENTS,
  agentItems = EMPTY_AGENT_ITEMS,
  instanceId,
  provider,
  pendingRequest,
}: MessageListProps) {
  // Delegated-agent cards: anchor index (tool_use id → agent) is recomputed
  // when the stream or agent set changes; the context keeps ToolContainer's
  // prop surface unchanged.
  const anchoredAgents = useMemo(() => buildAgentAnchorIndex(items, agents), [items, agents]);
  const pendingAgentId = useMemo(
    () => findRequestAgentId(pendingRequest, agents),
    [pendingRequest, agents],
  );
  const agentCardsValue = useMemo(
    () => ({ agents, agentItems, anchoredAgents, instanceId, provider, pendingAgentId }),
    [agents, agentItems, anchoredAgents, instanceId, provider, pendingAgentId],
  );
  // When a new turn is sent we "frame" it: park the message near the top and
  // reserve space below (spacerHeight) so the answer can stream into the gap,
  // then hand off to normal following once it fills the viewport.
  const [framedTurnId, setFramedTurnId] = useState<string | null>(null);
  const [spacerHeight, setSpacerHeight] = useState(0);
  const spacerHeightRef = useRef(0);
  // Set once the reader scrolls during a framed turn: we stop pinning/following,
  // but leave the spacer in place (removing it would yank the scroll position).
  // It shrinks on its own as the answer grows into the gap.
  const userTookOverRef = useRef(false);
  const releaseFraming = useCallback(() => {
    userTookOverRef.current = true;
  }, []);
  const {
    ref: scrollRef,
    forceStickToBottom,
    onContentChange,
    showScrollToBottom,
    detachFromBottom,
    beginFramed,
  } = useAutoScroll<HTMLDivElement>({ onUserScroll: releaseFraming });
  const isMobile = useMediaQuery("(max-width: 768px)");
  const [activeSearchRowId, setActiveSearchRowId] = useState<string | null>(null);
  const consumedSearchFocusRef = useRef<string | null>(null);

  // ── Container width tracking (for pretext layout) ────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const containerWidthRef = useRef(720); // default max-w-3xl - px-6
  const [, setFontTick] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    containerWidthRef.current = el.clientWidth;
    const observer = new ResizeObserver(([entry]) => {
      containerWidthRef.current = entry.contentRect.width;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => onFontReady(() => setFontTick((t) => t + 1)), []);

  // ── Build render rows ────────────────────────────────────────────
  // Queued user messages are rendered in a dedicated section at the bottom,
  // not interleaved with the live stream — otherwise they get buried as the
  // agent emits assistant text and tool calls.
  const allRows = useMemo(() => buildRows(items), [items]);
  const { rows, queuedRows } = useMemo(() => {
    const main: RenderRow[] = [];
    const queued: UserRow[] = [];
    for (const r of allRows) {
      if (r.kind === "user" && r.queued) queued.push(r);
      // Inserted cards whose agent isn't in `agents` (the provider doesn't
      // support agent activity, so the view resolved it to empty) render
      // nothing — drop the row so it doesn't leave an empty gap.
      else if (r.kind === "agent-card" && !agents[r.agentId]) continue;
      else main.push(r);
    }
    return { rows: main, queuedRows: queued };
  }, [allRows, agents]);
  const searchTargetIndex = useMemo(() => {
    if (!searchFocus?.query) return -1;
    return findSearchTargetRowIndex(rows, searchFocus);
  }, [rows, searchFocus]);

  // ── Hybrid split ─────────────────────────────────────────────────
  const firstUnvirtualizedRowIndex = useMemo(() => {
    const tailStart = Math.max(rows.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS, 0);
    if (!isProcessing) return tailStart;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].kind === "user") return Math.min(i, tailStart);
    }
    return tailStart;
  }, [rows, isProcessing]);

  const virtualizedRowCount = Math.min(firstUnvirtualizedRowIndex, rows.length);

  // ── Virtualizer ──────────────────────────────────────────────────
  const rowVirtualizer = useVirtualizer({
    count: virtualizedRowCount,
    getScrollElement: () => scrollRef.current,
    getItemKey: (i) => rows[i]?.id ?? i,
    estimateSize: (i) => (rows[i] ? estimateRowHeight(rows[i], containerWidthRef.current) : 96),
    gap: 16,
    overscan: isMobile ? 20 : 8,
  });

  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
      // On mobile, preserving momentum is more important than anchor-perfect
      // compensation while older virtualized rows mount above the viewport.
      if (isMobile) return false;
      // Only adjust scroll when the resized item is fully above the viewport.
      // This keeps the viewport stable when visible items change size
      // (e.g. user expanding/collapsing a tool call) — the content just
      // grows/shrinks in place without shifting the scroll position.
      const scrollOffset = instance.scrollOffset ?? 0;
      return item.start + item.size < scrollOffset;
    };
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [isMobile, rowVirtualizer]);

  // ── Scroll management ────────────────────────────────────────────
  // The last non-queued user turn — the "meaningful" anchor we park near the
  // top of the viewport on open (reopen position) and when a new turn is sent.
  const lastUserRow = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].kind === "user") return { index: i, id: rows[i].id };
    }
    return null;
  }, [rows]);

  const hadItems = useRef(false);
  const lastUserRowIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (items.length === 0) {
      hadItems.current = false;
      lastUserRowIdRef.current = null;
      return;
    }
    if (!hadItems.current) {
      // Reopen position: restore the reader's last scroll offset for this chat
      // if we have one; otherwise go to the bottom (the live edge).
      hadItems.current = true;
      lastUserRowIdRef.current = lastUserRow?.id ?? null;
      const saved = persistKey ? readSavedScroll(persistKey) : null;
      if (saved && !saved.atBottom) {
        detachFromBottom();
        const apply = () => {
          const el = scrollRef.current;
          if (!el) return;
          el.scrollTop = Math.min(saved.scrollTop, el.scrollHeight - el.clientHeight);
        };
        apply();
        requestAnimationFrame(() => requestAnimationFrame(apply));
      } else {
        forceStickToBottom();
      }
      return;
    }
    if (lastUserRow && lastUserRow.id !== lastUserRowIdRef.current) {
      // A new turn was sent — frame it near the top so the answer has room to
      // stream into. (Queued sends aren't in `rows`, so they don't trigger this
      // until they actually start.) The layout effect below positions it and
      // reserves the space; following resumes once the answer fills the screen.
      lastUserRowIdRef.current = lastUserRow.id;
      userTookOverRef.current = false;
      beginFramed();
      setFramedTurnId(lastUserRow.id);
      return;
    }
    onContentChange();
  }, [
    items,
    lastUserRow,
    beginFramed,
    forceStickToBottom,
    onContentChange,
    detachFromBottom,
    persistKey,
    scrollRef,
  ]);

  // While a turn is framed: reserve a spacer below so the message can sit near
  // the top, keep it pinned there as the answer streams into the gap. Once the
  // answer fills the viewport, hand off to normal stick-to-bottom following so
  // the live edge stays visible.
  useLayoutEffect(() => {
    if (!framedTurnId) return;
    const el = scrollRef.current;
    const container = containerRef.current;
    if (!el || !container) return;
    const node = el.querySelector<HTMLElement>(`[data-row-id="${framedTurnId}"]`);
    if (!node) return;

    // Offset of the framed message within the scroll content (scroll-independent).
    const messageTop = node.getBoundingClientRect().top - container.getBoundingClientRect().top;
    // With the iOS keyboard up, WebKit pushes the page (visualViewport.offsetTop)
    // instead of resizing the layout viewport, so the top of the scroll container
    // can sit off-screen above. Frame against the *visible* portion of the
    // container: pin below the hidden strip, size the spacer and handoff to the
    // height the reader can actually see. On desktop (and with the keyboard
    // closed) hiddenTop is 0 and viewport === clientHeight — this is inert.
    const rect = el.getBoundingClientRect();
    const vv = window.visualViewport;
    const visibleTop = vv ? Math.max(rect.top, vv.offsetTop) : rect.top;
    const visibleBottom = vv ? Math.min(rect.bottom, vv.offsetTop + vv.height) : rect.bottom;
    const hiddenTop = visibleTop - rect.top;
    const viewport = Math.max(0, visibleBottom - visibleTop);
    const realContentHeight = el.scrollHeight - spacerHeightRef.current;
    const belowMessage = realContentHeight - messageTop;

    if (belowMessage >= viewport) {
      // The answer has filled the space below the message. Collapse the spacer
      // and, unless the reader has scrolled away, start following the live edge.
      spacerHeightRef.current = 0;
      setSpacerHeight(0);
      setFramedTurnId(null);
      if (!userTookOverRef.current) forceStickToBottom();
      return;
    }

    // Shrink the spacer as the answer grows into the gap. Safe to do even after
    // the reader has taken over: the spacer is below their viewport, so the
    // scroll position doesn't move. Sized from clientHeight − hiddenTop (not the
    // visible height) so the pin position below stays exactly reachable even
    // when the keyboard covers part of the container's bottom.
    const nextSpacer = Math.max(0, el.clientHeight - hiddenTop - belowMessage);
    if (Math.abs(nextSpacer - spacerHeightRef.current) > 1) {
      spacerHeightRef.current = nextSpacer;
      setSpacerHeight(nextSpacer);
      return; // re-run once the spacer lands, then position the message
    }

    // Spacer is stable — pin the message to the top of the *visible* area.
    // Streaming content grows below it, so the position holds without
    // re-scrolling; this only fires to set the initial top and correct any
    // drift. Skip once the reader takes control of the scroll.
    const targetTop = Math.max(0, messageTop - hiddenTop);
    if (!userTookOverRef.current && Math.abs(el.scrollTop - targetTop) > 1) {
      el.scrollTop = targetTop;
    }
  });

  // Persist the reader's scroll offset for this chat so reopening lands where
  // they left off (throttled to once per frame).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !persistKey) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // While framing, scrollTop is spacer-relative and not meaningful to
        // restore later — skip persisting those positions.
        if (spacerHeightRef.current > 0) return;
        const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
        writeSavedScroll(persistKey, {
          scrollTop: el.scrollTop,
          atBottom: remaining <= 64,
        });
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [persistKey, scrollRef]);

  // ── Thinking indicator ───────────────────────────────────────────
  const showThinking =
    !pendingInteraction &&
    (!!showThinkingIndicator || !!isProcessing || instanceStatus === "processing");
  const lastUserMessage = [...items]
    .reverse()
    .find(
      (item): item is Extract<ChatItem, { kind: "user" }> => item.kind === "user" && !item.queued,
    );
  const isCompactingTurn =
    showThinking && !!lastUserMessage && /^\s*\/compact\b/i.test(lastUserMessage.text.trim());

  // ── TOC / timeline scroll-to-row handler ──────────────────────
  const handleScrollToRow = useCallback(
    (rowIndex: number) => {
      // Detach auto-scroll so the ResizeObserver / onContentChange won't
      // immediately yank back to the bottom.  The user re-engages by
      // scrolling near the bottom or clicking "Jump to latest".
      detachFromBottom();

      if (rowIndex < virtualizedRowCount) {
        rowVirtualizer.scrollToIndex(rowIndex, { align: "start", behavior: "smooth" });
      } else {
        const row = rows[rowIndex];
        if (row) {
          const el = scrollRef.current?.querySelector(`[data-row-id="${row.id}"]`);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }
      }
    },
    [detachFromBottom, virtualizedRowCount, rowVirtualizer, rows, scrollRef],
  );

  useEffect(() => {
    if (!searchFocus?.query) {
      consumedSearchFocusRef.current = null;
      setActiveSearchRowId(null);
      return;
    }
    if (searchTargetIndex < 0) return;

    const row = rows[searchTargetIndex];
    if (!row) return;

    const key = `${searchFocus.query}\n${searchFocus.snippet ?? ""}\n${row.id}`;
    if (consumedSearchFocusRef.current === key) return;
    consumedSearchFocusRef.current = key;

    const timer = window.setTimeout(() => {
      handleScrollToRow(searchTargetIndex);
      setActiveSearchRowId(row.id);
    }, 80);

    return () => window.clearTimeout(timer);
  }, [handleScrollToRow, rows, searchFocus, searchTargetIndex]);

  useEffect(() => {
    if (!activeSearchRowId) return;
    const timer = window.setTimeout(() => setActiveSearchRowId(null), 3000);
    return () => window.clearTimeout(timer);
  }, [activeSearchRowId]);

  // ── Row renderer ─────────────────────────────────────────────────
  const renderRow = (row: RenderRow, rowIndex?: number) => {
    switch (row.kind) {
      case "user":
        return (
          <UserMessage
            text={row.text}
            timestamp={row.timestamp}
            shrinkwrapWidth={
              row.renderMode?.kind === "json"
                ? undefined
                : computeBubbleShrinkwrap(row.text, containerWidthRef.current)
            }
            renderMode={row.renderMode}
            queued={row.queued}
            onInterruptAndSend={row.queued ? onInterruptAndSend : undefined}
            onEditQueued={
              row.queued && row.queuedId && onEditQueued ? () => onEditQueued(row) : undefined
            }
            onRemoveQueued={
              row.queued && row.queuedId && onRemoveQueued
                ? () => onRemoveQueued(row.queuedId!)
                : undefined
            }
          />
        );
      case "assistant": {
        // row.id is "assistant-${chatItemIndex}" — extract the original ChatItem
        // index so the server can anchor the spin-off excerpt correctly (the
        // virtualizer rowIndex includes dividers/tool-containers and would be wrong).
        const origIdx = parseInt(row.id.split("-")[1], 10);
        return (
          <AgentMessage
            text={row.text}
            timestamp={row.timestamp}
            anchorIndex={Number.isFinite(origIdx) ? origIdx : rowIndex}
            aborted={row.aborted}
          />
        );
      }
      case "system":
        return <SystemMessage text={row.text} isError={row.isError} />;
      case "compact-boundary":
        return <CompactBoundary timestamp={row.timestamp} />;
      case "model-switch":
        return (
          <ModelSwitchDivider
            fromModel={row.fromModel}
            toModel={row.toModel}
            fromModelLabel={row.fromModelLabel}
            toModelLabel={row.toModelLabel}
            timestamp={row.timestamp}
          />
        );
      case "thinking-block":
        return <ThinkingBlock text={row.text} />;
      case "agent-card": {
        const agent = agents[row.agentId];
        if (!agent) return null;
        return <AgentCard agent={agent} />;
      }
      case "agent-note":
        return <AgentNote text={row.text} name={row.name} agentId={row.agentId} timestamp={row.timestamp} />;
      case "response-divider":
        return <ResponseDivider durationLabel={row.durationLabel} />;
      case "tool-container":
        return (
          <ToolContainer
            groups={row.groups}
            allActivities={row.allActivities}
            onSendMessage={onSendMessage}
            onAnswerUserInput={onAnswerUserInput}
            isInteractive={isInteractive}
            onApproveTool={onApproveTool}
            approvedTools={approvedTools}
            isExternal={isExternal}
            planChildId={planChildId}
            planChildName={planChildName}
          />
        );
    }
  };

  // ── Render ───────────────────────────────────────────────────────
  const virtualRows = rowVirtualizer.getVirtualItems();
  const nonVirtualizedRows = rows.slice(virtualizedRowCount);
  const hasVirtual = virtualizedRowCount > 0;
  const hasNonVirtual = nonVirtualizedRows.length > 0 || showThinking || queuedRows.length > 0;

  return (
    <AgentCardsProvider value={agentCardsValue}>
    <div className="flex min-h-0 flex-1 flex-col">
      {!isMobile && (
        <ChatTimeline
          rows={rows}
          onScrollToRow={handleScrollToRow}
          isLive={!!isProcessing}
          agents={agents}
        />
      )}
      <div className="relative flex min-h-0 flex-1">
        <ChatTOC rows={rows} onScrollToRow={handleScrollToRow} />
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div
            ref={containerRef}
            className="mx-auto max-w-3xl px-6 py-6 max-[768px]:px-3 max-[768px]:py-3"
          >
            {/* Virtualized section — absolute-positioned items in a sized container */}
            {hasVirtual && (
              <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
                {virtualRows.map((virtualRow) => (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    data-row-id={rows[virtualRow.index]?.id}
                    ref={rowVirtualizer.measureElement}
                    className={`absolute left-0 top-0 flex w-full flex-col rounded-xl transition-colors duration-700 ${
                      rows[virtualRow.index]?.id === activeSearchRowId
                        ? "bg-accent/10 ring-1 ring-accent/30"
                        : ""
                    }`}
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    {renderRow(rows[virtualRow.index], virtualRow.index)}
                  </div>
                ))}
              </div>
            )}

            {/* Non-virtualized section — current turn during processing */}
            {hasNonVirtual && (
              <div className={`flex flex-col gap-4${hasVirtual ? " mt-4" : ""}`}>
                {nonVirtualizedRows.map((row, i) => (
                  <div
                    key={row.id}
                    data-row-id={row.id}
                    className={`flex animate-fade-in flex-col rounded-xl transition-colors duration-700 ${
                      row.id === activeSearchRowId ? "bg-accent/10 ring-1 ring-accent/30" : ""
                    }`}
                  >
                    {renderRow(row, virtualizedRowCount + i)}
                  </div>
                ))}
                {showThinking && (
                  <LiveStatusStrip
                    activity={lastActivity ?? null}
                    processingStartedAt={processingStartedAt ?? null}
                    isProcessing={!!isProcessing}
                    instanceStatus={instanceStatus}
                    isCompacting={isCompactingTurn}
                  />
                )}
                {queuedRows.length > 0 && (
                  <div className="mt-2 flex flex-col gap-3 border-t border-dashed border-border/30 pt-3">
                    <div className="px-1 text-[0.625rem] uppercase tracking-wider text-muted/50">
                      Queued
                      {queuedRows.length > 1 ? ` · ${queuedRows.length}` : ""}
                    </div>
                    {queuedRows.map((row) => (
                      <div
                        key={row.id}
                        data-row-id={row.id}
                        className="flex animate-fade-in flex-col"
                      >
                        {renderRow(row)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Framing spacer — lets the newest turn sit near the top while its
                answer streams into the gap below. Collapses as the answer grows. */}
            {spacerHeight > 0 && (
              <div aria-hidden="true" style={{ height: spacerHeight }} className="shrink-0" />
            )}
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-[1px] bottom-0 h-10 bg-gradient-to-t from-bg to-transparent" />

        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-6">
          <AnimatePresence>
            {showScrollToBottom && (
              <motion.button
                type="button"
                onClick={() => {
                  // Drop any framing spacer first so we land on the live edge,
                  // not in the reserved empty space below it.
                  spacerHeightRef.current = 0;
                  setSpacerHeight(0);
                  setFramedTurnId(null);
                  forceStickToBottom(true);
                }}
                aria-label="Scroll to bottom"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 12 }}
                transition={{ type: "spring", duration: 0.5, bounce: 0.3 }}
                className="glass pointer-events-auto inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[0.75rem] font-medium text-text-bright hover:brightness-110 active:scale-[0.97]"
              >
                <ArrowDown size={13} strokeWidth={2.5} />
                Jump to latest
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
    </AgentCardsProvider>
  );
}

// ── Scroll-position persistence ──────────────────────────────────────
// Stored per chat in sessionStorage so reopening a chat within the same tab
// session lands where the reader left off. Session-scoped on purpose: stale
// offsets from a prior browser session would be unreliable after the
// transcript has grown.
const SCROLL_STORE_PREFIX = "relay:chat-scroll:";

interface SavedScroll {
  scrollTop: number;
  atBottom: boolean;
}

function readSavedScroll(key: string): SavedScroll | null {
  try {
    const raw = sessionStorage.getItem(SCROLL_STORE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedScroll>;
    if (typeof parsed.scrollTop !== "number" || typeof parsed.atBottom !== "boolean") return null;
    return { scrollTop: parsed.scrollTop, atBottom: parsed.atBottom };
  } catch {
    return null;
  }
}

function writeSavedScroll(key: string, value: SavedScroll): void {
  try {
    sessionStorage.setItem(SCROLL_STORE_PREFIX + key, JSON.stringify(value));
  } catch {
    // Ignore quota / unavailable storage — persistence is best-effort.
  }
}

function findSearchTargetRowIndex(
  rows: RenderRow[],
  searchFocus: { query: string; snippet?: string },
): number {
  const snippetTerms = extractSnippetTerms(searchFocus.snippet);
  if (snippetTerms.length > 0) {
    const snippetMatch = findBestSearchRowIndex(rows, snippetTerms);
    if (snippetMatch >= 0) return snippetMatch;
  }

  const queryTerms = extractQueryTerms(searchFocus.query);
  if (queryTerms.length > 0) {
    return findBestSearchRowIndex(rows, queryTerms);
  }

  return -1;
}

function findBestSearchRowIndex(rows: RenderRow[], terms: string[]): number {
  let bestIndex = -1;
  let bestScore = 0;

  for (let i = 0; i < rows.length; i++) {
    const haystack = getSearchableRowText(rows[i]);
    if (!haystack) continue;
    const score = scoreSearchTerms(haystack, terms);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
      if (score >= terms.length * 4) break;
    }
  }

  return bestIndex;
}

function getSearchableRowText(row: RenderRow): string {
  switch (row.kind) {
    case "user":
    case "assistant":
    case "system":
    case "thinking-block":
      return normalizeSearchText(row.text);
    case "agent-note":
      return normalizeSearchText(`${row.name ?? ""} ${row.text}`);
    default:
      return "";
  }
}

function extractSnippetTerms(snippet?: string): string[] {
  if (!snippet) return [];
  const plain = snippet
    .replace(/<mark>/gi, " ")
    .replace(/<\/mark>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&hellip;|…/g, " ");
  return tokenizeSearchText(plain, 3);
}

function extractQueryTerms(query: string): string[] {
  return tokenizeSearchText(query.replace(/\b(?:AND|OR|NOT|NEAR)\b/gi, " "), 2);
}

function tokenizeSearchText(text: string, minLength: number): string[] {
  const normalized = normalizeSearchText(text);
  if (!normalized) return [];
  return [...new Set(normalized.split(" ").filter((term) => term.length >= minLength))];
}

function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function scoreSearchTerms(haystack: string, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    if (!haystack.includes(term)) continue;
    score += haystack.includes(` ${term} `) ? 4 : 2;
  }
  return score;
}
