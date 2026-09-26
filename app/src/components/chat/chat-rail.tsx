/**
 * Chat rail — a column of ticks in the left gutter of the message list, one
 * per user turn, vertically centred in the viewport.
 *
 * The tick for the turn in view is long and bright; its neighbours taper off
 * so the column reads like a ruler with a cursor, and the taper glides as you
 * scroll. Compaction and model switches are dimmer divider ticks. Hovering a
 * tick shows a card with the prompt as title and the reply's opening as body;
 * click or drag jumps. While the agent works the last tick pulses.
 *
 * Rendered as a zero-height sticky child *inside* the scroll container so
 * wheel events over it scroll the chat natively; the parent wrapper (not the
 * rail) must be the container's first child so `useAutoScroll`'s
 * ResizeObserver keeps watching the content. Which turn is current comes from
 * `getRowOffsets` (message-list owns the virtualizer) and is re-measured on
 * scroll, resize, and row changes.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { RenderRow } from "@/lib/chat-types";
import {
  buildRailModel,
  findActiveTurn,
  RAIL_MIN_TURNS,
  tickEmphasis,
  type RailEntry,
  type RailModel,
} from "@/lib/chat-rail";
import { formatElapsed } from "@/lib/utils";

interface ChatRailProps {
  rows: RenderRow[];
  /** The scrolling element the rail is mounted inside. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Content offsets (scroll coordinates) for the given row indexes; null when unknown. */
  getRowOffsets: (rowIndexes: number[]) => Array<number | null>;
  onScrollToRow: (rowIndex: number) => void;
  isLive: boolean;
}

interface RailState {
  /** Index into `model.turns`, or -1. */
  activeTurn: number;
  /** Viewport height — the rail's own height. */
  railHeight: number;
  /** Left offset of the chat content column inside the scroll element. */
  contentLeft: number;
}

/** Hover dwell before the card shows, so crossing the gutter doesn't flash it. */
const CARD_DELAY_MS = 120;
const SCRUB_THROTTLE_MS = 80;

/** Preferred vertical pitch between ticks; shrinks (to a floor) for very long chats. */
const PITCH = 12;
const PITCH_MIN = 5;
/** Vertical padding kept clear above and below the column. */
const COLUMN_INSET = 24;

/** Tick lengths by emphasis level (0 = base … 3 = active), narrow and wide gutters. */
const TICK_WIDTHS_NARROW = [6, 10, 14, 20];
const TICK_WIDTHS_WIDE = [8, 14, 20, 28];
/** Left edge of every tick. */
const TICK_LEFT = 4;

export function ChatRail({ rows, scrollRef, getRowOffsets, onScrollToRow, isLive }: ChatRailProps) {
  const model = useMemo(() => buildRailModel(rows), [rows]);
  const [state, setState] = useState<RailState | null>(null);
  const [hoverEntry, setHoverEntry] = useState(-1);
  const [cardOpen, setCardOpen] = useState(false);
  const columnRef = useRef<HTMLDivElement>(null);
  const cardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrubbing = useRef(false);
  const scrubThrottle = useRef(0);
  const enabled = model.turns.length >= RAIL_MIN_TURNS;

  // ── Measurement ───────────────────────────────────────────────
  const modelRef = useRef<RailModel>(model);
  modelRef.current = model;
  const getRowOffsetsRef = useRef(getRowOffsets);
  getRowOffsetsRef.current = getRowOffsets;

  const measure = useCallback(() => {
    const el = scrollRef.current;
    const m = modelRef.current;
    if (!el || m.turns.length < RAIL_MIN_TURNS) return;
    const activeTurn = findActiveTurn(m, {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
      turnOffsets: getRowOffsetsRef.current(m.turns.map((t) => t.rowIndex)),
    });
    const content = el.querySelector<HTMLElement>("[data-chat-content]");
    const next: RailState = {
      activeTurn,
      railHeight: el.clientHeight,
      contentLeft: content?.offsetLeft ?? 0,
    };
    setState((prev) =>
      prev &&
      prev.activeTurn === next.activeTurn &&
      prev.railHeight === next.railHeight &&
      prev.contentLeft === next.contentLeft
        ? prev
        : next,
    );
  }, [scrollRef]);

  // Coalesce every trigger (scroll, resize, row changes) into one measure per frame.
  const raf = useRef(0);
  const scheduleMeasure = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      measure();
    });
  }, [measure]);

  // Passive effect on purpose: the rail is a child of the scroll element, so a
  // layout effect here runs before React attaches the parent's ref and would
  // see `scrollRef.current === null` — and never subscribe to scroll.
  useEffect(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", scheduleMeasure, { passive: true });
    const ro = new ResizeObserver(scheduleMeasure);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => {
      el.removeEventListener("scroll", scheduleMeasure);
      ro.disconnect();
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [enabled, scrollRef, measure, scheduleMeasure]);

  // Rows changed (new turn, scene swap) → remeasure before paint.
  useLayoutEffect(() => {
    if (enabled) measure();
  }, [enabled, rows, measure]);

  // ── Hover card ────────────────────────────────────────────────
  const clearCardTimer = () => {
    if (cardTimer.current) clearTimeout(cardTimer.current);
    cardTimer.current = null;
  };
  useEffect(() => clearCardTimer, []);

  const hoverAt = (entry: number) => {
    if (entry === hoverEntry) return;
    setHoverEntry(entry);
    if (entry < 0) {
      clearCardTimer();
      setCardOpen(false);
      return;
    }
    if (cardOpen) return;
    clearCardTimer();
    cardTimer.current = setTimeout(() => setCardOpen(true), CARD_DELAY_MS);
  };

  // ── Geometry ──────────────────────────────────────────────────
  const entries = model.entries;
  const railHeight = state?.railHeight ?? 0;
  const pitch = Math.max(
    PITCH_MIN,
    Math.min(PITCH, Math.floor((railHeight - COLUMN_INSET * 2) / Math.max(1, entries.length))),
  );
  const columnHeight = entries.length * pitch;
  const columnTop = Math.max(COLUMN_INSET, (railHeight - columnHeight) / 2);
  // A wide gutter (content centred with room to spare) gets the longer ticks.
  const widths = (state?.contentLeft ?? 0) >= 24 ? TICK_WIDTHS_WIDE : TICK_WIDTHS_NARROW;
  const columnWidth = TICK_LEFT + widths[widths.length - 1] + 4;

  const activeEntry = useMemo(() => {
    if (!state || state.activeTurn < 0) return -1;
    const id = model.turns[state.activeTurn]?.id;
    return entries.findIndex((e) => e.kind === "turn" && e.turn.id === id);
  }, [state, model, entries]);

  // ── Pointer → entry ───────────────────────────────────────────
  const entryFromClientY = (clientY: number) => {
    const col = columnRef.current;
    if (!col) return -1;
    const y = clientY - col.getBoundingClientRect().top;
    const i = Math.floor(y / pitch);
    return i < 0 || i >= entries.length ? -1 : i;
  };

  const jumpTo = (entry: number) => {
    const e = entries[entry];
    if (!e) return;
    onScrollToRow(e.kind === "turn" ? e.turn.rowIndex : e.tick.rowIndex);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    scrubbing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    const entry = entryFromClientY(e.clientY);
    if (entry >= 0) {
      hoverAt(entry);
      jumpTo(entry);
      scrubThrottle.current = Date.now();
    }
  };
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const entry = entryFromClientY(e.clientY);
    hoverAt(entry);
    if (!scrubbing.current || entry < 0) return;
    const now = Date.now();
    if (now - scrubThrottle.current < SCRUB_THROTTLE_MS) return;
    scrubThrottle.current = now;
    jumpTo(entry);
  };
  const handlePointerUp = () => {
    scrubbing.current = false;
  };
  const handlePointerLeave = () => {
    scrubbing.current = false;
    hoverAt(-1);
  };

  if (!enabled || !state) return null;

  const hovered = hoverEntry >= 0 ? entries[hoverEntry] : undefined;
  const baseTs = model.turns[0]?.timestamp;
  let lastTurnEntry = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind === "turn") {
      lastTurnEntry = i;
      break;
    }
  }
  // The taper follows the pointer while hovering, the viewport otherwise.
  const emphasisAnchor = hoverEntry >= 0 ? hoverEntry : activeEntry;

  return (
    <div className="pointer-events-none sticky top-0 z-10 h-0">
      <div className="absolute left-0 top-0" style={{ height: railHeight }}>
        {/* Tick column — the hit area spans the column's full pitch grid. */}
        <div
          ref={columnRef}
          className="pointer-events-auto absolute cursor-pointer select-none touch-none"
          style={{ left: 0, top: columnTop, width: columnWidth, height: columnHeight }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          role="slider"
          aria-label="Conversation position"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, model.turns.length - 1)}
          aria-valuenow={Math.max(0, state.activeTurn)}
          tabIndex={-1}
        >
          {entries.map((entry, i) => (
            <Tick
              key={entry.kind === "turn" ? entry.turn.id : entry.tick.id}
              entry={entry}
              top={i * pitch + pitch / 2}
              width={widths[tickEmphasis(i - emphasisAnchor)]}
              active={i === activeEntry}
              hovered={i === hoverEntry}
              live={isLive && i === lastTurnEntry}
            />
          ))}
        </div>

        {/* Hover card — prompt as title, the reply's opening as body. */}
        <AnimatePresence>
          {cardOpen && hovered && (
            <motion.div
              key={hovered.kind === "turn" ? hovered.turn.id : hovered.tick.id}
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -4 }}
              transition={{ duration: 0.12, ease: "easeOut" }}
              className="pointer-events-none absolute w-80 rounded-xl border border-border bg-surface px-3.5 py-3 shadow-lg"
              style={{
                left: columnWidth + 6,
                top: Math.min(
                  Math.max(8, columnTop + hoverEntry * pitch - 20),
                  Math.max(8, railHeight - 148),
                ),
              }}
            >
              {hovered.kind === "turn" ? (
                <>
                  <div className="flex items-baseline gap-3">
                    <div className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-text-bright">
                      {hovered.turn.label}
                    </div>
                    {baseTs != null && hovered.turn.timestamp != null && hoverEntry > 0 && (
                      <span className="shrink-0 text-[0.625rem] tabular-nums text-muted/60">
                        {formatElapsed(hovered.turn.timestamp - baseTs)}
                      </span>
                    )}
                  </div>
                  {hovered.turn.preview && (
                    <p className="mt-1 line-clamp-3 text-[0.75rem] leading-snug text-muted">
                      {hovered.turn.preview}
                    </p>
                  )}
                </>
              ) : (
                <div
                  className={`text-[0.6875rem] uppercase tracking-wider ${
                    hovered.tick.kind === "boundary" ? "text-warning/80" : "text-accent/80"
                  }`}
                >
                  {hovered.tick.label}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ── Tick ───────────────────────────────────────────────────────────────

interface TickProps {
  entry: RailEntry;
  top: number;
  width: number;
  active: boolean;
  hovered: boolean;
  live: boolean;
}

function Tick({ entry, top, width, active, hovered, live }: TickProps) {
  if (entry.kind === "tick") {
    return (
      <div
        className={`absolute h-px -translate-y-1/2 transition-[width] duration-150 ${
          entry.tick.kind === "boundary" ? "bg-warning/45" : "bg-accent/50"
        }`}
        style={{ left: TICK_LEFT, top, width }}
      />
    );
  }
  const tone = live
    ? "bg-accent animate-pulse-dot"
    : active || hovered
      ? "bg-text/70"
      : "bg-muted/40";
  return (
    <div
      className={`absolute -translate-y-1/2 rounded-full transition-[width,background-color] duration-150 ${tone}`}
      style={{ left: TICK_LEFT, top, width, height: 2 }}
    />
  );
}
