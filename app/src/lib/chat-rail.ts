/**
 * Chat rail model — the pure half of `ChatRail`.
 *
 * The rail is a column of evenly spaced ticks, one per user turn (plus
 * divider ticks for compaction and model switches), with the tick for the
 * turn currently in view emphasised and its neighbours tapering off. Ticks are
 * placed by *index*, never by time or scroll height: a time axis produced dead
 * gaps for overnight pauses and piles of overlapping dots for quick exchanges,
 * and a scroll-proportional minimap made short turns vanish. The only thing
 * scroll geometry decides is which turn is current.
 */

import type { RenderRow } from "@/lib/chat-types";

// ── Model ──────────────────────────────────────────────────────────────

export interface RailTurn {
  /** Row id of the user message that opens the turn. */
  id: string;
  rowIndex: number;
  /** First substantive line of the prompt — the hover card's title. */
  label: string;
  /** Opening of the assistant's reply — the hover card's body. Empty when none yet. */
  preview: string;
  timestamp?: number;
}

export interface RailTick {
  id: string;
  kind: "boundary" | "model";
  rowIndex: number;
  label: string;
}

export type RailEntry = { kind: "turn"; turn: RailTurn } | { kind: "tick"; tick: RailTick };

export interface RailModel {
  turns: RailTurn[];
  /** Turns and divider ticks interleaved in row order — what the column renders. */
  entries: RailEntry[];
}

/** Below this many turns a rail is a single tick — nothing to navigate. */
export const RAIL_MIN_TURNS = 2;

const LABEL_MAX = 72;
const PREVIEW_MAX = 220;
const ATTACHMENT_LINE = /^\[(Image|File|Attachment)\b[^\]]*\]$/i;

/**
 * First non-empty line of a prompt that isn't a bare attachment marker, so an
 * image-first message labels itself by what was asked, not `[Image: …]`.
 */
export function turnLabel(text: string): string {
  const lines = text.split("\n");
  let pick = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (ATTACHMENT_LINE.test(line)) {
      if (!pick) pick = line;
      continue;
    }
    pick = line;
    break;
  }
  if (!pick) return "Attachment";
  return pick.length > LABEL_MAX ? pick.slice(0, LABEL_MAX).trimEnd() + "…" : pick;
}

/** Collapse a reply to one run of plain-ish text for the card body. */
export function replyPreview(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > PREVIEW_MAX ? flat.slice(0, PREVIEW_MAX).trimEnd() + "…" : flat;
}

function tickLabel(row: Extract<RenderRow, { kind: "compact-boundary" | "model-switch" }>) {
  if (row.kind === "compact-boundary") return "Context compacted";
  const to = row.toModelLabel ?? row.toModel;
  return to ? `Switched to ${to}` : "Model changed";
}

export function buildRailModel(rows: RenderRow[]): RailModel {
  const turns: RailTurn[] = [];
  const entries: RailEntry[] = [];
  let open: RailTurn | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    switch (row.kind) {
      case "user": {
        if (row.queued) break;
        const turn: RailTurn = {
          id: row.id,
          rowIndex: i,
          label: turnLabel(row.text),
          preview: "",
          timestamp: row.timestamp,
        };
        turns.push(turn);
        entries.push({ kind: "turn", turn });
        open = turn;
        break;
      }
      case "assistant":
        if (open && !open.preview) open.preview = replyPreview(row.text);
        break;
      case "compact-boundary":
      case "model-switch":
        entries.push({
          kind: "tick",
          tick: {
            id: row.id,
            kind: row.kind === "compact-boundary" ? "boundary" : "model",
            rowIndex: i,
            label: tickLabel(row),
          },
        });
        break;
      default:
        break;
    }
  }
  return { turns, entries };
}

// ── Current turn ───────────────────────────────────────────────────────

export interface RailGeometry {
  /** Scroll container metrics, in px. */
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  /** Content offset (scroll coordinates) of each turn's first row, or null when unknown. */
  turnOffsets: Array<number | null>;
}

/**
 * Replace unknown offsets by interpolating between the nearest known neighbours
 * by row index, so a turn whose row hasn't been laid out yet still lands in the
 * right order rather than vanishing.
 */
export function fillMissingOffsets(
  rowIndexes: number[],
  offsets: Array<number | null>,
  total: number,
): number[] {
  const n = rowIndexes.length;
  const out: number[] = Array.from({ length: n }, () => 0);
  // Virtual anchors: row -1 at offset 0, row +∞ at `total`.
  let prevIdx = -1;
  let prevOff = 0;
  for (let i = 0; i < n; i++) {
    const known = offsets[i];
    if (known != null) {
      out[i] = known;
      prevIdx = rowIndexes[i];
      prevOff = known;
      continue;
    }
    let j = i + 1;
    while (j < n && offsets[j] == null) j++;
    const nextIdx = j < n ? rowIndexes[j] : rowIndexes[n - 1] + 1;
    const nextOff = j < n ? (offsets[j] as number) : total;
    const span = Math.max(1, nextIdx - prevIdx);
    const t = (rowIndexes[i] - prevIdx) / span;
    out[i] = prevOff + (nextOff - prevOff) * t;
  }
  return out;
}

/** Index into `model.turns` of the turn occupying most of the viewport, or -1. */
export function findActiveTurn(model: RailModel, geom: RailGeometry): number {
  if (model.turns.length === 0) return -1;
  const total = Math.max(1, geom.scrollHeight);
  const offsets = fillMissingOffsets(
    model.turns.map((t) => t.rowIndex),
    geom.turnOffsets,
    total,
  );
  const viewTop = geom.scrollTop;
  const viewBottom = geom.scrollTop + geom.clientHeight;
  let active = -1;
  let bestOverlap = 0;
  for (let i = 0; i < offsets.length; i++) {
    const start = Math.max(0, offsets[i]);
    const end = i + 1 < offsets.length ? Math.max(start, offsets[i + 1]) : total;
    const overlap = Math.min(end, viewBottom) - Math.max(start, viewTop);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      active = i;
    }
  }
  return active;
}

// ── Emphasis ───────────────────────────────────────────────────────────

/** How many ticks either side of the active one taper before settling on the base length. */
export const TICK_TAPER = 3;

/** 0 = base length … `TICK_TAPER` = the active tick. */
export function tickEmphasis(distanceFromActive: number): number {
  return Math.max(0, TICK_TAPER - Math.abs(distanceFromActive));
}
