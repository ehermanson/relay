// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
/**
 * Live delegated-agent frames and chat state.
 *
 * A background child keeps emitting output/activity after the root turn has
 * gone idle. Those frames are recorded in history and broadcast, but they must
 * never drive the chat's own status, plan file, pending permission, or preview.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { resolveConfig } from "../dist/server/config.js";

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

class FakeProviderSession extends EventEmitter {
  constructor() {
    super();
    this.provider = "claude";
    this.isProcessing = false;
    this.pid = undefined;
    this.stats = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
    this.sent = [];
  }
  send(text) {
    this.sent.push(text);
  }
  interrupt() {}
  close() {}
  setModel() {}
  addAllowedTool() {}
  setRuntimeMode() {}
  setSessionId() {}
  getRuntimeBinding() {
    return { provider: "claude", providerSessionId: "fake-session" };
  }
  respondToRequest() {
    return false;
  }
}

function tick(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("live delegated-agent frames", () => {
  const cleanups = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  async function bootChat() {
    const tempDir = mkdtempSync(join(tmpdir(), "relay-agent-events-"));
    const manager = new InstanceManager(
      resolveConfig({
        password: "test",
        logger: noopLogger,
        maxProcesses: 3,
        dbPath: join(tempDir, "sessions.db"),
        providerDirs: { claude: join(tempDir, ".claude"), codex: join(tempDir, ".codex") },
        workingDirectory: tempDir,
      }),
    );
    cleanups.push(() => {
      manager.stopAll();
      rmSync(tempDir, { recursive: true, force: true });
    });
    const proc = new FakeProviderSession();
    manager.createProviderSession = () => proc;
    const info = manager.createInstance({ provider: "claude" });
    await manager.sendMessage(info.id, "delegate this");
    await tick();
    const instance = manager.instances.get(info.id);
    assert.equal(instance.process, proc, "fake process wired");
    assert.equal(instance.info.status, "processing");
    return { manager, proc, instance, id: info.id };
  }

  it("child output/activity never flips an idle chat back to processing", async () => {
    const { manager, proc, instance, id } = await bootChat();
    const outputs = [];
    const activities = [];
    manager.on("instance:output", (_id, m) => outputs.push(m));
    manager.on("instance:activity", (_id, m) => activities.push(m));

    // Root turn ends: chat goes idle.
    proc.emit("output", { type: "output", text: "", isWaiting: true });
    await tick();
    assert.equal(instance.info.status, "idle");

    // Background child keeps working.
    proc.emit("output", {
      type: "output",
      text: "child progress",
      isWaiting: false,
      agentId: "toolu_child",
    });
    proc.emit("activity", {
      type: "activity",
      activity: "tool_use",
      tool: "Edit",
      input: { file_path: "/x/plan.md" },
      agentId: "toolu_child",
      permissionDenied: "Edit",
    });
    await tick();

    assert.equal(instance.info.status, "idle", "attributed frames do not set processing");
    assert.equal(instance.planFilePath, undefined, "child edits never become the plan file");
    assert.equal(
      instance.info.pendingPermission,
      undefined,
      "child denial never becomes chat pending state",
    );
    assert.notEqual(instance.info.lastMessage?.text, "child progress", "preview stays the root's");

    // ...but they are recorded and broadcast for the nested transcript.
    assert.ok(
      instance.history.some(
        (e) => e.message.type === "output" && e.message.agentId === "toolu_child",
      ),
    );
    assert.ok(
      instance.history.some(
        (e) => e.message.type === "activity" && e.message.agentId === "toolu_child",
      ),
    );
    assert.ok(outputs.some((m) => m.agentId === "toolu_child"));
    assert.ok(activities.some((m) => m.agentId === "toolu_child"));

    // Control: an unattributed root activity still drives status.
    proc.emit("activity", { type: "activity", activity: "tool_use", tool: "Read", input: {} });
    await tick();
    assert.equal(instance.info.status, "processing");
    assert.equal(manager.instances.get(id)?.info.status, "processing");
  });

  it("a child's isWaiting never ends the root turn", async () => {
    const { proc, instance } = await bootChat();
    proc.emit("output", { type: "output", text: "", isWaiting: true, agentId: "toolu_child" });
    await tick();
    assert.equal(instance.info.status, "processing", "root turn still in flight");
  });
});
