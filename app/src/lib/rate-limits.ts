import type {
  ProviderAccountStatus,
  ProviderRateLimitStatus,
  ProviderRateLimitWindow,
} from "@shared/types";

/**
 * Past this age a reading describes windows that have almost certainly rolled
 * over, and bars that render it look live — worse than showing nothing. The
 * server polls every few minutes while a client is connected, so this only
 * hides readings that stopped refreshing (signed out, CLI missing).
 */
export const RATE_LIMIT_MAX_AGE_MS = 24 * 60 * 60_000;

/** Age at which the reading's age is worth saying out loud. */
export const RATE_LIMIT_AGE_WORTH_NAMING_MS = 15 * 60_000;

export interface RateLimitView {
  rateLimits: ProviderRateLimitStatus[];
  /** When the reading was taken, if it is old enough to mention. */
  staleSince: number | null;
}

/**
 * What to render for an account's plan limits right now, or null for nothing.
 * A window whose reset time has passed has reset: it shows 0% with no status
 * until the next reading, never the previous period's usage.
 */
export function rateLimitView(
  account: ProviderAccountStatus | undefined,
  now: number = Date.now(),
): RateLimitView | null {
  const limits = account?.rateLimits;
  const fetchedAt = account?.rateLimitsFetchedAt;
  if (fetchedAt && now - fetchedAt >= RATE_LIMIT_MAX_AGE_MS) return null;
  const rateLimits = (limits ?? [])
    .map((limit) => ({
      ...limit,
      windows: limit.windows?.map((window) => resetIfExpired(window, now)),
    }))
    .filter((limit) => limit.windows?.length);
  if (!rateLimits.length) return null;
  return {
    rateLimits,
    staleSince: fetchedAt && now - fetchedAt >= RATE_LIMIT_AGE_WORTH_NAMING_MS ? fetchedAt : null,
  };
}

function resetIfExpired(window: ProviderRateLimitWindow, now: number): ProviderRateLimitWindow {
  if (!window.resetAt) return window;
  const resetAt = new Date(window.resetAt).getTime();
  if (!Number.isFinite(resetAt) || resetAt > now) return window;
  return {
    ...window,
    usedPercent: 0,
    remaining: typeof window.limit === "number" ? window.limit : undefined,
    status: undefined,
    resetAt: undefined,
  };
}
