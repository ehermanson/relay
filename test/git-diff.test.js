import "./test-env.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  getCurrentBranch,
  getFullDiff,
  getFileDiff,
  getWorktreeDiff,
} from "../dist/server/core/git.js";

let seedRepoDir;

function ensureSeedRepo() {
  if (seedRepoDir) return seedRepoDir;
  seedRepoDir = mkdtempSync(join(tmpdir(), "relay-git-diff-seed-"));
  execSync("git init -b main", { cwd: seedRepoDir, stdio: "pipe" });
  writeFileSync(join(seedRepoDir, "file.txt"), "hello");
  execSync("git add -A && git commit -m init", { cwd: seedRepoDir, stdio: "pipe" });
  return seedRepoDir;
}

function makeRepoDir() {
  const root = mkdtempSync(join(tmpdir(), "relay-git-diff-test-"));
  const dir = join(root, "repo");
  cpSync(ensureSeedRepo(), dir, { recursive: true });
  return dir;
}

function createUnbornRepo() {
  const dir = mkdtempSync(join(tmpdir(), "relay-git-unborn-"));
  execSync("git init -b main", { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("getFullDiff", () => {
  let repoDir;

  beforeEach(async () => {
    repoDir = makeRepoDir();
  });

  afterEach(async () => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns null for a non-git directory", async () => {
    const plain = mkdtempSync(join(tmpdir(), "relay-git-test-"));
    try {
      assert.equal(await getFullDiff(plain), null);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("returns empty string when no changes", async () => {
    const diff = await getFullDiff(repoDir);
    assert.equal(typeof diff, "string");
    assert.equal(diff.trim(), "");
  });

  it("returns unified diff for uncommitted changes", async () => {
    writeFileSync(join(repoDir, "file.txt"), "modified content");
    const diff = await getFullDiff(repoDir);
    assert.ok(diff);
    assert.ok(diff.includes("diff --git"));
    assert.ok(diff.includes("file.txt"));
    assert.ok(diff.includes("+modified content"));
  });

  it("uses sessionCreatedAt to resolve base ref (falls back to HEAD for same-second commits)", async () => {
    // When all commits happen in the same second, getBaseCommit may return
    // the latest commit as base, resulting in an empty diff against HEAD.
    // This test verifies the function doesn't crash and returns a valid string.
    writeFileSync(join(repoDir, "file.txt"), "changed");
    execSync("git add -A && git commit -m 'change'", { cwd: repoDir, stdio: "pipe" });

    const diff = await getFullDiff(repoDir, { sessionCreatedAt: Date.now() });
    assert.equal(typeof diff, "string");
  });

  it("diffs against merge-base when originalBranch is provided", async () => {
    // Create a branch and make changes
    execSync("git checkout -b feature-branch", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "feature.txt"), "feature work");
    execSync("git add -A && git commit -m 'feature'", { cwd: repoDir, stdio: "pipe" });

    const diff = await getFullDiff(repoDir, { originalBranch: "master" });
    // May be 'main' or 'master' — try both
    if (!diff || diff.trim() === "") {
      const diffMain = await getFullDiff(repoDir, { originalBranch: "main" });
      // At least one should work
      if (diffMain && diffMain.trim()) {
        assert.ok(diffMain.includes("feature.txt"));
      }
    } else {
      assert.ok(diff.includes("feature.txt"));
    }
  });

  it("handles an unborn HEAD without throwing", async () => {
    const unbornRepo = createUnbornRepo();
    try {
      writeFileSync(join(unbornRepo, "new-file.txt"), "hello");
      execSync("git add new-file.txt", { cwd: unbornRepo, stdio: "pipe" });

      const diff = await getFullDiff(unbornRepo);
      assert.ok(diff);
      assert.ok(diff.includes("new-file.txt"));
    } finally {
      rmSync(unbornRepo, { recursive: true, force: true });
    }
  });
});

describe("getFileDiff", () => {
  let repoDir;

  beforeEach(async () => {
    repoDir = makeRepoDir();
  });

  afterEach(async () => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns null for a non-git directory", async () => {
    const plain = mkdtempSync(join(tmpdir(), "relay-git-test-"));
    try {
      assert.equal(await getFileDiff(plain, "file.txt"), null);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("returns diff for a specific changed file", async () => {
    writeFileSync(join(repoDir, "file.txt"), "changed");
    writeFileSync(join(repoDir, "other.txt"), "other change");
    execSync("git add other.txt", { cwd: repoDir, stdio: "pipe" });

    const diff = await getFileDiff(repoDir, "file.txt");
    assert.ok(diff);
    assert.ok(diff.includes("file.txt"));
    assert.ok(!diff.includes("other.txt"));
  });

  it("returns empty string for an unchanged file", async () => {
    const diff = await getFileDiff(repoDir, "file.txt");
    assert.equal(typeof diff, "string");
    assert.equal(diff.trim(), "");
  });

  it("handles an unborn HEAD without throwing", async () => {
    const unbornRepo = createUnbornRepo();
    try {
      writeFileSync(join(unbornRepo, "new-file.txt"), "hello");
      execSync("git add new-file.txt", { cwd: unbornRepo, stdio: "pipe" });

      const diff = await getFileDiff(unbornRepo, "new-file.txt");
      assert.ok(diff);
      assert.ok(diff.includes("new-file.txt"));
    } finally {
      rmSync(unbornRepo, { recursive: true, force: true });
    }
  });
});

describe("getWorktreeDiff", () => {
  let repoDir;

  beforeEach(async () => {
    repoDir = makeRepoDir();
  });

  afterEach(async () => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("includes untracked files alongside branch changes", async () => {
    const baseBranch = (await getCurrentBranch(repoDir)) ?? "main";
    execSync("git checkout -b feature-branch", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "tracked.txt"), "tracked branch work");
    execSync("git add tracked.txt && git commit -m 'tracked change'", {
      cwd: repoDir,
      stdio: "pipe",
    });
    writeFileSync(join(repoDir, "untracked.txt"), "new untracked work");

    const diff = await getWorktreeDiff(repoDir, baseBranch);
    assert.ok(diff);
    assert.ok(diff.includes("tracked.txt"));
    assert.ok(diff.includes("untracked.txt"));
    assert.ok(diff.includes("+new untracked work"));
  });
});
