// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionDB } from "../dist/server/core/db.js";
import { noopLogger } from "../dist/server/core/logger.js";
import { ProjectManager } from "../dist/server/core/project-manager.js";

function makeGitRepo(parent, name) {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function makeSessionRow(directory, suffix) {
  return {
    session_id: `session-${suffix}`,
    instance_id: `instance-${suffix}`,
    provider_name: "claude",
    name: `Session ${suffix}`,
    working_directory: directory,
    jsonl_path: join(directory, `${suffix}.jsonl`),
    created_at: Date.now(),
    last_activity_at: Date.now(),
    type: "external",
    archived: 0,
    custom_title: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    summary: null,
    first_prompt: null,
    git_branch: null,
    message_count: 1,
    allowed_tools: "[]",
    worktree_path: null,
    original_directory: null,
    parent_session_id: null,
    preferred_model: null,
    reasoning_budget: null,
    runtime_mode: null,
    last_message_text: null,
    last_message_from: null,
    last_message_at: null,
    git_info_branch: null,
    git_info_is_worktree: null,
    space_id: null,
    project_id: null,
    model: null,
  };
}

function makeManagedRow(directory, suffix) {
  return {
    instance_id: `managed-${suffix}`,
    provider_name: "claude",
    provider_session_id: `provider-${suffix}`,
    name: `Managed ${suffix}`,
    working_directory: directory,
    created_at: Date.now(),
    last_activity_at: Date.now(),
    archived: 0,
    custom_title: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    git_branch: null,
    worktree_path: null,
    original_directory: null,
    parent_session_id: null,
    preferred_model: null,
    reasoning_budget: null,
    runtime_mode: "approval-required",
    resume_cursor_json: null,
    runtime_payload_json: null,
    transcript_path: null,
    last_message_text: null,
    last_message_from: null,
    last_message_at: null,
    git_info_branch: null,
    git_info_is_worktree: null,
    space_id: null,
    project_id: null,
    model: null,
    model_options_json: null,
    original_git_branch: null,
  };
}

describe("ProjectManager removal tombstones", () => {
  const cleanup = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      rmSync(cleanup.pop(), { recursive: true, force: true });
    }
  });

  it("does not resurrect a removed project across a DB restart", () => {
    const tmp = mkdtempSync(join(tmpdir(), "relay-remove-"));
    cleanup.push(tmp);
    const repo = makeGitRepo(tmp, "removable");
    const subdir = join(repo, "packages", "core");
    mkdirSync(subdir, { recursive: true });
    const dbPath = join(tmp, "sessions.db");

    {
      const db = new SessionDB(dbPath, noopLogger);
      const manager = new ProjectManager(db, noopLogger);

      const project = manager.addProject(repo);
      db.upsert(makeSessionRow(repo, "root"));
      db.upsert(makeSessionRow(subdir, "sub"));
      db.upsertManaged(makeManagedRow(repo, "root"));
      db.upsertManaged(makeManagedRow(subdir, "sub"));
      manager.recoverProjectsFromSessionDirectories();

      // Recovery associated the subdirectory sessions too
      assert.ok(
        db.getAll().every((row) => row.project_id === project.id),
        "all sessions associated before removal",
      );

      assert.equal(manager.removeProject(project.id), true);
      assert.equal(manager.listProjects().length, 0);

      // No session (root, subdir, or managed) may keep a dangling project_id
      assert.ok(db.getAll().every((row) => row.project_id === null));
      assert.ok(db.getAllManagedActive().every((row) => row.project_id === null));

      db.close();
    }

    // Fresh process: startup-style recovery must not bring the project back
    {
      const db = new SessionDB(dbPath, noopLogger);
      const manager = new ProjectManager(db, noopLogger);
      const recovered = manager.recoverProjectsFromSessionDirectories();
      assert.equal(recovered, 0);
      assert.equal(manager.listProjects().length, 0);
      db.close();
    }
  });

  it("still recovers unregistered directories that were never removed", () => {
    const tmp = mkdtempSync(join(tmpdir(), "relay-remove-"));
    cleanup.push(tmp);
    const repo = makeGitRepo(tmp, "never-registered");

    const db = new SessionDB(join(tmp, "sessions.db"), noopLogger);
    const manager = new ProjectManager(db, noopLogger);

    db.upsert(makeSessionRow(repo, "b"));

    const recovered = manager.recoverProjectsFromSessionDirectories();
    assert.equal(recovered, 1);
    assert.equal(manager.listProjects().length, 1);

    db.close();
  });

  it("explicit re-add clears the tombstone and restores historical sessions", () => {
    const tmp = mkdtempSync(join(tmpdir(), "relay-remove-"));
    cleanup.push(tmp);
    const repo = makeGitRepo(tmp, "re-added");
    const subdir = join(repo, "src");
    mkdirSync(subdir, { recursive: true });

    const db = new SessionDB(join(tmp, "sessions.db"), noopLogger);
    const manager = new ProjectManager(db, noopLogger);

    const project = manager.addProject(repo);
    db.upsert(makeSessionRow(repo, "root"));
    db.upsert(makeSessionRow(subdir, "sub"));
    db.upsertManaged(makeManagedRow(subdir, "sub"));
    manager.recoverProjectsFromSessionDirectories();
    manager.removeProject(project.id);

    // Re-add alone (no recovery scan) restores root and subdirectory sessions
    const readded = manager.addProject(repo);
    assert.equal(manager.listProjects().length, 1);
    assert.ok(db.getAll().every((row) => row.project_id === readded.id));
    assert.ok(db.getAllManagedActive().every((row) => row.project_id === readded.id));

    // And recovery scans keep working normally afterwards
    const recovered = manager.recoverProjectsFromSessionDirectories();
    assert.equal(recovered, 0);
    assert.equal(manager.listProjects().length, 1);

    db.close();
  });
});
