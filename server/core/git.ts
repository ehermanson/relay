/**
 * Git helpers for projects, spaces, and worktree isolation.
 *
 * Two kinds of helpers live here:
 *
 * 1. **Filesystem-only metadata** (sync): repository/worktree discovery,
 *    worktree origin resolution, and HEAD branch reads. These parse `.git`,
 *    `commondir`, and `HEAD` directly — no subprocess — so they're safe on
 *    synchronous restore/scan paths.
 * 2. **Everything else** (async): every operation that needs git itself runs
 *    through the shared runner in `git-runner.ts` (non-blocking, prompt-free
 *    env, timeouts, concurrency cap, typed errors). Mutations take the
 *    per-repository lock (`withRepoLock`).
 *
 * Never call `execFileSync("git", …)` on a request, WebSocket, or manager path.
 */

import { existsSync, readFileSync, statSync, realpathSync, lstatSync, rmSync } from "fs";
import { open, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";

import type { FileChange } from "#core/types.js";
import { relayDir } from "#core/config.js";
import {
  GIT_TIMEOUTS,
  GitCommandError,
  runGit,
  withRepoLock,
  type GitErrorKind,
} from "#core/git-runner.js";

export { GitCommandError, isGitCommandError, withRepoLock } from "#core/git-runner.js";
export type { GitErrorKind } from "#core/git-runner.js";

const DEFAULT_WORKTREE_BASE = join(relayDir, "worktrees");

/**
 * Return the worktree base directory.
 * Respects RELAY_WORKTREE_BASE so tests can redirect to a temp dir. As a
 * safety net, a process running under the Node test runner without that
 * override never falls back to the real ~/.relay/worktrees.
 */
export function getWorktreeBase(): string {
  if (process.env.RELAY_WORKTREE_BASE) return process.env.RELAY_WORKTREE_BASE;
  if (process.env.NODE_TEST_CONTEXT) {
    const base = join(tmpdir(), `relay-test-worktrees-fallback-${process.pid}`);
    process.env.RELAY_WORKTREE_BASE = base;
    return base;
  }
  return DEFAULT_WORKTREE_BASE;
}
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const RELAY_GIT_FALLBACK_NAME = "Relay";
const RELAY_GIT_FALLBACK_EMAIL = "relay@local";
const MAX_DIFF_BYTES = 10 * 1024 * 1024;

/** Result shape for git mutations reported back to the UI. */
export type GitMutationResult =
  | { success: true }
  | {
      success: false;
      error: string;
      errorKind?: GitErrorKind;
      /** Conflicting paths when `error === "CONFLICT"`. */
      conflicts?: string[];
    };

function mutationFailure(err: unknown, fallback: string): GitMutationResult {
  if (err instanceof GitCommandError) {
    return { success: false, error: err.message, errorKind: err.kind };
  }
  return { success: false, error: err instanceof Error ? err.message : fallback };
}

// ─── Filesystem-only metadata (no subprocess) ─────────────────────────────

function hasValidRelayWorktreeAdmin(dir: string): boolean {
  if (!isRelayWorktreePath(dir)) return true;

  const gitPath = join(dir, ".git");
  if (!existsSync(gitPath)) return false;

  try {
    const stat = statSync(gitPath);
    if (stat.isDirectory()) return true;
    const raw = readFileSync(gitPath, "utf8").trim();
    const match = raw.match(/^gitdir:\s*(.+)$/i);
    if (!match) return false;
    return existsSync(resolve(dir, match[1]));
  } catch {
    return false;
  }
}

function canonicalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

interface GitDirs {
  /** Working tree root containing the `.git` entry. */
  root: string;
  /** Per-worktree git dir (`.git`, or `.git/worktrees/<name>` for linked worktrees). */
  gitDir: string;
  /** Shared git dir (`.git` of the primary checkout). */
  commonDir: string;
}

function findGitEntry(dir: string): string | null {
  let current = resolve(dir);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Resolve the working-tree root, git dir, and common dir for `dir` by reading
 * `.git` / `commondir` directly. Returns null outside a repository or when the
 * worktree's admin directory is missing (a broken linked worktree).
 */
export function resolveGitDirs(dir: string): GitDirs | null {
  const root = findGitEntry(dir);
  if (!root) return null;
  const gitPath = join(root, ".git");
  try {
    let gitDir: string;
    if (statSync(gitPath).isDirectory()) {
      gitDir = gitPath;
    } else {
      const match = readFileSync(gitPath, "utf8")
        .trim()
        .match(/^gitdir:\s*(.+)$/i);
      if (!match) return null;
      gitDir = resolve(root, match[1].trim());
      if (!existsSync(gitDir)) return null;
    }
    let commonDir = gitDir;
    const commonFile = join(gitDir, "commondir");
    if (existsSync(commonFile)) {
      commonDir = resolve(gitDir, readFileSync(commonFile, "utf8").trim());
    }
    return { root: canonicalize(root), gitDir, commonDir };
  } catch {
    return null;
  }
}

/**
 * Current branch and worktree-ness from `HEAD`, without spawning git.
 * Returns null outside a repository, on a detached HEAD, or when the HEAD
 * can't be interpreted (e.g. reftable repositories). For synchronous restore
 * and scan paths; async callers should prefer `getGitInfo`.
 */
export function readGitHeadInfo(dir: string): { branch: string; isWorktree: boolean } | null {
  if (!hasValidRelayWorktreeAdmin(dir)) return null;
  const dirs = resolveGitDirs(dir);
  if (!dirs) return null;
  try {
    const head = readFileSync(join(dirs.gitDir, "HEAD"), "utf8").trim();
    const match = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    const branch = match?.[1]?.trim();
    if (!branch || branch === ".invalid") return null;
    return { branch, isWorktree: resolve(dirs.gitDir) !== resolve(dirs.commonDir) };
  } catch {
    return null;
  }
}

/** Check if a file is likely binary by reading the first 8KB and looking for null bytes. */
async function isBinaryFile(absPath: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(absPath, "r");
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, 8192, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function normalizeBranchName(branch: string): string | null {
  const trimmed = branch.trim();
  if (!trimmed || trimmed === "HEAD") return null;
  return trimmed;
}

/** Pattern matching the default ~/.relay/worktrees/<name> paths. */
const RELAY_WORKTREE_RE = /[/\\]\.relay[/\\]worktrees[/\\][^/\\]+\/?$/;

/**
 * Check if a directory path is a relay-managed worktree.
 * Matches the canonical ~/.relay/worktrees/<name> pattern and also any
 * custom base set via RELAY_WORKTREE_BASE (used in tests).
 */
export function isRelayWorktreePath(dir: string): boolean {
  if (RELAY_WORKTREE_RE.test(dir)) return true;
  const base = getWorktreeBase();
  if (base === DEFAULT_WORKTREE_BASE) return false;
  const normalized = dir.replace(/[/\\]+$/, "");
  return (
    normalized.startsWith(base) &&
    normalized.length > base.length &&
    !normalized.slice(base.length + 1).includes("/")
  );
}

/**
 * For a relay worktree path, resolve the original repository directory
 * from the worktree's common dir (the main repo's `.git/`).
 * Returns null if the worktree doesn't exist on disk or can't be resolved.
 */
export function resolveWorktreeOrigin(worktreePath: string): string | null {
  if (!isRelayWorktreePath(worktreePath)) return null;
  if (!existsSync(worktreePath)) return null;
  if (!hasValidRelayWorktreeAdmin(worktreePath)) return null;
  const dirs = resolveGitDirs(worktreePath);
  return dirs ? dirname(dirs.commonDir) : null;
}

/**
 * Check if a directory is a git worktree (as opposed to a primary repo checkout).
 * A worktree has a .git file (not directory) containing a `gitdir:` reference.
 */
export function isGitWorktree(dir: string): boolean {
  const gitPath = join(dir, ".git");
  try {
    if (!existsSync(gitPath)) return false;
    const stat = statSync(gitPath);
    if (stat.isDirectory()) return false; // Primary repo, not a worktree
    const raw = readFileSync(gitPath, "utf8").trim();
    return /^gitdir:\s+/i.test(raw);
  } catch {
    return false;
  }
}

/**
 * Resolve any git worktree (relay or external) to the original repository directory.
 * Returns null if the directory is not a worktree or resolution fails.
 */
export function resolveAnyWorktreeOrigin(dir: string): string | null {
  if (!isGitWorktree(dir)) return null;
  const dirs = resolveGitDirs(dir);
  return dirs ? dirname(dirs.commonDir) : null;
}

/** Check if a directory is inside a (non-broken) git working tree. */
export function isGitRepo(dir: string): boolean {
  if (!hasValidRelayWorktreeAdmin(dir)) return false;
  return resolveGitDirs(dir) !== null;
}

/** Get the root directory of the git working tree containing `dir`. */
export function getRepoRoot(dir: string): string | null {
  if (!hasValidRelayWorktreeAdmin(dir)) return null;
  return resolveGitDirs(dir)?.root ?? null;
}

// ─── Repository setup ─────────────────────────────────────────────────────

function isMissingGitIdentityError(error: unknown): boolean {
  const text =
    error instanceof GitCommandError
      ? error.stderr
      : String((error as { stderr?: unknown })?.stderr ?? "");
  return (
    text.includes("Author identity unknown") ||
    text.includes("Committer identity unknown") ||
    text.includes("unable to auto-detect email address") ||
    text.includes("no email was given and auto-detection is disabled")
  );
}

/** Run `git commit …`, retrying with Relay's fallback identity when none is configured. */
async function commitWithFallbackIdentity(
  cwd: string,
  commitArgs: string[],
  operation: string,
): Promise<void> {
  try {
    await runGit(["commit", ...commitArgs], { cwd, timeoutMs: GIT_TIMEOUTS.normal, operation });
  } catch (error) {
    if (!isMissingGitIdentityError(error)) throw error;
    await runGit(
      [
        "-c",
        `user.name=${RELAY_GIT_FALLBACK_NAME}`,
        "-c",
        `user.email=${RELAY_GIT_FALLBACK_EMAIL}`,
        "commit",
        ...commitArgs,
      ],
      { cwd, timeoutMs: GIT_TIMEOUTS.normal, operation },
    );
  }
}

/**
 * Initialize a new git repository with an initial empty commit.
 * The commit ensures HEAD is valid for worktree creation and other git operations.
 */
export async function gitInit(dir: string): Promise<void> {
  await runGit(["init"], { cwd: dir, timeoutMs: GIT_TIMEOUTS.normal, operation: "git init" });
  await commitWithFallbackIdentity(dir, ["--allow-empty", "-m", "Initial commit"], "git commit");
}

// ─── Refs, branches, remotes ──────────────────────────────────────────────

function readOnly(cwd: string, operation: string, timeoutMs: number = GIT_TIMEOUTS.fast) {
  return { cwd, readOnly: true, operation, timeoutMs };
}

/**
 * Detect the primary remote name for a repo directory.
 * Prefers "origin" if it exists, otherwise the first remote; null when the
 * repository has no remotes. Throws `GitCommandError` on git failure.
 */
export async function getPrimaryRemote(dir: string): Promise<string | null> {
  const { stdout } = await runGit(["remote"], readOnly(dir, "git remote"));
  const remotes = stdout.trim().split("\n").filter(Boolean);
  if (remotes.includes("origin")) return "origin";
  return remotes[0] ?? null;
}

/**
 * Get the browsable URL of the primary remote (SSH URLs normalized to HTTPS).
 * Returns null when there is no remote or it has no URL.
 */
export async function getRemoteUrl(dir: string): Promise<string | null> {
  if (!hasValidRelayWorktreeAdmin(dir)) return null;
  const remote = await getPrimaryRemote(dir);
  if (!remote) return null;
  const { stdout, exitCode } = await runGit(["config", "--get", `remote.${remote}.url`], {
    ...readOnly(dir, "git config"),
    allowFailure: true,
  });
  const raw = exitCode === 0 ? stdout.trim() : "";
  if (!raw) return null;
  const sshMatch = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2]}`;
  return raw.replace(/\.git$/, "");
}

/**
 * Get the current branch name. Returns null on a detached HEAD (or a broken
 * Relay worktree); throws `GitCommandError` when git fails, so callers can
 * tell "no branch" from "couldn't tell".
 */
export async function getCurrentBranch(dir: string): Promise<string | null> {
  if (!hasValidRelayWorktreeAdmin(dir)) return null;
  const { stdout, exitCode, stderr } = await runGit(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    {
      ...readOnly(dir, "git symbolic-ref"),
      allowFailure: true,
    },
  );
  if (exitCode === 0) return normalizeBranchName(stdout);
  if (exitCode === 1) return null; // detached HEAD
  throw new GitCommandError({
    kind: stderr.toLowerCase().includes("not a git repository") ? "not_a_repo" : "failed",
    operation: "git symbolic-ref",
    cwd: dir,
    message: "Could not read current branch",
    exitCode,
    stderr,
  });
}

/**
 * Branch and worktree-ness via git in a single call. Null when unknown
 * (not a repo, detached HEAD, or git failure) — used for passive enrichment.
 */
export async function getGitInfo(
  dir: string,
): Promise<{ branch: string; isWorktree: boolean } | null> {
  if (!hasValidRelayWorktreeAdmin(dir)) return null;
  try {
    const { stdout } = await runGit(
      ["rev-parse", "--abbrev-ref", "HEAD", "--git-dir", "--git-common-dir"],
      readOnly(dir, "git rev-parse"),
    );
    const [branchLine, gitDirLine, commonDirLine] = stdout.split("\n");
    const branch = normalizeBranchName(branchLine ?? "");
    if (!branch || !gitDirLine || !commonDirLine) return null;
    return {
      branch,
      isWorktree: resolve(dir, gitDirLine.trim()) !== resolve(dir, commonDirLine.trim()),
    };
  } catch {
    return null;
  }
}

async function hasHeadCommit(dir: string): Promise<boolean> {
  const { exitCode } = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], {
    ...readOnly(dir, "git rev-parse"),
    allowFailure: true,
  });
  return exitCode === 0;
}

/** Commit hash of HEAD. Throws `GitCommandError` on failure. */
export async function getHeadCommit(dir: string): Promise<string> {
  const { stdout } = await runGit(["rev-parse", "HEAD"], readOnly(dir, "git rev-parse"));
  return stdout.trim();
}

/**
 * Get the default branch for a repository (main/master). Uses the primary
 * remote's HEAD, then a main/master heuristic. Best-effort: returns null
 * when nothing can be determined, including on git failure.
 */
export async function getDefaultBranch(dir: string): Promise<string | null> {
  if (!hasValidRelayWorktreeAdmin(dir)) return null;
  try {
    const remote = await getPrimaryRemote(dir);
    if (remote) {
      const prefix = `refs/remotes/${remote}/`;
      const { stdout, exitCode } = await runGit(["symbolic-ref", "--quiet", `${prefix}HEAD`], {
        ...readOnly(dir, "git symbolic-ref"),
        allowFailure: true,
      });
      const ref = stdout.trim();
      if (exitCode === 0 && ref.startsWith(prefix) && ref.length > prefix.length) {
        return ref.slice(prefix.length);
      }
    }
    for (const candidate of ["main", "master"]) {
      const { exitCode } = await runGit(["rev-parse", "--verify", "--quiet", candidate], {
        ...readOnly(dir, "git rev-parse"),
        allowFailure: true,
      });
      if (exitCode === 0) return candidate;
    }
  } catch {
    // unknown
  }
  return null;
}

/** True when `ancestor` is reachable from `descendant`. Throws on git failure. */
export async function isAncestor(
  dir: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const { exitCode, stderr } = await runGit(["merge-base", "--is-ancestor", ancestor, descendant], {
    ...readOnly(dir, "git merge-base"),
    allowFailure: true,
  });
  if (exitCode === 0) return true;
  if (exitCode === 1) return false;
  throw new GitCommandError({
    kind: "failed",
    operation: "git merge-base",
    cwd: dir,
    message: "Could not compare branches",
    exitCode,
    stderr,
  });
}

/**
 * List local and remote branches, marking the current branch.
 * Throws `GitCommandError` on failure.
 */
export async function listBranches(dir: string): Promise<{
  local: string[];
  remote: string[];
  current: string | null;
}> {
  const [localResult, remoteResult, primaryRemote] = await Promise.all([
    runGit(["branch", "--no-color"], readOnly(dir, "git branch")),
    runGit(["branch", "-r", "--no-color"], readOnly(dir, "git branch")),
    getPrimaryRemote(dir),
  ]);

  let current: string | null = null;
  const local: string[] = [];
  for (const line of localResult.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (line.startsWith("* ")) {
      const branch = trimmed.slice(2);
      current = branch.startsWith("(") ? null : branch;
      if (current) local.push(current);
    } else if (line.startsWith("+ ")) {
      // Branch checked out in another worktree — include it but don't mark as current
      const branch = trimmed.slice(2);
      if (branch && !branch.startsWith("(")) local.push(branch);
    } else {
      local.push(trimmed);
    }
  }

  const remote: string[] = [];
  const remotePrefix = primaryRemote ? `${primaryRemote}/` : null;
  for (const line of remoteResult.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes("->")) continue;
    // Strip the primary remote's prefix for cleaner display
    const name =
      remotePrefix && trimmed.startsWith(remotePrefix)
        ? trimmed.slice(remotePrefix.length)
        : trimmed;
    if (name && !remote.includes(name)) remote.push(name);
  }

  return { local, remote, current };
}

// ─── Status ───────────────────────────────────────────────────────────────

export interface GitStatusSummary {
  /** Checked-out branch; null on a detached HEAD. */
  branch: string | null;
  /** HEAD commit; null on an unborn branch. */
  head: string | null;
  /** Upstream ref (e.g. `origin/main`); null when none is configured. */
  upstream: string | null;
  /** Commits ahead of/behind upstream; null without a (reachable) upstream. */
  ahead: number | null;
  behind: number | null;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  /** Distinct changed paths (staged, unstaged, untracked, or conflicted). */
  changeCount: number;
  dirty: boolean;
  /** Changed paths relative to the repo root (only with `collectPaths`). */
  paths?: string[];
}

/**
 * Branch, upstream, ahead/behind, and change counts in ONE read-only call
 * (`git status --porcelain=2 --branch -z`). Throws `GitCommandError` on failure.
 */
export async function getStatusSummary(
  dir: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number; collectPaths?: boolean },
): Promise<GitStatusSummary> {
  const { stdout } = await runGit(
    ["status", "--porcelain=2", "--branch", "-z", "--untracked-files=normal"],
    {
      ...readOnly(dir, "git status", opts?.timeoutMs ?? GIT_TIMEOUTS.fast * 2),
      signal: opts?.signal,
    },
  );
  const summary: GitStatusSummary = {
    branch: null,
    head: null,
    upstream: null,
    ahead: null,
    behind: null,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    changeCount: 0,
    dirty: false,
  };
  const tokens = stdout.split("\0");
  const paths: string[] | null = opts?.collectPaths ? [] : null;
  // Porcelain v2: the path follows a fixed number of space-separated fields.
  const pathAfterFields = (entry: string, fields: number): string => {
    let idx = -1;
    for (let n = 0; n < fields; n++) {
      idx = entry.indexOf(" ", idx + 1);
      if (idx < 0) return "";
    }
    return entry.slice(idx + 1);
  };
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry) continue;
    if (entry.startsWith("# ")) {
      const [, key, ...rest] = entry.split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") summary.head = value === "(initial)" ? null : value;
      else if (key === "branch.head") summary.branch = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") summary.upstream = value;
      else if (key === "branch.ab") {
        const m = value.match(/^\+(\d+) -(\d+)$/);
        if (m) {
          summary.ahead = Number(m[1]);
          summary.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = entry[0];
    if (paths) {
      const fields = kind === "?" ? 1 : kind === "1" ? 8 : kind === "2" ? 9 : kind === "u" ? 10 : 0;
      const path = fields ? pathAfterFields(entry, fields) : "";
      if (path) paths.push(path);
    }
    if (kind === "?") {
      summary.untracked++;
      summary.changeCount++;
    } else if (kind === "u") {
      summary.conflicted++;
      summary.changeCount++;
    } else if (kind === "1" || kind === "2") {
      const xy = entry.slice(2, 4);
      if (xy[0] && xy[0] !== ".") summary.staged++;
      if (xy[1] && xy[1] !== ".") summary.unstaged++;
      summary.changeCount++;
      if (kind === "2") i++; // rename/copy: next token is the original path
    }
  }
  summary.dirty = summary.changeCount > 0;
  if (paths) summary.paths = paths;
  return summary;
}

/**
 * Whether `dir` (scoped to its subtree) has uncommitted changes.
 * Throws `GitCommandError` when status can't be read — callers must not
 * treat "unknown" as clean or dirty.
 */
export async function isWorktreeDirty(dir: string): Promise<boolean> {
  const { stdout } = await runGit(
    ["status", "--porcelain", "-z", "--", "."],
    readOnly(dir, "git status", GIT_TIMEOUTS.fast * 2),
  );
  return stdout.length > 0;
}

/**
 * Ahead/behind counts relative to the upstream tracking branch.
 * Returns null when no upstream is configured; throws on git failure.
 */
export async function getAheadBehind(
  dir: string,
): Promise<{ ahead: number; behind: number } | null> {
  const summary = await getStatusSummary(dir);
  if (summary.ahead == null || summary.behind == null) return null;
  return { ahead: summary.ahead, behind: summary.behind };
}

export interface GitWorktreeStatus {
  dirty: boolean;
  changeCount: number;
  /** 0/0 when there is no upstream — check `hasUpstream`. */
  aheadBehind: { ahead: number; behind: number };
  hasUpstream: boolean;
}

/** Dirty state + ahead/behind for a working directory. Throws on git failure. */
export async function getWorktreeStatus(dir: string): Promise<GitWorktreeStatus> {
  const summary = await getStatusSummary(dir);
  const hasUpstream = summary.ahead != null && summary.behind != null;
  return {
    dirty: summary.dirty,
    changeCount: summary.changeCount,
    aheadBehind: { ahead: summary.ahead ?? 0, behind: summary.behind ?? 0 },
    hasUpstream,
  };
}

/**
 * Count commits on HEAD that are not in `baseRef`. Throws `GitCommandError`
 * when the count can't be computed (e.g. unknown ref).
 */
export async function getCommitsAhead(dir: string, baseRef: string): Promise<number> {
  const { stdout } = await runGit(
    ["rev-list", "--count", `${baseRef}..HEAD`],
    readOnly(dir, "git rev-list"),
  );
  const n = Number(stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Whether a worktree has uncommitted changes or commits not on the original
 * directory's current branch. Conservative: returns true when it can't tell,
 * because this guards against discarding work.
 */
export async function hasWorktreeChanges(
  worktreePath: string,
  originalDirectory: string,
): Promise<boolean> {
  try {
    if (await isWorktreeDirty(worktreePath)) return true;
    const originalBranch = await getCurrentBranch(originalDirectory);
    if (!originalBranch) return true;
    return (await getCommitsAhead(worktreePath, originalBranch)) > 0;
  } catch {
    return true;
  }
}

// ─── Worktrees ────────────────────────────────────────────────────────────

/**
 * `git worktree add -b <branch> <path> <baseRef>` under the repository lock.
 * Throws `GitCommandError` on failure.
 */
export async function addWorktree(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
  baseRef: string,
): Promise<void> {
  await withRepoLock(repoRoot, () =>
    runGit(["worktree", "add", "-b", branchName, worktreePath, baseRef], {
      cwd: repoRoot,
      timeoutMs: GIT_TIMEOUTS.long,
      operation: "git worktree add",
    }),
  );
}

/**
 * Create a git worktree for an isolated instance: branch `relay/<shortId>`
 * at HEAD, checked out in `<worktree base>/<shortId>/`. Null on failure.
 */
export async function createWorktree(
  repoRoot: string,
  shortId: string,
): Promise<{ worktreePath: string; branchName: string } | null> {
  const worktreePath = join(getWorktreeBase(), shortId);
  const branchName = `relay/${shortId}`;
  try {
    await addWorktree(repoRoot, worktreePath, branchName, "HEAD");
    return { worktreePath, branchName };
  } catch {
    return null;
  }
}

export type WorktreeRemovalMethod = "git" | "fallback-delete" | "already-gone" | "failed";

export interface WorktreeRemovalResult {
  /** True when the directory no longer exists afterwards. */
  removed: boolean;
  method: WorktreeRemovalMethod;
  /** Why removal failed (or why the fallback was refused). */
  error?: string;
}

/** True when `child` is strictly inside `parent` (after canonicalization). */
function isPathInside(child: string, parent: string): boolean {
  const c = canonicalize(resolve(child));
  const p = canonicalize(resolve(parent));
  return c.length > p.length && c.startsWith(p.endsWith("/") ? p : `${p}/`);
}

/**
 * Filesystem check of a linked-worktree directory's `.git` pointer.
 * - `dangling`: `.git` is a `gitdir:` file whose target does not exist
 *   (the repository or its worktree admin dir is gone), and the target is
 *   not on an unmounted volume;
 * - `valid`: the pointer resolves;
 * - `unknown`: no `.git`, a `.git` directory, an unreadable/malformed file,
 *   or a target on a volume that is not mounted — never safe to delete.
 */
export function inspectWorktreeGitPointer(dir: string): {
  state: "dangling" | "valid" | "unknown";
  gitdir?: string;
} {
  const gitPath = join(dir, ".git");
  try {
    const stat = lstatSync(gitPath);
    if (!stat.isFile()) return { state: "unknown" };
    const raw = readFileSync(gitPath, "utf8").trim();
    const match = raw.match(/^gitdir:\s*(.+)$/i);
    if (!match) return { state: "unknown" };
    const gitdir = resolve(dir, match[1].trim());
    if (existsSync(gitdir)) return { state: "valid", gitdir };
    // A repository on a detached external drive looks exactly like a deleted
    // one. Refuse to call it dangling unless the volume root is present.
    const volume = gitdir.match(/^\/(Volumes|mnt|media|run\/media)\/[^/]+/)?.[0];
    if (volume && !existsSync(volume)) return { state: "unknown", gitdir };
    return { state: "dangling", gitdir };
  } catch {
    return { state: "unknown" };
  }
}

/**
 * Remove a git worktree and optionally its branch. Safe to call when the
 * worktree or branch is already gone. Pass `keepBranch: true` to preserve the
 * branch for recoverability.
 *
 * Never throws for removal failures — the result reports them. When
 * `git worktree remove --force` fails, the directory is deleted directly only
 * if it lives inside Relay's worktree base AND git no longer tracks it (not in
 * `git worktree list`, or its `.git` pointer dangles). Anything else is left
 * on disk and reported as `failed`.
 */
export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
  opts?: { keepBranch?: boolean },
): Promise<WorktreeRemovalResult> {
  return withRepoLock(repoRoot, async () => {
    const result = await removeWorktreeDir(repoRoot, worktreePath);
    if (!opts?.keepBranch) {
      await runGit(["branch", "-D", branchName], {
        cwd: repoRoot,
        timeoutMs: GIT_TIMEOUTS.normal,
        operation: "git branch -D",
      }).catch(() => undefined);
    }
    return result;
  });
}

async function pruneWorktrees(repoRoot: string): Promise<void> {
  await runGit(["worktree", "prune"], {
    cwd: repoRoot,
    timeoutMs: GIT_TIMEOUTS.normal,
    operation: "git worktree prune",
  }).catch(() => undefined);
}

async function isListedWorktree(repoRoot: string, worktreePath: string): Promise<boolean | null> {
  try {
    const target = canonicalize(resolve(worktreePath));
    return (await listWorktrees(repoRoot)).some((w) => canonicalize(w.path) === target);
  } catch {
    return null;
  }
}

async function removeWorktreeDir(
  repoRoot: string,
  worktreePath: string,
): Promise<WorktreeRemovalResult> {
  if (!existsSync(worktreePath)) {
    await pruneWorktrees(repoRoot);
    return { removed: true, method: "already-gone" };
  }
  let gitError: string;
  try {
    await runGit(["worktree", "remove", "--force", worktreePath], {
      cwd: repoRoot,
      timeoutMs: GIT_TIMEOUTS.long,
      operation: "git worktree remove",
    });
    if (!existsSync(worktreePath)) return { removed: true, method: "git" };
    gitError = "git worktree remove left the directory on disk";
  } catch (err) {
    gitError = err instanceof Error ? err.message : String(err);
  }

  await pruneWorktrees(repoRoot);
  if (!existsSync(worktreePath)) return { removed: true, method: "git" };

  if (!isPathInside(worktreePath, getWorktreeBase())) {
    return {
      removed: false,
      method: "failed",
      error: `${gitError} (outside Relay's worktree base; left in place)`,
    };
  }
  const pointer = inspectWorktreeGitPointer(worktreePath);
  const listed = await isListedWorktree(repoRoot, worktreePath);
  const untracked =
    pointer.state === "dangling" || (listed === false && pointer.state !== "unknown");
  if (!untracked) {
    return {
      removed: false,
      method: "failed",
      error: `${gitError} (git still tracks this worktree; left in place)`,
    };
  }
  try {
    rmSync(worktreePath, { recursive: true, force: true });
    return { removed: !existsSync(worktreePath), method: "fallback-delete" };
  } catch (err) {
    return {
      removed: false,
      method: "failed",
      error: `${gitError}; directory delete failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string;
  isPrimary: boolean;
  isBare: boolean;
  isDetached: boolean;
}

/**
 * List all git worktrees registered for the repo containing `dir`, parsed
 * from `git worktree list --porcelain`. `isPrimary` compares against the repo
 * root after canonicalization (macOS tmpdir symlinks). Throws on git failure.
 */
export async function listWorktrees(dir: string): Promise<WorktreeEntry[]> {
  const rawRepoRoot = getRepoRoot(dir);
  const canonicalRepoRoot = rawRepoRoot ? canonicalize(rawRepoRoot) : null;

  const { stdout } = await runGit(
    ["worktree", "list", "--porcelain"],
    readOnly(dir, "git worktree list"),
  );

  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | null = null;

  const flush = () => {
    if (!current?.path) return;
    const canonicalPath = canonicalize(current.path);
    const isPrimary =
      (rawRepoRoot != null && current.path === rawRepoRoot) ||
      (canonicalRepoRoot != null && canonicalPath === canonicalRepoRoot);
    entries.push({
      path: current.path,
      branch: current.branch ?? null,
      head: current.head ?? "",
      isPrimary,
      isBare: current.isBare ?? false,
      isDetached: current.isDetached ?? false,
    });
    current = null;
  };

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length).trim() };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    } else if (line === "bare") {
      current.isBare = true;
    } else if (line === "detached") {
      current.isDetached = true;
    }
  }
  flush();

  return entries;
}

// ─── Mutations ────────────────────────────────────────────────────────────

/**
 * Stage all changes (scoped to `dir`) and commit, under the repository lock.
 */
export async function commitAll(dir: string, message: string): Promise<GitMutationResult> {
  try {
    await withRepoLock(dir, async () => {
      await runGit(["add", "-A", "--", "."], {
        cwd: dir,
        timeoutMs: GIT_TIMEOUTS.normal,
        operation: "git add",
      });
      await commitWithFallbackIdentity(dir, ["--no-verify", "-m", message], "git commit");
    });
    return { success: true };
  } catch (err) {
    return mutationFailure(err, "Unknown commit error");
  }
}

/** Switch branch under the repository lock. Throws `GitCommandError` on failure. */
export async function checkoutBranch(dir: string, branch: string): Promise<void> {
  if (!branch || branch.startsWith("-")) {
    throw new GitCommandError({
      kind: "failed",
      operation: "git checkout",
      cwd: dir,
      message: `Invalid branch name: ${branch}`,
    });
  }
  await withRepoLock(dir, () =>
    runGit(["checkout", branch], {
      cwd: dir,
      timeoutMs: GIT_TIMEOUTS.normal,
      operation: "git checkout",
    }),
  );
}

function mergeOutputError(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`;
  if (combined.includes("CONFLICT")) return "CONFLICT";
  const text = stderr.trim() || stdout.trim();
  return text || "Unknown merge error";
}

/** Paths with unmerged index entries (conflicts) in `cwd`. Empty on failure. */
async function listConflictedPaths(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await runGit(
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      readOnly(cwd, "git diff"),
    );
    return [...new Set(stdout.split("\0").filter(Boolean))];
  } catch {
    return [];
  }
}

/**
 * Undo an in-progress (or squash) merge: `git reset --merge` restores only
 * the index entries and files the merge touched. Untracked files are never
 * removed (no `git clean`), and unrelated local edits are kept.
 */
async function undoMergeState(repoRoot: string): Promise<void> {
  await runGit(["reset", "--merge"], {
    cwd: repoRoot,
    timeoutMs: GIT_TIMEOUTS.normal,
    operation: "git reset --merge",
  }).catch(() => undefined);
}

/**
 * Merge a branch into whatever branch is checked out in `repoRoot`.
 * On conflict: runs `git merge --abort` and returns `error: "CONFLICT"`.
 * Caller should reject dirty worktrees first.
 */
export async function mergeWorktreeBranch(
  repoRoot: string,
  branchName: string,
): Promise<GitMutationResult> {
  try {
    return await withRepoLock(repoRoot, async (): Promise<GitMutationResult> => {
      const result = await runGit(["merge", branchName, "--no-edit", "--no-verify"], {
        cwd: repoRoot,
        timeoutMs: GIT_TIMEOUTS.long,
        operation: "git merge",
        allowFailure: true,
      });
      if (result.exitCode === 0) return { success: true };
      const conflicts = await listConflictedPaths(repoRoot);
      await runGit(["merge", "--abort"], {
        cwd: repoRoot,
        timeoutMs: GIT_TIMEOUTS.normal,
        operation: "git merge --abort",
      }).catch(() => undoMergeState(repoRoot));
      const error = mergeOutputError(result.stdout, result.stderr);
      return error === "CONFLICT"
        ? { success: false, error, conflicts }
        : { success: false, error };
    });
  } catch (err) {
    return mutationFailure(err, "Unknown merge error");
  }
}

/**
 * Squash-merge a branch into the current branch of repoRoot as one commit.
 * On failure: `git reset --merge` restores only what the merge touched
 * (`merge --squash` has no MERGE_HEAD, so `--abort` can't). Untracked files
 * are never deleted.
 */
export async function squashMergeBranch(
  repoRoot: string,
  branchName: string,
  commitMessage: string,
): Promise<GitMutationResult> {
  try {
    return await withRepoLock(repoRoot, async (): Promise<GitMutationResult> => {
      const squash = await runGit(["merge", "--squash", branchName], {
        cwd: repoRoot,
        timeoutMs: GIT_TIMEOUTS.long,
        operation: "git merge --squash",
        allowFailure: true,
      });
      if (squash.exitCode !== 0) {
        const conflicts = await listConflictedPaths(repoRoot);
        await undoMergeState(repoRoot);
        const error = mergeOutputError(squash.stdout, squash.stderr);
        return error === "CONFLICT"
          ? { success: false, error, conflicts }
          : { success: false, error };
      }
      try {
        await commitWithFallbackIdentity(
          repoRoot,
          ["--no-verify", "-m", commitMessage],
          "git commit",
        );
        return { success: true };
      } catch (err) {
        await undoMergeState(repoRoot);
        return mutationFailure(err, "Squash commit failed");
      }
    });
  } catch (err) {
    return mutationFailure(err, "Unknown merge error");
  }
}

// ─── Branch → target merge (no checkout required) ─────────────────────────

export type MergeTargetErrorCode =
  | "target_missing"
  | "target_checked_out"
  | "target_dirty"
  | "checkout_blocked"
  | "ref_moved"
  | "unsupported";

/** A merge that was refused before (or without) changing anything. */
export class MergeTargetError extends Error {
  readonly code: MergeTargetErrorCode;
  constructor(code: MergeTargetErrorCode, message: string) {
    super(message);
    this.name = "MergeTargetError";
    this.code = code;
  }
}

export type BranchMergeResult =
  | {
      status: "merged";
      mergeCommit: string;
      fastForward: boolean;
      /** Checkout whose working tree was fast-forwarded, or null when only the ref moved. */
      updatedCheckout: string | null;
    }
  | { status: "up_to_date"; mergeCommit: string; updatedCheckout: null }
  | { status: "conflict"; conflicts: string[] };

async function resolveCommit(cwd: string, ref: string): Promise<string | null> {
  const { stdout, exitCode } = await runGit(
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    {
      ...readOnly(cwd, "git rev-parse"),
      allowFailure: true,
    },
  );
  return exitCode === 0 ? stdout.trim() || null : null;
}

/** Whether `refs/heads/<branch>` exists. */
export async function localBranchExists(dir: string, branch: string): Promise<boolean> {
  if (!branch || branch.startsWith("-")) return false;
  return (await resolveCommit(dir, `refs/heads/${branch}`)) !== null;
}

/**
 * Map a base ref recorded at space creation (`main`, `origin/main`, `HEAD`,
 * a SHA) to the local branch the space should merge into. Null when the ref
 * names no branch (the caller falls back to the default branch).
 */
export async function resolveLocalTargetBranch(
  repoRoot: string,
  ref: string | null | undefined,
): Promise<string | null> {
  const value = ref?.trim();
  if (!value) return null;
  if (value === "HEAD") return getCurrentBranch(repoRoot).catch(() => null);
  const bare = value.replace(/^refs\/heads\//, "");
  if (await localBranchExists(repoRoot, bare)) return bare;
  const { stdout } = await runGit(["remote"], {
    ...readOnly(repoRoot, "git remote"),
    allowFailure: true,
  });
  const stripped = value.replace(/^refs\/remotes\//, "");
  for (const remote of stdout
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean)) {
    if (stripped.startsWith(`${remote}/`) && stripped.length > remote.length + 1) {
      return stripped.slice(remote.length + 1);
    }
  }
  return null;
}

async function commitTreeWithFallbackIdentity(cwd: string, args: string[]): Promise<string> {
  const opts = { cwd, timeoutMs: GIT_TIMEOUTS.normal, operation: "git commit-tree" };
  try {
    return (await runGit(["commit-tree", ...args], opts)).stdout.trim();
  } catch (error) {
    if (!isMissingGitIdentityError(error)) throw error;
    const { stdout } = await runGit(
      [
        "-c",
        `user.name=${RELAY_GIT_FALLBACK_NAME}`,
        "-c",
        `user.email=${RELAY_GIT_FALLBACK_EMAIL}`,
        "commit-tree",
        ...args,
      ],
      opts,
    );
    return stdout.trim();
  }
}

function isMergeTreeUnsupported(stderr: string): boolean {
  return /unknown option|usage: git merge-tree/i.test(stderr);
}

/**
 * Merge `sourceBranch` into local branch `targetBranch` without depending on
 * what the main checkout has checked out:
 *
 * - The merge is computed in memory (`git merge-tree --write-tree`); a
 *   conflict returns `{ status: "conflict", conflicts }` and changes nothing.
 * - If the target is checked out in the primary checkout, that checkout must
 *   have no tracked changes (untracked files are fine) and is fast-forwarded
 *   to the new commit with `git merge --ff-only`, which refuses (changing
 *   nothing) if an untracked file would be overwritten.
 * - If the target isn't checked out anywhere, only the ref moves
 *   (`git update-ref` with the old value as a compare-and-swap).
 * - A target checked out in another linked worktree is refused.
 *
 * Runs under the repository lock. Throws `MergeTargetError` for refusals and
 * `GitCommandError` for git failures.
 */
export async function mergeBranchIntoTarget(
  repoRoot: string,
  opts: {
    sourceBranch: string;
    targetBranch: string;
    method: "squash" | "merge-commit";
    message?: string;
  },
): Promise<BranchMergeResult> {
  const { sourceBranch, targetBranch, method } = opts;
  return withRepoLock(repoRoot, async (): Promise<BranchMergeResult> => {
    const oldTip = await resolveCommit(repoRoot, `refs/heads/${targetBranch}`);
    if (!oldTip) {
      throw new MergeTargetError(
        "target_missing",
        `Target branch "${targetBranch}" does not exist locally. Create or fetch it, then try again.`,
      );
    }
    const sourceTip = await resolveCommit(repoRoot, `refs/heads/${sourceBranch}`);
    if (!sourceTip) {
      throw new MergeTargetError(
        "target_missing",
        `Space branch "${sourceBranch}" does not exist.`,
      );
    }

    const holder = (await listWorktrees(repoRoot)).find((w) => w.branch === targetBranch);
    if (holder && !holder.isPrimary) {
      throw new MergeTargetError(
        "target_checked_out",
        `"${targetBranch}" is checked out in another worktree (${holder.path}). Switch that worktree to a different branch, then try again.`,
      );
    }
    const checkoutDir = holder?.path ?? null;
    if (checkoutDir) {
      const status = await getStatusSummary(checkoutDir);
      if (status.staged + status.unstaged + status.conflicted > 0) {
        throw new MergeTargetError(
          "target_dirty",
          `Your main workspace has uncommitted changes to tracked files on ${targetBranch}. Commit or stash them before completing this space. (Untracked files don't block completion.)`,
        );
      }
    }

    if (await isAncestor(repoRoot, sourceTip, oldTip)) {
      return { status: "up_to_date", mergeCommit: oldTip, updatedCheckout: null };
    }

    let newTip: string;
    let fastForward = false;
    if (method === "merge-commit" && (await isAncestor(repoRoot, oldTip, sourceTip))) {
      newTip = sourceTip;
      fastForward = true;
    } else {
      const mergeTree = await runGit(
        ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", oldTip, sourceTip],
        {
          cwd: repoRoot,
          timeoutMs: GIT_TIMEOUTS.long,
          operation: "git merge-tree",
          allowFailure: true,
          readOnly: true,
        },
      );
      if (mergeTree.exitCode === 1) {
        const [, ...paths] = mergeTree.stdout.split("\0");
        return { status: "conflict", conflicts: [...new Set(paths.filter(Boolean))] };
      }
      if (mergeTree.exitCode !== 0) {
        if (isMergeTreeUnsupported(mergeTree.stderr)) {
          return legacyCheckoutMerge(repoRoot, checkoutDir, opts);
        }
        throw new GitCommandError({
          kind: "failed",
          operation: "git merge-tree",
          cwd: repoRoot,
          message: `Merge failed: ${mergeTree.stderr.trim() || "git merge-tree failed"}`,
          exitCode: mergeTree.exitCode,
          stderr: mergeTree.stderr,
        });
      }
      const tree = mergeTree.stdout.split("\0")[0]?.trim();
      const message =
        opts.message?.trim() ||
        (method === "squash"
          ? `Squash merge ${sourceBranch}`
          : `Merge branch '${sourceBranch}' into ${targetBranch}`);
      const parents = method === "squash" ? ["-p", oldTip] : ["-p", oldTip, "-p", sourceTip];
      newTip = await commitTreeWithFallbackIdentity(repoRoot, [tree, ...parents, "-m", message]);
    }

    if (checkoutDir) {
      const ff = await runGit(["merge", "--ff-only", newTip], {
        cwd: checkoutDir,
        timeoutMs: GIT_TIMEOUTS.long,
        operation: "git merge --ff-only",
        allowFailure: true,
      });
      if (ff.exitCode !== 0) {
        throw new MergeTargetError(
          "checkout_blocked",
          `Could not update ${targetBranch} in your main workspace: ${summarizeMergeBlock(ff.stderr || ff.stdout)} Nothing was changed.`,
        );
      }
      return { status: "merged", mergeCommit: newTip, fastForward, updatedCheckout: checkoutDir };
    }

    const update = await runGit(
      [
        "update-ref",
        "-m",
        `relay: merge ${sourceBranch} into ${targetBranch}`,
        `refs/heads/${targetBranch}`,
        newTip,
        oldTip,
      ],
      {
        cwd: repoRoot,
        timeoutMs: GIT_TIMEOUTS.normal,
        operation: "git update-ref",
        allowFailure: true,
      },
    );
    if (update.exitCode !== 0) {
      throw new MergeTargetError(
        "ref_moved",
        `${targetBranch} changed while merging. Try completing the space again.`,
      );
    }
    return { status: "merged", mergeCommit: newTip, fastForward, updatedCheckout: null };
  });
}

function summarizeMergeBlock(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const overwritten = lines.findIndex((l) => /would be overwritten/i.test(l));
  if (overwritten >= 0) {
    const files = lines
      .slice(overwritten + 1)
      .filter((l) => !/^(please|aborting|merge with strategy|hint:)/i.test(l))
      .slice(0, 10);
    return `untracked or local files would be overwritten${files.length ? ` (${files.join(", ")})` : ""}. Move or remove them first.`;
  }
  return `${lines[0]?.replace(/^(fatal|error):\s*/i, "") || "merge refused"}.`;
}

/** Fallback for git < 2.38 (no `merge-tree --write-tree`): merge inside the checkout. */
async function legacyCheckoutMerge(
  repoRoot: string,
  checkoutDir: string | null,
  opts: {
    sourceBranch: string;
    targetBranch: string;
    method: "squash" | "merge-commit";
    message?: string;
  },
): Promise<BranchMergeResult> {
  if (!checkoutDir) {
    throw new MergeTargetError(
      "unsupported",
      `Merging into ${opts.targetBranch} without checking it out requires git 2.38 or newer. Check out ${opts.targetBranch} in your main workspace or update git.`,
    );
  }
  const result =
    opts.method === "squash"
      ? await squashMergeBranch(
          checkoutDir,
          opts.sourceBranch,
          opts.message || `Squash merge ${opts.sourceBranch}`,
        )
      : await mergeWorktreeBranch(checkoutDir, opts.sourceBranch);
  if (result.success) {
    return {
      status: "merged",
      mergeCommit: await getHeadCommit(checkoutDir),
      fastForward: false,
      updatedCheckout: checkoutDir,
    };
  }
  if (result.error === "CONFLICT") return { status: "conflict", conflicts: result.conflicts ?? [] };
  throw new GitCommandError({
    kind: result.errorKind ?? "failed",
    operation: "git merge",
    cwd: repoRoot,
    message: `Merge failed: ${result.error}`,
  });
}

// ─── Remote operations ────────────────────────────────────────────────────

export interface GitRemoteOpResult {
  success: boolean;
  error?: string;
  errorKind?: GitErrorKind;
  pushed?: boolean;
  message?: string;
}

function remoteFailure(err: unknown): GitRemoteOpResult {
  if (err instanceof GitCommandError) {
    return { success: false, error: err.message, errorKind: err.kind };
  }
  return { success: false, error: err instanceof Error ? err.message : String(err) };
}

/** Fetch from remotes with pruning, under the repository lock. */
export async function gitFetch(dir: string): Promise<GitRemoteOpResult> {
  try {
    await withRepoLock(dir, () =>
      runGit(["fetch", "--prune"], {
        cwd: dir,
        timeoutMs: GIT_TIMEOUTS.network,
        operation: "git fetch",
      }),
    );
    return { success: true };
  } catch (err) {
    return remoteFailure(err);
  }
}

/**
 * Pull from remote. Defaults to fast-forward only (safe). Pass `rebase: true`
 * for diverged branches — replays local commits on top of the remote with
 * `--rebase-merges` (preserving local merge topology) and `--autostash`.
 */
export async function gitPull(
  dir: string,
  opts?: { rebase?: boolean },
): Promise<GitRemoteOpResult> {
  const args = opts?.rebase ? ["pull", "--rebase=merges", "--autostash"] : ["pull", "--ff-only"];
  try {
    await withRepoLock(dir, () =>
      runGit(args, { cwd: dir, timeoutMs: GIT_TIMEOUTS.network, operation: "git pull" }),
    );
    return { success: true };
  } catch (err) {
    return remoteFailure(err);
  }
}

/** Push to the primary remote, optionally setting upstream tracking. */
export async function gitPush(
  dir: string,
  branch?: string,
  setUpstream?: boolean,
): Promise<GitRemoteOpResult> {
  try {
    return await withRepoLock(dir, async (): Promise<GitRemoteOpResult> => {
      const args = ["push"];
      if (branch) {
        const remote = await getPrimaryRemote(dir);
        if (!remote) {
          return { success: false, error: "No git remote is configured for this repository" };
        }
        if (setUpstream) args.push("-u");
        args.push(remote, branch);
      }
      const { stdout, stderr } = await runGit(args, {
        cwd: dir,
        timeoutMs: GIT_TIMEOUTS.network,
        operation: "git push",
      });
      if (`${stdout}\n${stderr}`.includes("Everything up-to-date")) {
        return {
          success: true,
          pushed: false,
          message: "Nothing to push — branch is already up to date",
        };
      }
      return { success: true, pushed: true };
    });
  } catch (err) {
    return remoteFailure(err);
  }
}

// ─── Diffs ────────────────────────────────────────────────────────────────

type DiffBaseOptions = { originalBranch?: string; sessionCreatedAt?: number };

/** Commit that was HEAD at or before `beforeTimestamp` (session diff baseline). */
async function getBaseCommit(cwd: string, beforeTimestamp: number): Promise<string | null> {
  if (!(await hasHeadCommit(cwd))) return null;
  try {
    const isoDate = new Date(beforeTimestamp).toISOString();
    const { stdout } = await runGit(
      ["log", "--before=" + isoDate, "-1", "--format=%H"],
      readOnly(cwd, "git log"),
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Base ref for diffing an instance's changes:
 * - Worktree: merge-base with the original branch
 * - Non-worktree: commit that was HEAD when the session started
 * - Fallback: HEAD (or the empty tree on an unborn branch)
 */
async function resolveBaseRef(cwd: string, opts?: DiffBaseOptions): Promise<string> {
  let baseRef = (await hasHeadCommit(cwd)) ? "HEAD" : EMPTY_TREE_HASH;
  if (opts?.originalBranch) {
    try {
      const { stdout } = await runGit(
        ["merge-base", opts.originalBranch, "HEAD"],
        readOnly(cwd, "git merge-base"),
      );
      if (stdout.trim()) baseRef = stdout.trim();
    } catch {
      // fall back
    }
  } else if (opts?.sessionCreatedAt) {
    const base = await getBaseCommit(cwd, opts.sessionCreatedAt);
    if (base) baseRef = base;
  }
  return baseRef;
}

/** Untracked (not ignored) files, relative to the repo root. */
async function getUntrackedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await runGit(
      ["ls-files", "--others", "--exclude-standard", "--full-name", "-z"],
      readOnly(cwd, "git ls-files"),
    );
    return stdout.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Unified diff patch for an untracked (new) file, in git's format so it can
 * be concatenated with tracked diffs. Null for unreadable files.
 */
async function diffForNewFile(repoRoot: string, relPath: string): Promise<string | null> {
  try {
    const absPath = join(repoRoot, relPath);
    if (await isBinaryFile(absPath)) {
      return [
        `diff --git a/${relPath} b/${relPath}`,
        "new file mode 100644",
        `Binary files /dev/null and b/${relPath} differ`,
        "",
      ].join("\n");
    }
    const content = await readFile(absPath, "utf8");

    if (content.length === 0) {
      return [
        `diff --git a/${relPath} b/${relPath}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${relPath}`,
        "",
      ].join("\n");
    }

    const lines = content.split("\n");
    const hasTrailingNewline = content.endsWith("\n");
    const displayLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
    const header = [
      `diff --git a/${relPath} b/${relPath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${relPath}`,
      `@@ -0,0 +1,${displayLines.length} @@`,
    ];
    const body = displayLines.map((l) => `+${l}`);
    if (!hasTrailingNewline) body.push("\\ No newline at end of file");
    return header.join("\n") + "\n" + body.join("\n") + "\n";
  } catch {
    return null;
  }
}

async function appendUntrackedPatches(
  diff: string,
  cwd: string,
  repoRoot: string,
): Promise<string> {
  for (const relPath of await getUntrackedFiles(cwd)) {
    const patch = await diffForNewFile(repoRoot, relPath);
    if (patch) diff += patch;
  }
  return diff;
}

/**
 * Unified diff of a worktree's full state (committed + uncommitted +
 * untracked) vs its merge-base with `defaultBranch`. Null on failure, unless
 * `throwOnError` (then the `GitCommandError` propagates).
 */
export async function getWorktreeDiff(
  worktreePath: string,
  defaultBranch: string,
  opts?: { throwOnError?: boolean },
): Promise<string | null> {
  try {
    const repoRoot = getRepoRoot(worktreePath);
    if (!repoRoot) {
      if (opts?.throwOnError) {
        throw new GitCommandError({
          kind: "not_a_repo",
          operation: "git diff",
          cwd: worktreePath,
          message: "git diff failed: not a git repository",
        });
      }
      return null;
    }
    const { stdout: mergeBase } = await runGit(
      ["merge-base", defaultBranch, "HEAD"],
      readOnly(worktreePath, "git merge-base"),
    );
    const { stdout } = await runGit(["diff", mergeBase.trim()], {
      ...readOnly(worktreePath, "git diff", GIT_TIMEOUTS.normal),
      maxOutputBytes: MAX_DIFF_BYTES,
    });
    return await appendUntrackedPatches(stdout, worktreePath, repoRoot);
  } catch (err) {
    if (opts?.throwOnError) throw err;
    return null;
  }
}

/**
 * Unified diff for all changes relative to the session baseline, including
 * untracked files. Null when not a git repo or the diff fails.
 */
export async function getFullDiff(cwd: string, opts?: DiffBaseOptions): Promise<string | null> {
  try {
    const repoRoot = getRepoRoot(cwd);
    if (!repoRoot) return null;
    const baseRef = await resolveBaseRef(cwd, opts);
    const { stdout } = await runGit(["diff", baseRef], {
      ...readOnly(cwd, "git diff", GIT_TIMEOUTS.normal),
      maxOutputBytes: MAX_DIFF_BYTES,
    });
    return await appendUntrackedPatches(stdout, cwd, repoRoot);
  } catch {
    return null;
  }
}

/**
 * Unified diff for a single file relative to the session baseline (tracked
 * or untracked). Null when not a git repo or the diff fails.
 */
export async function getFileDiff(
  cwd: string,
  filePath: string,
  opts?: DiffBaseOptions,
): Promise<string | null> {
  try {
    const repoRoot = getRepoRoot(cwd);
    if (!repoRoot) return null;
    const baseRef = await resolveBaseRef(cwd, opts);
    const { stdout: diff } = await runGit(["diff", baseRef, "--", filePath], {
      ...readOnly(cwd, "git diff", GIT_TIMEOUTS.normal),
      maxOutputBytes: MAX_DIFF_BYTES,
    });
    if (!diff.trim()) {
      const relPath = filePath.startsWith(repoRoot)
        ? filePath.slice(repoRoot.length + 1)
        : filePath;
      if ((await getUntrackedFiles(cwd)).includes(relPath)) {
        return (await diffForNewFile(repoRoot, relPath)) ?? "";
      }
    }
    return diff;
  } catch {
    return null;
  }
}

/**
 * Parse `git diff --numstat -z` output into repo-relative path → counts.
 * Binary files (`-`) are skipped. Renames report the destination path.
 */
export function parseNumstatZ(
  output: string,
): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>();
  const tokens = output.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const firstTab = token.indexOf("\t");
    const secondTab = firstTab >= 0 ? token.indexOf("\t", firstTab + 1) : -1;
    if (firstTab < 0 || secondTab < 0) continue;
    const added = token.slice(0, firstTab);
    const deleted = token.slice(firstTab + 1, secondTab);
    let path = token.slice(secondTab + 1);
    if (!path) {
      // Rename/copy: `<a>\t<d>\t\0<old>\0<new>\0`
      path = tokens[i + 2] ?? "";
      i += 2;
    }
    if (!path || added === "-" || deleted === "-") continue;
    result.set(path, { additions: Number(added) || 0, deletions: Number(deleted) || 0 });
  }
  return result;
}

/**
 * Enrich `files` in place with per-file additions/deletions relative to the
 * session baseline (see `resolveBaseRef`). Untracked files count all lines
 * as additions. Silently skips outside git repos.
 */
export async function enrichDiffStats(
  cwd: string,
  files: Map<string, FileChange>,
  opts?: DiffBaseOptions,
): Promise<void> {
  try {
    const repoRoot = getRepoRoot(cwd);
    if (!repoRoot) return;
    const baseRef = await resolveBaseRef(cwd, opts);
    const { stdout } = await runGit(["diff", baseRef, "--numstat", "-z"], {
      ...readOnly(cwd, "git diff --numstat", GIT_TIMEOUTS.normal),
      maxOutputBytes: MAX_DIFF_BYTES,
    });
    for (const [relPath, counts] of parseNumstatZ(stdout)) {
      const file = files.get(join(repoRoot, relPath));
      if (file) {
        file.additions = counts.additions;
        file.deletions = counts.deletions;
      }
    }

    for (const relPath of await getUntrackedFiles(cwd)) {
      const absPath = join(repoRoot, relPath);
      const file = files.get(absPath);
      if (!file) continue;
      try {
        if (await isBinaryFile(absPath)) continue;
        const content = await readFile(absPath, "utf8");
        file.additions =
          content.length === 0 ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
        file.deletions = 0;
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // git not available or not a repo — silently skip
  }
}
