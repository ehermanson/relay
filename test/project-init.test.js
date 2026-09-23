// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionDB } from "../dist/server/core/db.js";
import { noopLogger } from "../dist/server/core/logger.js";
import { ProjectManager } from "../dist/server/core/project-manager.js";

async function withStrictGitIdentityEnv(run) {
  const saved = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
    EMAIL: process.env.EMAIL,
  };

  const fakeHome = mkdtempSync(join(tmpdir(), "relay-git-home-"));
  process.env.HOME = fakeHome;
  process.env.XDG_CONFIG_HOME = fakeHome;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = join(fakeHome, ".gitconfig-does-not-exist");
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "user.useConfigOnly";
  process.env.GIT_CONFIG_VALUE_0 = "true";
  delete process.env.GIT_AUTHOR_NAME;
  delete process.env.GIT_AUTHOR_EMAIL;
  delete process.env.GIT_COMMITTER_NAME;
  delete process.env.GIT_COMMITTER_EMAIL;
  delete process.env.EMAIL;

  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

describe("ProjectManager.initProject", () => {
  const cleanup = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      rmSync(cleanup.pop(), { recursive: true, force: true });
    }
  });

  it("creates a project even when git identity must be provided explicitly", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "relay-project-init-"));
    cleanup.push(tempDir);

    const db = new SessionDB(join(tempDir, "sessions.db"), noopLogger);
    const manager = new ProjectManager(db, noopLogger);

    await withStrictGitIdentityEnv(async () => {
      const project = await manager.initProject(tempDir, "new-project");
      const projectDir = join(tempDir, "new-project");

      assert.equal(realpathSync(project.directory), realpathSync(projectDir));
      assert.equal(project.name, "new-project");
      assert.equal(
        execSync("git rev-parse --is-inside-work-tree", { cwd: projectDir }).toString().trim(),
        "true",
      );
      assert.match(
        execFileSync("git", ["log", "--format=%an <%ae>", "-1"], { cwd: projectDir })
          .toString()
          .trim(),
        /^Relay <relay@local>$/,
      );
    });

    db.close();
  });
});
