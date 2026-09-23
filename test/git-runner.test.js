// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runGit,
  buildGitEnv,
  buildGhEnv,
  withRepoLock,
  getRepoLockKey,
  getGitRunnerStats,
  setGitConcurrencyLimit,
  GitCommandError,
  summarizeGitOutput,
} from "../dist/server/core/git-runner.js";
import { getStatusSummary, parseNumstatZ } from "../dist/server/core/git.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });

function makeRepo(root) {
  const dir = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** `git <alias>` that runs a shell snippet — lets tests make git slow or dump env. */
const shellAlias = (name, script) => ["-c", `alias.${name}=!${script}`, name];

describe("git-runner", () => {
  let root;
  let repo;

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "relay-git-runner-")));
    repo = makeRepo(root);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("environment hardening", () => {
    it("disables prompts for every call and optional locks for reads", () => {
      const env = buildGitEnv({ readOnly: true });
      assert.equal(env.GIT_TERMINAL_PROMPT, "0");
      assert.equal(env.GCM_INTERACTIVE, "never");
      assert.equal(env.GIT_ASKPASS, "");
      assert.equal(env.SSH_ASKPASS, "");
      assert.equal(env.SSH_ASKPASS_REQUIRE, "never");
      assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
      assert.equal(buildGitEnv().GIT_OPTIONAL_LOCKS, undefined);

      const ghEnv = buildGhEnv();
      assert.equal(ghEnv.GH_PROMPT_DISABLED, "1");
      assert.equal(ghEnv.GH_NO_UPDATE_NOTIFIER, "1");
      assert.equal(ghEnv.GIT_TERMINAL_PROMPT, "0");
    });

    it("applies the hardened env to the spawned process", async () => {
      const { stdout } = await runGit(shellAlias("envdump", "env"), {
        cwd: repo,
        readOnly: true,
      });
      assert.match(stdout, /^GIT_TERMINAL_PROMPT=0$/m);
      assert.match(stdout, /^GIT_OPTIONAL_LOCKS=0$/m);
      assert.match(stdout, /^SSH_ASKPASS_REQUIRE=never$/m);
      assert.match(stdout, /^GCM_INTERACTIVE=never$/m);
    });
  });

  describe("error classification", () => {
    it("reports a timeout and kills the process", async () => {
      const started = Date.now();
      await assert.rejects(
        runGit(shellAlias("slp", "sleep 5"), { cwd: repo, timeoutMs: 200, operation: "git slp" }),
        (err) => {
          assert.ok(err instanceof GitCommandError);
          assert.equal(err.kind, "timeout");
          assert.equal(err.operation, "git slp");
          assert.equal(err.message, "git slp timed out");
          return true;
        },
      );
      assert.ok(Date.now() - started < 3000, "timed-out call should settle promptly");
    });

    it("classifies a non-repository directory as not_a_repo", async () => {
      const plain = mkdtempSync(join(tmpdir(), "relay-git-runner-plain-"));
      try {
        await assert.rejects(
          runGit(["status"], {
            cwd: plain,
            readOnly: true,
            env: { GIT_CEILING_DIRECTORIES: tmpdir() },
          }),
          { kind: "not_a_repo" },
        );
        await assert.rejects(runGit(["status"], { cwd: join(plain, "missing") }), {
          kind: "not_a_repo",
        });
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    });

    it("returns non-zero exits with allowFailure instead of throwing", async () => {
      const result = await runGit(["rev-parse", "--verify", "--quiet", "no-such-ref"], {
        cwd: repo,
        readOnly: true,
        allowFailure: true,
      });
      assert.equal(result.exitCode, 1);
    });

    it("caps output: fails by default, truncates on request", async () => {
      await assert.rejects(runGit(["log", "-1"], { cwd: repo, maxOutputBytes: 10 }), {
        kind: "output_too_large",
      });
      const truncated = await runGit(["log", "-1"], {
        cwd: repo,
        maxOutputBytes: 10,
        truncateOutput: true,
      });
      assert.equal(truncated.truncated, true);
      assert.equal(truncated.stdout.length, 10);
    });

    it("summarizes stderr to one redacted line", () => {
      assert.equal(
        summarizeGitOutput(
          "hint: ignore me\nfatal: unable to access 'https://user:tok3n@example.com/r.git/': 403\nmore",
        ),
        "unable to access 'https://***@example.com/r.git/': 403",
      );
    });

    it("retries transient index.lock errors for mutations", async () => {
      const lock = join(repo, ".git", "index.lock");
      writeFileSync(join(repo, "b.txt"), "b\n");
      writeFileSync(lock, "");
      setTimeout(() => unlinkSync(lock), 60);
      await runGit(["add", "b.txt"], { cwd: repo });
      git(repo, "reset", "-q");
      rmSync(join(repo, "b.txt"));
    });

    it("reports a persistent lock as locked", async () => {
      const lock = join(repo, ".git", "index.lock");
      writeFileSync(join(repo, "c.txt"), "c\n");
      writeFileSync(lock, "");
      try {
        await assert.rejects(runGit(["add", "c.txt"], { cwd: repo }), { kind: "locked" });
      } finally {
        unlinkSync(lock);
        rmSync(join(repo, "c.txt"));
      }
    });
  });

  describe("withRepoLock", () => {
    it("serializes mutations of one repository, including across worktrees", async () => {
      const wt = join(root, "wt-lock");
      git(repo, "worktree", "add", "-q", "-b", "lock-branch", wt);
      try {
        assert.equal(await getRepoLockKey(repo), await getRepoLockKey(wt));

        const events = [];
        const task = (name, cwd) =>
          withRepoLock(cwd, async () => {
            events.push(`start:${name}`);
            await new Promise((r) => setTimeout(r, 50));
            events.push(`end:${name}`);
          });
        await Promise.all([task("a", repo), task("b", wt), task("c", repo)]);
        assert.deepEqual(events, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
      } finally {
        git(repo, "worktree", "remove", "--force", wt);
      }
    });

    it("is re-entrant and releases after a failure", async () => {
      const nested = await withRepoLock(repo, () => withRepoLock(repo, async () => "inner"));
      assert.equal(nested, "inner");
      await assert.rejects(
        withRepoLock(repo, async () => {
          throw new Error("boom");
        }),
        /boom/,
      );
      assert.equal(await withRepoLock(repo, async () => "after"), "after");
    });
  });

  describe("concurrency cap", () => {
    it("queues short ops beyond the limit, while long ops bypass it", async () => {
      const previous = setGitConcurrencyLimit(2);
      try {
        let maxActive = 0;
        let sawQueue = false;
        const sampler = setInterval(() => {
          const stats = getGitRunnerStats();
          maxActive = Math.max(maxActive, stats.active);
          if (stats.queued > 0) sawQueue = true;
        }, 5);

        const shortOps = Array.from({ length: 5 }, () =>
          runGit(shellAlias("slp", "sleep 0.2"), { cwd: repo, timeoutMs: 5_000 }),
        );
        // A long op (network-tier timeout) must not wait for the short queue.
        const longStarted = Date.now();
        await runGit(shellAlias("quick", "true"), { cwd: repo, timeoutMs: 60_000 });
        const longElapsed = Date.now() - longStarted;

        await Promise.all(shortOps);
        clearInterval(sampler);

        assert.ok(maxActive <= 2, `active short ops exceeded the cap: ${maxActive}`);
        assert.ok(sawQueue, "expected short ops to queue");
        assert.ok(longElapsed < 400, `long op waited on the short queue (${longElapsed}ms)`);
        assert.deepEqual(getGitRunnerStats().active, 0);
      } finally {
        setGitConcurrencyLimit(previous);
      }
    });
  });
});

describe("git.ts status primitives", () => {
  let root;
  let repo;

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "relay-git-status-")));
    repo = makeRepo(root);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("getStatusSummary reports branch, upstream, and change counts in one call", async () => {
    let summary = await getStatusSummary(repo);
    assert.equal(summary.branch, "main");
    assert.equal(summary.upstream, null);
    assert.equal(summary.ahead, null);
    assert.equal(summary.dirty, false);

    writeFileSync(join(repo, "a.txt"), "changed\n");
    writeFileSync(join(repo, "new file.txt"), "n\n");
    writeFileSync(join(repo, "staged.txt"), "s\n");
    git(repo, "add", "staged.txt");
    git(repo, "mv", "a.txt", "renamed.txt");
    summary = await getStatusSummary(repo);
    assert.equal(summary.dirty, true);
    assert.equal(summary.untracked, 1);
    assert.equal(summary.changeCount, 3);
    assert.ok(summary.staged >= 2);

    const remote = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git(repo, "commit", "-q", "-am", "work");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "-u", "origin", "main");
    writeFileSync(join(repo, "later.txt"), "l\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "later");
    summary = await getStatusSummary(repo);
    assert.equal(summary.upstream, "origin/main");
    assert.equal(summary.ahead, 1);
    assert.equal(summary.behind, 0);
  });

  it("parseNumstatZ handles spaces, renames, and binary files", () => {
    const out = [
      "3\t1\tsrc/with space.ts",
      "-\t-\timage.png",
      "2\t0\t",
      "old name.ts",
      "new name.ts",
      "",
    ].join("\0");
    const parsed = parseNumstatZ(out);
    assert.deepEqual(parsed.get("src/with space.ts"), { additions: 3, deletions: 1 });
    assert.equal(parsed.has("image.png"), false);
    assert.deepEqual(parsed.get("new name.ts"), { additions: 2, deletions: 0 });
    assert.equal(parsed.size, 2);
  });
});
