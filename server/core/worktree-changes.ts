/**
 * Per-turn worktree attribution: which files did a chat change during one
 * turn, however it changed them (edit tools, Bash, scripts, formatters,
 * codegen, `git checkout -- file`, …)?
 *
 * A snapshot is HEAD plus a fingerprint (`mtimeMs:size`, or `missing`) of
 * every path `git status` reports. The turn's changes are the paths that are
 * new or re-fingerprinted between the turn-start and turn-end snapshots, plus
 * whatever the turn committed. HEAD moving is not enough: a pull, rebase, merge
 * or checkout moves it across files nobody in the turn wrote, so a path counts
 * only if it changed between the two HEADs **and** a commit made during the
 * turn touched it. Paths that left `git status` without a commit (reverted, or
 * dirt that was already there) are not attributed. Read-only git, never under
 * the repo lock.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { getRepoRoot, getStatusSummary, resolveGitDirs } from "#core/git.js";
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
  /** When the snapshot was taken (ms): commits at or after it belong to the turn. */
  capturedAt: number;
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

/**
 * Snapshot `dir`'s worktree; null when not a git repo, on failure, or past the
 * path cap. `onFailure` hears the last two: a null there silently costs the
 * turn its attribution, which a plain non-repo doesn't.
 */
export async function captureWorktreeSnapshot(
  dir: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number; onFailure?: (reason: string) => void },
): Promise<WorktreeSnapshot | null> {
  const root = getRepoRoot(dir);
  if (!root) return null;
  const capturedAt = Date.now();
  try {
    const summary = await getStatusSummary(dir, {
      collectPaths: true,
      untrackedFiles: "all",
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
    // A trailing slash is a nested repository (usually a linked worktree under
    // the checkout), which git reports as one entry. It isn't a file.
    const list = (summary.paths ?? []).filter((p) => !p.endsWith("/"));
    if (list.length > WORKTREE_SNAPSHOT_PATH_LIMIT) {
      opts?.onFailure?.(`${list.length} changed paths exceed the snapshot limit`);
      return null;
    }
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
    return {
      root,
      head: summary.head,
      paths,
      untracked: new Set(summary.untrackedPaths ?? []),
      capturedAt,
    };
  } catch (err) {
    opts?.onFailure?.(err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** A baseline as stored for restart recovery. */
export function serializeWorktreeSnapshot(snapshot: WorktreeSnapshot): string {
  return JSON.stringify({
    root: snapshot.root,
    head: snapshot.head,
    paths: Array.from(snapshot.paths),
    untracked: Array.from(snapshot.untracked),
    capturedAt: snapshot.capturedAt,
  });
}

/** Null for anything that isn't a stored baseline. */
export function parseWorktreeSnapshot(json: string): WorktreeSnapshot | null {
  try {
    const value = JSON.parse(json) as Partial<
      Omit<WorktreeSnapshot, "paths" | "untracked"> & {
        paths: [string, string][];
        untracked: string[];
      }
    >;
    if (typeof value.root !== "string" || typeof value.capturedAt !== "number") return null;
    return {
      root: value.root,
      head: value.head ?? null,
      paths: new Map(value.paths ?? []),
      untracked: new Set(value.untracked ?? []),
      capturedAt: value.capturedAt,
    };
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
 * The commits in `beforeHead..afterHead` made since `sinceMs`. Dates are read
 * here rather than with `git log --since`, which stops walking at the first
 * older commit and hides newer ones behind it. Octopus merges are skipped:
 * remerge can't diff them, so they would list everything they merged.
 */
async function commitsMadeSince(
  dir: string,
  beforeHead: string,
  afterHead: string,
  sinceMs: number,
): Promise<string[]> {
  const { stdout } = await runGit(
    [
      // Signature verification text would land in the output.
      "-c",
      "log.showSignature=false",
      "log",
      "--format=%H %ct %P",
      `${beforeHead}..${afterHead}`,
    ],
    { cwd: dir, readOnly: true, timeoutMs: GIT_TIMEOUTS.fast * 2, operation: "git log" },
  );
  const sinceSeconds = Math.floor(sinceMs / 1000);
  const commits: string[] = [];
  for (const line of stdout.split("\n")) {
    const [hash, committedAt, ...parents] = line.trim().split(" ");
    if (hash && Number(committedAt) >= sinceSeconds && parents.length <= 2) commits.push(hash);
  }
  return commits;
}

/**
 * Paths those commits touched. `--diff-merges=remerge` keeps what a merge
 * resolved by hand and drops what it merged in cleanly. It needs git 2.36;
 * older git rejects it, and without it a merge lists no paths at all.
 */
async function pathsTouchedBy(dir: string, commits: string[]): Promise<Set<string>> {
  if (commits.length === 0) return new Set();
  const list = (mergeArgs: string[]) =>
    runGit(
      [
        "-c",
        "diff.relative=false",
        "-c",
        "log.showSignature=false",
        "log",
        "--no-walk=unsorted",
        "--format=",
        "--name-only",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        ...mergeArgs,
        ...commits,
      ],
      {
        cwd: dir,
        readOnly: true,
        timeoutMs: GIT_TIMEOUTS.fast * 2,
        operation: "git log --name-only",
      },
    );
  const { stdout } = await list(["--diff-merges=remerge"]).catch(() => list([]));
  return new Set(
    stdout
      .split("\0")
      .map((path) => path.trim())
      .filter(Boolean),
  );
}

/**
 * Paths the turn committed (repo-root relative; `added` for files it created):
 * changed between the two HEADs and touched by a commit made since `sinceMs`.
 * Requiring both is what separates authored work from imports. The date alone
 * would keep a rebase's re-stamped older commits; the diff alone keeps
 * everything a pull brought in. [] when HEAD didn't move or on failure.
 */
export async function committedPathsBetween(
  dir: string,
  beforeHead: string | null,
  afterHead: string | null,
  sinceMs: number,
): Promise<{ path: string; added?: boolean }[]> {
  if (!beforeHead || !afterHead || beforeHead === afterHead) return [];
  try {
    const [{ stdout }, commits] = await Promise.all([
      runGit(
        [
          "-c",
          "diff.relative=false",
          "diff",
          "--name-status",
          "-z",
          "--no-renames",
          beforeHead,
          afterHead,
        ],
        {
          cwd: dir,
          readOnly: true,
          timeoutMs: GIT_TIMEOUTS.fast * 2,
          operation: "git diff --name-status",
        },
      ),
      commitsMadeSince(dir, beforeHead, afterHead, sinceMs),
    ]);
    const authored = await pathsTouchedBy(dir, commits);
    const tokens = stdout.split("\0");
    const out: { path: string; added?: boolean }[] = [];
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const status = tokens[i];
      const path = tokens[i + 1];
      if (!status || !path || !authored.has(path)) continue;
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
  for (const committed of await committedPathsBetween(
    dir,
    before.head,
    after.head,
    before.capturedAt,
  )) {
    const path = join(after.root, committed.path);
    if (!byPath.has(path)) byPath.set(path, { path, type: committed.added ? "added" : "edited" });
  }
  return Array.from(byPath.values());
}

/**
 * Files changed in a worktree the chat moved into mid-turn, where no baseline
 * exists. It has to be the same repository, so the turn-start HEAD still names
 * a commit there. Everything dirty in it counts: the chat went there to work.
 */
export async function detectEnteredWorktreeChanges(
  dir: string,
  before: WorktreeSnapshot,
  after: WorktreeSnapshot,
): Promise<DetectedFileChange[]> {
  const commonDir = resolveGitDirs(before.root)?.commonDir;
  if (!commonDir || commonDir !== resolveGitDirs(after.root)?.commonDir) return [];
  return detectTurnWorktreeChanges(
    dir,
    { ...before, root: after.root, paths: new Map(), untracked: new Set() },
    after,
  );
}
