/**
 * Tests for worktree detection and recovery:
 * - git.ts: isRelayWorktreePath(), resolveWorktreeOrigin()
 * - instance-manager.ts: getGitInfo() worktree detection
 * - instance-manager.ts: addExternalInstance() / scanAllSessions() worktree path recovery
 */

import { TEST_WORKTREE_BASE } from "./test-env.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  isRelayWorktreePath,
  resolveWorktreeOrigin,
  isGitWorktree,
  resolveAnyWorktreeOrigin,
  removeWorktree,
} from "../dist/server/core/git.js";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { SessionDB } from "../dist/server/core/db.js";
import { resolveConfig } from "../dist/server/config.js";
import { createTestWorktree } from "./helpers.js";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function runGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    timeout: 5000,
  });
}

function randomHex(length = 8) {
  return Math.random()
    .toString(16)
    .slice(2, 2 + length)
    .padEnd(length, "0");
}

let seedRepoDir;

function ensureSeedRepo() {
  if (seedRepoDir) return seedRepoDir;
  seedRepoDir = realpathSync(mkdtempSync(join(tmpdir(), "relay-wt-seed-")));
  runGit(seedRepoDir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(seedRepoDir, "README.md"), "# Test\n");
  runGit(seedRepoDir, ["add", "."]);
  runGit(seedRepoDir, [
    "-c",
    "user.email=test@test.com",
    "-c",
    "user.name=Test",
    "commit",
    "-q",
    "-m",
    "initial",
  ]);
  return seedRepoDir;
}

function makeRepoDir() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relay-wt-test-")));
  const dir = join(root, "repo");
  cpSync(ensureSeedRepo(), dir, { recursive: true });
  return dir;
}

function createSpaceWorktree(repoDir, shortId = "aabbccdd") {
  const base = TEST_WORKTREE_BASE;
  const worktreePath = join(base, `space-${shortId}`);
  const branchName = `relay-space/${shortId}`;
  mkdirSync(base, { recursive: true });
  rmSync(worktreePath, { recursive: true, force: true });
  runGit(repoDir, ["worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
  return { worktreePath, branchName };
}

// =============================================================================
// git.ts — isRelayWorktreePath / resolveWorktreeOrigin
// =============================================================================

describe("isRelayWorktreePath", () => {
  it("matches standard relay worktree paths", async () => {
    const home = homedir();
    assert.equal(isRelayWorktreePath(`${home}/.relay/worktrees/8c625689`), true);
    assert.equal(isRelayWorktreePath(`${home}/.relay/worktrees/abcdef01`), true);
    assert.equal(isRelayWorktreePath(`${home}/.relay/worktrees/space-abcdef01`), true);
    assert.equal(isRelayWorktreePath(`${home}/.relay/worktrees/abcdef01/`), true);
  });

  it("rejects non-worktree paths", async () => {
    assert.equal(isRelayWorktreePath("/Users/foo/projects/my-app"), false);
    assert.equal(isRelayWorktreePath("/tmp/test"), false);
    assert.equal(isRelayWorktreePath("/home/user/.relay/uploads/file.png"), false);
  });

  it("rejects paths outside the relay worktree root", async () => {
    const home = homedir();
    assert.equal(isRelayWorktreePath(`${home}/.relay/worktrees/space-abcdef01/nested`), false);
    assert.equal(isRelayWorktreePath(`${home}/.relay/worktrees`), false);
  });
});

describe("resolveWorktreeOrigin", () => {
  let repoDir;
  let worktree;
  const cleanupWorktrees = [];

  beforeEach(async () => {
    repoDir = makeRepoDir();
  });

  afterEach(async () => {
    // Clean up any worktrees we created
    for (const wt of cleanupWorktrees) {
      try {
        await removeWorktree(repoDir, wt.worktreePath, wt.branchName);
      } catch {}
    }
    cleanupWorktrees.length = 0;
    try {
      runGit(repoDir, ["worktree", "prune"]);
    } catch {}
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("resolves worktree origin to the main repo directory", async () => {
    worktree = createTestWorktree(repoDir, "aabbccdd");
    assert.ok(worktree, "worktree should be created");
    cleanupWorktrees.push(worktree);

    const origin = resolveWorktreeOrigin(worktree.worktreePath);
    assert.ok(origin, "origin should be resolved");
    // realpathSync to handle any remaining symlinks
    assert.equal(realpathSync(origin), realpathSync(repoDir));
  });

  it("resolves space worktree origins to the main repo directory", async () => {
    worktree = createSpaceWorktree(repoDir, "a1b2c3d4");
    assert.ok(worktree, "space worktree should be created");
    cleanupWorktrees.push(worktree);

    const origin = resolveWorktreeOrigin(worktree.worktreePath);
    assert.ok(origin, "origin should be resolved");
    assert.equal(realpathSync(origin), realpathSync(repoDir));
  });

  it("returns null for non-relay-worktree paths", async () => {
    assert.equal(resolveWorktreeOrigin(repoDir), null);
    assert.equal(resolveWorktreeOrigin("/tmp/test"), null);
  });

  it("returns null for nonexistent worktree directory", async () => {
    const home = homedir();
    assert.equal(resolveWorktreeOrigin(`${home}/.relay/worktrees/deadbeef`), null);
  });
});

// =============================================================================
// isGitWorktree / resolveAnyWorktreeOrigin — general worktree detection
// =============================================================================

describe("isGitWorktree / resolveAnyWorktreeOrigin", () => {
  let repoDir;
  const cleanupWorktrees = [];

  beforeEach(async () => {
    repoDir = makeRepoDir();
  });

  afterEach(async () => {
    for (const wt of cleanupWorktrees) {
      try {
        await removeWorktree(repoDir, wt.worktreePath, wt.branchName);
      } catch {}
    }
    cleanupWorktrees.length = 0;
    try {
      runGit(repoDir, ["worktree", "prune"]);
    } catch {}
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("detects relay worktrees as git worktrees", async () => {
    const wt = createTestWorktree(repoDir, "aabbccdd");
    cleanupWorktrees.push(wt);
    assert.equal(isGitWorktree(wt.worktreePath), true);
  });

  it("detects non-relay worktrees as git worktrees", async () => {
    // Create a plain git worktree outside the relay worktree base
    const wtPath = join(mkdtempSync(join(tmpdir(), "relay-nonrelay-wt-")), "wt");
    const branchName = "test-external-wt";
    runGit(repoDir, ["worktree", "add", "-b", branchName, wtPath, "HEAD"]);
    cleanupWorktrees.push({ worktreePath: wtPath, branchName });

    assert.equal(isGitWorktree(wtPath), true);
    assert.equal(isRelayWorktreePath(wtPath), false, "should NOT be a relay worktree");

    const origin = resolveAnyWorktreeOrigin(wtPath);
    assert.ok(origin, "should resolve origin");
    assert.equal(realpathSync(origin), realpathSync(repoDir));
  });

  it("returns false for a primary repo (not a worktree)", async () => {
    assert.equal(isGitWorktree(repoDir), false);
  });

  it("returns false for a non-git directory", async () => {
    assert.equal(isGitWorktree(tmpdir()), false);
  });

  it("resolveAnyWorktreeOrigin returns null for non-worktree", async () => {
    assert.equal(resolveAnyWorktreeOrigin(repoDir), null);
  });
});

// =============================================================================
// getGitInfo worktree detection (via InstanceManager integration)
// =============================================================================

describe("getGitInfo worktree detection", () => {
  let repoDir;
  const cleanupWorktrees = [];

  beforeEach(async () => {
    repoDir = makeRepoDir();
  });

  afterEach(async () => {
    for (const wt of cleanupWorktrees) {
      try {
        await removeWorktree(repoDir, wt.worktreePath, wt.branchName);
      } catch {}
    }
    cleanupWorktrees.length = 0;
    try {
      runGit(repoDir, ["worktree", "prune"]);
    } catch {}
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("reports isWorktree=true for a git worktree directory", async () => {
    const wt = createTestWorktree(repoDir, "aabbccdd");
    assert.ok(wt, "worktree should be created");
    cleanupWorktrees.push(wt);

    // Create a manager that points at the worktree — createInstance sets gitInfo
    const tempDir = mkdtempSync(join(tmpdir(), "relay-gitinfo-"));
    const config = resolveConfig({
      password: "test",
      logger: noopLogger,
      maxProcesses: 3,
      dbPath: join(tempDir, "sessions.db"),
      providerDirs: {
        claude: join(tempDir, ".claude"),
        codex: join(tempDir, ".codex"),
      },
    });
    const manager = new InstanceManager(config);

    // Create instance in the worktree directory
    const info = manager.createInstance({ workingDirectory: wt.worktreePath });
    assert.ok(info.gitInfo, "gitInfo should be present");
    assert.equal(info.gitInfo.isWorktree, true);
    assert.equal(info.gitInfo.branch, wt.branchName);

    manager.stopAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports isWorktree=false for a normal git repo", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "relay-gitinfo-"));
    const config = resolveConfig({
      password: "test",
      logger: noopLogger,
      maxProcesses: 3,
      dbPath: join(tempDir, "sessions.db"),
      providerDirs: {
        claude: join(tempDir, ".claude"),
        codex: join(tempDir, ".codex"),
      },
    });
    const manager = new InstanceManager(config);

    const info = manager.createInstance({ workingDirectory: repoDir });
    assert.ok(info.gitInfo, "gitInfo should be present");
    assert.equal(info.gitInfo.isWorktree, false);
    assert.equal(info.gitInfo.branch, "main");
    assert.equal(info.gitBranch, undefined);
    assert.equal(info.originalDirectory, undefined);

    const instance = manager.instances.get(info.id);
    assert.ok(instance, "internal instance should exist");
    assert.equal(instance.worktreePath, undefined);
    assert.equal(instance.actualCwd, undefined);

    manager.stopAll();
    rmSync(tempDir, { recursive: true, force: true });
  });
});

// =============================================================================
// scanAllSessions worktree path recovery
// =============================================================================

describe("scanAllSessions worktree recovery", () => {
  let repoDir;
  let tempDir;
  const cleanupWorktrees = [];

  beforeEach(async () => {
    repoDir = makeRepoDir();
    tempDir = mkdtempSync(join(tmpdir(), "relay-scan-wt-"));
  });

  afterEach(async () => {
    for (const wt of cleanupWorktrees) {
      try {
        await removeWorktree(repoDir, wt.worktreePath, wt.branchName);
      } catch {}
    }
    cleanupWorktrees.length = 0;
    try {
      runGit(repoDir, ["worktree", "prune"]);
    } catch {}
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves worktree cwd to original directory during JSONL scan", async () => {
    const wt = createTestWorktree(repoDir, "aabbccdd");
    assert.ok(wt, "worktree should be created");
    cleanupWorktrees.push(wt);

    // Simulate a JSONL file whose cwd field is the worktree path
    const claudeDir = join(tempDir, ".claude");
    const encoded = wt.worktreePath.replace(/[^A-Za-z0-9_-]/g, "-");
    const projectDir = join(claudeDir, "projects", encoded);
    mkdirSync(projectDir, { recursive: true });

    const sessionId = "00000000-0000-0000-0000-000000000001";
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
    const jsonlContent =
      JSON.stringify({
        type: "system",
        cwd: wt.worktreePath,
        timestamp: new Date().toISOString(),
      }) + "\n";
    writeFileSync(jsonlPath, jsonlContent);

    // Create a fresh manager and restore — scanAllSessions should detect the worktree
    const config = resolveConfig({
      password: "test",
      logger: noopLogger,
      maxProcesses: 3,
      dbPath: join(tempDir, "sessions.db"),
      providerDirs: {
        claude: claudeDir,
        codex: join(tempDir, ".codex"),
      },
    });
    const manager = new InstanceManager(config);
    manager.projectManager.addProject(repoDir);
    manager.restoreAndScan();

    // The instance should have workingDirectory = original repo dir, not the worktree
    const instances = manager.listInstances();
    assert.equal(instances.length, 1, "should have discovered 1 instance");

    const inst = instances[0];
    assert.equal(
      realpathSync(inst.workingDirectory),
      realpathSync(repoDir),
      `workingDirectory should be original repo dir, got: ${inst.workingDirectory}`,
    );
    assert.equal(
      realpathSync(inst.originalDirectory),
      realpathSync(repoDir),
      "originalDirectory should point to original repo dir",
    );
    assert.equal(inst.external, true, "should be external");

    manager.stopAll();
  });

  it("does not create a project for worktree sessions when parent is not registered", async () => {
    const wt = createTestWorktree(repoDir, "orphaned1");
    assert.ok(wt, "worktree should be created");
    cleanupWorktrees.push(wt);

    const claudeDir = join(tempDir, ".claude");
    const encoded = wt.worktreePath.replace(/[^A-Za-z0-9_-]/g, "-");
    const projectDir = join(claudeDir, "projects", encoded);
    mkdirSync(projectDir, { recursive: true });

    const sessionId = "00000000-0000-0000-0000-000000000099";
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(
      jsonlPath,
      JSON.stringify({
        type: "system",
        cwd: wt.worktreePath,
        timestamp: new Date().toISOString(),
      }) + "\n",
    );

    const config = resolveConfig({
      password: "test",
      logger: noopLogger,
      maxProcesses: 3,
      dbPath: join(tempDir, "sessions.db"),
      providerDirs: {
        claude: claudeDir,
        codex: join(tempDir, ".codex"),
      },
    });
    const manager = new InstanceManager(config);
    // Do NOT register the parent repo as a project
    manager.restoreAndScan();

    // No project should be auto-created from the worktree session
    const projects = manager.projectManager.listProjects();
    assert.equal(projects.length, 0, "should NOT auto-create a project from worktree sessions");

    manager.stopAll();
  });

  it("rebuilds sessions from legacy space-prefixed Relay worktree transcript dirs", async () => {
    const shortId = randomHex(8);
    const wt = createSpaceWorktree(repoDir, shortId);
    assert.ok(wt, "space worktree should be created");
    cleanupWorktrees.push(wt);

    const claudeDir = join(tempDir, ".claude");
    const encoded = wt.worktreePath.replace(/[^A-Za-z0-9_-]/g, "-");
    const projectDir = join(claudeDir, "projects", encoded);
    mkdirSync(projectDir, { recursive: true });

    const sessionId = "00000000-0000-0000-0000-00000000000a";
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(
      jsonlPath,
      JSON.stringify({
        type: "system",
        cwd: wt.worktreePath,
        timestamp: new Date().toISOString(),
      }) + "\n",
    );

    const config = resolveConfig({
      password: "test",
      logger: noopLogger,
      maxProcesses: 3,
      dbPath: join(tempDir, "sessions.db"),
      providerDirs: {
        claude: claudeDir,
        codex: join(tempDir, ".codex"),
      },
    });
    const manager = new InstanceManager(config);
    manager.projectManager.addProject(repoDir);
    manager.restoreAndScan();

    const instances = manager.listInstances();
    assert.equal(instances.length, 1, "should restore the space-backed session");
    assert.equal(realpathSync(instances[0].workingDirectory), realpathSync(repoDir));

    const db = new SessionDB(config.dbPath, noopLogger);
    try {
      const row = db.getByJsonlPath(jsonlPath);
      assert.ok(row, "scanned session row should exist");
      assert.equal(row.git_branch, wt.branchName);
      assert.equal(realpathSync(row.worktree_path), realpathSync(wt.worktreePath));
      assert.equal(realpathSync(row.original_directory), realpathSync(repoDir));
    } finally {
      db.close();
    }

    manager.stopAll();
  });

  it("archives gracefully when worktree no longer exists on disk", async () => {
    const wt = createTestWorktree(repoDir, "aabbccdd");
    assert.ok(wt, "worktree should be created");
    const worktreePath = wt.worktreePath;

    // Remove the worktree so resolveWorktreeOrigin can't use git
    await removeWorktree(repoDir, wt.worktreePath, wt.branchName);
    assert.ok(!existsSync(worktreePath), "worktree should be removed");

    // Simulate a JSONL file whose cwd field is the now-deleted worktree path
    const claudeDir = join(tempDir, ".claude");
    const encoded = worktreePath.replace(/[^A-Za-z0-9_-]/g, "-");
    const projectDir = join(claudeDir, "projects", encoded);
    mkdirSync(projectDir, { recursive: true });

    const sessionId = "00000000-0000-0000-0000-000000000002";
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
    const jsonlContent =
      JSON.stringify({
        type: "system",
        cwd: worktreePath,
        timestamp: new Date().toISOString(),
      }) + "\n";
    writeFileSync(jsonlPath, jsonlContent);

    // Create a fresh manager and restore
    const config = resolveConfig({
      password: "test",
      logger: noopLogger,
      maxProcesses: 3,
      dbPath: join(tempDir, "sessions.db"),
      providerDirs: {
        claude: claudeDir,
        codex: join(tempDir, ".codex"),
      },
    });
    const manager = new InstanceManager(config);
    manager.restoreAndScan();

    // Session gets discovered but then archived because the working_directory
    // (worktree path) no longer exists and there's no original_directory to fall back to
    const instances = manager.listInstances();
    assert.equal(instances.length, 0, "deleted worktree with no recovery path should be archived");

    manager.stopAll();
  });
});

// =============================================================================
// Archive protection for worktree instances
// =============================================================================

describe("scanAllSessions archive protection", () => {
  let repoDir;
  let tempDir;
  const cleanupWorktrees = [];

  beforeEach(async () => {
    repoDir = makeRepoDir();
    tempDir = mkdtempSync(join(tmpdir(), "relay-archive-wt-"));
  });

  afterEach(async () => {
    for (const wt of cleanupWorktrees) {
      try {
        await removeWorktree(repoDir, wt.worktreePath, wt.branchName);
      } catch {}
    }
    cleanupWorktrees.length = 0;
    try {
      runGit(repoDir, ["worktree", "prune"]);
    } catch {}
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not archive worktree instances when original_directory exists", async () => {
    const wt = createTestWorktree(repoDir, "aabbccdd");
    assert.ok(wt, "worktree should be created");
    cleanupWorktrees.push(wt);

    const claudeDir = join(tempDir, ".claude");
    const encoded = wt.worktreePath.replace(/[^A-Za-z0-9_-]/g, "-");
    const projectDir = join(claudeDir, "projects", encoded);
    mkdirSync(projectDir, { recursive: true });

    const sessionId = "00000000-0000-0000-0000-000000000003";
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(
      jsonlPath,
      JSON.stringify({
        type: "system",
        cwd: wt.worktreePath,
        timestamp: new Date().toISOString(),
      }) + "\n",
    );

    const config = resolveConfig({
      password: "test",
      logger: noopLogger,
      maxProcesses: 3,
      dbPath: join(tempDir, "sessions.db"),
      providerDirs: {
        claude: claudeDir,
        codex: join(tempDir, ".codex"),
      },
    });

    // First scan discovers the session and resolves worktree
    const manager1 = new InstanceManager(config);
    manager1.projectManager.addProject(repoDir);
    manager1.restoreAndScan();

    let instances = manager1.listInstances();
    assert.equal(instances.length, 1);
    manager1.stopAll();

    // Now remove the worktree (simulating cleanup) — the working_directory
    // should now point to the original repo dir (which still exists)
    await removeWorktree(repoDir, wt.worktreePath, wt.branchName);
    cleanupWorktrees.length = 0; // Already cleaned up

    // Second scan should NOT archive the instance because original_directory exists
    const manager2 = new InstanceManager(config);
    manager2.restoreAndScan();

    instances = manager2.listInstances();
    assert.equal(instances.length, 1, "instance should survive re-scan after worktree removal");
    manager2.stopAll();
  });
});

describe("live discovery worktree recovery", () => {
  let repoDir;
  let tempDir;
  const cleanupWorktrees = [];

  beforeEach(async () => {
    repoDir = makeRepoDir();
    tempDir = mkdtempSync(join(tmpdir(), "relay-live-wt-"));
  });

  afterEach(async () => {
    for (const wt of cleanupWorktrees) {
      try {
        await removeWorktree(repoDir, wt.worktreePath, wt.branchName);
      } catch {}
    }
    cleanupWorktrees.length = 0;
    try {
      runGit(repoDir, ["worktree", "prune"]);
    } catch {}
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("discovers running Claude sessions from relay worktrees under the registered repo", async () => {
    const wt = createTestWorktree(repoDir, "aabbccdd");
    assert.ok(wt, "worktree should be created");
    cleanupWorktrees.push(wt);

    const claudeDir = join(tempDir, ".claude");
    const encoded = wt.worktreePath.replace(/[^A-Za-z0-9_-]/g, "-");
    const projectDir = join(claudeDir, "projects", encoded);
    mkdirSync(projectDir, { recursive: true });

    const sessionId = "00000000-0000-0000-0000-000000000004";
    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(
      jsonlPath,
      JSON.stringify({
        type: "system",
        cwd: wt.worktreePath,
        timestamp: new Date().toISOString(),
      }) + "\n",
    );

    const config = resolveConfig({
      password: "test",
      logger: noopLogger,
      maxProcesses: 3,
      dbPath: join(tempDir, "sessions.db"),
      providerDirs: {
        claude: claudeDir,
        codex: join(tempDir, ".codex"),
      },
    });
    const manager = new InstanceManager(config);
    manager.projectManager.addProject(repoDir);

    manager["discoverExternalSessions"] = () =>
      Promise.resolve([
        {
          provider: "claude",
          cwd: wt.worktreePath,
          transcriptPath: jsonlPath,
          sessionId,
          pid: 99999,
        },
      ]);

    await manager["discoverExisting"]();

    const instances = manager.listInstances();
    assert.equal(instances.length, 1, "should discover the worktree-backed session");
    assert.equal(realpathSync(instances[0].workingDirectory), realpathSync(repoDir));
    assert.equal(instances[0].projectId, manager.projectManager.getProjectByDirectory(repoDir)?.id);

    manager.stopAll();
  });
});
