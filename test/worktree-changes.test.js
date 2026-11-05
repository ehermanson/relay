import "./test-env.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  captureWorktreeSnapshot,
  committedPathsBetween,
  detectEnteredWorktreeChanges,
  detectTurnWorktreeChanges,
  diffWorktreeSnapshots,
  parseWorktreeSnapshot,
  serializeWorktreeSnapshot,
} from "../dist/server/core/worktree-changes.js";

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

// Work that predates the turn, as upstream commits being pulled in do.
const EARLIER = "2020-01-01T00:00:00Z";
const gitEarlier = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: EARLIER, GIT_COMMITTER_DATE: EARLIER },
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
      (await committedPathsBetween(dir, before.head, after.head, before.capturedAt)).sort((x, y) =>
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
    assert.deepEqual(await committedPathsBetween(dir, before.head, before.head, 0), []);
    assert.deepEqual(await committedPathsBetween(dir, null, before.head, 0), []);
  });

  /** A clone of a repo whose origin gained `upstream.txt` before the turn. */
  function makeCloneBehindOrigin() {
    const origin = makeRepo();
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "relay-worktree-clone-")));
    cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
    const dir = join(parent, "clone");
    git(parent, "clone", "-q", origin, dir);
    writeFileSync(join(origin, "upstream.txt"), "theirs\n");
    git(origin, "add", ".");
    gitEarlier(origin, "commit", "-q", "-m", "upstream work");
    return dir;
  }

  const relativePaths = (dir, detected) =>
    detected.map((file) => file.path.slice(dir.length + 1)).sort();

  it("does not attribute files a pull brought in", async () => {
    const dir = makeCloneBehindOrigin();
    const before = await captureWorktreeSnapshot(dir);
    git(dir, "pull", "-q", "--ff-only");
    const after = await captureWorktreeSnapshot(dir);
    assert.notEqual(before.head, after.head);
    assert.deepEqual(await detectTurnWorktreeChanges(dir, before, after), []);
  });

  it("keeps the turn's commit through a rebase, without what it rebased onto", async () => {
    const dir = makeCloneBehindOrigin();
    const before = await captureWorktreeSnapshot(dir);
    writeFileSync(join(dir, "mine.txt"), "ours\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "turn commit");
    git(dir, "pull", "-q", "--rebase");
    const after = await captureWorktreeSnapshot(dir);
    assert.deepEqual(relativePaths(dir, await detectTurnWorktreeChanges(dir, before, after)), [
      "mine.txt",
    ]);
  });

  it("does not re-attribute an older commit a rebase re-stamped", async () => {
    const dir = makeCloneBehindOrigin();
    writeFileSync(join(dir, "earlier.txt"), "from an earlier turn\n");
    git(dir, "add", ".");
    gitEarlier(dir, "commit", "-q", "-m", "earlier work");
    const before = await captureWorktreeSnapshot(dir);
    git(dir, "pull", "-q", "--rebase");
    const after = await captureWorktreeSnapshot(dir);
    assert.deepEqual(await detectTurnWorktreeChanges(dir, before, after), []);
  });

  it("ignores a clean merge but keeps what the turn resolved by hand", async () => {
    const dir = makeRepo();
    git(dir, "checkout", "-q", "-b", "other");
    writeFileSync(join(dir, "a.txt"), "theirs\n");
    writeFileSync(join(dir, "clean.txt"), "merged cleanly\n");
    git(dir, "add", ".");
    gitEarlier(dir, "commit", "-q", "-m", "other work");
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "a.txt"), "ours\n");
    git(dir, "add", ".");
    gitEarlier(dir, "commit", "-q", "-m", "main work");

    const before = await captureWorktreeSnapshot(dir);
    assert.throws(() => git(dir, "merge", "-q", "other"));
    writeFileSync(join(dir, "a.txt"), "resolved\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "--no-edit");
    const after = await captureWorktreeSnapshot(dir);
    assert.deepEqual(relativePaths(dir, await detectTurnWorktreeChanges(dir, before, after)), [
      "a.txt",
    ]);
  });

  it("finds a turn's commit behind an older-dated one", async () => {
    const dir = makeRepo();
    const before = await captureWorktreeSnapshot(dir);
    writeFileSync(join(dir, "first.txt"), "made in the turn\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "first");
    writeFileSync(join(dir, "kept-date.txt"), "cherry-picked with its old date\n");
    git(dir, "add", ".");
    gitEarlier(dir, "commit", "-q", "-m", "old date");
    writeFileSync(join(dir, "last.txt"), "made in the turn\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "last");
    const after = await captureWorktreeSnapshot(dir);
    assert.deepEqual(relativePaths(dir, await detectTurnWorktreeChanges(dir, before, after)), [
      "first.txt",
      "last.txt",
    ]);
  });

  it("ignores an octopus merge, which remerge can't diff", async () => {
    const dir = makeRepo();
    for (const name of ["one", "two"]) {
      git(dir, "checkout", "-q", "-b", name, "main");
      writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
      git(dir, "add", ".");
      gitEarlier(dir, "commit", "-q", "-m", name);
    }
    git(dir, "checkout", "-q", "main");
    const before = await captureWorktreeSnapshot(dir);
    git(dir, "merge", "-q", "--no-edit", "one", "two");
    const after = await captureWorktreeSnapshot(dir);
    assert.deepEqual(await detectTurnWorktreeChanges(dir, before, after), []);
  });

  it("still attributes commits on git without remerge diffs", async (t) => {
    const dir = makeRepo();
    const before = await captureWorktreeSnapshot(dir);
    writeFileSync(join(dir, "mine.txt"), "ours\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "turn commit");
    const after = await captureWorktreeSnapshot(dir);

    const bin = realpathSync(mkdtempSync(join(tmpdir(), "relay-old-git-")));
    cleanups.push(() => rmSync(bin, { recursive: true, force: true }));
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nfor arg in "$@"; do\n  [ "$arg" = "--diff-merges=remerge" ] && exit 129\ndone\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    t.after(() => {
      process.env.PATH = path;
    });
    assert.deepEqual(relativePaths(dir, await detectTurnWorktreeChanges(dir, before, after)), [
      "mine.txt",
    ]);
  });

  it("does not attribute a branch switch", async () => {
    const dir = makeRepo();
    git(dir, "checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "feature.txt"), "feature work\n");
    git(dir, "add", ".");
    gitEarlier(dir, "commit", "-q", "-m", "feature work");

    const onFeature = await captureWorktreeSnapshot(dir);
    git(dir, "checkout", "-q", "main");
    const onMain = await captureWorktreeSnapshot(dir);
    assert.deepEqual(await detectTurnWorktreeChanges(dir, onFeature, onMain), []);

    git(dir, "checkout", "-q", "feature");
    const backOnFeature = await captureWorktreeSnapshot(dir);
    assert.deepEqual(await detectTurnWorktreeChanges(dir, onMain, backOnFeature), []);
  });

  it("does not report a nested worktree as a changed file", async () => {
    const dir = makeRepo();
    const before = await captureWorktreeSnapshot(dir);
    git(dir, "worktree", "add", "-q", join(dir, "nested"), "-b", "nested");
    const after = await captureWorktreeSnapshot(dir);
    assert.deepEqual([...after.paths.keys()], []);
    assert.deepEqual(await detectTurnWorktreeChanges(dir, before, after), []);
  });

  it("attributes work in a worktree entered mid-turn, and nothing it merely branched from", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "older.txt"), "older\n");
    git(dir, "add", ".");
    gitEarlier(dir, "commit", "-q", "-m", "older");
    const before = await captureWorktreeSnapshot(dir);

    const worktree = join(dir, "..", `${dir.split("/").pop()}-wt`);
    cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));
    git(dir, "worktree", "add", "-q", worktree, "-b", "wt", "HEAD~1");
    writeFileSync(join(worktree, "committed.txt"), "committed\n");
    git(worktree, "add", ".");
    git(worktree, "commit", "-q", "-m", "worktree commit");
    writeFileSync(join(worktree, "dirty.txt"), "dirty\n");

    const realWorktree = realpathSync(worktree);
    const after = await captureWorktreeSnapshot(worktree);
    assert.deepEqual(
      relativePaths(realWorktree, await detectEnteredWorktreeChanges(worktree, before, after)),
      ["committed.txt", "dirty.txt"],
    );
  });

  it("attributes nothing from a different repository", async () => {
    const dir = makeRepo();
    const other = makeRepo();
    writeFileSync(join(other, "dirty.txt"), "dirty\n");
    const before = await captureWorktreeSnapshot(dir);
    const after = await captureWorktreeSnapshot(other);
    assert.deepEqual(await detectEnteredWorktreeChanges(other, before, after), []);
  });

  it("reports why a snapshot failed, but not for a plain non-repo", async () => {
    const dir = makeRepo();
    const reasons = [];
    const snapshot = await captureWorktreeSnapshot(dir, {
      timeoutMs: 0.001,
      onFailure: (reason) => reasons.push(reason),
    });
    assert.equal(snapshot, null);
    assert.equal(reasons.length, 1);

    const plain = realpathSync(mkdtempSync(join(tmpdir(), "relay-not-a-repo-")));
    cleanups.push(() => rmSync(plain, { recursive: true, force: true }));
    await captureWorktreeSnapshot(plain, { onFailure: (reason) => reasons.push(reason) });
    assert.equal(reasons.length, 1);
  });

  it("round-trips a stored baseline and rejects anything else", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "dirty\n");
    writeFileSync(join(dir, "new.txt"), "new\n");
    const snapshot = await captureWorktreeSnapshot(dir);
    assert.deepEqual(parseWorktreeSnapshot(serializeWorktreeSnapshot(snapshot)), snapshot);
    assert.equal(parseWorktreeSnapshot("not json"), null);
    assert.equal(parseWorktreeSnapshot("{}"), null);
  });
});
