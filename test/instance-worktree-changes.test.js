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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { resolveConfig } from "../dist/server/config.js";

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
const EARLIER = "2020-01-01T00:00:00Z";
const gitEarlier = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: EARLIER, GIT_COMMITTER_DATE: EARLIER },
  });

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

    it("does not claim files a pull brought in during the turn", async () => {
      const { manager, proc, id, repo } = await bootChat({
        beforeSend: (r) => {
          const origin = `${r}-origin`;
          git(r, "clone", "-q", "--bare", ".", origin);
          git(r, "remote", "add", "origin", origin);
          git(r, "fetch", "-q", "origin");
          git(r, "branch", "-q", "--set-upstream-to=origin/main", "main");
          const other = `${r}-other`;
          git(r, "clone", "-q", origin, other);
          writeFileSync(join(other, "upstream.txt"), "theirs\n");
          git(other, "add", ".");
          gitEarlier(other, "commit", "-q", "-m", "upstream");
          git(other, "push", "-q", "origin", "HEAD:main");
        },
      });
      git(repo, "pull", "-q", "--ff-only");
      writeFileSync(join(repo, "a.txt"), "mine\n");
      await endTurn(manager, proc, id);
      assert.deepEqual(
        [...manager.instances.get(id).files.keys()],
        [join(repo, "a.txt")],
        "only the turn's own edit",
      );
    });

    it("attributes a turn the provider started itself", async () => {
      const { manager, proc, id, repo } = await bootChat();
      await endTurn(manager, proc, id);
      assert.equal(manager.getInstance(id).status, "idle");

      proc.emit("activity", { type: "activity", activity: "thinking", description: "Thinking" });
      await manager.worktreeReconcileIdle(id);
      assert.equal(manager.getInstance(id).status, "processing");
      writeFileSync(join(repo, "woke.txt"), "after a background task\n");
      await endTurn(manager, proc, id);
      assert.ok(manager.instances.get(id).files.has(join(repo, "woke.txt")));
    });

    it("does not extend the baseline over changes made while idle", async () => {
      const { manager, proc, id, repo } = await bootChat();
      await endTurn(manager, proc, id);
      writeFileSync(join(repo, "while-idle.txt"), "the user's own edit\n");
      await manager.sendMessage(id, "next turn");
      writeFileSync(join(repo, "during.txt"), "the turn's edit\n");
      await endTurn(manager, proc, id);
      assert.deepEqual([...manager.instances.get(id).files.keys()], [join(repo, "during.txt")]);
    });

    it("reconciles a turn a restart interrupted", async () => {
      const { manager, id, repo, config } = await bootChat({
        beforeSend: (r) => writeFileSync(join(r, "pre.txt"), "dirty before send\n"),
      });
      writeFileSync(join(repo, "mid-turn.txt"), "written before the restart\n");
      manager.stopAll();

      const restored = makeManager(config);
      restored.autoContinueAfterRestart = () => {};
      restored.restoreInstances();
      assert.ok(restored.instances.get(id).turnWorktreeBaseline, "baseline survived the restart");

      restored.recoverTurnBaselines();
      await restored.worktreeReconcileIdle(id);
      assert.deepEqual([...restored.instances.get(id).files.keys()], [join(repo, "mid-turn.txt")]);
      assert.deepEqual(restored.db.getTurnBaselines(), [], "reconciled once");
    });

    it("keeps the original baseline when a restarted turn resumes", async () => {
      const { manager, id, repo, config } = await bootChat();
      writeFileSync(join(repo, "before-restart.txt"), "1\n");
      manager.stopAll();

      const restored = makeManager(config);
      const proc = new FakeProviderSession(provider);
      restored.createProviderSession = () => proc;
      restored.autoContinueAfterRestart = () => {};
      restored.restoreInstances();
      await restored.sendMessage(id, "carry on");
      restored.recoverTurnBaselines();
      await restored.worktreeReconcileIdle(id);
      assert.ok(restored.instances.get(id).turnWorktreeBaseline, "still tracking the turn");

      writeFileSync(join(repo, "after-restart.txt"), "2\n");
      await endTurn(restored, proc, id);
      const files = restored.instances.get(id).files;
      assert.ok(files.has(join(repo, "before-restart.txt")));
      assert.ok(files.has(join(repo, "after-restart.txt")));
    });

    it("clears the stored baseline when the turn ends", async () => {
      const { manager, proc, id } = await bootChat();
      assert.equal(manager.db.getTurnBaselines().length, 1);
      await endTurn(manager, proc, id);
      assert.deepEqual(manager.db.getTurnBaselines(), []);
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

describe("worktree change attribution across an agent-entered worktree", () => {
  const cleanups = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  async function boot() {
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "relay-entered-worktree-")));
    cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));
    const repo = join(tempDir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\n");
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
    const manager = new InstanceManager(config);
    cleanups.unshift(() => manager.stopAll());
    manager.fileStatsDebouncer.delayMs = 60;
    const proc = new FakeProviderSession("claude");
    manager.createProviderSession = () => proc;
    const info = manager.createInstance({ provider: "claude", workingDirectory: repo });
    // Filed under another project dir, as Claude does when a session changes
    // worktree: only the lookup by session id finds it.
    const projectDir = join(tempDir, ".claude", "projects", "-relocated");
    mkdirSync(projectDir, { recursive: true });
    const transcript = join(projectDir, "fake-claude-session.jsonl");
    writeFileSync(transcript, "");
    manager.instances.get(info.id).jsonlPath = transcript;

    const enter = (worktreePath) =>
      writeFileSync(
        transcript,
        `${JSON.stringify({
          type: "worktree-state",
          worktreeSession: {
            originalCwd: repo,
            worktreePath,
            worktreeName: "wt",
            worktreeBranch: "wt",
            sessionId: "s1",
          },
          sessionId: "s1",
        })}\n`,
      );
    const exit = () =>
      writeFileSync(
        transcript,
        `${JSON.stringify({ type: "worktree-state", worktreeSession: null, sessionId: "s1" })}\n`,
      );
    const endTurn = async () => {
      proc.isProcessing = false;
      proc.emit("output", { type: "output", text: "", isWaiting: true });
      await manager.worktreeReconcileIdle(info.id);
      await manager.fileStatsDebouncer.idle(info.id);
      await manager.worktreeReconcileIdle(info.id);
    };
    const paths = () => [...(manager.instances.get(info.id).files?.keys() ?? [])].sort();
    return { manager, id: info.id, repo, tempDir, enter, exit, endTurn, paths };
  }

  function addWorktree(repo, tempDir) {
    const worktree = join(tempDir, "wt");
    git(repo, "worktree", "add", "-q", worktree, "-b", "wt");
    return worktree;
  }

  it("sees edits and commits when the agent enters the worktree mid-turn", async () => {
    const { manager, id, repo, tempDir, enter, endTurn, paths } = await boot();
    await manager.sendMessage(id, "work in a worktree");
    const worktree = addWorktree(repo, tempDir);
    enter(worktree);
    writeFileSync(join(worktree, "committed.txt"), "c\n");
    git(worktree, "add", ".");
    git(worktree, "commit", "-q", "-m", "worktree commit");
    writeFileSync(join(worktree, "bash.txt"), "b\n");
    await endTurn();
    assert.deepEqual(paths(), [join(worktree, "bash.txt"), join(worktree, "committed.txt")]);
  });

  it("baselines the worktree for a turn that starts inside it", async () => {
    const { manager, id, repo, tempDir, enter, endTurn, paths } = await boot();
    const worktree = addWorktree(repo, tempDir);
    enter(worktree);
    writeFileSync(join(worktree, "pre.txt"), "already dirty\n");
    await manager.sendMessage(id, "keep going");
    writeFileSync(join(worktree, "during.txt"), "d\n");
    await endTurn();
    assert.deepEqual(paths(), [join(worktree, "during.txt")]);
  });

  it("does not claim the spawn checkout's dirt when the agent exits the worktree", async () => {
    const { manager, id, repo, tempDir, enter, exit, endTurn, paths } = await boot();
    const worktree = addWorktree(repo, tempDir);
    enter(worktree);
    writeFileSync(join(repo, "someone-elses.txt"), "dirty\n");
    await manager.sendMessage(id, "finish up");
    writeFileSync(join(worktree, "last.txt"), "l\n");
    exit();
    await endTurn();
    assert.deepEqual(paths(), [join(worktree, "last.txt")]);
  });

  it("reports stats and the diff root from the worktree", async () => {
    const { manager, id, repo, tempDir, enter, endTurn } = await boot();
    const worktree = addWorktree(repo, tempDir);
    enter(worktree);
    await manager.sendMessage(id, "edit");
    writeFileSync(join(worktree, "a.txt"), "one\ntwo\n");
    await endTurn();
    assert.equal(manager.instances.get(id).files.get(join(worktree, "a.txt")).additions, 1);
    await manager.refreshGitBranchStateAsync(id, manager.instances.get(id));
    assert.deepEqual(manager.getInstanceDiffRoots(id), [worktree]);
  });

  it("reports a symlinked chat's diff root in both spellings, from a subdirectory too", async () => {
    const { manager, repo, tempDir } = await boot();
    const link = join(tempDir, "link");
    symlinkSync(repo, link);
    mkdirSync(join(repo, "sub"));
    for (const [cwd, label] of [
      [link, "at the root"],
      [join(link, "sub"), "in a subdirectory"],
    ]) {
      const info = manager.createInstance({ provider: "claude", workingDirectory: cwd });
      assert.deepEqual(manager.getInstanceDiffRoots(info.id), [link, repo], label);
    }
  });
});
