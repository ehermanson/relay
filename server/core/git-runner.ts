/**
 * Shared, non-blocking runner for `git` and `gh` subprocesses.
 *
 * Every git/gh invocation reachable from a request, WebSocket handler, or
 * manager goes through here so that:
 * - the Node event loop is never blocked (async spawn, arg arrays, no shell);
 * - credential/host-key prompts can never hang a call (prompt-free env, no
 *   controlling terminal, stdin closed);
 * - read-only calls don't take optional locks (`GIT_OPTIONAL_LOCKS=0`) and so
 *   never collide with an agent's own git operations;
 * - short calls share a global concurrency cap, while long calls (push, pull,
 *   merge, worktree add/remove, PR creation) bypass it and cannot starve reads;
 * - mutations of one repository (including all of its worktrees) serialize
 *   through `withRepoLock`;
 * - failures surface as a typed `GitCommandError` instead of fake defaults.
 */

import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// ─── Timeouts ─────────────────────────────────────────────────────────────

/** Timeout tiers. `fast` may be overridden with RELAY_GIT_TIMEOUT_MS. */
export const GIT_TIMEOUTS = {
  /** Local metadata reads (rev-parse, status, branch lists). */
  fast: Number(process.env.RELAY_GIT_TIMEOUT_MS) || 5_000,
  /** Local work that scales with repo size (diff, commit, checkout). */
  normal: 30_000,
  /** Anything that talks to a remote (fetch, pull, push, gh). */
  network: 120_000,
  /** Worktree add/remove and merges. */
  long: 300_000,
} as const;

/** Calls with a timeout above this (or none) bypass the concurrency cap. */
const LONG_OP_THRESHOLD_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const LOCK_RETRY_ATTEMPTS = 2;
const LOCK_RETRY_DELAY_MS = 100;
const KILL_GRACE_MS = 2_000;

// ─── Errors ───────────────────────────────────────────────────────────────

export type GitErrorKind =
  | "timeout"
  | "auth"
  | "not_a_repo"
  | "locked"
  | "output_too_large"
  /** The git/gh binary itself could not be found. */
  | "not_found"
  | "aborted"
  | "failed";

export class GitCommandError extends Error {
  readonly kind: GitErrorKind;
  readonly operation: string;
  readonly cwd: string;
  readonly exitCode: number | null;
  /** Full stderr for logs. Never forward this to users verbatim. */
  readonly stderr: string;

  constructor(opts: {
    kind: GitErrorKind;
    operation: string;
    cwd: string;
    message: string;
    exitCode?: number | null;
    stderr?: string;
  }) {
    super(opts.message);
    this.name = "GitCommandError";
    this.kind = opts.kind;
    this.operation = opts.operation;
    this.cwd = opts.cwd;
    this.exitCode = opts.exitCode ?? null;
    this.stderr = opts.stderr ?? "";
  }
}

export function isGitCommandError(err: unknown): err is GitCommandError {
  return err instanceof GitCommandError;
}

/** Remove credentials embedded in URLs (https://user:token@host → https://***@host). */
function redact(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@");
}

/** First meaningful stderr line, redacted and length-capped, for user-facing messages. */
export function summarizeGitOutput(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !/^hint:/i.test(l)) ?? "";
  const cleaned = redact(line.replace(/^(fatal|error):\s*/i, ""));
  return cleaned.length > 200 ? `${cleaned.slice(0, 197)}...` : cleaned;
}

function classifyFailure(stderr: string): GitErrorKind {
  const s = stderr.toLowerCase();
  if (s.includes("not a git repository")) return "not_a_repo";
  if (
    s.includes("index.lock") ||
    s.includes(".lock': file exists") ||
    s.includes("another git process seems to be running") ||
    s.includes("cannot lock ref") ||
    (s.includes("unable to create") && s.includes(".lock"))
  ) {
    return "locked";
  }
  if (
    s.includes("authentication failed") ||
    s.includes("could not read username") ||
    s.includes("could not read password") ||
    s.includes("terminal prompts disabled") ||
    s.includes("permission denied (publickey") ||
    s.includes("host key verification failed") ||
    s.includes("invalid username or password") ||
    s.includes("http basic: access denied") ||
    s.includes("could not read from remote repository") ||
    s.includes("gh auth login") ||
    s.includes("not logged into") ||
    s.includes("gh_token")
  ) {
    return "auth";
  }
  return "failed";
}

function messageFor(kind: GitErrorKind, operation: string, stderr: string, tool: string): string {
  const detail = summarizeGitOutput(stderr);
  switch (kind) {
    case "timeout":
      return `${operation} timed out`;
    case "not_found":
      return `${tool} is not installed or not on PATH`;
    case "not_a_repo":
      return `${operation} failed: not a git repository`;
    case "locked":
      return `${operation} failed: the repository is locked by another git process${detail ? ` (${detail})` : ""}`;
    case "auth":
      return `${operation} failed: authentication required or rejected${detail ? ` (${detail})` : ""}`;
    case "output_too_large":
      return `${operation} produced too much output`;
    case "aborted":
      return `${operation} was cancelled`;
    default:
      return detail ? `${operation} failed: ${detail}` : `${operation} failed`;
  }
}

// ─── Environment ──────────────────────────────────────────────────────────

/**
 * Environment for every git call: inherit the process env, but make any
 * credential or passphrase prompt fail immediately instead of hanging.
 */
export function buildGitEnv(opts?: {
  readOnly?: boolean;
  extra?: Record<string, string | undefined>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    SSH_ASKPASS_REQUIRE: "never",
    // Keep stderr in English so failure classification is reliable.
    LC_MESSAGES: "C",
  };
  if (opts?.readOnly) env.GIT_OPTIONAL_LOCKS = "0";
  if (opts?.extra) {
    for (const [key, value] of Object.entries(opts.extra)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  return env;
}

export function buildGhEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return buildGitEnv({
    extra: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", ...extra },
  });
}

// ─── Concurrency cap ──────────────────────────────────────────────────────

let concurrencyLimit = 8;
let activeShortOps = 0;
const shortOpWaiters: Array<() => void> = [];

async function acquireShortSlot(signal?: AbortSignal): Promise<void> {
  if (activeShortOps < concurrencyLimit) {
    activeShortOps++;
    return;
  }
  await new Promise<void>((resolveWait, rejectWait) => {
    const wake = () => {
      signal?.removeEventListener("abort", onAbort);
      resolveWait();
    };
    const onAbort = () => {
      const idx = shortOpWaiters.indexOf(wake);
      if (idx >= 0) shortOpWaiters.splice(idx, 1);
      rejectWait(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    shortOpWaiters.push(wake);
  });
  // The releasing call handed its slot over, so `activeShortOps` is unchanged.
}

function releaseShortSlot(): void {
  const next = shortOpWaiters.shift();
  if (next) {
    next();
    return;
  }
  activeShortOps = Math.max(0, activeShortOps - 1);
}

/** Snapshot of the short-op concurrency cap (for diagnostics and tests). */
export function getGitRunnerStats(): { active: number; queued: number; limit: number } {
  return { active: activeShortOps, queued: shortOpWaiters.length, limit: concurrencyLimit };
}

/** Override the concurrency cap (tests only). Returns the previous limit. */
export function setGitConcurrencyLimit(limit: number): number {
  const previous = concurrencyLimit;
  concurrencyLimit = Math.max(1, Math.floor(limit));
  while (activeShortOps < concurrencyLimit && shortOpWaiters.length > 0) {
    activeShortOps++;
    shortOpWaiters.shift()?.();
  }
  return previous;
}

// ─── Process execution ────────────────────────────────────────────────────

export interface RunGitOptions {
  cwd: string;
  /** Defaults to `GIT_TIMEOUTS.fast`. `0` disables the timeout (long op). */
  timeoutMs?: number;
  /** Max combined stdout bytes before the call fails with `output_too_large`. */
  maxOutputBytes?: number;
  /** With `truncateOutput`, exceeding the cap stops the process and returns `truncated: true`. */
  truncateOutput?: boolean;
  /** Extra env vars (undefined deletes an inherited var). */
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** Resolve (instead of throwing) when the command exits non-zero. */
  allowFailure?: boolean;
  /** Human-readable label used in errors, e.g. "git fetch". */
  operation?: string;
  /** Read-only call: disables optional locks and lock-retry. */
  readOnly?: boolean;
  /** Retry transient lock errors for mutations. Defaults to true unless readOnly. */
  retryOnLock?: boolean;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
}

interface SpawnSpec {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  opts: RunGitOptions;
  operation: string;
}

function spawnOnce(spec: SpawnSpec): Promise<GitResult> {
  const { binary, args, env, opts, operation } = spec;
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUTS.fast;
  const maxOutput = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise<GitResult>((resolveRun, rejectRun) => {
    const fail = (kind: GitErrorKind, stderr: string, exitCode: number | null = null) =>
      new GitCommandError({
        kind,
        operation,
        cwd: opts.cwd,
        message: messageFor(kind, operation, stderr, binary),
        exitCode,
        stderr,
      });

    if (opts.signal?.aborted) {
      rejectRun(fail("aborted", ""));
      return;
    }
    // spawn reports a missing cwd as ENOENT, indistinguishable from a missing
    // binary — check it first so it's classified correctly.
    if (!existsSync(opts.cwd)) {
      rejectRun(
        new GitCommandError({
          kind: "not_a_repo",
          operation,
          cwd: opts.cwd,
          message: `${operation} failed: directory does not exist`,
        }),
      );
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, args, {
        cwd: opts.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        // New process group with no controlling terminal: ssh/credential
        // helpers can't open /dev/tty to prompt, and a timeout can kill the
        // whole group (git → ssh → helper), not just git.
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      rejectRun(fail(code === "ENOENT" ? "not_found" : "failed", String(err)));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminal: GitErrorKind | "truncated" | null = null;
    let timer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const killTree = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const pid = child.pid;
      try {
        if (pid && process.platform !== "win32") process.kill(-pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        try {
          if (pid && process.platform !== "win32") process.kill(-pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, KILL_GRACE_MS);
      killTimer.unref();
    };

    const stop = (reason: GitErrorKind | "truncated") => {
      if (terminal) return;
      terminal = reason;
      killTree();
    };

    const onAbort = () => stop("aborted");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    if (timeoutMs > 0) {
      timer = setTimeout(() => stop("timeout"), timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (terminal) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutput) {
        const keep = chunk.length - (stdoutBytes - maxOutput);
        if (keep > 0) stdoutChunks.push(chunk.subarray(0, keep));
        stop(opts.truncateOutput ? "truncated" : "output_too_large");
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // stderr is diagnostic only; cap it so a chatty process can't balloon memory.
      if (stderrBytes > 64 * 1024) return;
      stderrBytes += chunk.length;
      stderrChunks.push(chunk);
    });

    const finish = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      finish();
      if (killTimer) clearTimeout(killTimer);
      rejectRun(fail(err.code === "ENOENT" ? "not_found" : "failed", err.message));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      finish();
      if (killTimer) clearTimeout(killTimer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      if (terminal === "truncated") {
        resolveRun({ stdout, stderr, exitCode: null, truncated: true });
        return;
      }
      if (terminal) {
        rejectRun(fail(terminal, stderr, code));
        return;
      }
      if (code === 0 || opts.allowFailure) {
        resolveRun({ stdout, stderr, exitCode: code, truncated: false });
        return;
      }
      rejectRun(fail(classifyFailure(stderr || stdout), stderr || stdout, code));
    });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function runWithPolicy(spec: SpawnSpec): Promise<GitResult> {
  const timeoutMs = spec.opts.timeoutMs ?? GIT_TIMEOUTS.fast;
  const isLong = timeoutMs <= 0 || timeoutMs > LONG_OP_THRESHOLD_MS;
  const retryOnLock = spec.opts.retryOnLock ?? !spec.opts.readOnly;

  for (let attempt = 0; ; attempt++) {
    if (!isLong) {
      try {
        await acquireShortSlot(spec.opts.signal);
      } catch {
        throw new GitCommandError({
          kind: "aborted",
          operation: spec.operation,
          cwd: spec.opts.cwd,
          message: messageFor("aborted", spec.operation, "", spec.binary),
        });
      }
    }
    try {
      return await spawnOnce(spec);
    } catch (err) {
      if (
        retryOnLock &&
        attempt < LOCK_RETRY_ATTEMPTS &&
        err instanceof GitCommandError &&
        err.kind === "locked"
      ) {
        await sleep(LOCK_RETRY_DELAY_MS);
        continue;
      }
      throw err;
    } finally {
      if (!isLong) releaseShortSlot();
    }
  }
}

/**
 * Run `git <args>` asynchronously with a hardened environment.
 * Throws `GitCommandError` on failure (unless `allowFailure`).
 */
export function runGit(args: string[], opts: RunGitOptions): Promise<GitResult> {
  const operation = opts.operation ?? `git ${args.find((a) => !a.startsWith("-")) ?? ""}`.trim();
  return runWithPolicy({
    binary: "git",
    args,
    env: buildGitEnv({ readOnly: opts.readOnly, extra: opts.env }),
    opts,
    operation,
  });
}

/** Run `gh <args>` asynchronously with prompts and update checks disabled. */
export function runGh(args: string[], opts: RunGitOptions): Promise<GitResult> {
  const operation = opts.operation ?? `gh ${args.slice(0, 2).join(" ")}`.trim();
  return runWithPolicy({
    binary: "gh",
    args,
    env: buildGhEnv(opts.env),
    opts: { timeoutMs: GIT_TIMEOUTS.network, ...opts },
    operation,
  });
}

// ─── Per-repository mutation lock ─────────────────────────────────────────

const repoKeyCache = new Map<string, string>();
const repoQueues = new Map<string, Promise<unknown>>();
const heldRepoLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Resolve the lock key for a directory: the repository's git common dir, so
 * every worktree of one repository shares a key (they share refs and objects).
 * Falls back to the resolved directory when git can't answer.
 */
export async function getRepoLockKey(cwd: string): Promise<string> {
  const dir = resolve(cwd);
  const cached = repoKeyCache.get(dir);
  if (cached) return cached;
  let key = dir;
  try {
    const { stdout } = await runGit(["rev-parse", "--git-common-dir"], {
      cwd: dir,
      readOnly: true,
      operation: "git rev-parse",
    });
    const common = stdout.trim();
    if (common) key = resolve(dir, common);
  } catch {
    // Not a repo (yet) — lock on the directory itself, and don't cache.
    return dir;
  }
  repoKeyCache.set(dir, key);
  return key;
}

/**
 * Serialize repository mutations. `fn` runs after every previously queued
 * mutation for the same repository settles. Re-entrant: nested calls for a
 * key already held by the current async context run immediately.
 * Reads never need this.
 */
export async function withRepoLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const key = await getRepoLockKey(cwd);
  const held = heldRepoLocks.getStore();
  if (held?.has(key)) return fn();

  const previous = repoQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((r) => {
    release = r;
  });
  const tail = previous.then(() => current);
  repoQueues.set(key, tail);

  await previous.catch(() => undefined);
  const nextHeld = new Set(held ?? []);
  nextHeld.add(key);
  try {
    return await heldRepoLocks.run(nextHeld, fn);
  } finally {
    release();
    if (repoQueues.get(key) === tail) repoQueues.delete(key);
    notifyRepoMutation(key, resolve(cwd));
  }
}

/**
 * Whether a mutation currently holds (or is queued for) the lock with this
 * key (see `getRepoLockKey`). Used by background work that should skip rather
 * than wait behind user-initiated mutations.
 */
export function isRepoLockHeld(key: string): boolean {
  return repoQueues.has(key);
}

/** Keys of every repository lock currently held or queued. */
export function listHeldRepoLocks(): string[] {
  return Array.from(repoQueues.keys());
}

// ─── Mutation notifications ───────────────────────────────────────────────

/** Called after every outermost `withRepoLock` section settles (success or failure). */
export type RepoMutationListener = (repoKey: string, cwd: string) => void;

const repoMutationListeners = new Set<RepoMutationListener>();

/**
 * Observe repository mutations. Every git mutation Relay performs runs under
 * `withRepoLock`, so this is the one central hook for "the repo may have
 * changed" (commit, push, pull, fetch, checkout, merge, worktree changes).
 * Returns an unsubscribe function.
 */
export function onRepoMutation(listener: RepoMutationListener): () => void {
  repoMutationListeners.add(listener);
  return () => repoMutationListeners.delete(listener);
}

function notifyRepoMutation(repoKey: string, cwd: string): void {
  for (const listener of repoMutationListeners) {
    try {
      listener(repoKey, cwd);
    } catch {
      // listeners must never break a mutation
    }
  }
}

/** Test helper: forget cached repo keys (e.g. after a temp repo is deleted). */
export function clearRepoLockKeyCache(): void {
  repoKeyCache.clear();
}
