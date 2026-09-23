import "./test-env.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  isGitRepo,
  getRepoRoot,
  getCurrentBranch,
  getRemoteUrl,
  isRelayWorktreePath,
  createWorktree,
  removeWorktree,
  isWorktreeDirty,
  getWorktreeStatus,
  hasWorktreeChanges,
  commitAll,
  gitPull,
  gitFetch,
  getAheadBehind,
} from "../dist/server/core/git.js";

let seedRepoDir;

function ensureSeedRepo() {
  if (seedRepoDir) return seedRepoDir;
  seedRepoDir = mkdtempSync(join(tmpdir(), "relay-git-seed-"));
  execSync("git init -b main", { cwd: seedRepoDir, stdio: "pipe" });
  writeFileSync(join(seedRepoDir, "file.txt"), "hello");
  execSync("git add -A && git commit -m init", { cwd: seedRepoDir, stdio: "pipe" });
  return seedRepoDir;
}

function makeRepoDir() {
  const root = mkdtempSync(join(tmpdir(), "relay-git-test-"));
  const dir = join(root, "repo");
  cpSync(ensureSeedRepo(), dir, { recursive: true });
  return dir;
}

describe("isGitRepo", () => {
  let repoDir;
  let plainDir;

  beforeEach(async () => {
    repoDir = makeRepoDir();
    plainDir = mkdtempSync(join(tmpdir(), "relay-git-test-plain-"));
  });

  afterEach(async () => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(plainDir, { recursive: true, force: true });
  });

  it("returns true for a git repository", async () => {
    assert.equal(isGitRepo(repoDir), true);
  });

  it("returns true for a subdirectory within a git repo", async () => {
    const sub = join(repoDir, "subdir");
    mkdirSync(sub);
    assert.equal(isGitRepo(sub), true);
  });

  it("returns false for a non-git directory", async () => {
    assert.equal(isGitRepo(plainDir), false);
  });

  it("returns false for a nonexistent directory", async () => {
    assert.equal(isGitRepo("/tmp/nonexistent-relay-test-dir-xyz"), false);
  });
});

describe("getRepoRoot", () => {
  let repoDir;

  beforeEach(async () => {
    repoDir = makeRepoDir();
  });

  afterEach(async () => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns the repo root from the root directory", async () => {
    const expected = execSync("git rev-parse --show-toplevel", {
      cwd: repoDir,
      encoding: "utf-8",
    }).trim();
    const actual = getRepoRoot(repoDir);
    assert.ok(actual);
    assert.equal(realpathSync(actual), realpathSync(expected));
  });

  it("returns the repo root from a subdirectory", async () => {
    const sub = join(repoDir, "nested");
    mkdirSync(sub);
    const root = getRepoRoot(sub);
    assert.ok(root);
    assert.equal(getRepoRoot(repoDir), root);
  });

  it("returns null for a non-git directory", async () => {
    const plain = mkdtempSync(join(tmpdir(), "relay-git-test-"));
    try {
      assert.equal(getRepoRoot(plain), null);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("getCurrentBranch", () => {
  let repoDir;

  beforeEach(async () => {
    repoDir = makeRepoDir();
  });

  afterEach(async () => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns the default branch name", async () => {
    const branch = await getCurrentBranch(repoDir);
    assert.ok(branch);
    // Could be 'main' or 'master' depending on git config
    assert.ok(typeof branch === "string" && branch.length > 0);
  });

  it("returns the correct branch after checkout", async () => {
    execSync("git checkout -b test-branch", { cwd: repoDir, stdio: "pipe" });
    assert.equal(await getCurrentBranch(repoDir), "test-branch");
  });

  it("rejects for a non-git directory", async () => {
    const plain = mkdtempSync(join(tmpdir(), "relay-git-test-"));
    try {
      // Failure is distinguishable from "no branch" (detached HEAD → null).
      await assert.rejects(getCurrentBranch(plain), { kind: "not_a_repo" });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("returns null for detached HEAD instead of the literal HEAD ref", async () => {
    execSync("git checkout --detach", { cwd: repoDir, stdio: "pipe" });
    assert.equal(await getCurrentBranch(repoDir), null);
  });
});

describe("getRemoteUrl", () => {
  let repoDir;

  beforeEach(async () => {
    repoDir = makeRepoDir();
  });

  afterEach(async () => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("normalizes SSH URLs to HTTPS", async () => {
    execSync("git remote add origin git@github.com:owner/repo.git", {
      cwd: repoDir,
      stdio: "pipe",
    });
    assert.equal(await getRemoteUrl(repoDir), "https://github.com/owner/repo");
  });

  it("strips .git suffix from HTTPS URLs", async () => {
    execSync("git remote add origin https://github.com/owner/repo.git", {
      cwd: repoDir,
      stdio: "pipe",
    });
    assert.equal(await getRemoteUrl(repoDir), "https://github.com/owner/repo");
  });

  it("returns HTTPS URL as-is when no .git suffix", async () => {
    execSync("git remote add origin https://github.com/owner/repo", {
      cwd: repoDir,
      stdio: "pipe",
    });
    assert.equal(await getRemoteUrl(repoDir), "https://github.com/owner/repo");
  });

  it("returns null when no remote configured", async () => {
    assert.equal(await getRemoteUrl(repoDir), null);
  });

  it("rejects for a non-git directory", async () => {
    const plain = mkdtempSync(join(tmpdir(), "relay-git-test-"));
    try {
      await assert.rejects(getRemoteUrl(plain), { kind: "not_a_repo" });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("isRelayWorktreePath", () => {
  it("matches valid relay worktree paths", async () => {
    assert.equal(isRelayWorktreePath("/home/user/.relay/worktrees/abcd1234"), true);
    assert.equal(isRelayWorktreePath("/Users/me/.relay/worktrees/deadbeef/"), true);
  });

  it("rejects non-relay paths", async () => {
    assert.equal(isRelayWorktreePath("/home/user/projects/myapp"), false);
    assert.equal(isRelayWorktreePath("/home/user/.relay/uploads/abcd1234"), false);
    assert.equal(isRelayWorktreePath("/home/user/.relay/worktrees/"), false);
  });
});

describe("worktree lifecycle", () => {
  let repoDir;
  let worktreeResult;

  beforeEach(async () => {
    repoDir = makeRepoDir();
  });

  afterEach(async () => {
    // Clean up worktree if it was created
    if (worktreeResult) {
      try {
        await removeWorktree(repoDir, worktreeResult.worktreePath, worktreeResult.branchName);
      } catch {
        // ignore
      }
    }
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("createWorktree creates a worktree and branch", async () => {
    worktreeResult = await createWorktree(repoDir, "test1234");
    assert.ok(worktreeResult);
    assert.ok(worktreeResult.worktreePath.includes("test1234"));
    assert.equal(worktreeResult.branchName, "relay/test1234");

    // Verify the worktree is a valid git repo
    assert.equal(isGitRepo(worktreeResult.worktreePath), true);
    assert.equal(await getCurrentBranch(worktreeResult.worktreePath), "relay/test1234");
  });

  it("isWorktreeDirty detects clean vs dirty state", async () => {
    worktreeResult = await createWorktree(repoDir, "dirty1234");
    assert.ok(worktreeResult);

    // Clean initially
    assert.equal(await isWorktreeDirty(worktreeResult.worktreePath), false);

    // Make it dirty
    writeFileSync(join(worktreeResult.worktreePath, "new-file.txt"), "dirty");
    assert.equal(await isWorktreeDirty(worktreeResult.worktreePath), true);
  });

  it("treats tracked relay task metadata as normal worktree changes", async () => {
    worktreeResult = await createWorktree(repoDir, "relaymd1");
    assert.ok(worktreeResult);

    mkdirSync(join(worktreeResult.worktreePath, ".relay"), { recursive: true });
    writeFileSync(
      join(worktreeResult.worktreePath, ".relay", "tasks.json"),
      '{"version":1,"tasks":[{"id":"1","title":"Test","status":"open"}]}\n',
    );

    const status = await getWorktreeStatus(worktreeResult.worktreePath);
    assert.equal(await isWorktreeDirty(worktreeResult.worktreePath), true);
    assert.equal(status.dirty, true);
    assert.equal(status.changeCount, 1);
  });

  it("hasWorktreeChanges detects committed changes", async () => {
    worktreeResult = await createWorktree(repoDir, "changes1");
    assert.ok(worktreeResult);

    // No changes yet
    assert.equal(await hasWorktreeChanges(worktreeResult.worktreePath, repoDir), false);

    // Add a commit in the worktree
    writeFileSync(join(worktreeResult.worktreePath, "new.txt"), "content");
    execSync("git add -A && git commit -m 'worktree change'", {
      cwd: worktreeResult.worktreePath,
      stdio: "pipe",
    });

    assert.equal(await hasWorktreeChanges(worktreeResult.worktreePath, repoDir), true);
  });

  it("does not execute shell syntax embedded in worktree paths", async () => {
    const previousBase = process.env.RELAY_WORKTREE_BASE;
    const markerFile = join(repoDir, "pwned");
    const maliciousBase = join(dirname(repoDir), "wt-$(touch pwned)");
    mkdirSync(maliciousBase, { recursive: true });

    try {
      process.env.RELAY_WORKTREE_BASE = maliciousBase;

      worktreeResult = await createWorktree(repoDir, "safe1234");
      assert.ok(worktreeResult);
      assert.equal(existsSync(markerFile), false);

      writeFileSync(join(worktreeResult.worktreePath, "new.txt"), "content");
      execSync("git add -A && git commit -m 'worktree change'", {
        cwd: worktreeResult.worktreePath,
        stdio: "pipe",
      });

      assert.equal(await hasWorktreeChanges(worktreeResult.worktreePath, repoDir), true);
      assert.equal(existsSync(markerFile), false);

      await removeWorktree(repoDir, worktreeResult.worktreePath, worktreeResult.branchName);
      assert.equal(existsSync(markerFile), false);
      worktreeResult = null;
    } finally {
      if (previousBase === undefined) {
        delete process.env.RELAY_WORKTREE_BASE;
      } else {
        process.env.RELAY_WORKTREE_BASE = previousBase;
      }
    }
  });

  it("commitAll stages and commits all changes", async () => {
    worktreeResult = await createWorktree(repoDir, "commit12");
    assert.ok(worktreeResult);

    writeFileSync(join(worktreeResult.worktreePath, "file.txt"), "modified");
    writeFileSync(join(worktreeResult.worktreePath, "new.txt"), "added");

    const result = await commitAll(worktreeResult.worktreePath, "test commit");
    assert.deepEqual(result, { success: true });

    // Should be clean after commit
    assert.equal(await isWorktreeDirty(worktreeResult.worktreePath), false);
  });

  it("commitAll bypasses pre-commit hooks", async () => {
    worktreeResult = await createWorktree(repoDir, "hookpass");
    assert.ok(worktreeResult);

    // --git-path may be relative to the worktree; never resolve it against
    // process.cwd(), which is the real repo when tests run from a git hook.
    const hookPath = resolve(
      worktreeResult.worktreePath,
      execSync("git rev-parse --git-path hooks/pre-commit", {
        cwd: worktreeResult.worktreePath,
        encoding: "utf8",
        stdio: "pipe",
      }).trim(),
    );
    assert.ok(!hookPath.startsWith(process.cwd()), `hook path escaped the temp repo: ${hookPath}`);
    writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
    execSync(`chmod +x "${hookPath}"`, {
      cwd: worktreeResult.worktreePath,
      stdio: "pipe",
    });
    writeFileSync(join(worktreeResult.worktreePath, "hooked.txt"), "content");

    const result = await commitAll(worktreeResult.worktreePath, "hook commit");
    assert.deepEqual(result, { success: true });
    assert.equal(await isWorktreeDirty(worktreeResult.worktreePath), false);
  });

  it("commitAll returns error when nothing to commit", async () => {
    worktreeResult = await createWorktree(repoDir, "empty123");
    assert.ok(worktreeResult);

    const result = await commitAll(worktreeResult.worktreePath, "empty commit");
    assert.equal(result.success, false);
  });

  it("removeWorktree cleans up worktree and branch", async () => {
    worktreeResult = await createWorktree(repoDir, "remove12");
    assert.ok(worktreeResult);

    await removeWorktree(repoDir, worktreeResult.worktreePath, worktreeResult.branchName);

    // Branch should be gone
    const branches = execSync("git branch", { cwd: repoDir, encoding: "utf-8" });
    assert.ok(!branches.includes("relay/remove12"));

    // Prevent afterEach from trying to clean up again
    worktreeResult = null;
  });
});

describe("gitPull", () => {
  let root;
  let remote;
  let cloneA;
  let cloneB;

  const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: "pipe" });

  const configIdentity = (dir) => {
    git(dir, "config user.email test@example.com");
    git(dir, "config user.name Test");
    git(dir, "config commit.gpgsign false");
  };

  const cloneOf = (name) => {
    git(root, `clone --quiet ${remote} ${name}`);
    const dir = join(root, name);
    configIdentity(dir);
    return dir;
  };

  const addCommit = (dir, file, contents, message) => {
    writeFileSync(join(dir, file), contents);
    git(dir, "add -A");
    git(dir, `commit -m ${message}`);
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "relay-git-pull-"));
    remote = join(root, "remote.git");
    mkdirSync(remote, { recursive: true });
    git(remote, "init --bare -b main");

    // cloneA seeds the shared history and pushes it as origin/main.
    cloneA = cloneOf("a");
    addCommit(cloneA, "file.txt", "base\n", "base");
    git(cloneA, "push -u origin main");

    // cloneB starts from that same base, tracking origin/main.
    cloneB = cloneOf("b");
  });

  afterEach(async () => {
    rmSync(root, { recursive: true, force: true });
  });

  it("fast-forwards when only behind the remote", async () => {
    addCommit(cloneA, "file.txt", "base\nupstream\n", "upstream");
    git(cloneA, "push origin main");

    const result = await gitPull(cloneB);
    assert.deepEqual(result, { success: true });
    assert.match(execSync("cat file.txt", { cwd: cloneB, encoding: "utf8" }), /upstream/);
    assert.deepEqual(await getAheadBehind(cloneB), { ahead: 0, behind: 0 });
  });

  it("ff-only pull fails on a diverged branch, rebase pull succeeds", async () => {
    addCommit(cloneB, "local.txt", "local\n", "local");
    addCommit(cloneA, "file.txt", "base\nupstream\n", "upstream");
    git(cloneA, "push origin main");

    await gitFetch(cloneB);
    assert.deepEqual(await getAheadBehind(cloneB), { ahead: 1, behind: 1 });

    const ffOnly = await gitPull(cloneB);
    assert.equal(ffOnly.success, false);

    const rebased = await gitPull(cloneB, { rebase: true });
    assert.deepEqual(rebased, { success: true });
    // Local commit replayed on top of upstream: ahead 1 (unpushed), behind 0.
    assert.deepEqual(await getAheadBehind(cloneB), { ahead: 1, behind: 0 });
    assert.match(execSync("cat file.txt", { cwd: cloneB, encoding: "utf8" }), /upstream/);
    assert.match(execSync("cat local.txt", { cwd: cloneB, encoding: "utf8" }), /local/);
  });

  it("does not rebase when rebase is not requested (flag is respected)", async () => {
    addCommit(cloneB, "local.txt", "local\n", "local");
    addCommit(cloneA, "file.txt", "base\nupstream\n", "upstream");
    git(cloneA, "push origin main");

    // Explicit falsy flag must keep ff-only semantics — which fail on divergence.
    const result = await gitPull(cloneB, { rebase: false });
    assert.equal(result.success, false);
  });

  it("auto-stashes a dirty worktree during a rebase pull", async () => {
    addCommit(cloneB, "local.txt", "local\n", "local");
    writeFileSync(join(cloneB, "file.txt"), "base\ndirty-edit\n"); // uncommitted
    addCommit(cloneA, "other.txt", "upstream\n", "upstream");
    git(cloneA, "push origin main");

    const result = await gitPull(cloneB, { rebase: true });
    assert.deepEqual(result, { success: true });
    // Autostash should have restored the uncommitted edit.
    assert.match(execSync("cat file.txt", { cwd: cloneB, encoding: "utf8" }), /dirty-edit/);
  });

  it("preserves a local merge commit when rebasing a diverged branch", async () => {
    // Build a local merge commit on cloneB's main.
    git(cloneB, "checkout -b side");
    addCommit(cloneB, "side.txt", "side\n", "side");
    git(cloneB, "checkout main");
    git(cloneB, "merge --no-ff side -m merge");

    addCommit(cloneA, "file.txt", "base\nupstream\n", "upstream");
    git(cloneA, "push origin main");

    const result = await gitPull(cloneB, { rebase: true });
    assert.deepEqual(result, { success: true });
    // --rebase=merges keeps the merge commit instead of flattening it.
    const mergeCount = Number(
      execSync("git rev-list --merges --count HEAD", { cwd: cloneB, encoding: "utf8" }).trim(),
    );
    assert.ok(mergeCount >= 1, `expected a merge commit to survive, got ${mergeCount}`);
  });
});
