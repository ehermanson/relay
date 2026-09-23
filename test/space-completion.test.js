import "./test-env.js";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { TEST_WORKTREE_BASE } from "./test-env.js";

const previousRelayHome = process.env.RELAY_HOME;
const relayHome = mkdtempSync(join(tmpdir(), "relay-space-completion-home-"));
process.env.RELAY_HOME = relayHome;

const [{ SessionDB }, { noopLogger }, { SpaceManager, SpaceCompletionError }, git, pr] =
  await Promise.all([
    import("../dist/server/core/db.js"),
    import("../dist/server/core/logger.js"),
    import("../dist/server/core/space-manager.js"),
    import("../dist/server/core/git.js"),
    import("../dist/server/core/space-pr.js"),
  ]);

after(() => {
  if (previousRelayHome === undefined) delete process.env.RELAY_HOME;
  else process.env.RELAY_HOME = previousRelayHome;
  rmSync(relayHome, { recursive: true, force: true });
});

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: "pipe" }).toString().trim();

function createRepo(root) {
  const repoDir = join(root, "repo");
  execSync("git init -b main repo", { cwd: root, stdio: "pipe" });
  writeFileSync(join(repoDir, "README.md"), "# Space test\n");
  sh("git add -A && git commit -m initial", repoDir);
  return repoDir;
}

describe("Space completion", () => {
  let tempDir;
  let repoDir;
  let db;
  let manager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-space-completion-"));
    repoDir = createRepo(tempDir);
    db = new SessionDB(join(tempDir, "sessions.db"), noopLogger);
    manager = new SpaceManager(db, noopLogger);
  });

  afterEach(() => {
    try {
      sh("git worktree prune", repoDir);
    } catch {
      // best effort
    }
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("records the base branch at creation and uses it as the target", async () => {
    const space = await manager.createSpace(repoDir, { name: "Base", baseBranch: "main" });
    assert.equal(space.baseBranch, "main");
  });

  it("merges into the target branch while the main checkout is on another branch", async () => {
    const space = await manager.createSpace(repoDir, { name: "Target" });
    writeFileSync(join(space.worktreePath, "feature.txt"), "space work\n");

    sh("git checkout -b other", repoDir);
    writeFileSync(join(repoDir, "scratch.txt"), "untracked on other\n");
    const otherHead = sh("git rev-parse HEAD", repoDir);

    const stopped = [];
    manager.setSpaceChatStopper((id) => {
      stopped.push(id);
      return 0;
    });

    const result = await manager.completeSpace(space.id, { mergeMethod: "squash" });
    assert.equal(result.targetBranch, "main");
    assert.equal(result.updatedCheckout, null);
    assert.deepEqual(stopped, [space.id]);

    // Main checkout untouched: still on `other`, same HEAD, untracked file kept.
    assert.equal(sh("git rev-parse --abbrev-ref HEAD", repoDir), "other");
    assert.equal(sh("git rev-parse HEAD", repoDir), otherHead);
    assert.equal(existsSync(join(repoDir, "feature.txt")), false);
    assert.equal(readFileSync(join(repoDir, "scratch.txt"), "utf8"), "untracked on other\n");

    // `main` received the squash commit.
    assert.equal(sh("git show main:feature.txt", repoDir), "space work");
    assert.equal(sh("git rev-parse main", repoDir), result.mergeCommit);
    assert.equal(manager.getSpace(space.id).status, "completed");
    assert.equal(existsSync(space.worktreePath), false);
  });

  it("does not let untracked files in the main checkout block completion, and keeps them", async () => {
    const space = await manager.createSpace(repoDir, { name: "Untracked" });
    writeFileSync(join(space.worktreePath, "feature.txt"), "space work\n");
    writeFileSync(join(repoDir, "notes.local"), "keep me\n");
    mkdirSync(join(repoDir, "tmp-dir"));
    writeFileSync(join(repoDir, "tmp-dir", "a.txt"), "keep dir\n");

    const result = await manager.completeSpace(space.id, { mergeMethod: "merge-commit" });
    assert.equal(realpathSync(result.updatedCheckout), realpathSync(repoDir));
    assert.equal(readFileSync(join(repoDir, "feature.txt"), "utf8"), "space work\n");
    assert.equal(readFileSync(join(repoDir, "notes.local"), "utf8"), "keep me\n");
    assert.equal(readFileSync(join(repoDir, "tmp-dir", "a.txt"), "utf8"), "keep dir\n");
  });

  it("refuses when the main checkout has tracked changes on the target", async () => {
    const space = await manager.createSpace(repoDir, { name: "Dirty" });
    writeFileSync(join(space.worktreePath, "feature.txt"), "space work\n");
    writeFileSync(join(repoDir, "README.md"), "local edit\n");

    await assert.rejects(
      () => manager.completeSpace(space.id),
      (err) => err instanceof SpaceCompletionError && err.code === "target_dirty",
    );
    assert.equal(manager.getSpace(space.id).status, "active");
    assert.equal(readFileSync(join(repoDir, "README.md"), "utf8"), "local edit\n");
  });

  it("returns a structured conflict and changes nothing", async () => {
    const space = await manager.createSpace(repoDir, { name: "Conflict" });
    writeFileSync(join(space.worktreePath, "README.md"), "space side\n");
    writeFileSync(join(repoDir, "README.md"), "main side\n");
    sh("git commit -am 'main change'", repoDir);
    writeFileSync(join(repoDir, "untracked.txt"), "survives\n");
    const mainHead = sh("git rev-parse HEAD", repoDir);

    await assert.rejects(
      () => manager.completeSpace(space.id, { mergeMethod: "squash" }),
      (err) => {
        assert.ok(err instanceof SpaceCompletionError);
        assert.equal(err.code, "conflict");
        assert.deepEqual(err.conflicts, ["README.md"]);
        assert.equal(err.targetBranch, "main");
        assert.match(err.message, /git merge main/);
        return true;
      },
    );
    assert.equal(sh("git rev-parse HEAD", repoDir), mainHead);
    assert.equal(sh("git status --porcelain --untracked-files=no", repoDir), "");
    assert.equal(readFileSync(join(repoDir, "untracked.txt"), "utf8"), "survives\n");
    assert.equal(manager.getSpace(space.id).status, "active");
    assert.equal(existsSync(space.worktreePath), true);
  });

  it("failed squash merge restores only merge-touched files and keeps untracked files", async () => {
    sh("git checkout -b feature", repoDir);
    writeFileSync(join(repoDir, "README.md"), "feature side\n");
    sh("git commit -am feature", repoDir);
    sh("git checkout main", repoDir);
    writeFileSync(join(repoDir, "README.md"), "main side\n");
    sh("git commit -am main", repoDir);
    writeFileSync(join(repoDir, "untracked.txt"), "survives\n");
    mkdirSync(join(repoDir, "untracked-dir"));
    writeFileSync(join(repoDir, "untracked-dir", "x.txt"), "x\n");

    const result = await git.squashMergeBranch(repoDir, "feature", "squash");
    assert.equal(result.success, false);
    assert.equal(result.error, "CONFLICT");
    assert.deepEqual(result.conflicts, ["README.md"]);
    assert.equal(readFileSync(join(repoDir, "README.md"), "utf8"), "main side\n");
    assert.equal(readFileSync(join(repoDir, "untracked.txt"), "utf8"), "survives\n");
    assert.equal(readFileSync(join(repoDir, "untracked-dir", "x.txt"), "utf8"), "x\n");
    assert.equal(sh("git status --porcelain --untracked-files=no", repoDir), "");
  });

  it("diff failures are errors, not a missing space", async () => {
    assert.equal(await manager.getSpaceDiff("missing"), null);
    const space = await manager.createSpace(repoDir, { name: "Diff" });
    db.setSpaceBaseBranch(space.id, "does-not-exist");
    await assert.rejects(() => manager.getSpaceDiff(space.id), git.GitCommandError);
  });
});

describe("Space PR flow (gh shim)", () => {
  let tempDir;
  let repoDir;
  let db;
  let manager;
  let previousPath;
  let shimLog;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-space-pr-"));
    repoDir = createRepo(tempDir);
    sh(`git init --bare -b main ${join(tempDir, "remote.git")}`, tempDir);
    sh(`git remote add origin ${join(tempDir, "remote.git")} && git push -u origin main`, repoDir);
    db = new SessionDB(join(tempDir, "sessions.db"), noopLogger);
    manager = new SpaceManager(db, noopLogger);

    const shimDir = join(tempDir, "bin");
    mkdirSync(shimDir);
    shimLog = join(tempDir, "gh.log");
    writeFileSync(
      join(shimDir, "gh"),
      `#!/bin/sh
echo "$@" >> "${shimLog}"
case "$1 $2" in
  "--version "*) echo "gh version 9.9.9"; exit 0 ;;
  "auth status") exit 0 ;;
  "pr list") echo '[{"url":"https://github.com/o/r/pull/7","number":7,"state":"OPEN"}]'; exit 0 ;;
  "pr view") echo '{"number":7,"url":"https://github.com/o/r/pull/7","title":"T","state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","reviewDecision":"","statusCheckRollup":[]}'; exit 0 ;;
  "pr create") echo "https://github.com/o/r/pull/99"; exit 0 ;;
esac
exit 1
`,
    );
    chmodSync(join(shimDir, "gh"), 0o755);
    previousPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${previousPath}`;
  });

  afterEach(() => {
    process.env.PATH = previousPath;
    try {
      sh("git worktree prune", repoDir);
    } catch {
      // best effort
    }
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reuses an existing open PR instead of creating a duplicate", async () => {
    const space = await manager.createSpace(repoDir, { name: "PR space" });
    writeFileSync(join(space.worktreePath, "feature.txt"), "work\n");

    const result = await manager.pushSpace(space.id, { createPR: true });
    assert.equal(result.pushed, true);
    assert.equal(result.prAction, "opened_existing");
    assert.equal(result.prUrl, "https://github.com/o/r/pull/7");
    const log = readFileSync(shimLog, "utf8");
    assert.match(log, /pr list --head relay-space\//);
    assert.doesNotMatch(log, /pr create/);
    const updated = manager.getSpace(space.id);
    assert.equal(updated.remoteStatus, "pr-open");
    assert.equal(updated.prUrl, "https://github.com/o/r/pull/7");

    const status = await manager.getSpacePrStatus(space.id, { force: true });
    assert.equal(status.pr.number, 7);
    assert.equal(status.pr.state, "open");
    assert.equal(manager.getSpace(space.id).prStatus.number, 7);
  });
});

describe("PR status normalization", () => {
  it("dedupes checks by workflow + name keeping the newest", () => {
    const summary = pr.summarizePrChecks([
      {
        __typename: "CheckRun",
        workflowName: "CI",
        name: "test",
        status: "COMPLETED",
        conclusion: "FAILURE",
        completedAt: "2026-01-01T00:00:00Z",
      },
      {
        __typename: "CheckRun",
        workflowName: "CI",
        name: "test",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        completedAt: "2026-01-02T00:00:00Z",
      },
      { __typename: "CheckRun", workflowName: "CI", name: "lint", status: "IN_PROGRESS" },
      {
        __typename: "CheckRun",
        workflowName: "Other",
        name: "test",
        status: "COMPLETED",
        conclusion: "SKIPPED",
      },
      { __typename: "StatusContext", context: "deploy", state: "SUCCESS" },
    ]);
    assert.deepEqual(summary, {
      total: 4,
      passing: 2,
      failing: 0,
      pending: 1,
      skipped: 1,
      state: "pending",
    });
  });

  it("normalizes state, draft, mergeable, and review", () => {
    const status = pr.normalizePrStatus(
      {
        number: 3,
        url: "https://x/pull/3",
        title: "Hello",
        state: "OPEN",
        isDraft: true,
        mergeable: "CONFLICTING",
        reviewDecision: "CHANGES_REQUESTED",
        statusCheckRollup: [{ __typename: "StatusContext", context: "ci", state: "ERROR" }],
      },
      42,
    );
    assert.equal(status.state, "draft");
    assert.equal(status.mergeable, "conflicting");
    assert.equal(status.reviewDecision, "changes_requested");
    assert.equal(status.checks.state, "failing");
    assert.equal(status.fetchedAt, 42);
    assert.equal(pr.normalizePrStatus({ state: "MERGED", number: 1, url: "u" }).state, "merged");
    assert.equal(pr.normalizePrStatus({}), null);
  });

  it("caches for 60s and backs off exponentially on failure", async () => {
    let now = 0;
    let calls = 0;
    let fail = true;
    const reader = new pr.PrStatusReader({
      now: () => now,
      read: async () => {
        calls++;
        if (fail) throw new Error("boom");
        return pr.normalizePrStatus({ number: 1, url: "u", state: "OPEN" }, now);
      },
    });
    const first = await reader.get("s", "/", "u");
    assert.equal(first.ok, false);
    assert.equal(first.retryAt, 20_000);
    now = 10_000;
    assert.equal((await reader.get("s", "/", "u")).ok, false);
    assert.equal(calls, 1, "backing off: no gh call");
    now = 20_000;
    await reader.get("s", "/", "u");
    assert.equal(calls, 2);
    assert.equal(pr.prStatusBackoffMs(2), 40_000);
    assert.equal(pr.prStatusBackoffMs(20), 15 * 60_000);
    fail = false;
    now = 60_001;
    assert.equal((await reader.get("s", "/", "u")).ok, true);
    now = 100_000;
    const cached = await reader.get("s", "/", "u");
    assert.equal(cached.ok && cached.cached, true);
    assert.equal(calls, 3);
  });
});

describe("sweepOrphanedWorktrees", () => {
  let tempDir;
  let db;
  let manager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-sweep-"));
    db = new SessionDB(join(tempDir, "sessions.db"), noopLogger);
    manager = new SpaceManager(db, noopLogger);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("removes only dangling-gitdir space dirs inside the worktree base", async () => {
    const repoDir = createRepo(tempDir);
    const valid = await manager.createSpace(repoDir, { name: "Valid" });

    const dangling = join(TEST_WORKTREE_BASE, "space-dead0001");
    mkdirSync(dangling, { recursive: true });
    writeFileSync(
      join(dangling, ".git"),
      `gitdir: ${join(tempDir, "gone", ".git", "worktrees", "x")}\n`,
    );
    writeFileSync(join(dangling, "file.txt"), "leftover\n");

    const noGit = join(TEST_WORKTREE_BASE, "space-nogit001");
    mkdirSync(noGit, { recursive: true });
    const notSpace = join(TEST_WORKTREE_BASE, "other-dangling");
    mkdirSync(notSpace, { recursive: true });
    writeFileSync(join(notSpace, ".git"), "gitdir: /nonexistent/path\n");

    // Valid but unreferenced worktree: only logged.
    const unreferenced = join(TEST_WORKTREE_BASE, "space-unref001");
    sh(`git worktree add -b unref ${unreferenced}`, repoDir);

    // Dangling but referenced by an active space: kept.
    const kept = join(TEST_WORKTREE_BASE, "space-keep0001");
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, ".git"), "gitdir: /nonexistent/keep\n");
    db.upsertSpace({
      id: "keep",
      project_directory: repoDir,
      name: "keep",
      git_branch: "relay-space/keep",
      worktree_path: kept,
      is_default: 0,
      status: "active",
      created_at: 1,
      last_activity_at: 1,
    });

    const result = await manager.sweepOrphanedWorktrees();
    // Leftovers from earlier tests (their temp repos are gone) are dangling too.
    assert.ok(result.removed.includes(dangling));
    assert.ok(!result.removed.includes(kept));
    assert.equal(existsSync(dangling), false);
    assert.equal(existsSync(noGit), true);
    assert.equal(existsSync(notSpace), true);
    assert.equal(existsSync(valid.worktreePath), true);
    assert.equal(existsSync(unreferenced), true);
    assert.ok(result.unreferenced.includes(unreferenced));
    assert.deepEqual(result.keptReferenced, [kept]);

    rmSync(noGit, { recursive: true, force: true });
    rmSync(notSpace, { recursive: true, force: true });
    rmSync(kept, { recursive: true, force: true });
  });

  it("removeWorktree falls back to deleting an untracked dir inside the base", async () => {
    const repoDir = createRepo(tempDir);
    const dir = join(TEST_WORKTREE_BASE, "space-fallbk01");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".git"), "gitdir: /nonexistent/fallback\n");
    const result = await git.removeWorktree(repoDir, dir, "nope", { keepBranch: true });
    assert.equal(result.removed, true);
    assert.equal(result.method, "fallback-delete");

    const outside = join(tempDir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, ".git"), "gitdir: /nonexistent/outside\n");
    const refused = await git.removeWorktree(repoDir, outside, "nope", { keepBranch: true });
    assert.equal(refused.removed, false);
    assert.equal(refused.method, "failed");
    assert.equal(existsSync(outside), true);
  });
});
