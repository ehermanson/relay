import "./test-env.js";
/**
 * Per-turn git attribution: files a managed chat changed during a turn by any
 * means (Bash, scripts, commits) join its file set as `origin: "worktree"`,
 * arrive as file_stats, and replay from session_events. Provider-neutral.
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
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });

class FakeProviderSession extends EventEmitter {
  constructor(provider) {
    super();
    this.provider = provider;
    this.isProcessing = false;
    this.pid = undefined;
    this.stats = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  }
  send() {
    this.isProcessing = true;
  }
  interrupt() {}
  close() {}
  setModel() {}
  addAllowedTool() {}
  setRuntimeMode() {}
  setSessionId() {}
  getRuntimeBinding() {
    return { provider: this.provider, providerSessionId: `fake-${this.provider}-session` };
  }
  respondToRequest() {
    return false;
  }
}

for (const provider of ["claude", "codex"]) {
  describe(`worktree change attribution (${provider})`, () => {
    const cleanups = [];
    afterEach(() => {
      for (const fn of cleanups.splice(0)) fn();
    });

    function makeManager(config) {
      const manager = new InstanceManager(config);
      cleanups.unshift(() => {
        try {
          manager.stopAll();
        } catch {
          // already stopped by the test
        }
      });
      manager.fileStatsDebouncer.delayMs = 60;
      return manager;
    }

    async function bootChat({ beforeSend } = {}) {
      const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "relay-worktree-attr-")));
      cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));
      const repo = join(tempDir, "repo");
      execFileSync("mkdir", ["-p", repo]);
      git(repo, "init", "-q", "-b", "main");
      writeFileSync(join(repo, "a.txt"), "one\n");
      writeFileSync(join(repo, "pre.txt"), "pre\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "init");
      const config = resolveConfig({
        password: "test",
        logger: noopLogger,
        maxProcesses: 3,
        dbPath: join(tempDir, "sessions.db"),
        providerDirs: { claude: join(tempDir, ".claude"), codex: join(tempDir, ".codex") },
        workingDirectory: repo,
      });
      const manager = makeManager(config);
      const proc = new FakeProviderSession(provider);
      manager.createProviderSession = () => proc;
      const info = manager.createInstance({ provider, workingDirectory: repo });
      const stats = [];
      const fileLists = [];
      manager.on("instance:file_stats", (_id, m) => stats.push(m.files));
      manager.on("instance:activity", (_id, m) => {
        if (m.activity === "file_list") fileLists.push(m.files);
      });
      beforeSend?.(repo);
      await manager.sendMessage(info.id, "change things");
      await manager.worktreeReconcileIdle(info.id);
      return { manager, proc, id: info.id, repo, config, stats, fileLists };
    }

    async function endTurn(manager, proc, id) {
      proc.isProcessing = false;
      proc.emit("output", { type: "output", text: "", isWaiting: true });
      // The emit enqueues the turn-end mutation synchronously; wait on the
      // queue + reconcile, then the stats pass they schedule — no timing.
      await manager.worktreeReconcileIdle(id);
      await manager.fileStatsDebouncer.idle(id);
      await manager.worktreeReconcileIdle(id);
    }

    it("attributes a Bash-style write and enriches its stats", async () => {
      const { manager, proc, id, repo, stats, fileLists } = await bootChat();
      writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
      writeFileSync(join(repo, "script-out.txt"), "x\ny\n");
      await endTurn(manager, proc, id);

      assert.equal(fileLists.length, 0, "never a file_list activity");
      assert.ok(stats.length >= 1);
      const first = stats[0];
      assert.deepEqual(first.map((f) => [f.path, f.type, f.origin, f.editCount]).sort(), [
        [join(repo, "a.txt"), "edited", "worktree", 1],
        [join(repo, "script-out.txt"), "added", "worktree", 1],
      ]);
      const last = new Map(stats.at(-1).map((f) => [f.path, f]));
      assert.equal(last.get(join(repo, "a.txt")).additions, 1);
      assert.equal(last.get(join(repo, "a.txt")).deletions, 0);
      assert.equal(last.get(join(repo, "script-out.txt")).additions, 2);
      assert.equal(manager.getInstance(id).status, "idle");
    });

    it("does not attribute files dirtied before the turn", async () => {
      const { manager, proc, id, repo, stats } = await bootChat({
        beforeSend: (r) => writeFileSync(join(r, "pre.txt"), "dirty before send\n"),
      });
      writeFileSync(join(repo, "a.txt"), "during\n");
      await endTurn(manager, proc, id);
      const paths = stats.at(-1).map((f) => f.path);
      assert.deepEqual(paths, [join(repo, "a.txt")]);
    });

    it("keeps tool-tracked entries as they are", async () => {
      const { manager, proc, id, repo, stats } = await bootChat();
      writeFileSync(join(repo, "a.txt"), "tool edit\n");
      proc.emit("activity", {
        type: "activity",
        activity: "file_list",
        files: [{ path: join(repo, "a.txt"), editCount: 3, type: "edited" }],
      });
      writeFileSync(join(repo, "bash.txt"), "bash\n");
      await endTurn(manager, proc, id);
      const files = new Map(stats.at(-1).map((f) => [f.path, f]));
      assert.equal(files.get(join(repo, "a.txt")).origin, undefined);
      assert.equal(files.get(join(repo, "a.txt")).editCount, 3);
      assert.equal(files.get(join(repo, "bash.txt")).origin, "worktree");

      // A later tool file_list (the provider's whole set) keeps git-detected files.
      proc.emit("activity", {
        type: "activity",
        activity: "file_list",
        files: [{ path: join(repo, "a.txt"), editCount: 4, type: "edited" }],
      });
      await manager.worktreeReconcileIdle(id);
      assert.ok(manager.instances.get(id).files.has(join(repo, "bash.txt")));
    });

    it("attributes files committed during the turn", async () => {
      const { manager, proc, id, repo, stats } = await bootChat();
      writeFileSync(join(repo, "a.txt"), "committed\n");
      writeFileSync(join(repo, "c.txt"), "new committed\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "agent commit");
      await endTurn(manager, proc, id);
      assert.deepEqual(
        stats
          .at(-1)
          .map((f) => [f.path, f.type])
          .sort(),
        [
          [join(repo, "a.txt"), "edited"],
          [join(repo, "c.txt"), "added"],
        ],
      );
    });

    it("reconciles the finished turn before draining a queued message", async () => {
      const { manager, proc, id, repo, stats } = await bootChat();
      await manager.sendMessage(id, "queued follow-up");
      writeFileSync(join(repo, "turn1.txt"), "1\n");
      await endTurn(manager, proc, id);
      assert.ok(stats.at(-1).some((f) => f.path === join(repo, "turn1.txt")));
      // turn1.txt is now part of the next turn's baseline: unchanged → not re-added.
      writeFileSync(join(repo, "turn2.txt"), "2\n");
      await endTurn(manager, proc, id);
      const paths = stats
        .at(-1)
        .map((f) => f.path)
        .sort();
      assert.deepEqual(paths, [join(repo, "turn1.txt"), join(repo, "turn2.txt")]);
      assert.equal(manager.instances.get(id).files.get(join(repo, "turn1.txt")).editCount, 1);
    });

    it("replays detected files without surfacing a system event", async () => {
      const { manager, proc, id, repo, config } = await bootChat();
      writeFileSync(join(repo, "bash.txt"), "bash\n");
      await endTurn(manager, proc, id);
      manager.stopAll();

      const restored = makeManager(config);
      restored.restoreInstances();
      assert.ok(restored.getInstance(id), "managed chat restored");
      const history = restored.getHistory(id);
      assert.equal(
        history.some((e) => e.message.type === "system_event"),
        false,
        "files_detected is bookkeeping, not a visible event",
      );
      const lastFileList = history
        .filter((e) => e.message.type === "activity" && e.message.activity === "file_list")
        .at(-1);
      assert.ok(lastFileList, "history carries a file_list");
      const file = lastFileList.message.files.find((f) => f.path === join(repo, "bash.txt"));
      assert.ok(file);
      assert.equal(file.origin, "worktree");
      assert.equal(file.type, "added");
    });
  });
}
