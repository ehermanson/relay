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

describe("ProjectManager slug generation", () => {
  const cleanup = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      rmSync(cleanup.pop(), { recursive: true, force: true });
    }
  });

  it("assigns a basename-derived slug at registration", () => {
    const tmp = mkdtempSync(join(tmpdir(), "relay-slug-"));
    cleanup.push(tmp);
    const repo = makeGitRepo(tmp, "my-app");

    const db = new SessionDB(join(tmp, "sessions.db"), noopLogger);
    const manager = new ProjectManager(db, noopLogger);

    const project = manager.addProject(repo);
    assert.equal(project.slug, "my-app");

    db.close();
  });

  it("suffixes -2/-3 on slug collisions across different parent directories", () => {
    const tmp = mkdtempSync(join(tmpdir(), "relay-slug-"));
    cleanup.push(tmp);
    const a = makeGitRepo(join(tmp, "a"), "shared");
    const b = makeGitRepo(join(tmp, "b"), "shared");
    const c = makeGitRepo(join(tmp, "c"), "shared");

    const db = new SessionDB(join(tmp, "sessions.db"), noopLogger);
    const manager = new ProjectManager(db, noopLogger);

    assert.equal(manager.addProject(a).slug, "shared");
    assert.equal(manager.addProject(b).slug, "shared-2");
    assert.equal(manager.addProject(c).slug, "shared-3");

    db.close();
  });

  it("getProject(slug) and getProject(uuid) return the same project", () => {
    const tmp = mkdtempSync(join(tmpdir(), "relay-slug-"));
    cleanup.push(tmp);
    const repo = makeGitRepo(tmp, "lookup-me");

    const db = new SessionDB(join(tmp, "sessions.db"), noopLogger);
    const manager = new ProjectManager(db, noopLogger);
    const created = manager.addProject(repo);

    const byId = manager.getProject(created.id);
    const bySlug = manager.getProject(created.slug);
    assert.ok(byId);
    assert.ok(bySlug);
    assert.equal(byId.id, bySlug.id);
    assert.equal(bySlug.slug, "lookup-me");

    db.close();
  });
});
