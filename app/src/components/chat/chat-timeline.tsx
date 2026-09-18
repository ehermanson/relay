/**
 * DAW-style timeline scrubber for chat messages.
 *
 * Renders a compact horizontal strip above the message list showing event
 * markers evenly distributed along the rail. Supports:
 *  - Click/drag to scrub through the conversation
 *  - Hover tooltips with message previews and elapsed time
 *  - Live indicator when the agent is actively working
 *  - Alternating turn bands for visual structure
 *
 * Markers are positioned by index (equal spacing) rather than by timestamp,
 * so user/assistant pairs don't cluster at turn boundaries.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import type { RenderRow } from "@/lib/chat-types";
import type { AgentInfo } from "@shared/types";
import { getAgentTitle } from "@/lib/agents";
import { formatElapsed } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────

interface TimelineMarker {
  timestamp: number;
  rowIndex: number;
  kind: "user" | "assistant" | "boundary" | "model" | "delegated";
  label: string;
}

interface ChatTimelineProps {
  rows: RenderRow[];
  onScrollToRow: (index: number) => void;
  isLive: boolean;
  /** Delegated agents, for labelling inserted `agent-card` rows by name. */
  agents?: Record<string, AgentInfo>;
}

// ── Helpers ────────────────────────────────────────────────────────────

function extractLabel(row: RenderRow, agents: Record<string, AgentInfo> | undefined): string {
  switch (row.kind) {
    case "user":
    case "assistant":
      return row.text.slice(0, 100);
    case "compact-boundary":
      return "Context compacted";
    case "model-switch": {
      const from = row.fromModelLabel ?? row.fromModel;
      const to = row.toModelLabel ?? row.toModel;
      if (from && to) return `${from} → ${to}`;
      return to ? `Changed to ${to}` : "Model changed";
    }
    case "agent-card": {
      const agent = agents?.[row.agentId];
      return agent ? getAgentTitle(agent) : "";
    }
    case "agent-note":
      return row.name ? `From ${row.name}: ${row.text.slice(0, 80)}` : row.text.slice(0, 100);
    default:
      return "";
  }
}

const KIND_LABELS: Record<TimelineMarker["kind"], string> = {
  user: "You",
  assistant: "Agent",
  boundary: "Compaction",
  model: "Model switch",
  delegated: "Delegated agent",
};

// ── Marker builder ─────────────────────────────────────────────────────

function getRowTimestamp(row: RenderRow): number | undefined {
  switch (row.kind) {
    case "user":
    case "assistant":
    case "compact-boundary":
    case "model-switch":
    case "agent-card":
    case "agent-note":
      return row.timestamp;
    default:
      return undefined;
  }
}

function buildMarkers(
  rows: RenderRow[],
  agents: Record<string, AgentInfo> | undefined,
): TimelineMarker[] {
  const markers: TimelineMarker[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let kind: TimelineMarker["kind"];

    switch (row.kind) {
      case "user":
        kind = "user";
        break;
      case "assistant":
        kind = "assistant";
        break;
      case "compact-boundary":
        kind = "boundary";
        break;
      case "model-switch":
        kind = "model";
        break;
      case "agent-card":
      case "agent-note":
        kind = "delegated";
        break;
      default:
        continue;
    }

    const ts = getRowTimestamp(row);
    if (ts == null) continue;

    markers.push({ timestamp: ts, rowIndex: i, kind, label: extractLabel(row, agents) });
  }

  return markers;
}

// ── Tooltip content ────────────────────────────────────────────────────

function MarkerTooltipContent({ marker, baseTs }: { marker: TimelineMarker; baseTs: number }) {
  const label = marker.label.length > 80 ? marker.label.slice(0, 80) + "\u2026" : marker.label;

  return (
    <div className="max-w-[240px]">
      <div className="flex items-center gap-1.5 text-muted">
        <span>{KIND_LABELS[marker.kind]}</span>
        <span>&middot;</span>
        <span className="tabular-nums">{formatElapsed(marker.timestamp - baseTs)}</span>
      </div>
      {label && <p className="mt-0.5 text-text-bright">{label}</p>}
    </div>
  );
}

// ── Marker dot ─────────────────────────────────────────────────────────

function MarkerDot({ kind }: { kind: TimelineMarker["kind"] }) {
  switch (kind) {
    case "user":
      return <div className="h-2.5 w-2.5 rounded-full bg-accent/90" />;
    case "assistant":
      return <div className="h-[5px] w-[5px] rounded-full bg-text-bright/40" />;
    default:
      return <div className="h-1 w-1 rounded-full bg-muted/40" />;
  }
}

// ── Position helpers ───────────────────────────────────────────────────

/**
 * Build a cumulative sqrt-compressed position array from marker timestamps.
 *
 * Small gaps (user→assistant within a turn) stay proportional; large gaps
 * (tool work between turns) get compressed.  Returns an array of percentages
 * (0–100) — one per marker.
 */
function buildPositions(markers: TimelineMarker[]): number[] {
  if (markers.length <= 1) return markers.length === 1 ? [50] : [];

  // Cumulative sqrt of inter-marker deltas
  const cumulative = new Array<number>(markers.length);
  cumulative[0] = 0;
  for (let i = 1; i < markers.length; i++) {
    const delta = Math.max(0, markers[i].timestamp - markers[i - 1].timestamp);
    cumulative[i] = cumulative[i - 1] + Math.sqrt(delta);
  }

  const total = cumulative[markers.length - 1] || 1;
  return cumulative.map((v) => (v / total) * 100);
}

// ── Component ──────────────────────────────────────────────────────────

export function ChatTimeline({ rows, onScrollToRow, isLive, agents }: ChatTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [activeMarkerIdx, setActiveMarkerIdx] = useState<number | null>(null);

  const scrubbing = useRef(false);
  const scrollThrottle = useRef(0);

  const markers = useMemo(() => buildMarkers(rows, agents), [rows, agents]);
  const positions = useMemo(() => buildPositions(markers), [markers]);

  const baseTs = markers.length > 0 ? markers[0].timestamp : 0;
  const totalElapsed = useMemo(() => {
    if (markers.length < 2) return 0;
    const last = markers[markers.length - 1].timestamp;
    const first = markers[0].timestamp;
    return (isLive ? Math.max(last, Date.now()) : last) - first;
  }, [markers, isLive]);

  // ── Pointer → nearest marker index ────────────────────────────
  const idxFromClientX = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el || positions.length === 0) return 0;
      const rect = el.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * 100;
      // Find the marker whose position is closest to the click
      let bestIdx = 0;
      let bestD = Math.abs(positions[0] - pct);
      for (let i = 1; i < positions.length; i++) {
        const d = Math.abs(positions[i] - pct);
        if (d < bestD) {
          bestD = d;
          bestIdx = i;
        }
      }
      return bestIdx;
    },
    [positions],
  );

  // ── Throttled scroll ──────────────────────────────────────────
  const throttledScroll = useCallback(
    (rowIdx: number) => {
      const now = Date.now();
      if (now - scrollThrottle.current < 80) return;
      scrollThrottle.current = now;
      onScrollToRow(rowIdx);
    },
    [onScrollToRow],
  );

  // ── Pointer handlers ──────────────────────────────────────────
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      scrubbing.current = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

      const idx = idxFromClientX(e.clientX);
      setActiveMarkerIdx(idx);
      onScrollToRow(markers[idx].rowIndex);
    },
    [idxFromClientX, onScrollToRow, markers],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!scrubbing.current) return;

      const idx = idxFromClientX(e.clientX);
      setActiveMarkerIdx(idx);
      throttledScroll(markers[idx].rowIndex);
    },
    [idxFromClientX, throttledScroll, markers],
  );

  const handlePointerUp = useCallback(() => {
    scrubbing.current = false;
  }, []);

  const handlePointerLeave = useCallback(() => {
    scrubbing.current = false;
  }, []);

  // ── Turn bands: shade regions between user markers ─────────────
  // NOTE: must be declared before any early return so the hook order stays
  // stable across renders (dismiss flips `visible` → early return).
  const turnBands = useMemo(() => {
    const bands: Array<{ left: number; width: number }> = [];
    const userIndices: number[] = [];
    for (let i = 0; i < markers.length; i++) {
      if (markers[i].kind === "user") userIndices.push(i);
    }
    for (let j = 0; j < userIndices.length; j++) {
      const start = positions[userIndices[j]];
      const end = j + 1 < userIndices.length ? positions[userIndices[j + 1]] : 100;
      if (j % 2 === 0) bands.push({ left: start, width: end - start });
    }
    return bands;
  }, [markers, positions]);

  // ── Guards ─────────────────────────────────────────────────────
  if (!visible || markers.length < 2) return null;

  return (
    <div className="shrink-0 border-b border-border/30 bg-surface-inset/30 px-3 py-1">
      <div
        ref={trackRef}
        className="relative h-7 w-full cursor-crosshair select-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
      >
        {/* Turn bands — alternating subtle shading */}
        {turnBands.map((band, i) => (
          <div
            key={i}
            className="absolute inset-y-1 rounded-sm bg-border/[0.07]"
            style={{ left: `${band.left}%`, width: `${band.width}%` }}
          />
        ))}

        {/* Center rail */}
        <div className="absolute top-1/2 h-px w-full -translate-y-1/2 bg-border/40" />

        {/* Markers with tooltips */}
        {markers.map((m, i) => {
          const x = positions[i];
          const isActive = i === activeMarkerIdx;

          // Compaction boundaries and model switches render as full-height
          // vertical lines so they read as dividers between conversation
          // phases rather than another point-event marker. Compaction is a
          // dashed warning line; a model switch is a solid accent line.
          if (m.kind === "boundary" || m.kind === "model") {
            return (
              <Tooltip
                key={`${m.kind}-${i}`}
                side="bottom"
                delay={150}
                content={<MarkerTooltipContent marker={m} baseTs={baseTs} />}
              >
                <div
                  className={`absolute inset-y-0.5 -translate-x-1/2 px-1 transition-transform ${
                    isActive ? "scale-y-110" : ""
                  }`}
                  style={{ left: `${x}%` }}
                >
                  <div
                    className={
                      m.kind === "boundary"
                        ? "h-full w-0.5 border-l-2 border-dashed border-warning/60"
                        : "h-full w-0.5 border-l-2 border-solid border-accent/50"
                    }
                  />
                </div>
              </Tooltip>
            );
          }

          return (
            <Tooltip
              key={`${m.kind}-${i}`}
              side="bottom"
              delay={150}
              content={<MarkerTooltipContent marker={m} baseTs={baseTs} />}
            >
              <div
                className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 p-1 transition-transform ${
                  isActive ? "scale-125" : ""
                }`}
                style={{ left: `${x}%` }}
              >
                <MarkerDot kind={m.kind} />
              </div>
            </Tooltip>
          );
        })}

        {/* Active position indicator */}
        {activeMarkerIdx != null && (
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-accent/70"
            style={{ left: `${positions[activeMarkerIdx]}%` }}
          >
            <div className="absolute -top-[1px] left-1/2 h-[5px] w-[5px] -translate-x-1/2 rounded-full bg-accent" />
            <div className="absolute -bottom-[1px] left-1/2 h-[5px] w-[5px] -translate-x-1/2 rounded-full bg-accent" />
          </div>
        )}

        {/* Live pulse */}
        {isLive && (
          <div className="absolute right-0 top-1/2 -translate-y-1/2 pr-0.5">
            <div className="h-1.5 w-1.5 rounded-full bg-green-400">
              <div className="h-1.5 w-1.5 animate-ping rounded-full bg-green-400/60" />
            </div>
          </div>
        )}
      </div>

      {/* Duration label + dismiss */}
      <div className="flex items-center justify-end gap-1.5">
        <span className="hidden text-[0.5625rem] tabular-nums text-muted/40 sm:inline">
          {formatElapsed(totalElapsed)}
        </span>
        <button
          type="button"
          onClick={() => setVisible(false)}
          className="flex h-4 w-4 items-center justify-center rounded text-muted/40 transition-colors hover:text-text-bright"
          aria-label="Dismiss timeline"
        >
          <X size={10} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
