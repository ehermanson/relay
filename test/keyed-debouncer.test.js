import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KeyedTrailingDebouncer } from "../dist/server/core/keyed-debouncer.js";

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

describe("KeyedTrailingDebouncer", () => {
  it("coalesces a burst into one trailing run", async () => {
    const runs = [];
    const d = new KeyedTrailingDebouncer({
      delayMs: 30,
      maxWaitMs: 1000,
      run: async (key) => {
        runs.push(key);
      },
    });
    for (let i = 0; i < 20; i++) d.schedule("a");
    await tick(80);
    assert.deepEqual(runs, ["a"]);
    assert.equal(d.isPending("a"), false);
  });

  it("never defers past maxWait during a continuous burst", async () => {
    let runs = 0;
    const d = new KeyedTrailingDebouncer({
      delayMs: 40,
      maxWaitMs: 100,
      run: async () => {
        runs++;
      },
    });
    const start = Date.now();
    while (Date.now() - start < 180) {
      d.schedule("a");
      await tick(10);
    }
    assert.ok(runs >= 1, "ran at least once during the burst");
    d.cancel("a");
  });

  it("never overlaps itself; requests during a run produce exactly one rerun", async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const d = new KeyedTrailingDebouncer({
      delayMs: 5,
      maxWaitMs: 100,
      run: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        runs++;
        await tick(40);
        active--;
      },
    });
    d.schedule("a");
    await tick(15); // run in flight
    for (let i = 0; i < 5; i++) d.schedule("a");
    await d.idle("a");
    assert.equal(maxActive, 1);
    assert.equal(runs, 2);
  });

  it("immediate skips the quiet period; cancel drops queued work", async () => {
    let runs = 0;
    const d = new KeyedTrailingDebouncer({
      delayMs: 1000,
      maxWaitMs: 5000,
      run: async () => {
        runs++;
      },
    });
    d.schedule("a", { immediate: true });
    await tick(10);
    assert.equal(runs, 1);
    d.schedule("b");
    d.cancel("b");
    await tick(20);
    assert.equal(runs, 1);
    assert.equal(d.isPending("b"), false);
  });

  it("keys are independent", async () => {
    const runs = [];
    const d = new KeyedTrailingDebouncer({
      delayMs: 10,
      maxWaitMs: 100,
      run: async (key) => {
        runs.push(key);
      },
    });
    d.schedule("a");
    d.schedule("b");
    d.schedule("a");
    await tick(40);
    assert.deepEqual(runs.sort(), ["a", "b"]);
  });
});
