import "./test-env.js";
/**
 * Push-based repo status service: fingerprint dedup, ref counting, refresh
 * coalescing, mutation-triggered refresh, and background-fetch policy
 * (interval, exponential backoff, skip when the repo lock is held).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepoStatusService, NoRemoteError } from "../dist/server/core/repo-status-service.js";
import { withRepoLock, clearRepoLockKeyCache } from "../dist/server/core/git-runner.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function makeStatus(overrides = {}) {
  return {
    branch: "main",
    head: "abc",
    upstream: null,
    ahead: null,
    behind: null,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    changeCount: 0,
    dirty: false,
    ...overrides,
  };
}

/** Controllable fake computation. */
function fakeCompute() {
  const state = { calls: 0, status: makeStatus(), digest: "d0", gate: null };
  const compute = async () => {
    state.calls++;
    if (state.gate) await state.gate;
    return {
      status: { ...state.status },
      diffStat: { files: state.status.changeCount, additions: 0, deletions: 0 },
      diffDigest: state.digest,
    };
  };
  return { state, compute };
}

describe("RepoStatusService", () => {
  const services = [];
  const tempDirs = [];
  afterEach(() => {
    for (const s of services.splice(0)) s.dispose();
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
    clearRepoLockKeyCache();
  });

  function create(opts) {
    const service = new RepoStatusService({
      backgroundFetch: false,
      observeMutations: false,
      resolveRepoKey: async () => "repo-key",
      ...opts,
    });
    services.push(service);
    return service;
  }

  function tempDir() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-repo-status-")));
    tempDirs.push(dir);
    return dir;
  }

  it("sends a snapshot on subscribe and publishes only when the fingerprint changes", async () => {
    const { state, compute } = fakeCompute();
    const service = create({ compute });
    const dir = tempDir();
    const seen = [];
    service.subscribe(dir, (s) => seen.push(s));
    await tick();
    assert.equal(seen.length, 1, "initial snapshot");
    assert.equal(seen[0].directory, dir);

    await service.invalidate(dir);
    assert.equal(seen.length, 1, "unchanged fingerprint is not republished");
    assert.equal(state.calls, 2);

    state.digest = "d1"; // content changed with identical counts
    await service.invalidate(dir);
    assert.equal(seen.length, 2);
    assert.notEqual(seen[1].fingerprint, seen[0].fingerprint);

    state.status = makeStatus({ behind: 2, ahead: 0, upstream: "origin/main" });
    await service.invalidate(dir);
    assert.equal(seen.length, 3);
    assert.equal(seen[2].status.behind, 2);
  });

  it("later subscribers get the cached snapshot without a new computation", async () => {
    const { state, compute } = fakeCompute();
    const service = create({ compute });
    const dir = tempDir();
    service.subscribe(dir, () => {});
    await tick();
    const late = [];
    service.subscribe(dir, (s) => late.push(s));
    await tick();
    assert.equal(late.length, 1);
    assert.equal(state.calls, 1);
  });

  it("ref counts subscribers and stops all work when the last one leaves", async () => {
    const { state, compute } = fakeCompute();
    let fetches = 0;
    const service = create({
      compute,
      backgroundFetch: true,
      fetchIntervalMs: 20,
      fetchRemote: async () => {
        fetches++;
      },
    });
    const dir = tempDir();
    const a = service.subscribe(dir, () => {});
    const b = service.subscribe(dir, () => {});
    await tick(5);
    assert.equal(service.size, 1, "one entry per directory");
    assert.ok(service.hasFetchTimer("repo-key") || fetches > 0);
    a();
    assert.equal(service.size, 1, "still subscribed");
    b();
    assert.equal(service.size, 0, "entry dropped");
    assert.equal(service.hasFetchTimer("repo-key"), false, "fetch timer cleared");
    const callsAfter = state.calls;
    const fetchesAfter = fetches;
    await service.invalidate(dir);
    await tick(60);
    assert.equal(state.calls, callsAfter, "no refresh without subscribers");
    assert.equal(fetches, fetchesAfter, "no background fetch without subscribers");
  });

  it("coalesces concurrent refresh requests into one trailing run", async () => {
    const { state, compute } = fakeCompute();
    const service = create({ compute });
    const dir = tempDir();
    service.subscribe(dir, () => {});
    await tick();
    assert.equal(state.calls, 1);

    let release;
    state.gate = new Promise((r) => (release = r));
    const pending = [];
    for (let i = 0; i < 10; i++) pending.push(service.invalidate(dir));
    await tick();
    assert.equal(state.calls, 2, "only one run in flight");
    state.gate = null;
    release();
    await Promise.all(pending);
    assert.equal(state.calls, 3, "exactly one trailing rerun for the burst");
  });

  it("refreshes every worktree of a repository after a Relay git mutation", async () => {
    const { state, compute } = fakeCompute();
    const service = create({ compute, observeMutations: true, resolveRepoKey: undefined });
    const repo = tempDir();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    service.subscribe(repo, () => {});
    await tick(100);
    const before = state.calls;
    await withRepoLock(repo, async () => {
      writeFileSync(join(repo, "a.txt"), "x");
    });
    await tick(20);
    assert.ok(state.calls > before, "mutation under withRepoLock triggers a refresh");
  });

  it("computes real status for a git repo and fingerprints working-tree edits", async () => {
    const service = create({ resolveRepoKey: undefined });
    const repo = tempDir();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"],
      { cwd: repo },
    );
    writeFileSync(join(repo, "f.txt"), "one\n");
    execFileSync("git", ["add", "f.txt"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "f"], {
      cwd: repo,
    });

    const seen = [];
    service.subscribe(repo, (s) => seen.push(s));
    await tick(300);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].status.branch, "main");
    assert.equal(seen[0].status.dirty, false);

    writeFileSync(join(repo, "f.txt"), "two\n");
    await service.invalidate(repo);
    assert.equal(seen.length, 2);
    assert.equal(seen[1].status.dirty, true);
    assert.deepEqual(
      { additions: seen[1].diffStat.additions, deletions: seen[1].diffStat.deletions },
      { additions: 1, deletions: 1 },
    );

    // Same counts, different content → still a new fingerprint.
    writeFileSync(join(repo, "f.txt"), "three\n");
    await service.invalidate(repo);
    assert.equal(seen.length, 3);
  });

  it("reports an error snapshot outside a repository", async () => {
    const service = create({ resolveRepoKey: undefined });
    const dir = tempDir();
    const seen = [];
    service.subscribe(dir, (s) => seen.push(s));
    await tick(300);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].status, null);
    assert.ok(seen[0].error);
  });
});

describe("RepoStatusService background fetch", () => {
  const services = [];
  afterEach(() => {
    for (const s of services.splice(0)) s.dispose();
  });

  function setup({ fetchImpl, locked = () => false } = {}) {
    let now = 1_000_000;
    const clock = { advance: (ms) => (now += ms) };
    const calls = [];
    const { compute } = fakeCompute();
    const service = new RepoStatusService({
      compute,
      observeMutations: false,
      backgroundFetch: true,
      resolveRepoKey: async () => "repo",
      isRepoLocked: locked,
      now: () => now,
      fetchIntervalMs: 60_000,
      fetchBackoffBaseMs: 30_000,
      fetchBackoffMaxMs: 15 * 60_000,
      // Keep the internal timer out of the way; tests drive fetches directly.
      fetchLockedRetryMs: 10_000_000,
      fetchRemote: async (dir) => {
        calls.push(dir);
        if (fetchImpl) await fetchImpl();
      },
    });
    services.push(service);
    const dir = realpathSync(tmpdir());
    const seen = [];
    service.subscribe(dir, (s) => seen.push(s));
    return { service, clock, calls, dir, seen };
  }

  it("fetches at most once per interval", async () => {
    const { service, clock, calls, dir } = setup();
    await tick(); // initial subscribe-triggered fetch
    assert.equal(calls.length, 1);
    assert.equal(await service.triggerBackgroundFetch(dir), "skipped_recent");
    clock.advance(59_000);
    assert.equal(await service.triggerBackgroundFetch(dir), "skipped_recent");
    clock.advance(2_000);
    assert.equal(await service.triggerBackgroundFetch(dir), "ok");
    assert.equal(calls.length, 2);
  });

  it("backs off exponentially on failure and never surfaces it as a status error", async () => {
    let fail = true;
    const { service, clock, calls, dir, seen } = setup({
      fetchImpl: async () => {
        if (fail) throw new Error("git fetch failed: could not resolve host");
      },
    });
    await tick();
    assert.equal(calls.length, 1, "first attempt failed");
    const expectedDelays = [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000];
    for (const delay of expectedDelays) {
      clock.advance(delay - 1);
      assert.equal(await service.triggerBackgroundFetch(dir), "skipped_backoff");
      clock.advance(1);
      assert.equal(await service.triggerBackgroundFetch(dir), "failed");
    }
    await tick();
    const last = seen.at(-1);
    assert.equal(last.error, null, "status itself is fine");
    assert.match(last.lastFetchError, /could not resolve host/);

    fail = false;
    clock.advance(900_000);
    assert.equal(await service.triggerBackgroundFetch(dir), "ok");
    await tick();
    assert.equal(seen.at(-1).lastFetchError, null, "success clears the error");
    assert.ok(seen.at(-1).lastFetchedAt);
  });

  it("skips (does not queue) when the repo lock is held or a fetch is in flight", async () => {
    let locked = true;
    let release;
    let gate = null;
    const { service, clock, calls, dir } = setup({
      locked: () => locked,
      fetchImpl: () => gate,
    });
    await tick();
    assert.equal(calls.length, 0, "initial attempt skipped while locked");
    assert.equal(await service.triggerBackgroundFetch(dir), "skipped_locked");
    locked = false;
    gate = new Promise((r) => (release = r));
    const first = service.triggerBackgroundFetch(dir);
    assert.equal(await service.triggerBackgroundFetch(dir), "skipped_in_flight");
    release();
    assert.equal(await first, "ok");
    assert.equal(calls.length, 1);
    clock.advance(0);
  });

  it("stops fetching for repositories without a remote", async () => {
    const { service, calls, dir } = setup({
      fetchImpl: async () => {
        throw new NoRemoteError();
      },
    });
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(await service.triggerBackgroundFetch(dir), "skipped_recent");
  });
});
