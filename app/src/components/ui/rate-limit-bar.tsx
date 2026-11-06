import type { ProviderRateLimitStatus, ProviderRateLimitWindow, SpendLimit } from "@shared/types";
import { formatTimeUntil, rateLimitColorClass } from "../../lib/utils";

/**
 * Known limit-pool scopes/names → display qualifier appended to the window
 * label so distinct pools don't render as identical-looking bars. `null`
 * means the pool is the primary/overall one and needs no qualifier.
 */
const LIMIT_QUALIFIERS: Record<string, string | null> = {
  five_hour: null,
  seven_day: null,
  codex: null,
  seven_day_sonnet: "Sonnet",
  seven_day_opus: "Opus",
  seven_day_oauth_apps: "OAuth apps",
  seven_day_overage_included: "Overage incl.",
  overage: "Overage",
};

/**
 * Display qualifier for a rate-limit pool. Providers can report several
 * pools at once (e.g. Codex's main pool plus a per-model pool, or Claude's
 * overall weekly plus a Sonnet-specific weekly); without a qualifier their
 * windows render as indistinguishable "5h window"/"Weekly" bars.
 */
function limitQualifier(limit: Pick<ProviderRateLimitStatus, "name" | "scope">): string | null {
  for (const key of [limit.scope, limit.name]) {
    if (key && key in LIMIT_QUALIFIERS) return LIMIT_QUALIFIERS[key];
  }
  return limit.name ?? null;
}

/**
 * Derive a human-readable label from the rate-limit window duration.
 *
 * Providers report windows with a `windowMinutes` field (e.g. 300 for a 5-hour
 * window, 10080 for a weekly window). We bucket these into the most natural
 * human-readable unit:
 *
 *   < 60 min  → "30m window"
 *   < 1 day   → "5h window"
 *   < 1 week  → "3d window"
 *   ≥ 1 week  → "Weekly"
 *
 * Falls back to the raw `window.label` from the provider (e.g. "Primary"),
 * or a generic "Window N" if neither is available.
 */
function windowLabel(window: ProviderRateLimitWindow, fallbackIndex: number): string {
  const w = window.windowMinutes;
  if (typeof w === "number" && w > 0) {
    if (w < 60) return `${w}m window`; // minutes
    if (w < 1440) return `${Math.round(w / 60)}h window`; // hours
    if (w < 10080) return `${Math.round(w / 1440)}d window`; // days
    return "Weekly";
  }
  return window.label ?? `Window ${fallbackIndex + 1}`;
}

export function RateLimitBar({
  window,
  index = 0,
  size = "sm",
  qualifier,
}: {
  window: ProviderRateLimitWindow;
  /** Fallback index used when no label or windowMinutes are available. */
  index?: number;
  /** "sm" for sidecar, "md" for settings page. */
  size?: "sm" | "md";
  /** Limit-pool name shown after the window label to disambiguate pools. */
  qualifier?: string | null;
}) {
  const pct = typeof window.usedPercent === "number" ? window.usedPercent : null;

  // Derive pct from remaining/limit when usedPercent isn't provided
  const derivedPct =
    pct === null &&
    typeof window.remaining === "number" &&
    typeof window.limit === "number" &&
    window.limit > 0
      ? ((window.limit - window.remaining) / window.limit) * 100
      : null;

  // When rejected and no pct is available, show a full bar.
  const effectivePct = pct ?? derivedPct ?? (window.status === "rejected" ? 100 : null);

  const barColor = rateLimitColorClass(window.status, effectivePct);

  const resetIn = window.resetAt
    ? formatTimeUntil(window.resetAt)
    : typeof window.windowMinutes === "number"
      ? `${window.windowMinutes}m window`
      : "";

  const baseLabel = windowLabel(window, index);
  const label = qualifier ? `${baseLabel} · ${qualifier}` : baseLabel;
  const textSize = size === "sm" ? "text-[0.6875rem]" : "text-[0.75rem]";
  const barHeight = size === "sm" ? "h-1.5" : "h-2";

  // Usage text
  const usageText =
    pct !== null
      ? `${Math.round(pct)}% used`
      : typeof window.remaining === "number" && typeof window.limit === "number"
        ? `${window.limit - window.remaining} / ${window.limit}`
        : typeof window.remaining === "number"
          ? `${window.remaining} remaining`
          : "—";

  return (
    <div>
      <div className={`mb-1 flex items-center justify-between ${textSize} text-muted`}>
        <span>{label}</span>
        <span className="tabular-nums">
          {usageText}
          {resetIn ? <span className="ml-1.5 text-muted">(resets in {resetIn})</span> : null}
        </span>
      </div>
      {effectivePct !== null ? (
        <div className={`flex ${barHeight} w-full overflow-hidden rounded-full bg-surface-hover`}>
          <div
            className={`h-full rounded-full transition-all ${barColor}`}
            style={{ width: `${Math.min(effectivePct, 100)}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Renders a monthly spending-limit bar using Claude's extra_usage budget data.
 * Amounts are stored as minor currency units (cents for USD) and displayed as
 * formatted currency strings.
 */
export function SpendLimitBar({
  spendLimit,
  size = "sm",
}: {
  spendLimit: SpendLimit;
  size?: "sm" | "md";
}) {
  const { usedCents, limitCents, utilization, currency } = spendLimit;

  const fmtCurrency = (cents: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: 2,
    }).format(cents / 100);

  const pct = typeof utilization === "number" ? utilization : null;
  const barColor = rateLimitColorClass(undefined, pct ?? undefined);
  const textSize = size === "sm" ? "text-[0.6875rem]" : "text-[0.75rem]";
  const barHeight = size === "sm" ? "h-1.5" : "h-2";

  const usageText =
    limitCents !== null
      ? `${fmtCurrency(usedCents)} / ${fmtCurrency(limitCents)}`
      : fmtCurrency(usedCents);

  return (
    <div>
      <div className={`mb-1 flex items-center justify-between ${textSize} text-muted`}>
        <span>Monthly spend</span>
        <span className="tabular-nums">{usageText}</span>
      </div>
      {pct !== null ? (
        <div className={`flex ${barHeight} w-full overflow-hidden rounded-full bg-surface-hover`}>
          <div
            className={`h-full rounded-full transition-all ${barColor}`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Flatten all rate-limit windows from a list of rate-limit statuses
 * into a flat array suitable for mapping over with <RateLimitBar>.
 * Each entry carries its pool's display qualifier so windows from
 * different pools stay distinguishable after flattening.
 */
export function flattenRateLimitWindows(
  rateLimits: Pick<ProviderRateLimitStatus, "name" | "scope" | "windows">[],
): { window: ProviderRateLimitWindow; key: string; qualifier: string | null }[] {
  return rateLimits.flatMap((limit, li) =>
    (limit.windows ?? []).map((w, wi) => ({
      window: w,
      key: `rl-${li}-${wi}`,
      qualifier: limitQualifier(limit),
    })),
  );
}
