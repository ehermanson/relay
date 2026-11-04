import type { UiNode, UiTone, UiView } from "@shared/ui-render";
import type { ChatItem } from "@/lib/chat-types";

/**
 * Apply a live `ui_render` event: a view already in the chat is replaced
 * where it is (an update never moves it); a new one is appended.
 */
export function upsertUiViewItem(items: ChatItem[], view: UiView, timestamp: number): ChatItem[] {
  const index = items.findIndex((item) => item.kind === "ui-render" && item.view.id === view.id);
  if (index === -1) return [...items, { kind: "ui-render", view, timestamp }];
  const next = [...items];
  const existing = next[index] as Extract<ChatItem, { kind: "ui-render" }>;
  next[index] = { ...existing, view };
  return next;
}

/** A rough height for the virtualizer before the card is measured. */
export function estimateUiViewHeight(node: UiNode): number {
  switch (node.type) {
    case "stack":
      return node.direction === "horizontal"
        ? Math.max(0, ...node.children.map(estimateUiViewHeight))
        : node.children.reduce((sum, child) => sum + estimateUiViewHeight(child) + 12, 0);
    case "section":
      return (
        32 +
        (node.collapsed
          ? 0
          : node.children.reduce((sum, c) => sum + estimateUiViewHeight(c) + 12, 0))
      );
    case "tabs":
      return 40 + Math.max(0, ...(node.items[0]?.children ?? []).map(estimateUiViewHeight));
    case "text":
      return 24 + Math.ceil(node.markdown.length / 90) * 22;
    case "metrics":
      return node.items.some((m) => m.trend) ? 110 : 80;
    case "table":
      return 40 + Math.min(node.rows.length, node.maxRows ?? 10) * 34;
    case "list":
      return node.items.length * 34;
    case "progress":
      return 36;
    case "code":
    case "diff": {
      const text = node.type === "code" ? node.code : node.patch;
      return 32 + Math.min(text.split("\n").length, 30) * 18;
    }
    case "chart":
      return (node.height ?? 220) + 40;
    case "actions":
      return 48;
    case "choice":
      return 60 + node.options.length * 36;
    default:
      return 32;
  }
}

/** Text colour per tone; colour is decoration, the text still says it. */
export const TONE_TEXT: Record<UiTone, string> = {
  neutral: "text-text",
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
  info: "text-tool-use-text",
  accent: "text-accent",
};

/** Tinted chip background per tone. */
export const TONE_CHIP: Record<UiTone, string> = {
  neutral: "bg-surface-hover text-muted",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  error: "bg-error/10 text-error",
  info: "bg-tool-use-text/10 text-tool-use-text",
  accent: "bg-accent/10 text-accent",
};

/** Solid fill per tone, for bars and dots. */
export const TONE_FILL: Record<UiTone, string> = {
  neutral: "bg-muted",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
  info: "bg-tool-use-text",
  accent: "bg-accent",
};

/** `--color-chart-1…8`, in series order. */
export const CHART_COLORS = Array.from({ length: 8 }, (_, i) => `var(--color-chart-${i + 1})`);

/** A compact axis/tooltip number: 1.2k, 3.4M, trimmed decimals. */
export function formatChartValue(value: number, unit?: string): string {
  const abs = Math.abs(value);
  let text: string;
  if (abs >= 1_000_000) text = `${trim(value / 1_000_000)}M`;
  else if (abs >= 10_000) text = `${trim(value / 1_000)}k`;
  else text = trim(value);
  return unit ? `${text}${unit === "%" ? "" : " "}${unit}` : text;
}

function trim(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(Math.abs(value) < 10 ? 2 : 1).replace(/\.?0+$/, "");
}

/** Round numbers for a y axis spanning [min, max]: about 5 steps on a 1/2/5 scale. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    if (max === 0) return [0, 1];
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  const span = max - min;
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}
