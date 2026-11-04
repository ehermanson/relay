import { useEffect, useMemo, useRef, useState } from "react";
import type { UiChartNode, UiTone } from "@shared/ui-render";
import { CHART_COLORS, formatChartValue, niceTicks } from "@/lib/ui-render-layout";

const TONE_STROKE: Record<UiTone, string> = {
  neutral: "var(--color-muted)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  error: "var(--color-error)",
  info: "var(--color-tool-use-text)",
  accent: "var(--color-accent)",
};

/** A tiny trend line under a metric. */
export function Sparkline({ values, tone }: { values: number[]; tone?: UiTone }) {
  const width = 120;
  const height = 24;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - 2 - ((v - min) / span) * (height - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="mt-1 block h-6 w-full"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke={TONE_STROKE[tone ?? "accent"]}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The container's width in CSS pixels, so text stays crisp instead of scaling with a viewBox. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

const PAD = { top: 8, right: 8, bottom: 22, left: 44 };

/**
 * Bar, line or area chart on Relay's categorical chart colours. Hover (or
 * tap) a column for its values; a legend shows when there are several series.
 */
export function UiChart({ node }: { node: UiChartNode }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const height = node.height ?? 220;
  const stacked = node.stacked === true && node.series.length > 1;
  const count = node.labels.length;

  const { ticks, yMin, yMax } = useMemo(() => {
    const totals = stacked
      ? node.labels.map((_, i) =>
          node.series.reduce((sum, s) => sum + Math.max(0, s.values[i] ?? 0), 0),
        )
      : node.series.flatMap((s) => s.values);
    const lows = stacked ? [0] : node.series.flatMap((s) => s.values);
    const low = Math.min(0, ...lows);
    const high = Math.max(...totals, 0);
    const t = niceTicks(node.kind === "bar" ? Math.min(0, low) : low, high);
    return { ticks: t, yMin: t[0], yMax: t[t.length - 1] };
  }, [node, stacked]);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;
  const band = count > 0 ? plotW / count : 0;
  const xCenter = (i: number) =>
    node.kind === "bar"
      ? PAD.left + band * i + band / 2
      : PAD.left + (count === 1 ? plotW / 2 : (i / (count - 1)) * plotW);
  // Show at most ~8 x labels so they never collide.
  const labelEvery = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(plotW / 64))));

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left - PAD.left;
    if (count === 0 || x < -band) return setActive(null);
    const i =
      node.kind === "bar"
        ? Math.floor(x / (band || 1))
        : Math.round((x / (plotW || 1)) * (count - 1));
    setActive(Math.min(count - 1, Math.max(0, i)));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div ref={ref} className="relative w-full" style={{ height }}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            className="block touch-pan-y"
            onPointerMove={onMove}
            onPointerDown={onMove}
            onPointerLeave={() => setActive(null)}
            role="img"
            aria-label={`${node.kind} chart of ${node.series.map((s) => s.name).join(", ")}`}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={y(t)}
                  y2={y(t)}
                  stroke="var(--color-border)"
                  strokeDasharray={t === 0 ? undefined : "2 3"}
                />
                <text
                  x={PAD.left - 6}
                  y={y(t)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-muted text-[0.625rem] tabular-nums"
                >
                  {formatChartValue(t, node.unit)}
                </text>
              </g>
            ))}
            {node.labels.map((label, i) =>
              i % labelEvery === 0 ? (
                <text
                  key={i}
                  x={xCenter(i)}
                  y={height - 6}
                  textAnchor="middle"
                  className="fill-muted text-[0.625rem]"
                >
                  {label.length > 12 ? `${label.slice(0, 11)}…` : label}
                </text>
              ) : null,
            )}
            {active !== null && (
              <line
                x1={xCenter(active)}
                x2={xCenter(active)}
                y1={PAD.top}
                y2={PAD.top + plotH}
                stroke="var(--color-border-hover, var(--color-border))"
              />
            )}
            {node.kind === "bar" ? (
              <Bars node={node} stacked={stacked} band={band} y={y} active={active} />
            ) : (
              node.series.map((series, s) => {
                const color = CHART_COLORS[s % CHART_COLORS.length];
                const pts = series.values.map((v, i) => [xCenter(i), y(v)] as const);
                const line = pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
                return (
                  <g key={series.name}>
                    {node.kind === "area" && (
                      <polygon
                        points={`${pts[0][0]},${y(Math.max(yMin, 0))} ${line} ${pts[pts.length - 1][0]},${y(Math.max(yMin, 0))}`}
                        fill={color}
                        opacity={0.12}
                      />
                    )}
                    <polyline
                      points={line}
                      fill="none"
                      stroke={color}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                    {active !== null && (
                      <circle cx={pts[active][0]} cy={pts[active][1]} r={3.5} fill={color} />
                    )}
                  </g>
                );
              })
            )}
          </svg>
        )}
        {active !== null && width > 0 && (
          <div
            className="pointer-events-none absolute top-1 z-10 min-w-[7rem] rounded-md border border-border bg-surface-raised px-2 py-1.5 text-[0.6875rem] shadow-(--shadow-surface)"
            style={
              xCenter(active) > width / 2
                ? { right: width - xCenter(active) + 8 }
                : { left: xCenter(active) + 8 }
            }
          >
            <div className="mb-0.5 font-medium text-text">{node.labels[active]}</div>
            {node.series.map((series, s) => (
              <div key={series.name} className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 shrink-0 rounded-sm"
                  style={{ background: CHART_COLORS[s % CHART_COLORS.length] }}
                />
                <span className="min-w-0 flex-1 truncate text-muted">{series.name}</span>
                <span className="tabular-nums text-text">
                  {formatChartValue(series.values[active], node.unit)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {node.series.length > 1 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[0.6875rem] text-muted">
          {node.series.map((series, s) => (
            <span key={series.name} className="inline-flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-sm"
                style={{ background: CHART_COLORS[s % CHART_COLORS.length] }}
              />
              {series.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Bars({
  node,
  stacked,
  band,
  y,
  active,
}: {
  node: UiChartNode;
  stacked: boolean;
  band: number;
  y: (v: number) => number;
  active: number | null;
}) {
  const inner = band * 0.72;
  const groups = node.series.length;
  const zero = y(0);
  return (
    <g>
      {node.labels.map((_, i) => {
        const left = PAD.left + band * i + (band - inner) / 2;
        let base = 0;
        return (
          <g key={i} opacity={active === null || active === i ? 1 : 0.55}>
            {node.series.map((series, s) => {
              const value = series.values[i] ?? 0;
              const color = CHART_COLORS[s % CHART_COLORS.length];
              if (stacked) {
                const top = y(base + Math.max(0, value));
                const bottom = y(base);
                base += Math.max(0, value);
                return (
                  <rect
                    key={s}
                    x={left}
                    width={Math.max(1, inner)}
                    y={top}
                    height={Math.max(0, bottom - top)}
                    fill={color}
                  />
                );
              }
              const w = inner / groups;
              const top = Math.min(y(value), zero);
              return (
                <rect
                  key={s}
                  x={left + w * s}
                  width={Math.max(1, w - (groups > 1 ? 1 : 0))}
                  y={top}
                  height={Math.max(value === 0 ? 0 : 1, Math.abs(zero - y(value)))}
                  rx={Math.min(3, w / 4)}
                  fill={color}
                />
              );
            })}
          </g>
        );
      })}
    </g>
  );
}
