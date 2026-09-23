// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { resolveConfig } from "../dist/server/config.js";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function makeConfig(overrides = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "relay-stale-test-"));
  return {
    config: resolveConfig({
      password: "test",
      logger: noopLogger,
      maxProcesses: 10,
      dbPath: join(tempDir, "sessions.db"),
      providerDirs: {
        claude: join(tempDir, ".claude"),
        codex: join(tempDir, ".codex"),
      },
      ...overrides,
    }),
    tempDir,
  };
}

/**
 * Helper: inject an external instance into the manager by directly manipulating
 * internal state. This avoids needing real `ps`/`lsof` or full JSONL parsing.
 */
function injectExternalInstance(manager, instanceId, jsonlPath, sessionId) {
  const instances = manager["instances"];
  const info = {
    id: instanceId,
    name: "Test External",
    workingDirectory: "/tmp/test",
    status: "idle",
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    external: true,
    sessionId,
  };
  const instance = {
    info,
    process: null,
    history: [],
    sessionId,
    jsonlPath,
    externalState: { jsonlPath, sessionId },
    watchState: {
      jsonlPath,
      fileOffset: 0,
      pendingTools: new Map(),
      pendingTaskCreates: new Map(),
      stats: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    },
  };
  instances.set(instanceId, instance);
  return instance;
}

describe("External session stale grace period", () => {
  let manager;
  let tempDir;
  let jsonlDir;

  beforeEach(() => {
    const setup = makeConfig();
    manager = new InstanceManager(setup.config);
    tempDir = setup.tempDir;
    jsonlDir = join(tempDir, "jsonl");
    mkdirSync(jsonlDir, { recursive: true });
  });

  it("does not mark session stopped on first missed poll", () => {
    const jsonlPath = join(jsonlDir, "test-session.jsonl");
    writeFileSync(jsonlPath, "");
    // Set mtime to the past so it doesn't trigger the "recently modified" check
    const past = new Date(Date.now() - 120_000);
    utimesSync(jsonlPath, past, past);

    injectExternalInstance(manager, "ext-1", jsonlPath, "test-session");

    // Simulate one missed discovery poll
    manager["removeStaleExternals"](new Set());

    const info = manager.getInstance("ext-1");
    assert.ok(info, "Instance should still exist");
    assert.equal(info.status, "idle", "Should still be idle after 1 miss");
    assert.ok(info.external, "Should still be external");
  });

  it("does not mark session stopped after two missed polls", () => {
    const jsonlPath = join(jsonlDir, "test-session.jsonl");
    writeFileSync(jsonlPath, "");
    const past = new Date(Date.now() - 120_000);
    utimesSync(jsonlPath, past, past);

    injectExternalInstance(manager, "ext-1", jsonlPath, "test-session");

    // Simulate two missed polls (below threshold of 3)
    manager["removeStaleExternals"](new Set());
    manager["removeStaleExternals"](new Set());

    const info = manager.getInstance("ext-1");
    assert.ok(info, "Instance should still exist");
    assert.equal(info.status, "idle", "Should still be idle after 2 misses");
  });

  it("marks session stopped after STALE_THRESHOLD (3) consecutive misses", () => {
    const jsonlPath = join(jsonlDir, "test-session.jsonl");
    writeFileSync(jsonlPath, "");
    const past = new Date(Date.now() - 120_000);
    utimesSync(jsonlPath, past, past);

    injectExternalInstance(manager, "ext-1", jsonlPath, "test-session");

    // Simulate 3 missed polls (hits the threshold)
    manager["removeStaleExternals"](new Set());
    manager["removeStaleExternals"](new Set());
    manager["removeStaleExternals"](new Set());

    const info = manager.getInstance("ext-1");
    assert.ok(info, "Instance should still exist (archived, not deleted)");
    assert.equal(info.status, "stopped", "Should be stopped after 3 misses");
  });

  it("resets stale counter when session reappears in active set", () => {
    const jsonlPath = join(jsonlDir, "test-session.jsonl");
    writeFileSync(jsonlPath, "");
    const past = new Date(Date.now() - 120_000);
    utimesSync(jsonlPath, past, past);

    injectExternalInstance(manager, "ext-1", jsonlPath, "test-session");

    // 2 misses (below threshold)
    manager["removeStaleExternals"](new Set());
    manager["removeStaleExternals"](new Set());

    // Session reappears — counter resets
    manager["removeStaleExternals"](new Set([jsonlPath]));

    // 2 more misses (still below threshold because counter was reset)
    manager["removeStaleExternals"](new Set());
    manager["removeStaleExternals"](new Set());

    const info = manager.getInstance("ext-1");
    assert.ok(info, "Instance should still exist");
    assert.equal(info.status, "idle", "Should still be idle — counter was reset");
  });

  it("keeps JSONL watcher running during grace period", () => {
    const jsonlPath = join(jsonlDir, "test-session.jsonl");
    writeFileSync(jsonlPath, "");
    const past = new Date(Date.now() - 120_000);
    utimesSync(jsonlPath, past, past);

    const instance = injectExternalInstance(manager, "ext-1", jsonlPath, "test-session");

    // Start watching so there's a watcher to preserve
    manager["startWatching"]("ext-1", instance);
    assert.ok(manager["watchIntervals"].has("ext-1"), "Watcher should be running before test");

    // 1 miss — below threshold
    manager["removeStaleExternals"](new Set());

    assert.ok(
      manager["watchIntervals"].has("ext-1"),
      "Watcher should still be running during grace period",
    );
    assert.ok(instance.externalState, "externalState should be preserved during grace period");

    // Clean up watcher
    const interval = manager["watchIntervals"].get("ext-1");
    if (interval) clearInterval(interval);
  });

  it("stops JSONL watcher when session actually ends", () => {
    const jsonlPath = join(jsonlDir, "test-session.jsonl");
    writeFileSync(jsonlPath, "");
    const past = new Date(Date.now() - 120_000);
    utimesSync(jsonlPath, past, past);

    const instance = injectExternalInstance(manager, "ext-1", jsonlPath, "test-session");

    manager["startWatching"]("ext-1", instance);

    // 3 misses — hits threshold
    manager["removeStaleExternals"](new Set());
    manager["removeStaleExternals"](new Set());
    manager["removeStaleExternals"](new Set());

    assert.ok(
      !manager["watchIntervals"].has("ext-1"),
      "Watcher should be stopped after session ends",
    );
    assert.ok(!instance.externalState, "externalState should be deleted");
  });

  it("does not count misses when JSONL was recently modified", () => {
    const jsonlPath = join(jsonlDir, "test-session.jsonl");
    writeFileSync(jsonlPath, "");
    // Keep mtime as now (recently modified)

    injectExternalInstance(manager, "ext-1", jsonlPath, "test-session");

    // Even with many "misses", the JSONL mtime resets the counter each time
    for (let i = 0; i < 10; i++) {
      // Touch the file to keep mtime fresh
      writeFileSync(jsonlPath, "");
      manager["removeStaleExternals"](new Set());
    }

    const info = manager.getInstance("ext-1");
    assert.ok(info, "Instance should still exist");
    assert.equal(
      info.status,
      "idle",
      "Should still be idle — JSONL mtime kept resetting the counter",
    );
  });

  it("handles deleted JSONL file gracefully", () => {
    const jsonlPath = join(jsonlDir, "deleted-session.jsonl");
    // Don't create the file — simulate it being deleted

    injectExternalInstance(manager, "ext-1", jsonlPath, "deleted-session");

    // Should increment stale counter (file doesn't exist)
    manager["removeStaleExternals"](new Set());
    const info1 = manager.getInstance("ext-1");
    assert.equal(info1.status, "idle", "Should still be idle after 1 miss");

    // 2 more to hit threshold
    manager["removeStaleExternals"](new Set());
    manager["removeStaleExternals"](new Set());

    const info2 = manager.getInstance("ext-1");
    assert.equal(info2.status, "stopped", "Should be stopped after 3 misses");
  });

  it("does not affect managed instances", () => {
    // Create a managed instance through the normal API
    const managed = manager.createInstance({ name: "Managed" });

    // removeStaleExternals should not touch it (no externalState)
    manager["removeStaleExternals"](new Set());
    manager["removeStaleExternals"](new Set());
    manager["removeStaleExternals"](new Set());

    const info = manager.getInstance(managed.id);
    assert.ok(info, "Managed instance should still exist");
    assert.equal(info.status, "idle", "Managed instance should still be idle");
  });

  it("tracks multiple external instances independently", () => {
    const jsonl1 = join(jsonlDir, "session-1.jsonl");
    const jsonl2 = join(jsonlDir, "session-2.jsonl");
    writeFileSync(jsonl1, "");
    writeFileSync(jsonl2, "");
    const past = new Date(Date.now() - 120_000);
    utimesSync(jsonl1, past, past);
    utimesSync(jsonl2, past, past);

    injectExternalInstance(manager, "ext-1", jsonl1, "session-1");
    injectExternalInstance(manager, "ext-2", jsonl2, "session-2");

    // 2 misses for both
    manager["removeStaleExternals"](new Set());
    manager["removeStaleExternals"](new Set());

    // ext-1 reappears, ext-2 doesn't
    manager["removeStaleExternals"](new Set([jsonl1]));

    // 1 more miss — ext-2 now at 3, ext-1 at 0
    manager["removeStaleExternals"](new Set());

    const info1 = manager.getInstance("ext-1");
    const info2 = manager.getInstance("ext-2");

    assert.equal(info1.status, "idle", "ext-1 should be idle (counter was reset)");
    assert.equal(info2.status, "stopped", "ext-2 should be stopped (3 consecutive misses)");
  });

  it("upgrades restored stopped externals with externalState when found active", () => {
    // Regression test: commit 64c5940 added externalState to restored externals,
    // which blocked upgradeRestoredExternal (it checked !externalState).
    const jsonlPath = join(jsonlDir, "restored-session.jsonl");
    writeFileSync(jsonlPath, "some content");

    // Simulate a restored external instance (has externalState, but status=stopped)
    const instance = injectExternalInstance(manager, "ext-restored", jsonlPath, "restored-session");
    instance.info.status = "stopped"; // restored from DB as stopped

    // Discovery finds the session in the active set — should upgrade to idle
    const activeJsonls = new Set([jsonlPath]);
    // removeStaleExternals should NOT remove it (it's in the active set)
    manager["removeStaleExternals"](activeJsonls);

    const info = manager.getInstance("ext-restored");
    assert.ok(info, "Instance should still exist");
    // The instance should still have externalState (not removed by stale check)
    assert.ok(instance.externalState, "externalState should be preserved");
  });

  it("upgradeRestoredExternal works on stopped externals with externalState", () => {
    // Directly test upgradeRestoredExternal — this is the code path that
    // discoverExisting() calls when it finds a known JSONL in the active set.
    const jsonlPath = join(jsonlDir, "upgrade-test.jsonl");
    writeFileSync(jsonlPath, "test content for file size");

    const instance = injectExternalInstance(manager, "ext-upgrade", jsonlPath, "upgrade-test");
    instance.info.status = "stopped";

    // Simulate what discoverExisting does: check conditions and call upgrade
    const existing = manager["instances"].get("ext-upgrade");
    assert.ok(existing);
    assert.ok(existing.info.external);
    assert.equal(existing.info.status, "stopped");
    // The key assertion: externalState exists but upgrade should still happen
    assert.ok(existing.externalState);

    manager["upgradeRestoredExternal"]("ext-upgrade", existing, jsonlPath);

    const info = manager.getInstance("ext-upgrade");
    assert.equal(info.status, "idle", "Should be upgraded to idle");

    // Clean up watcher
    const interval = manager["watchIntervals"].get("ext-upgrade");
    if (interval) clearInterval(interval);
  });

  it("cleans up staleCounts on removeInstance", () => {
    const jsonlPath = join(jsonlDir, "test-session.jsonl");
    writeFileSync(jsonlPath, "");
    const past = new Date(Date.now() - 120_000);
    utimesSync(jsonlPath, past, past);

    injectExternalInstance(manager, "ext-1", jsonlPath, "test-session");

    // Accumulate some stale counts
    manager["removeStaleExternals"](new Set());
    assert.ok(manager["staleCounts"].has("ext-1"), "Should have stale count");

    // Remove the instance
    manager.removeInstance("ext-1");
    assert.ok(!manager["staleCounts"].has("ext-1"), "Stale count should be cleaned up");
  });
});
