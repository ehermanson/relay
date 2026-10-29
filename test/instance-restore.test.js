// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveExternalRestorePaths,
  resolveManagedRestorePaths,
} from "../dist/server/core/instance-restore.js";

const WORKTREE_ROW = {
  worktree_path: "/tmp/worktrees/feature",
  git_branch: "feature",
  original_directory: "/repo",
  working_directory: "/repo",
};

describe("Instance Restore Helpers", () => {
  // The resolvers never check the disk: a missing worktree is restored as
  // recorded (and is read-only at use time), so its metadata survives the
  // next save and a remounted volume brings the chat back intact.
  it("restores an external worktree chat with its recorded worktree as the cwd", () => {
    assert.deepEqual(resolveExternalRestorePaths(WORKTREE_ROW), {
      workingDirectory: "/repo",
      worktreePath: "/tmp/worktrees/feature",
      originalDirectory: "/repo",
      actualCwd: "/tmp/worktrees/feature",
      gitBranch: "feature",
    });
  });

  it("restores a managed worktree chat at its recorded worktree", () => {
    assert.deepEqual(resolveManagedRestorePaths(WORKTREE_ROW), {
      workingDirectory: "/tmp/worktrees/feature",
      worktreePath: "/tmp/worktrees/feature",
      originalDirectory: "/repo",
      actualCwd: "/tmp/worktrees/feature",
      gitBranch: "feature",
    });
  });

  it("restores a managed chat without a worktree at its recorded directory", () => {
    const restored = resolveManagedRestorePaths({
      worktree_path: null,
      git_branch: null,
      original_directory: null,
      working_directory: "/repo",
    });

    assert.deepEqual(restored, { workingDirectory: "/repo" });
  });
});
