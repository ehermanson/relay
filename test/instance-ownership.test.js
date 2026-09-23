// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPersistenceOwnershipReconciliation,
  getPersistenceRowProjectDirectory,
  getProjectDirectoryCandidates,
} from "../dist/server/core/instance-ownership.js";

describe("instance-ownership helpers", () => {
  it("normalizes persisted project directories and candidate lookup paths", () => {
    assert.equal(
      getPersistenceRowProjectDirectory({
        original_directory: "/tmp/project",
        working_directory: "/tmp/project/worktree",
      }),
      "/tmp/project",
    );
    assert.equal(getProjectDirectoryCandidates(null).length, 0);
    assert.equal(getProjectDirectoryCandidates("/tmp/project").includes("/tmp/project"), true);
  });

  it("builds persistence ownership reconciliation patches", () => {
    const reconciliation = buildPersistenceOwnershipReconciliation({
      workingDirectory: "/tmp/project/.git/worktrees/feature",
      originalDirectory: "/tmp/project/.git/worktrees/feature",
      infoOriginalDirectory: null,
      infoProjectId: "project-old",
      projectId: "project-1",
      space: {
        isDefault: false,
        projectDirectory: "/tmp/project",
      },
    });

    assert.deepEqual(reconciliation, {
      projectDirectory: "/tmp/project",
      nextInfoProjectId: "project-1",
      nextOriginalDirectory: "/tmp/project",
      nextInfoOriginalDirectory: "/tmp/project",
    });
  });

  it("skips original-directory rewrites for default spaces and unchanged projects", () => {
    const reconciliation = buildPersistenceOwnershipReconciliation({
      workingDirectory: "/tmp/project",
      originalDirectory: "/tmp/project",
      infoOriginalDirectory: "/tmp/project",
      infoProjectId: "project-1",
      projectId: "project-1",
      space: {
        isDefault: true,
        projectDirectory: "/tmp/project",
      },
    });

    assert.deepEqual(reconciliation, {
      projectDirectory: "/tmp/project",
    });
  });

  it("handles missing space and missing project reconciliation inputs", () => {
    const reconciliation = buildPersistenceOwnershipReconciliation({
      workingDirectory: "/tmp/project",
      originalDirectory: null,
      infoOriginalDirectory: null,
      infoProjectId: null,
    });

    assert.deepEqual(reconciliation, {
      projectDirectory: "/tmp/project",
    });
  });
});
