import "./test-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCodexAgentHistoryCache,
  getCodexAgentHistoryCacheDiagnostics,
  readCodexAgentHistory,
  resolveCodexAgentRolloutPath,
} from "../dist/server/core/providers/codex-transcript.js";

function fixture(t) {
  clearCodexAgentHistoryCache();
  const home = mkdtempSync(join(tmpdir(), "relay-codex-cache-"));
  mkdirSync(join(home, "sessions"));
  t.after(() => {
    clearCodexAgentHistoryCache();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    home,
    write(id, text = "hello") {
      const path = join(home, "sessions", `rollout-${id}.jsonl`);
      writeFileSync(
        path,
        [
          {
            type: "session_meta",
            timestamp: "2026-01-01T00:00:00Z",
            payload: { id, cwd: "/tmp/project" },
          },
          {
            type: "event_msg",
            timestamp: "2026-01-01T00:00:01Z",
            payload: { type: "agent_message", message: text },
          },
        ]
          .map(JSON.stringify)
          .join("\n"),
      );
      return path;
    },
  };
}

test("Codex child history cache bounds retained bytes and skips oversized histories without truncating them", async (t) => {
  const { home, write } = fixture(t);
  for (let index = 0; index < 6; index++)
    write(`child-${index}`, String(index).repeat(1024 * 1024));
  const first = await readCodexAgentHistory(home, "child-0");
  assert.strictEqual(await readCodexAgentHistory(home, "child-0"), first);
  let latest;
  for (let index = 1; index < 6; index++)
    latest = await readCodexAgentHistory(home, `child-${index}`);
  let stats = getCodexAgentHistoryCacheDiagnostics();
  assert.ok(stats.histories < 6, "large histories evict before the entry-count limit");
  assert.ok(stats.historyBytes <= stats.historyByteLimit);
  assert.strictEqual(await readCodexAgentHistory(home, "child-5"), latest);
  assert.notStrictEqual(
    await readCodexAgentHistory(home, "child-0"),
    first,
    "old history is reparsed after eviction",
  );
  stats = getCodexAgentHistoryCacheDiagnostics();
  const huge = "z".repeat(Math.ceil(stats.historyByteLimit / 4));
  write("oversized", huge);
  const uncached = await readCodexAgentHistory(home, "oversized");
  assert.equal(uncached.find((e) => e.message.type === "output").message.text, huge);
  assert.equal(getCodexAgentHistoryCacheDiagnostics().historyBytes, stats.historyBytes);
  assert.equal(getCodexAgentHistoryCacheDiagnostics().histories, stats.histories);
  write("child-0", "changed");
  const changed = await readCodexAgentHistory(home, "child-0");
  assert.equal(changed.find((e) => e.message.type === "output").message.text, "changed");
  assert.ok(
    getCodexAgentHistoryCacheDiagnostics().historyBytes < stats.historyBytes,
    "replacing a changed file releases its old retained-byte accounting",
  );
});

test("Codex rollout lookup cache is bounded and evicted paths remain discoverable", (t) => {
  const { home, write } = fixture(t);
  const firstPath = write("path-0000");
  for (let index = 0; index < 520; index++) {
    const id = `path-${String(index).padStart(4, "0")}`;
    const path = write(id);
    assert.equal(resolveCodexAgentRolloutPath(home, id), path);
  }
  const stats = getCodexAgentHistoryCacheDiagnostics();
  assert.equal(stats.paths, 512);
  assert.ok(stats.pathBytes <= stats.pathByteLimit);
  assert.equal(resolveCodexAgentRolloutPath(home, "path-0000"), firstPath);
  clearCodexAgentHistoryCache();
  assert.equal(getCodexAgentHistoryCacheDiagnostics().historyBytes, 0);
  assert.equal(getCodexAgentHistoryCacheDiagnostics().pathBytes, 0);
});
