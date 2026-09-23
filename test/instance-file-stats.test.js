import "./test-env.js";
/**
 * Per-edit diff stats are debounced: every file_list is emitted immediately
 * (in order, with last-known stats), one trailing git pass per chat follows a
 * burst, and its result arrives as a separate file_stats event.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { resolveConfig } from "../dist/server/config.js";

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

class FakeProviderSession extends EventEmitter {
  constructor() {
    super();
    this.provider = "claude";
    this.isProcessing = false;
    this.pid = undefined;
    this.stats = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  }
  send() {}
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

describe("debounced file diff stats", () => {
  const cleanups = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  async function bootChat() {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "relay-file-stats-")));
    const repo = join(tempDir, "repo");
    execFileSync("mkdir", ["-p", repo]);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "one\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"],
      { cwd: repo },
    );
    const manager = new InstanceManager(
      resolveConfig({
        password: "test",
        logger: noopLogger,
        maxProcesses: 3,
        dbPath: join(tempDir, "sessions.db"),
        providerDirs: { claude: join(tempDir, ".claude"), codex: join(tempDir, ".codex") },
        workingDirectory: repo,
      }),
    );
    cleanups.push(() => {
      manager.stopAll();
      rmSync(tempDir, { recursive: true, force: true });
    });
    manager.fileStatsDebouncer.delayMs = 60;
    const proc = new FakeProviderSession();
    manager.createProviderSession = () => proc;
    const info = manager.createInstance({ provider: "claude", workingDirectory: repo });
    await manager.sendMessage(info.id, "edit files");
    await tick();
    return { manager, proc, id: info.id, repo };
  }

  it("emits every file_list immediately and runs one enrichment per burst", async () => {
    const { manager, proc, id, repo } = await bootChat();
    let runs = 0;
    const original = manager.refreshFileStats.bind(manager);
    manager.refreshFileStats = async (key) => {
      runs++;
      return original(key);
    };
    const events = [];
    manager.on("instance:activity", (_id, m) => {
      if (m.activity === "file_list") events.push({ type: "file_list", files: m.files });
    });
    manager.on("instance:file_stats", (_id, m) =>
      events.push({ type: "file_stats", files: m.files }),
    );

    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
    const path = join(repo, "a.txt");
    const N = 8;
    for (let i = 1; i <= N; i++) {
      proc.emit("activity", {
        type: "activity",
        activity: "file_list",
        files: [{ path, editCount: i, type: "edited" }],
      });
    }
    await tick(20);
    assert.equal(
      events.filter((e) => e.type === "file_list").length,
      N,
      "no file_list is held back",
    );
    assert.deepEqual(
      events.map((e) => e.files[0].editCount),
      Array.from({ length: N }, (_, i) => i + 1),
      "order preserved",
    );
    assert.equal(runs, 0, "enrichment waits for the quiet period");

    await tick(300);
    await manager.fileStatsDebouncer.idle(id);
    assert.equal(runs, 1, "one enrichment for the whole burst");
    const stats = events.filter((e) => e.type === "file_stats");
    assert.equal(stats.length, 1);
    assert.equal(events.at(-1).type, "file_stats", "stats arrive after the burst");
    assert.equal(stats[0].files[0].additions, 2);
    assert.equal(stats[0].files[0].deletions, 0);

    // The next file_list carries the last-known stats instead of dropping them.
    proc.emit("activity", {
      type: "activity",
      activity: "file_list",
      files: [{ path, editCount: N + 1, type: "edited" }],
    });
    await tick(10);
    const last = events.filter((e) => e.type === "file_list").at(-1);
    assert.equal(last.files[0].additions, 2);
  });

  it("forces a stats refresh at turn end", async () => {
    const { manager, proc, id, repo } = await bootChat();
    manager.fileStatsDebouncer.delayMs = 10_000;
    const stats = [];
    manager.on("instance:file_stats", (_id, m) => stats.push(m));
    writeFileSync(join(repo, "a.txt"), "changed\n");
    proc.emit("activity", {
      type: "activity",
      activity: "file_list",
      files: [{ path: join(repo, "a.txt"), editCount: 1, type: "edited" }],
    });
    await tick(20);
    proc.emit("output", { type: "output", text: "", isWaiting: true });
    await tick(50);
    await manager.fileStatsDebouncer.idle(id);
    assert.equal(stats.length, 1, "turn end does not wait for the debounce window");
    assert.equal(stats[0].files[0].additions, 1);
    assert.equal(stats[0].files[0].deletions, 1);
  });
});
