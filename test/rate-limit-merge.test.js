// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  rlSeverity,
  mergeRateLimitWindows,
  mergeRateLimits,
  overlayRateLimits,
  rateLimitPollInterval,
} from "../dist/server/core/instance-manager.js";

const future = () => new Date(Date.now() + 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

describe("rlSeverity", () => {
  it("orders rejected > allowed_warning > allowed", () => {
    assert.ok(rlSeverity("rejected") > rlSeverity("allowed_warning"));
    assert.ok(rlSeverity("allowed_warning") > rlSeverity("allowed"));
    assert.equal(rlSeverity(undefined), 0);
    assert.equal(rlSeverity("nonsense"), 0);
  });
});

describe("mergeRateLimitWindows", () => {
  // Case 1
  it("returns a copy of prev when patch is undefined", () => {
    const prev = [{ status: "rejected", resetAt: future(), usedPercent: 100 }];
    const merged = mergeRateLimitWindows(prev, undefined);
    assert.deepEqual(merged, prev);
    assert.notEqual(merged, prev);
    assert.notEqual(merged[0], prev[0]);
    // Mutating the result must not touch the source.
    merged[0].status = "allowed";
    assert.equal(prev[0].status, "rejected");
  });

  it("returns undefined when both prev and patch are undefined", () => {
    assert.equal(mergeRateLimitWindows(undefined, undefined), undefined);
  });

  // Case 2
  it("passes patch window through when no prev at that index", () => {
    const patch = [{ status: "allowed", usedPercent: 12 }];
    const merged = mergeRateLimitWindows(undefined, patch);
    assert.deepEqual(merged, patch);
    assert.notEqual(merged[0], patch[0]);
  });

  it("passes a patch window through when prev array is shorter", () => {
    const prev = [{ status: "rejected", resetAt: future(), usedPercent: 100 }];
    const patch = [
      { status: "rejected", resetAt: future(), usedPercent: 100 },
      { status: "allowed", usedPercent: 5 },
    ];
    const merged = mergeRateLimitWindows(prev, patch);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged[1], patch[1]);
  });

  // Case 3
  it("keeps the more-severe prev status while prev window is still active", () => {
    const prev = [{ status: "rejected", resetAt: future(), usedPercent: 100 }];
    const patch = [{ status: "allowed" }];
    const merged = mergeRateLimitWindows(prev, patch);
    assert.equal(merged[0].status, "rejected");
    assert.equal(merged[0].resetAt, prev[0].resetAt);
    // No fresh usage on the patch → prev usedPercent carried.
    assert.equal(merged[0].usedPercent, 100);
  });

  // Case 4
  it("lets patch win when it carries usedPercent < 100", () => {
    const prev = [{ status: "rejected", resetAt: future(), usedPercent: 100 }];
    const patch = [{ status: "allowed", usedPercent: 42, remaining: 580 }];
    const merged = mergeRateLimitWindows(prev, patch);
    // Affirmative evidence the window cleared: status NOT carried.
    assert.equal(merged[0].status, "allowed");
    assert.equal(merged[0].usedPercent, 42);
    assert.equal(merged[0].remaining, 580);
  });

  // Case 5
  it("lets patch win when prev window has already reset", () => {
    const prev = [{ status: "rejected", resetAt: past(), usedPercent: 100 }];
    const patch = [{ status: "allowed" }];
    const merged = mergeRateLimitWindows(prev, patch);
    assert.equal(merged[0].status, "allowed");
    // prev is no longer current → its usedPercent is not carried either.
    assert.equal(merged[0].usedPercent, undefined);
  });

  // Case 6
  it("carries prev usedPercent when patch omits it and prev is current", () => {
    // Same severity (both allowed) so the severe-status branch is skipped;
    // the field-level carry branch fires.
    const prev = [{ status: "allowed", resetAt: future(), usedPercent: 73, remaining: 270 }];
    const patch = [{ status: "allowed" }];
    const merged = mergeRateLimitWindows(prev, patch);
    assert.equal(merged[0].status, "allowed");
    assert.equal(merged[0].usedPercent, 73);
    assert.equal(merged[0].remaining, 270);
  });

  it("does not carry prev usedPercent when prev window has reset", () => {
    const prev = [{ status: "allowed", resetAt: past(), usedPercent: 73, remaining: 270 }];
    const patch = [{ status: "allowed" }];
    const merged = mergeRateLimitWindows(prev, patch);
    assert.equal(merged[0].usedPercent, undefined);
    assert.equal(merged[0].remaining, undefined);
  });

  it("keeps a fresh patch usedPercent while carrying the severe prev status", () => {
    // prev rejected + still active; patch has usedPercent but >= 100 so it is
    // not 'cleared' evidence → severe status carried, but fresh usage kept.
    const prev = [{ status: "rejected", resetAt: future(), usedPercent: 100, remaining: 0 }];
    const patch = [{ status: "allowed", usedPercent: 100, remaining: 3 }];
    const merged = mergeRateLimitWindows(prev, patch);
    assert.equal(merged[0].status, "rejected");
    assert.equal(merged[0].usedPercent, 100);
    assert.equal(merged[0].remaining, 3);
    assert.equal(merged[0].resetAt, prev[0].resetAt);
  });
});

describe("mergeRateLimits", () => {
  it("returns a copy of prev when patch is undefined", () => {
    const prev = [{ scope: "5h", windows: [{ status: "rejected" }] }];
    const merged = mergeRateLimits(prev, undefined);
    assert.deepEqual(merged, prev);
    assert.notEqual(merged, prev);
    assert.notEqual(merged[0], prev[0]);
  });

  // Case 7
  it("matches limits by scope then name and merges their windows", () => {
    const prev = [
      {
        scope: "5h",
        name: "Five hour",
        windows: [{ status: "rejected", resetAt: future(), usedPercent: 100 }],
      },
    ];
    const patch = [{ scope: "5h", name: "Five hour", windows: [{ status: "allowed" }] }];
    const merged = mergeRateLimits(prev, patch);
    assert.equal(merged.length, 1);
    // Severe prev status carried through window merge.
    assert.equal(merged[0].windows[0].status, "rejected");
    assert.equal(merged[0].scope, "5h");
  });

  it("matches by name when scope differs", () => {
    const prev = [
      {
        scope: "old",
        name: "Weekly",
        windows: [{ status: "rejected", resetAt: future(), usedPercent: 100 }],
      },
    ];
    const patch = [{ scope: "new", name: "Weekly", windows: [{ status: "allowed" }] }];
    const merged = mergeRateLimits(prev, patch);
    assert.equal(merged[0].windows[0].status, "rejected");
    assert.equal(merged[0].scope, "new");
  });

  // Case 7b
  it("passes through a patch limit with no matching prev", () => {
    const prev = [
      { scope: "5h", windows: [{ status: "rejected", resetAt: future(), usedPercent: 100 }] },
    ];
    const patch = [{ scope: "weekly", windows: [{ status: "allowed", usedPercent: 10 }] }];
    const merged = mergeRateLimits(prev, patch);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].scope, "weekly");
    assert.equal(merged[0].windows[0].status, "allowed");
    assert.equal(merged[0].windows[0].usedPercent, 10);
  });
});

describe("overlayRateLimits", () => {
  it("merges a partial update without dropping other limits", () => {
    const prev = [
      { scope: "five_hour", windows: [{ usedPercent: 20, resetAt: future() }] },
      { scope: "seven_day", windows: [{ usedPercent: 40, resetAt: future() }] },
    ];
    const out = overlayRateLimits(prev, [
      { scope: "five_hour", windows: [{ status: "allowed_warning", usedPercent: 81 }] },
    ]);
    assert.deepEqual(
      out.map((l) => [l.scope, l.windows[0].usedPercent]),
      [
        ["five_hour", 81],
        ["seven_day", 40],
      ],
    );
    assert.equal(out[0].windows[0].status, "allowed_warning");
  });

  it("keeps a known percentage when the live event carries none", () => {
    const prev = [{ scope: "five_hour", windows: [{ usedPercent: 20, resetAt: future() }] }];
    const out = overlayRateLimits(prev, [{ scope: "five_hour", windows: [{ status: "allowed" }] }]);
    assert.equal(out[0].windows[0].usedPercent, 20);
  });

  it("appends limits the update introduces", () => {
    const prev = [{ scope: "codex", windows: [{ usedPercent: 5 }] }];
    const out = overlayRateLimits(prev, [{ scope: "gpt-x", windows: [{ usedPercent: 9 }] }]);
    assert.deepEqual(
      out.map((l) => l.scope),
      ["codex", "gpt-x"],
    );
  });
});

describe("rateLimitPollInterval", () => {
  const policy = { success: 300, backoffBase: 180, backoffMax: 900 };
  it("settles to the success interval and backs off on failures, capped", () => {
    assert.equal(rateLimitPollInterval(policy, 0), 300);
    assert.equal(rateLimitPollInterval(policy, 1), 180);
    assert.equal(rateLimitPollInterval(policy, 2), 360);
    assert.equal(rateLimitPollInterval(policy, 3), 720);
    assert.equal(rateLimitPollInterval(policy, 4), 900);
  });
});

describe("overlayRateLimits with an unkeyed limit", () => {
  it("updates the provider's one unnamed limit instead of appending a copy", () => {
    const prev = [{ windows: [{ usedPercent: 10 }] }];
    const out = overlayRateLimits(prev, [{ windows: [{ usedPercent: 30 }] }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].windows[0].usedPercent, 30);
  });
});
