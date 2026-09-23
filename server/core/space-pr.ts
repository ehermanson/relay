/**
 * Pull-request helpers for Spaces, backed by the `gh` CLI.
 *
 * - `checkGhAvailability` classifies gh as missing / unauthenticated / ready
 *   using the shared runner's error kinds (`gh --version`, `gh auth status`).
 * - `findOpenPullRequest` detects an existing open PR for a head branch so
 *   pushing twice never tries to create a duplicate.
 * - `createPullRequest` passes the body through `--body-file` (a temp file,
 *   always deleted) instead of argv.
 * - `PrStatusReader` reads `gh pr view` with a 60s cache, exponential backoff
 *   on failure (20s → 15min), and a small concurrency cap.
 * - `normalizePrStatus` / `summarizePrChecks` are pure and unit-tested.
 */

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { GIT_TIMEOUTS, GitCommandError, runGh, type GitErrorKind } from "#core/git-runner.js";
import type { SpacePrChecksSummary, SpacePrState, SpacePrStatus } from "#core/types.js";

// ─── Normalization (pure) ─────────────────────────────────────────────────

interface RawCheck {
  __typename?: string;
  name?: string;
  context?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  startedAt?: string;
  completedAt?: string;
}

type CheckOutcome = "passing" | "failing" | "pending" | "skipped";

function checkOutcome(check: RawCheck): CheckOutcome {
  // StatusContext (commit statuses) carries `state`; CheckRun carries status + conclusion.
  if (check.__typename === "StatusContext" || (check.state && !check.status)) {
    switch ((check.state ?? "").toUpperCase()) {
      case "SUCCESS":
        return "passing";
      case "FAILURE":
      case "ERROR":
        return "failing";
      default:
        return "pending";
    }
  }
  if ((check.status ?? "").toUpperCase() !== "COMPLETED") return "pending";
  switch ((check.conclusion ?? "").toUpperCase()) {
    case "SUCCESS":
      return "passing";
    case "FAILURE":
    case "TIMED_OUT":
    case "STARTUP_FAILURE":
    case "ACTION_REQUIRED":
      return "failing";
    case "":
      return "pending";
    default:
      // NEUTRAL, SKIPPED, CANCELLED, STALE
      return "skipped";
  }
}

function checkTimestamp(check: RawCheck): number {
  const t = Date.parse(check.completedAt || check.startedAt || "");
  return Number.isFinite(t) ? t : 0;
}

/**
 * Count CI checks, deduplicated by workflow + check name (re-runs and
 * re-triggered statuses keep only the newest entry).
 */
export function summarizePrChecks(rollup: unknown): SpacePrChecksSummary {
  const latest = new Map<string, RawCheck>();
  if (Array.isArray(rollup)) {
    for (const item of rollup) {
      if (!item || typeof item !== "object") continue;
      const check = item as RawCheck;
      const name = check.name ?? check.context ?? "";
      const key = `${check.workflowName ?? ""}\u0000${name}`;
      const previous = latest.get(key);
      if (!previous || checkTimestamp(check) >= checkTimestamp(previous)) latest.set(key, check);
    }
  }
  const summary: SpacePrChecksSummary = {
    total: latest.size,
    passing: 0,
    failing: 0,
    pending: 0,
    skipped: 0,
    state: "none",
  };
  for (const check of latest.values()) summary[checkOutcome(check)]++;
  if (summary.failing > 0) summary.state = "failing";
  else if (summary.pending > 0) summary.state = "pending";
  else if (summary.passing > 0) summary.state = "passing";
  return summary;
}

/** Normalize `gh pr view --json …` output. Null when it isn't a PR payload. */
export function normalizePrStatus(raw: unknown, fetchedAt = Date.now()): SpacePrStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const number = typeof r.number === "number" ? r.number : Number(r.number);
  const url = typeof r.url === "string" ? r.url : "";
  if (!Number.isFinite(number) || !url) return null;
  const isDraft = r.isDraft === true;
  const rawState = String(r.state ?? "").toUpperCase();
  const state: SpacePrState =
    rawState === "MERGED"
      ? "merged"
      : rawState === "CLOSED"
        ? "closed"
        : isDraft
          ? "draft"
          : "open";
  const mergeable = String(r.mergeable ?? "").toUpperCase();
  const review = String(r.reviewDecision ?? "").toUpperCase();
  return {
    number,
    url,
    title: typeof r.title === "string" ? r.title : "",
    state,
    isDraft,
    mergeable:
      mergeable === "MERGEABLE"
        ? "mergeable"
        : mergeable === "CONFLICTING"
          ? "conflicting"
          : "unknown",
    reviewDecision:
      review === "APPROVED"
        ? "approved"
        : review === "CHANGES_REQUESTED"
          ? "changes_requested"
          : review === "REVIEW_REQUIRED"
            ? "review_required"
            : null,
    checks: summarizePrChecks(r.statusCheckRollup),
    fetchedAt,
  };
}

/** `remote_status` value persisted for a PR state. */
export function remoteStatusForPr(pr: SpacePrStatus): string {
  return pr.state === "merged" ? "pr-merged" : pr.state === "closed" ? "pr-closed" : "pr-open";
}

// ─── gh commands ──────────────────────────────────────────────────────────

export type GhAvailability =
  | { ok: true }
  | { ok: false; reason: "not_installed" | "not_authenticated"; message: string };

/**
 * `gh --version` then `gh auth status`. Only a runner `auth` classification
 * counts as unauthenticated; other `auth status` failures (e.g. one stale
 * host among several) don't block — the PR command reports its own error.
 */
export async function checkGhAvailability(cwd: string): Promise<GhAvailability> {
  try {
    await runGh(["--version"], { cwd, timeoutMs: GIT_TIMEOUTS.fast, operation: "gh --version" });
  } catch {
    return { ok: false, reason: "not_installed", message: "gh CLI not found" };
  }
  try {
    await runGh(["auth", "status"], {
      cwd,
      timeoutMs: GIT_TIMEOUTS.normal,
      operation: "gh auth status",
    });
  } catch (err) {
    if (err instanceof GitCommandError && err.kind === "auth") {
      return { ok: false, reason: "not_authenticated", message: "gh CLI is not authenticated" };
    }
  }
  return { ok: true };
}

/** The open PR whose head is `branch`, or null. Throws `GitCommandError`. */
export async function findOpenPullRequest(
  cwd: string,
  branch: string,
): Promise<{ url: string; number: number } | null> {
  const { stdout } = await runGh(
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "url,number,state",
      "--limit",
      "1",
    ],
    { cwd, operation: "gh pr list" },
  );
  const list = JSON.parse(stdout || "[]") as Array<{ url?: string; number?: number }>;
  const first = Array.isArray(list) ? list.find((pr) => typeof pr?.url === "string") : undefined;
  return first?.url ? { url: first.url, number: Number(first.number) } : null;
}

/** `gh pr create` with the body passed via a temp `--body-file`. Returns the PR URL. */
export async function createPullRequest(
  cwd: string,
  opts: { head: string; base: string; title: string; body: string },
): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "relay-pr-body-"));
  const bodyFile = join(dir, "body.md");
  try {
    writeFileSync(bodyFile, opts.body, "utf8");
    const { stdout } = await runGh(
      [
        "pr",
        "create",
        "--head",
        opts.head,
        "--base",
        opts.base,
        "--title",
        opts.title,
        "--body-file",
        bodyFile,
      ],
      { cwd, operation: "gh pr create" },
    );
    return stdout.match(/https?:\/\/\S+/)?.[0] ?? null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PR_VIEW_FIELDS = "number,state,isDraft,mergeable,reviewDecision,statusCheckRollup,url,title";

/**
 * `gh pr view <url|branch>`. Null when gh reports there is no such PR;
 * throws `GitCommandError` for other failures.
 */
export async function readPullRequest(cwd: string, ref: string): Promise<SpacePrStatus | null> {
  try {
    const { stdout } = await runGh(["pr", "view", ref, "--json", PR_VIEW_FIELDS], {
      cwd,
      operation: "gh pr view",
    });
    return normalizePrStatus(JSON.parse(stdout));
  } catch (err) {
    if (
      err instanceof GitCommandError &&
      err.kind === "failed" &&
      /no pull requests found|could not resolve to a pullrequest/i.test(err.stderr)
    ) {
      return null;
    }
    throw err;
  }
}

// ─── Cached reader ────────────────────────────────────────────────────────

export const PR_STATUS_CACHE_MS = 60_000;
export const PR_STATUS_BACKOFF_MIN_MS = 20_000;
export const PR_STATUS_BACKOFF_MAX_MS = 15 * 60_000;
const PR_STATUS_MAX_CONCURRENT = 4;

export type PrStatusReadResult =
  | { ok: true; pr: SpacePrStatus | null; cached: boolean }
  | { ok: false; error: string; errorKind?: GitErrorKind; retryAt: number };

interface CacheEntry {
  pr: SpacePrStatus | null;
  fetchedAt: number;
  failures: number;
  retryAt: number;
  lastError?: { message: string; kind?: GitErrorKind };
}

/** Backoff delay after `failures` consecutive failures (20s doubling, capped at 15min). */
export function prStatusBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(PR_STATUS_BACKOFF_MAX_MS, PR_STATUS_BACKOFF_MIN_MS * 2 ** (failures - 1));
}

export class PrStatusReader {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<PrStatusReadResult>>();
  private active = 0;
  private waiters: Array<() => void> = [];
  private readonly read: (cwd: string, ref: string) => Promise<SpacePrStatus | null>;
  private readonly now: () => number;

  constructor(opts?: {
    read?: (cwd: string, ref: string) => Promise<SpacePrStatus | null>;
    now?: () => number;
  }) {
    this.read = opts?.read ?? readPullRequest;
    this.now = opts?.now ?? Date.now;
  }

  /** Drop the cached entry (and backoff) for `key` — e.g. after a push. */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Read the PR for `key` (a space id). Serves the 60s cache unless `force`;
   * while backing off after failures, returns the failure without calling gh.
   */
  get(
    key: string,
    cwd: string,
    ref: string,
    opts?: { force?: boolean },
  ): Promise<PrStatusReadResult> {
    const now = this.now();
    const entry = this.cache.get(key);
    if (entry && entry.failures > 0 && now < entry.retryAt) {
      return Promise.resolve({
        ok: false,
        error: entry.lastError?.message ?? "PR status unavailable",
        errorKind: entry.lastError?.kind,
        retryAt: entry.retryAt,
      });
    }
    if (
      !opts?.force &&
      entry &&
      entry.failures === 0 &&
      now - entry.fetchedAt < PR_STATUS_CACHE_MS
    ) {
      return Promise.resolve({ ok: true, pr: entry.pr, cached: true });
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const run = this.fetch(key, cwd, ref).finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  private async fetch(key: string, cwd: string, ref: string): Promise<PrStatusReadResult> {
    await this.acquire();
    try {
      const pr = await this.read(cwd, ref);
      this.cache.set(key, { pr, fetchedAt: this.now(), failures: 0, retryAt: 0 });
      return { ok: true, pr, cached: false };
    } catch (err) {
      const previous = this.cache.get(key);
      const failures = (previous?.failures ?? 0) + 1;
      const retryAt = this.now() + prStatusBackoffMs(failures);
      const message = err instanceof Error ? err.message : String(err);
      const kind = err instanceof GitCommandError ? err.kind : undefined;
      this.cache.set(key, {
        pr: previous?.pr ?? null,
        fetchedAt: previous?.fetchedAt ?? 0,
        failures,
        retryAt,
        lastError: { message, kind },
      });
      return { ok: false, error: message, errorKind: kind, retryAt };
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < PR_STATUS_MAX_CONCURRENT) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }
}
