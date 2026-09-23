/**
 * Push-based repository status.
 *
 * One entry per worktree directory (keyed by realpath), shared by every
 * subscriber. A refresh runs one `git status --porcelain=2` plus one
 * `git diff --numstat`, derives a cheap fingerprint, and publishes only when
 * that fingerprint (or background-fetch state) changes. Nothing polls: refreshes
 * are triggered by
 * - the first subscriber (later subscribers get the cached snapshot first),
 * - `invalidateRepoStatus(dir)` (agent turn end, diff-stat enrichment, …),
 * - every Relay git mutation (`onRepoMutation`: anything run under
 *   `withRepoLock` — commit, push, pull, fetch, checkout, merge, worktrees),
 * - a completed background fetch.
 *
 * While a repository has subscribers, a quiet background `git fetch` keeps
 * ahead/behind honest: at most once per `fetchIntervalMs` per repository
 * (git common dir), exponential backoff on failure, skipped (never queued) when
 * a mutation holds the repo lock. Failures are recorded on the snapshot
 * (`lastFetchError`) and never surfaced as errors.
 *
 * When the last subscriber leaves, the entry and its timers are dropped.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  GIT_TIMEOUTS,
  getRepoLockKey,
  isGitCommandError,
  isRepoLockHeld,
  listHeldRepoLocks as heldLockKeys,
  onRepoMutation,
  runGit,
  withRepoLock,
} from "#core/git-runner.js";
import { getPrimaryRemote, getRepoRoot, getStatusSummary, parseNumstatZ } from "#core/git.js";
import type { RepoDiffStat, RepoStatusSnapshot, RepoStatusSummary } from "#core/types.js";

const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const NUMSTAT_MAX_BYTES = 4 * 1024 * 1024;
/** Changed files whose mtime/size feed the fingerprint (bounds the stat fan-out). */
const FINGERPRINT_STAT_LIMIT = 500;

export const REPO_STATUS_DEFAULTS = {
  fetchIntervalMs: 60_000,
  fetchBackoffBaseMs: 30_000,
  fetchBackoffMaxMs: 15 * 60_000,
  fetchTimeoutMs: 15_000,
  /** Retry delay after skipping because a mutation held the lock. */
  fetchLockedRetryMs: 10_000,
  /** Recheck interval when the repository has no remote. */
  noRemoteRecheckMs: 15 * 60_000,
} as const;

export interface RepoStatusComputation {
  status: RepoStatusSummary;
  diffStat: RepoDiffStat;
  /** Opaque digest of the numstat output (content-level change detection). */
  diffDigest: string;
}

export type BackgroundFetchResult =
  | "ok"
  | "failed"
  | "no_remote"
  | "disabled"
  | "skipped_in_flight"
  | "skipped_locked"
  | "skipped_recent"
  | "skipped_backoff";

export class NoRemoteError extends Error {
  constructor() {
    super("No git remote is configured");
    this.name = "NoRemoteError";
  }
}

export interface RepoStatusServiceOptions {
  /** Status + diff-stat computation (default: git status + git diff --numstat). */
  compute?: (dir: string) => Promise<RepoStatusComputation>;
  /** Background fetch (default: quiet fetch of the primary remote under the repo lock). Throw `NoRemoteError` when there is no remote. */
  fetchRemote?: (dir: string, timeoutMs: number) => Promise<void>;
  /** Repository key shared by all worktrees (default: git common dir via `getRepoLockKey`). */
  resolveRepoKey?: (dir: string) => Promise<string>;
  isRepoLocked?: (repoKey: string) => boolean;
  now?: () => number;
  backgroundFetch?: boolean;
  fetchIntervalMs?: number;
  fetchBackoffBaseMs?: number;
  fetchBackoffMaxMs?: number;
  fetchTimeoutMs?: number;
  fetchLockedRetryMs?: number;
  /** Subscribe to Relay git mutations (default true). */
  observeMutations?: boolean;
  logger?: { debug: (...args: unknown[]) => void };
}

export type RepoStatusListener = (snapshot: RepoStatusSnapshot) => void;

interface Entry {
  dir: string;
  listeners: Set<RepoStatusListener>;
  snapshot: RepoStatusSnapshot | null;
  /** Signature of the last published snapshot (fingerprint + fetch error). */
  publishedSignature: string | null;
  refreshing: Promise<void> | null;
  dirty: boolean;
  repoKey: string | null;
  disposed: boolean;
}

interface FetchState {
  repoKey: string;
  /** A directory inside the repository to run fetch in. */
  dir: string;
  entries: Set<Entry>;
  inFlight: boolean;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  failures: number;
  nextAllowedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Lock keys are not canonicalized by the runner; compare canonical forms. */
function isRepoLockHeldCanonical(canonicalKey: string): boolean {
  for (const key of heldLockKeys()) {
    if (canonicalRepoDir(key) === canonicalKey) return true;
  }
  return false;
}

/** Realpath when the directory exists, else the resolved path. */
export function canonicalRepoDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * Default computation: one porcelain status + one numstat diff against HEAD,
 * plus mtime/size of the changed paths so a same-size edit (or an edit to an
 * untracked file) still changes the fingerprint.
 */
export async function computeRepoStatus(dir: string): Promise<RepoStatusComputation> {
  const { paths = [], ...status } = await getStatusSummary(dir, { collectPaths: true });
  const base = status.head ? "HEAD" : EMPTY_TREE_HASH;
  const { stdout, truncated } = await runGit(["diff", base, "--numstat", "-z"], {
    cwd: dir,
    readOnly: true,
    timeoutMs: GIT_TIMEOUTS.normal,
    maxOutputBytes: NUMSTAT_MAX_BYTES,
    truncateOutput: true,
    operation: "git diff --numstat",
  });
  let additions = 0;
  let deletions = 0;
  for (const counts of parseNumstatZ(stdout).values()) {
    additions += counts.additions;
    deletions += counts.deletions;
  }
  const hash = createHash("sha1").update(stdout);
  const root = getRepoRoot(dir) ?? dir;
  const stats = await Promise.all(
    paths.slice(0, FINGERPRINT_STAT_LIMIT).map((p) =>
      stat(join(root, p)).then(
        (st) => `${p}:${st.mtimeMs}:${st.size}`,
        () => `${p}:missing`,
      ),
    ),
  );
  for (const line of stats) hash.update("\0").update(line);
  return {
    status,
    diffStat: {
      files: status.changeCount,
      additions,
      deletions,
      truncated: truncated || undefined,
    },
    diffDigest: hash.digest("hex"),
  };
}

/** Default background fetch: quiet, tag-less fetch of the primary remote under the repo lock. */
export async function fetchPrimaryRemote(dir: string, timeoutMs: number): Promise<void> {
  const remote = await getPrimaryRemote(dir);
  if (!remote) throw new NoRemoteError();
  await withRepoLock(dir, () =>
    runGit(["fetch", "--quiet", "--no-tags", "--recurse-submodules=no", remote], {
      cwd: dir,
      timeoutMs,
      operation: "git fetch (background)",
    }),
  );
}

function fingerprintOf(computation: RepoStatusComputation | null, error: string | null): string {
  const s = computation?.status;
  const payload = JSON.stringify([
    s?.branch,
    s?.head,
    s?.upstream,
    s?.ahead,
    s?.behind,
    s?.staged,
    s?.unstaged,
    s?.untracked,
    s?.conflicted,
    computation?.diffDigest,
    error,
  ]);
  return createHash("sha1").update(payload).digest("hex").slice(0, 16);
}

export class RepoStatusService {
  private readonly entries = new Map<string, Entry>();
  private readonly fetchStates = new Map<string, FetchState>();
  private readonly compute: (dir: string) => Promise<RepoStatusComputation>;
  private readonly fetchRemote: (dir: string, timeoutMs: number) => Promise<void>;
  private readonly resolveRepoKey: (dir: string) => Promise<string>;
  private readonly isRepoLocked: (repoKey: string) => boolean;
  private readonly now: () => number;
  private readonly backgroundFetch: boolean;
  private readonly fetchIntervalMs: number;
  private readonly fetchBackoffBaseMs: number;
  private readonly fetchBackoffMaxMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly fetchLockedRetryMs: number;
  private readonly logger?: { debug: (...args: unknown[]) => void };
  private readonly stopObserving: (() => void) | null;

  constructor(opts: RepoStatusServiceOptions = {}) {
    this.compute = opts.compute ?? computeRepoStatus;
    this.fetchRemote = opts.fetchRemote ?? fetchPrimaryRemote;
    // Canonicalize so symlinked paths (e.g. /var vs /private/var) still match.
    this.resolveRepoKey =
      opts.resolveRepoKey ?? ((dir) => getRepoLockKey(dir).then((key) => canonicalRepoDir(key)));
    this.isRepoLocked =
      opts.isRepoLocked ?? ((key) => isRepoLockHeld(key) || isRepoLockHeldCanonical(key));
    this.now = opts.now ?? Date.now;
    this.backgroundFetch = opts.backgroundFetch ?? true;
    this.fetchIntervalMs = opts.fetchIntervalMs ?? REPO_STATUS_DEFAULTS.fetchIntervalMs;
    this.fetchBackoffBaseMs = opts.fetchBackoffBaseMs ?? REPO_STATUS_DEFAULTS.fetchBackoffBaseMs;
    this.fetchBackoffMaxMs = opts.fetchBackoffMaxMs ?? REPO_STATUS_DEFAULTS.fetchBackoffMaxMs;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? REPO_STATUS_DEFAULTS.fetchTimeoutMs;
    this.fetchLockedRetryMs = opts.fetchLockedRetryMs ?? REPO_STATUS_DEFAULTS.fetchLockedRetryMs;
    this.logger = opts.logger;
    this.stopObserving =
      opts.observeMutations === false
        ? null
        : onRepoMutation((repoKey, cwd) => this.handleMutation(repoKey, cwd));
  }

  /**
   * Subscribe to status for `dir`. The listener receives the cached snapshot
   * first (if any), then every change. Returns an unsubscribe function.
   */
  subscribe(dir: string, listener: RepoStatusListener): () => void {
    const key = canonicalRepoDir(dir);
    let entry = this.entries.get(key);
    const created = !entry;
    if (!entry) {
      entry = {
        dir: key,
        listeners: new Set(),
        snapshot: null,
        publishedSignature: null,
        refreshing: null,
        dirty: false,
        repoKey: null,
        disposed: false,
      };
      this.entries.set(key, entry);
    }
    const current = entry;
    current.listeners.add(listener);
    if (created) {
      void this.refreshEntry(current);
      void this.attachRepoKey(current);
    } else if (current.snapshot) {
      const snapshot = current.snapshot;
      queueMicrotask(() => {
        if (current.listeners.has(listener) && !current.disposed) listener(snapshot);
      });
    }
    return () => {
      if (!current.listeners.delete(listener)) return;
      if (current.listeners.size === 0) this.disposeEntry(current);
    };
  }

  /** Latest snapshot for a subscribed dir, or a one-shot computation otherwise. */
  async getSnapshot(dir: string): Promise<RepoStatusSnapshot> {
    const entry = this.entries.get(canonicalRepoDir(dir));
    if (entry) {
      if (!entry.snapshot) await this.refreshEntry(entry);
      if (entry.snapshot) return entry.snapshot;
    }
    return this.buildSnapshot(canonicalRepoDir(dir), await this.safeCompute(dir), null);
  }

  /**
   * Request a refresh for `dir` and every subscribed worktree of the same
   * repository. Cheap no-op when nothing is subscribed.
   */
  invalidate(dir: string): Promise<void> {
    if (this.entries.size === 0) return Promise.resolve();
    const key = canonicalRepoDir(dir);
    const direct = this.entries.get(key);
    const refreshes: Promise<void>[] = [];
    if (direct) refreshes.push(this.refreshEntry(direct));
    return this.resolveRepoKey(dir)
      .catch(() => null)
      .then((repoKey) => {
        if (repoKey) {
          for (const entry of this.entries.values()) {
            if (entry !== direct && entry.repoKey === repoKey) {
              refreshes.push(this.refreshEntry(entry));
            }
          }
        }
        return Promise.all(refreshes).then(() => undefined);
      });
  }

  /** Number of live entries (tests/diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  /** Whether a background-fetch timer is armed for the repository of `dir`. */
  hasFetchTimer(repoKey: string): boolean {
    return !!this.fetchStates.get(repoKey)?.timer;
  }

  /**
   * Run (or skip) a background fetch for the repository of a subscribed dir.
   * Exposed for tests; normally driven by the internal timer.
   */
  async triggerBackgroundFetch(dir: string): Promise<BackgroundFetchResult> {
    const entry = this.entries.get(canonicalRepoDir(dir));
    if (!entry) return "disabled";
    if (!entry.repoKey) await this.attachRepoKey(entry);
    const state = entry.repoKey ? this.fetchStates.get(entry.repoKey) : undefined;
    if (!state) return "disabled";
    return this.runFetch(state);
  }

  /** Stop all work (server shutdown / tests). */
  dispose(): void {
    for (const entry of Array.from(this.entries.values())) this.disposeEntry(entry);
    for (const state of this.fetchStates.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    }
    this.stopObserving?.();
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private handleMutation(lockKey: string, cwd: string): void {
    if (this.entries.size === 0) return;
    const repoKey = canonicalRepoDir(lockKey);
    const dir = canonicalRepoDir(cwd);
    for (const entry of this.entries.values()) {
      if (entry.repoKey === repoKey || entry.dir === dir) {
        void this.refreshEntry(entry);
      }
    }
  }

  private refreshEntry(entry: Entry): Promise<void> {
    if (entry.disposed) return Promise.resolve();
    if (entry.refreshing) {
      entry.dirty = true;
      return entry.refreshing;
    }
    const run = (async () => {
      do {
        entry.dirty = false;
        const result = await this.safeCompute(entry.dir);
        if (entry.disposed) return;
        const fetchState = entry.repoKey ? this.fetchStates.get(entry.repoKey) : undefined;
        this.publish(entry, this.buildSnapshot(entry.dir, result, fetchState ?? null));
      } while (entry.dirty && !entry.disposed);
    })().finally(() => {
      entry.refreshing = null;
    });
    entry.refreshing = run;
    return run;
  }

  private async safeCompute(
    dir: string,
  ): Promise<{ computation: RepoStatusComputation | null; error: string | null }> {
    try {
      return { computation: await this.compute(dir), error: null };
    } catch (err) {
      const message = isGitCommandError(err)
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
      return { computation: null, error: message };
    }
  }

  private buildSnapshot(
    dir: string,
    result: { computation: RepoStatusComputation | null; error: string | null },
    fetchState: FetchState | null,
  ): RepoStatusSnapshot {
    return {
      directory: dir,
      fingerprint: fingerprintOf(result.computation, result.error),
      status: result.computation?.status ?? null,
      diffStat: result.computation?.diffStat ?? null,
      error: result.error,
      refreshedAt: this.now(),
      lastFetchedAt: fetchState?.lastSuccessAt ?? null,
      lastFetchError: fetchState?.lastError ?? null,
    };
  }

  private publish(entry: Entry, snapshot: RepoStatusSnapshot): void {
    entry.snapshot = snapshot;
    // A successful fetch that changed nothing stays silent (lastFetchedAt rides
    // along on the next real change); a fetch error appearing/clearing publishes.
    const signature = `${snapshot.fingerprint}|${snapshot.lastFetchError ?? ""}`;
    if (signature === entry.publishedSignature) return;
    entry.publishedSignature = signature;
    for (const listener of Array.from(entry.listeners)) {
      try {
        listener(snapshot);
      } catch (err) {
        this.logger?.debug("[RepoStatus] listener failed:", err);
      }
    }
  }

  private async attachRepoKey(entry: Entry): Promise<void> {
    if (entry.repoKey) return;
    const repoKey = await this.resolveRepoKey(entry.dir).catch(() => null);
    if (!repoKey || entry.disposed || entry.repoKey) return;
    entry.repoKey = repoKey;
    let state = this.fetchStates.get(repoKey);
    if (!state) {
      state = {
        repoKey,
        dir: entry.dir,
        entries: new Set(),
        inFlight: false,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastError: null,
        failures: 0,
        nextAllowedAt: 0,
        timer: null,
      };
      this.fetchStates.set(repoKey, state);
    }
    const wasIdle = state.entries.size === 0;
    state.entries.add(entry);
    if (wasIdle) state.dir = entry.dir;
    if (this.backgroundFetch && !state.timer && !state.inFlight) {
      // First subscriber for this repository: fetch now unless recently fetched
      // or backing off (the timer handles those).
      this.scheduleFetch(state, Math.max(0, state.nextAllowedAt - this.now()));
    }
  }

  private disposeEntry(entry: Entry): void {
    if (entry.disposed) return;
    entry.disposed = true;
    entry.listeners.clear();
    this.entries.delete(entry.dir);
    if (!entry.repoKey) return;
    const state = this.fetchStates.get(entry.repoKey);
    if (!state) return;
    state.entries.delete(entry);
    if (state.entries.size === 0) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    } else if (state.dir === entry.dir) {
      state.dir = state.entries.values().next().value!.dir;
    }
  }

  private scheduleFetch(state: FetchState, delayMs: number): void {
    if (!this.backgroundFetch || state.entries.size === 0) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.runFetch(state);
    }, delayMs);
    state.timer.unref?.();
  }

  private backoffMs(failures: number): number {
    return Math.min(
      this.fetchBackoffBaseMs * 2 ** Math.max(0, failures - 1),
      this.fetchBackoffMaxMs,
    );
  }

  private async runFetch(state: FetchState): Promise<BackgroundFetchResult> {
    if (!this.backgroundFetch) return "disabled";
    if (state.entries.size === 0) return "disabled";
    if (state.inFlight) return "skipped_in_flight";
    const now = this.now();
    if (now < state.nextAllowedAt) {
      this.scheduleFetch(state, state.nextAllowedAt - now);
      return state.failures > 0 ? "skipped_backoff" : "skipped_recent";
    }
    if (this.isRepoLocked(state.repoKey)) {
      // A user-initiated mutation is running — never queue behind it.
      this.scheduleFetch(state, this.fetchLockedRetryMs);
      return "skipped_locked";
    }

    state.inFlight = true;
    state.lastAttemptAt = now;
    let result: BackgroundFetchResult;
    try {
      await this.fetchRemote(state.dir, this.fetchTimeoutMs);
      state.lastSuccessAt = this.now();
      state.lastError = null;
      state.failures = 0;
      state.nextAllowedAt = state.lastSuccessAt + this.fetchIntervalMs;
      result = "ok";
    } catch (err) {
      if (err instanceof NoRemoteError) {
        state.lastError = null;
        state.failures = 0;
        state.nextAllowedAt = this.now() + REPO_STATUS_DEFAULTS.noRemoteRecheckMs;
        result = "no_remote";
      } else {
        state.failures += 1;
        state.lastError = err instanceof Error ? err.message : String(err);
        state.nextAllowedAt = this.now() + this.backoffMs(state.failures);
        this.logger?.debug(
          `[RepoStatus] background fetch failed for ${state.dir} (attempt ${state.failures}):`,
          state.lastError,
        );
        result = "failed";
      }
    } finally {
      state.inFlight = false;
    }

    // Refresh ahead/behind (and publish fetch state) for every worktree of the repo.
    for (const entry of Array.from(state.entries)) void this.refreshEntry(entry);
    this.scheduleFetch(state, Math.max(0, state.nextAllowedAt - this.now()));
    return result;
  }
}

// ─── Process-wide instance ────────────────────────────────────────────────

let defaultService: RepoStatusService | null = null;

/** The shared service used by the server (lazily created). */
export function getRepoStatusService(): RepoStatusService {
  if (!defaultService) {
    defaultService = new RepoStatusService({
      backgroundFetch: process.env.RELAY_BACKGROUND_FETCH !== "0" && !process.env.NODE_TEST_CONTEXT,
    });
  }
  return defaultService;
}

/** Replace the shared service (tests). Disposes the previous one. */
export function setRepoStatusService(service: RepoStatusService | null): void {
  defaultService?.dispose();
  defaultService = service;
}

/**
 * The repository at `dir` may have changed: refresh subscribed status for it
 * and every other worktree of the same repository. Safe to call anywhere and
 * often — a no-op when nothing is subscribed, coalesced otherwise.
 * (Mutations run under `withRepoLock` are already observed automatically.)
 */
export function invalidateRepoStatus(dir: string | null | undefined): void {
  if (!dir || !defaultService) return;
  void defaultService.invalidate(dir).catch(() => undefined);
}
