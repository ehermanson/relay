/**
 * Per-turn worktree attribution: which files did a chat change during one
 * turn, however it changed them (edit tools, Bash, scripts, formatters,
 * codegen, `git checkout -- file`, …)?
 *
 * A snapshot is HEAD plus a fingerprint (`mtimeMs:size`, or `missing`) of
 * every path `git status` reports. The turn's changes are the paths that are
 * new or re-fingerprinted between the turn-start and turn-end snapshots, plus
 * whatever the turn committed (HEAD moved). Paths that left `git status`
 * without a commit (reverted, or dirt that was already there) are not
 * attributed. Read-only git, never under the repo lock.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { getRepoRoot, getStatusSummary } from "#core/git.js";
import { GIT_TIMEOUTS, runGit } from "#core/git-runner.js";

/** Beyond this many changed paths a snapshot is skipped (no attribution beats a stat storm). */
export const WORKTREE_SNAPSHOT_PATH_LIMIT = 5000;

export interface WorktreeSnapshot {
  /** Repo root the paths are relative to. */
  root: string;
  /** HEAD commit; null on an unborn branch. */
  head: string | null;
  /** Changed path (repo-root relative) → `"mtimeMs:size"` or `"missing"`. */
  paths: Map<string, string>;
  /** Paths in `paths` that are untracked. */
  untracked: Set<string>;
}

export interface WorktreePathChange {
  path: string;
  untracked?: boolean;
}

export interface DetectedFileChange {
  /** Absolute path. */
  path: string;
  type: "added" | "edited";
}

/** Snapshot `dir`'s worktree; null when not a git repo, on failure, or past the path cap. */
export async function captureWorktreeSnapshot(
  dir: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<WorktreeSnapshot | null> {
  const root = getRepoRoot(dir);
  if (!root) return null;
  try {
    const summary = await getStatusSummary(dir, {
      collectPaths: true,
      untrackedFiles: "all",
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
    const list = summary.paths ?? [];
    if (list.length > WORKTREE_SNAPSHOT_PATH_LIMIT) return null;
    const fingerprints = await Promise.all(
      list.map((p) =>
        stat(join(root, p)).then(
          (st) => `${st.mtimeMs}:${st.size}`,
          () => "missing",
        ),
      ),
    );
    const paths = new Map<string, string>();
    list.forEach((p, i) => paths.set(p, fingerprints[i]));
    return { root, head: summary.head, paths, untracked: new Set(summary.untrackedPaths ?? []) };
  } catch {
    return null;
  }
}

/** Paths new or re-fingerprinted in `after`. Paths that disappeared are not reported. */
export function diffWorktreeSnapshots(
  before: WorktreeSnapshot,
  after: WorktreeSnapshot,
): WorktreePathChange[] {
  const changes: WorktreePathChange[] = [];
  for (const [path, fingerprint] of after.paths) {
    if (before.paths.get(path) === fingerprint) continue;
    changes.push(after.untracked.has(path) ? { path, untracked: true } : { path });
  }
  return changes;
}

/**
 * Paths changed by commits between two HEADs (repo-root relative; `added` for
 * files the commits created). [] when HEAD didn't move or on failure.
 */
export async function committedPathsBetween(
  dir: string,
  beforeHead: string | null,
  afterHead: string | null,
): Promise<{ path: string; added?: boolean }[]> {
  if (!beforeHead || !afterHead || beforeHead === afterHead) return [];
  try {
    const { stdout } = await runGit(
      ["diff", "--name-status", "-z", "--no-renames", beforeHead, afterHead],
      {
        cwd: dir,
        readOnly: true,
        timeoutMs: GIT_TIMEOUTS.fast * 2,
        operation: "git diff --name-status",
      },
    );
    const tokens = stdout.split("\0");
    const out: { path: string; added?: boolean }[] = [];
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const status = tokens[i];
      const path = tokens[i + 1];
      if (!status || !path) continue;
      out.push(status.startsWith("A") ? { path, added: true } : { path });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Files the turn changed: uncommitted changes that appeared or moved between
 * the snapshots, plus files the turn committed. De-duplicated, absolute paths.
 */
export async function detectTurnWorktreeChanges(
  dir: string,
  before: WorktreeSnapshot,
  after: WorktreeSnapshot,
): Promise<DetectedFileChange[]> {
  // A different root means the chat moved checkouts mid-turn; nothing to compare.
  if (before.root !== after.root) return [];
  const byPath = new Map<string, DetectedFileChange>();
  for (const change of diffWorktreeSnapshots(before, after)) {
    const path = join(after.root, change.path);
    byPath.set(path, { path, type: change.untracked ? "added" : "edited" });
  }
  for (const committed of await committedPathsBetween(dir, before.head, after.head)) {
    const path = join(after.root, committed.path);
    if (!byPath.has(path)) byPath.set(path, { path, type: committed.added ? "added" : "edited" });
  }
  return Array.from(byPath.values());
}
