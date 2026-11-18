import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MessageUsageTracker, addMessageUsage } from "../dist/server/core/message-usage.js";

const zero = () => ({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });

describe("MessageUsageTracker", () => {
  it("counts repeated records of one message once", () => {
    const stats = zero();
    const tracker = new MessageUsageTracker();
    const usage = { input_tokens: 2, output_tokens: 466, cache_read_input_tokens: 16491 };
    for (let i = 0; i < 4; i++) tracker.add(stats, "msg_a", usage);
    assert.deepEqual(stats, {
      inputTokens: 2,
      outputTokens: 466,
      cacheCreationTokens: 0,
      cacheReadTokens: 16491,
    });
  });

  it("adds only the growth when a later record's usage is larger", () => {
    const stats = zero();
    const tracker = new MessageUsageTracker();
    tracker.add(stats, "msg_a", { input_tokens: 5, output_tokens: 1 });
    tracker.add(stats, "msg_a", { input_tokens: 5, output_tokens: 40 });
    tracker.add(stats, "msg_a", { input_tokens: 5, output_tokens: 12 });
    assert.equal(stats.inputTokens, 5);
    assert.equal(stats.outputTokens, 40);
  });

  it("counts records without an id in full", () => {
    const stats = zero();
    const tracker = new MessageUsageTracker();
    tracker.add(stats, undefined, { output_tokens: 3 });
    tracker.add(stats, undefined, { output_tokens: 3 });
    assert.equal(stats.outputTokens, 6);
  });

  it("keeps one tracker per stats accumulator", () => {
    const a = zero();
    const b = zero();
    addMessageUsage(a, "msg_x", { output_tokens: 10 });
    addMessageUsage(a, "msg_x", { output_tokens: 10 });
    addMessageUsage(b, "msg_x", { output_tokens: 10 });
    assert.equal(a.outputTokens, 10);
    assert.equal(b.outputTokens, 10);
  });
});
