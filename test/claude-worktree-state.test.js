// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
/**
 * Claude `EnterWorktree` moves a running session into a git worktree without
 * changing the cwd Relay spawned it with, and relocates its transcript into
 * the worktree's project dir. The chat's branch must follow the worktree, and
 * the stored transcript path must follow the file.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  pickClaudeWorktreeStateFromLines,
  readClaudeWorktreeState,
} from "../dist/server/core/providers/claude-worktree-state.js";
import {
  readSessionWorkingDirectoryForProvider,
  resolveManagedTranscriptPathForProvider,
} from "../dist/server/core/provider-registry.js";

const entered = (worktreePath) =>
  JSON.stringify({
    type: "worktree-state",
    worktreeSession: {
      originalCwd: "/repo",
      worktreePath,
      worktreeName: "feat",
      worktreeBranch: "worktree-feat",
      originalBranch: "main",
    },
    sessionId: "s1",
  });
const exited = JSON.stringify({ type: "worktree-state", worktreeSession: null, sessionId: "s1" });
const user = JSON.stringify({
  type: "user",
  cwd: "/repo",
  message: { role: "user", content: "hi" },
});

let tempDir;
afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("claude worktree-state", () => {
  it("last record wins; exit clears; no record is undefined", () => {
    assert.equal(pickClaudeWorktreeStateFromLines(user), undefined);
    assert.deepEqual(pickClaudeWorktreeStateFromLines([user, entered("/wt")].join("\n")), {
      worktreePath: "/wt",
      worktreeBranch: "worktree-feat",
    });
    assert.equal(pickClaudeWorktreeStateFromLines([entered("/wt"), user, exited].join("\n")), null);
    assert.equal(
      pickClaudeWorktreeStateFromLines([exited, entered("/wt2")].join("\n"))?.worktreePath,
      "/wt2",
    );
  });

  it("reads the transcript and refreshes when it grows", () => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-wt-state-"));
    const file = join(tempDir, "s1.jsonl");
    writeFileSync(file, user + "\n");
    assert.equal(readClaudeWorktreeState(file), null);
    appendFileSync(file, entered("/wt") + "\n");
    assert.equal(readClaudeWorktreeState(file)?.worktreePath, "/wt");
    assert.equal(readSessionWorkingDirectoryForProvider("claude", file), "/wt");
    appendFileSync(file, exited + "\n");
    assert.equal(readClaudeWorktreeState(file), null);
    assert.equal(readClaudeWorktreeState(join(tempDir, "missing.jsonl")), null);
  });

  it("finds a transcript the CLI relocated to another project dir", () => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-wt-reloc-"));
    const claudeRoot = join(tempDir, ".claude");
    const repo = join(tempDir, "repo");
    const relocatedDir = join(claudeRoot, "projects", "-repo--claude-worktrees-feat");
    mkdirSync(relocatedDir, { recursive: true });
    const relocated = join(relocatedDir, "s1.jsonl");
    writeFileSync(relocated, user + "\n");
    const stale = join(claudeRoot, "projects", "-repo", "s1.jsonl");

    const resolved = resolveManagedTranscriptPathForProvider("claude", {
      providerDirs: { claude: claudeRoot, codex: join(tempDir, ".codex") },
      sessionId: "s1",
      transcriptPath: stale,
      workingDirectory: repo,
    });
    assert.equal(resolved, relocated);
  });
});
