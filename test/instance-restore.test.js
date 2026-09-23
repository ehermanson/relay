// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  explicitOrInferredSpaceIdForPersistenceRow,
  inferSpaceIdForPersistenceRow,
  resolveExternalRestorePaths,
  resolveManagedRestorePaths,
} from "../dist/server/core/instance-restore.js";

describe("Instance Restore Helpers", () => {
  it("infers space ownership from worktree and missing worktree paths", () => {
    const spaces = [
      {
        id: "space-1",
        projectDirectory: "/repo",
        name: "Space One",
        gitBranch: "relay-space/one",
        worktreePath: "/tmp/worktrees/space-1",
        missingWorktreePath: "/tmp/missing/space-1",
        isDefault: false,
        status: "active",
        createdAt: 1,
        lastActivityAt: 1,
        chatCount: 0,
      },
    ];

    assert.equal(
      inferSpaceIdForPersistenceRow(
        {
          space_id: null,
          worktree_path: "/tmp/worktrees/space-1",
          git_branch: null,
          original_directory: "/repo",
          working_directory: "/repo",
        },
        spaces,
      ),
      "space-1",
    );

    assert.equal(
      inferSpaceIdForPersistenceRow(
        {
          space_id: null,
          worktree_path: "/tmp/missing/space-1",
          git_branch: null,
          original_directory: "/repo",
          working_directory: "/repo",
        },
        spaces,
      ),
      "space-1",
    );
  });

  it("falls back to branch matching for legacy rows and preserves explicit ownership", () => {
    const spaces = [
      {
        id: "space-2",
        projectDirectory: "/repo",
        name: "Space Two",
        gitBranch: "relay-space/two",
        worktreePath: "/tmp/worktrees/space-2",
        missingWorktreePath: null,
        isDefault: false,
        status: "active",
        createdAt: 1,
        lastActivityAt: 1,
        chatCount: 0,
      },
    ];

    assert.equal(
      inferSpaceIdForPersistenceRow(
        {
          space_id: null,
          worktree_path: null,
          git_branch: "relay-space/two",
          original_directory: "/repo",
          working_directory: "/repo",
        },
        spaces,
      ),
      "space-2",
    );

    assert.equal(
      explicitOrInferredSpaceIdForPersistenceRow(
        {
          space_id: "explicit-space",
          worktree_path: null,
          git_branch: "relay-space/two",
          original_directory: "/repo",
          working_directory: "/repo",
        },
        spaces,
      ),
      "explicit-space",
    );
  });

  it("keeps explicit broken external space restores read-only at the missing worktree path", () => {
    const restored = resolveExternalRestorePaths({
      row: {
        space_id: "space-1",
        worktree_path: "/tmp/worktrees/space-1",
        git_branch: "relay-space/one",
        original_directory: "/repo",
        working_directory: "/repo",
      },
      hasExplicitSpaceOwnership: true,
      usableStoredWorktreePath: false,
    });

    assert.deepEqual(restored, {
      workingDirectory: "/tmp/worktrees/space-1",
      originalDirectory: "/repo",
      gitBranch: "relay-space/one",
      repairedStaleWorktree: false,
    });
  });

  it("falls back legacy external restores to the original directory when the worktree is stale", () => {
    const restored = resolveExternalRestorePaths({
      row: {
        space_id: null,
        worktree_path: "/tmp/worktrees/legacy",
        git_branch: "relay-space/legacy",
        original_directory: "/repo",
        working_directory: "/repo",
      },
      hasExplicitSpaceOwnership: false,
      usableStoredWorktreePath: false,
    });

    assert.deepEqual(restored, {
      workingDirectory: "/repo",
      originalDirectory: "/repo",
      gitBranch: "relay-space/legacy",
      repairedStaleWorktree: true,
    });
  });

  it("keeps explicit broken managed space restores read-only and preserves original metadata", () => {
    const restored = resolveManagedRestorePaths({
      row: {
        space_id: "space-3",
        worktree_path: "/tmp/worktrees/space-3",
        git_branch: "relay-space/three",
        original_directory: "/repo",
        working_directory: "/repo",
      },
      hasExplicitSpaceOwnership: true,
      usableStoredWorktreePath: false,
    });

    assert.deepEqual(restored, {
      workingDirectory: "/tmp/worktrees/space-3",
      originalDirectory: "/repo",
      gitBranch: "relay-space/three",
      repairedStaleWorktree: false,
    });
  });

  it("restores managed worktrees directly when the stored path is still usable", () => {
    const restored = resolveManagedRestorePaths({
      row: {
        space_id: "space-4",
        worktree_path: "/tmp/worktrees/space-4",
        git_branch: "relay-space/four",
        original_directory: "/repo",
        working_directory: "/repo",
      },
      hasExplicitSpaceOwnership: true,
      usableStoredWorktreePath: true,
    });

    assert.deepEqual(restored, {
      workingDirectory: "/tmp/worktrees/space-4",
      worktreePath: "/tmp/worktrees/space-4",
      originalDirectory: "/repo",
      actualCwd: "/tmp/worktrees/space-4",
      gitBranch: "relay-space/four",
      repairedStaleWorktree: false,
    });
  });
});
