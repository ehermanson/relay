import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeAntigravityJson,
  parseAntigravityUsage,
} from "../dist/server/core/providers/antigravity-usage.js";

const NOW = Date.parse("2026-11-25T22:00:00Z");

// Shape captured from agy 1.5.x `agy -p /usage --output-format json`.
const usage = (groups, extra = {}) => ({
  status: "SUCCESS",
  command: { name: "usage", data: { groups } },
  ...extra,
});

const gemini = {
  name: "Gemini Models",
  buckets: [
    {
      id: "gemini-weekly",
      name: "Weekly Limit Remaining",
      window: "weekly",
      remaining_fraction: 0.93,
      reset_time: "2026-11-30T21:53:23Z",
    },
    {
      id: "gemini-5h",
      name: "Five Hour Limit Remaining",
      window: "5h",
      remaining_fraction: 1,
      reset_time: "2026-11-26T03:36:55Z",
    },
  ],
};

describe("parseAntigravityUsage", () => {
  it("maps each model group to a limit with 5h before weekly", () => {
    const limits = parseAntigravityUsage(usage([gemini]), NOW);
    assert.equal(limits.length, 1);
    assert.equal(limits[0].name, "Gemini Models");
    const [fiveHour, weekly] = limits[0].windows;
    assert.equal(fiveHour.windowMinutes, 300);
    assert.equal(fiveHour.usedPercent, 0);
    assert.equal(fiveHour.resetAt, "2026-11-26T03:36:55.000Z");
    assert.equal(weekly.windowMinutes, 10080);
    assert.ok(Math.abs(weekly.usedPercent - 7) < 1e-6);
    assert.equal(weekly.remaining, 93);
  });

  it("reads an omitted remaining_fraction on a live window as exhausted", () => {
    const limits = parseAntigravityUsage(
      usage([
        {
          name: "Gemini Models",
          buckets: [{ id: "gemini-5h", window: "5h", reset_time: "2026-11-26T03:00:00Z" }],
        },
      ]),
      NOW,
    );
    assert.equal(limits[0].windows[0].usedPercent, 100);
  });

  it("hides an unused secondary pool and shows it once it has usage", () => {
    const thirdParty = (fraction) => ({
      name: "Claude and GPT models",
      buckets: [
        {
          id: "3p-5h",
          window: "5h",
          remaining_fraction: fraction,
          reset_time: "2026-11-26T03:36:55Z",
        },
      ],
    });
    assert.equal(parseAntigravityUsage(usage([gemini, thirdParty(1)]), NOW).length, 1);
    const used = parseAntigravityUsage(usage([gemini, thirdParty(0.6)]), NOW);
    assert.deepEqual(
      used.map((l) => l.name),
      ["Gemini Models", "Claude and GPT models"],
    );
  });

  it("returns null for errors and payloads without quota", () => {
    assert.equal(parseAntigravityUsage({ status: "ERROR", error: "no account quota" }, NOW), null);
    assert.equal(parseAntigravityUsage({ status: "SUCCESS", response: "x" }, NOW), null);
    assert.equal(parseAntigravityUsage(null, NOW), null);
  });

  it("decodes JSON wrapped in log noise", () => {
    const text = `warning: something\n${JSON.stringify(usage([gemini]))}\n`;
    assert.equal(parseAntigravityUsage(decodeAntigravityJson(text), NOW).length, 1);
  });
});
