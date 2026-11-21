/**
 * Shared test environment setup.
 *
 * Redirects RELAY_WORKTREE_BASE to a temp directory so tests never
 * pollute ~/.relay/worktrees. Cleans up the temp dir on process exit.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const inheritedWorktreeBase = process.env.RELAY_WORKTREE_BASE;
const shouldIsolateWorktreeBase =
  !inheritedWorktreeBase || inheritedWorktreeBase.includes("relay-test-worktrees-");

if (shouldIsolateWorktreeBase) {
  process.env.RELAY_WORKTREE_BASE = mkdtempSync(join(tmpdir(), "relay-test-worktrees-"));
}

export const TEST_WORKTREE_BASE = process.env.RELAY_WORKTREE_BASE;

// Clear hook-inherited git env vars that point at the parent repo's internals.
// When running via pre-commit hook in a worktree, git sets GIT_DIR and
// GIT_INDEX_FILE to absolute paths inside the parent repo — these leak into
// test subprocesses and cause `git worktree add` in temp repos to fail with
// "index file open failed: Not a directory".
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;
delete process.env.GIT_INDEX_FILE;

// Keep git-dependent tests deterministic and avoid inheriting slow global config
// like LFS filters, signing hooks, or interactive prompts from the host machine.
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_ASKPASS = "true";
process.env.GIT_LFS_SKIP_SMUDGE = "1";
process.env.RELAY_GIT_TIMEOUT_MS = process.env.RELAY_GIT_TIMEOUT_MS || "5000";

// Make the Claude provider appear installed without requiring the real CLI on
// PATH. The managed-session tests construct provider sessions but never spawn
// the binary (sends are stubbed), so a sentinel path is enough to pass the
// provider-availability gate. Keeps the suite hermetic — e.g. on CI runners
// and clean contributor machines where the Claude CLI isn't installed.
process.env.RELAY_CLAUDE_CLI_PATH = process.env.RELAY_CLAUDE_CLI_PATH || "/usr/bin/true";
process.env.RELAY_CODEX_CLI_PATH = process.env.RELAY_CODEX_CLI_PATH || "/usr/bin/true";
// Antigravity stays "not installed" unless a test opts in, and never reads the
// real Gemini home (~/.gemini) even on a machine where `agy` is installed.
process.env.RELAY_ANTIGRAVITY_CLI_PATH =
  process.env.RELAY_ANTIGRAVITY_CLI_PATH || "/nonexistent/relay-test-agy";
process.env.ANTIGRAVITY_DIR =
  process.env.ANTIGRAVITY_DIR || mkdtempSync(join(tmpdir(), "relay-test-gemini-"));
process.env.GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || "Relay Test";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || "relay-test@example.com";
process.env.GIT_COMMITTER_NAME = process.env.GIT_COMMITTER_NAME || process.env.GIT_AUTHOR_NAME;
process.env.GIT_COMMITTER_EMAIL = process.env.GIT_COMMITTER_EMAIL || process.env.GIT_AUTHOR_EMAIL;

process.on("exit", () => {
  try {
    rmSync(TEST_WORKTREE_BASE, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});
