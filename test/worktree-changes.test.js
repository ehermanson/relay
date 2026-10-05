import "./test-env.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  captureWorktreeSnapshot,
  committedPathsBetween,
  detectTurnWorktreeChanges,
  diffWorktreeSnapshots,
} from "../dist/server/core/worktree-changes.js";

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

describe("worktree change detection", () => {
  const cleanups = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  function makeRepo() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-worktree-changes-")));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "one\n");
    writeFileSync(join(dir, "b.txt"), "bee\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    return dir;
  }

  it("returns null outside a git repo", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-not-git-")));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(await captureWorktreeSnapshot(dir), null);
  });

  it("snapshots HEAD and changed paths with untracked flags", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "two\n");
    mkdirSync(join(dir, "newdir"));
    writeFileSync(join(dir, "newdir", "c.txt"), "c\n");
    const snap = await captureWorktreeSnapshot(dir);
    assert.ok(snap);
    assert.equal(snap.head, git(dir, "rev-parse", "HEAD"));
    assert.deepEqual([...snap.paths.keys()].sort(), ["a.txt", "newdir/c.txt"]);
    assert.deepEqual([...snap.untracked], ["newdir/c.txt"]);
    assert.match(snap.paths.get("a.txt"), /^\d+(\.\d+)?:4$/);
  });

  it("attributes new and re-fingerprinted paths, not pre-existing or vanished ones", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "pre.txt"), "dirty before\n"); // untouched during the turn
    writeFileSync(join(dir, "b.txt"), "reverted later\n"); // reverted during the turn
    const before = await captureWorktreeSnapshot(dir);

    writeFileSync(join(dir, "a.txt"), "edited by sed\n");
    writeFileSync(join(dir, "new.txt"), "created\n");
    git(dir, "checkout", "--", "b.txt");
    const after = await captureWorktreeSnapshot(dir);

    const changes = diffWorktreeSnapshots(before, after).sort((x, y) =>
      x.path.localeCompare(y.path),
    );
    assert.deepEqual(changes, [{ path: "a.txt" }, { path: "new.txt", untracked: true }]);
  });

  it("re-attributes a file that was already dirty when the turn changed it again", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "dirty\n");
    const before = await captureWorktreeSnapshot(dir);
    writeFileSync(join(dir, "a.txt"), "dirtier and longer\n");
    const after = await captureWorktreeSnapshot(dir);
    assert.deepEqual(diffWorktreeSnapshots(before, after), [{ path: "a.txt" }]);
  });

  it("includes files the turn committed", async () => {
    const dir = makeRepo();
    const before = await captureWorktreeSnapshot(dir);
    writeFileSync(join(dir, "a.txt"), "committed change\n");
    writeFileSync(join(dir, "added.txt"), "new\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "turn commit");
    unlinkSync(join(dir, "b.txt"));
    const after = await captureWorktreeSnapshot(dir);

    assert.deepEqual(
      (await committedPathsBetween(dir, before.head, after.head)).sort((x, y) =>
        x.path.localeCompare(y.path),
      ),
      [{ path: "a.txt" }, { path: "added.txt", added: true }],
    );
    const detected = await detectTurnWorktreeChanges(dir, before, after);
    assert.deepEqual(
      detected.sort((x, y) => x.path.localeCompare(y.path)),
      [
        { path: join(dir, "a.txt"), type: "edited" },
        { path: join(dir, "added.txt"), type: "added" },
        { path: join(dir, "b.txt"), type: "edited" },
      ],
    );
  });

  it("reports nothing for an unchanged worktree or unmoved HEAD", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "pre.txt"), "x\n");
    const before = await captureWorktreeSnapshot(dir);
    const after = await captureWorktreeSnapshot(dir);
    assert.deepEqual(await detectTurnWorktreeChanges(dir, before, after), []);
    assert.deepEqual(await committedPathsBetween(dir, before.head, before.head), []);
    assert.deepEqual(await committedPathsBetween(dir, null, before.head), []);
  });
});
