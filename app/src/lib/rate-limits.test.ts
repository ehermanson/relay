import { describe, expect, it } from "vitest";
import {
  RATE_LIMIT_AGE_WORTH_NAMING_MS,
  RATE_LIMIT_MAX_AGE_MS,
  rateLimitView,
} from "./rate-limits";

const NOW = Date.parse("2026-11-25T12:00:00Z");

describe("rateLimitView", () => {
  it("returns null with no windows", () => {
    expect(rateLimitView(undefined, NOW)).toBeNull();
    expect(rateLimitView({ rateLimits: [] }, NOW)).toBeNull();
    expect(rateLimitView({ rateLimits: [{ scope: "x", windows: [] }] }, NOW)).toBeNull();
  });

  it("passes current windows through", () => {
    const view = rateLimitView(
      {
        rateLimits: [
          { scope: "seven_day", windows: [{ usedPercent: 40, resetAt: "2026-11-30T00:00:00Z" }] },
        ],
        rateLimitsFetchedAt: NOW - 60_000,
      },
      NOW,
    );
    expect(view?.rateLimits[0].windows?.[0].usedPercent).toBe(40);
    expect(view?.staleSince).toBeNull();
  });

  it("shows a window whose reset passed as reset, not last period's usage", () => {
    const view = rateLimitView(
      {
        rateLimits: [
          {
            scope: "five_hour",
            windows: [{ usedPercent: 93, status: "rejected", resetAt: "2026-11-25T11:00:00Z" }],
          },
        ],
      },
      NOW,
    );
    const window = view?.rateLimits[0].windows?.[0];
    expect(window?.usedPercent).toBe(0);
    expect(window?.status).toBeUndefined();
    expect(window?.resetAt).toBeUndefined();
  });

  it("names the age of an old reading and hides one older than a day", () => {
    const account = {
      rateLimits: [{ scope: "seven_day", windows: [{ usedPercent: 10 }] }],
    };
    const old = NOW - RATE_LIMIT_AGE_WORTH_NAMING_MS;
    expect(rateLimitView({ ...account, rateLimitsFetchedAt: old }, NOW)?.staleSince).toBe(old);
    expect(
      rateLimitView({ ...account, rateLimitsFetchedAt: NOW - RATE_LIMIT_MAX_AGE_MS }, NOW),
    ).toBeNull();
  });
});
