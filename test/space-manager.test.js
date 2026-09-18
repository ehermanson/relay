import "./test-env.js";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const previousRelayHome = process.env.RELAY_HOME;
const relayHome = mkdtempSync(join(tmpdir(), "relay-space-manager-home-"));
process.env.RELAY_HOME = relayHome;

const [{ SessionDB }, { noopLogger }, { SpaceManager }] = await Promise.all([
  import("../dist/server/core/db.js"),
  import("../dist/server/core/logger.js"),
  import("../dist/server/core/space-manager.js"),
]);

after(() => {
  if (previousRelayHome === undefined) {
    delete process.env.RELAY_HOME;
  } else {
    process.env.RELAY_HOME = previousRelayHome;
  }
  rmSync(relayHome, { recursive: true, force: true });
});

function createRepo(root) {
  const repoDir = join(root, "repo");
  execSync("git init -b main repo", { cwd: root, stdio: "pipe" });
  writeFileSync(join(repoDir, "README.md"), "# Space test\n");
  execSync("git add -A", { cwd: repoDir, stdio: "pipe" });
  execSync("git commit -m initial", { cwd: repoDir, stdio: "pipe" });
  return repoDir;
}

describe("SpaceManager lifecycle", () => {
  let tempDir;
  let repoDir;
  let db;
  let manager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-space-manager-"));
    repoDir = createRepo(tempDir);
    db = new SessionDB(join(tempDir, "sessions.db"), noopLogger);
    manager = new SpaceManager(db, noopLogger);
  });

  afterEach(() => {
    try {
      execSync("git worktree prune", { cwd: repoDir, stdio: "pipe" });
    } catch {
      // best effort
    }
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates, renames, archives, and preserves context for a space", () => {
    const events = [];
    manager.on("space:created", (space) => events.push(["created", space.name]));
    manager.on("space:updated", (space) => events.push(["updated", space.name]));
    manager.on("space:removed", (spaceId) => events.push(["removed", spaceId]));

    const space = manager.createSpace(repoDir, {
      name: "Feature space",
      description: "Coordinate backend work",
    });

    assert.equal(space.isDefault, false);
    assert.equal(existsSync(space.worktreePath), true);
    assert.match(manager.readSpaceContext(space.id), /Coordinate backend work/);
    assert.equal(manager.listSpaces(repoDir).length, 2);

    const renamed = manager.renameSpace(space.id, "  Backend feature  ");
    assert.equal(renamed.name, "Backend feature");

    manager.deleteSpace(space.id);

    const archived = manager.getSpace(space.id);
    assert.equal(archived.status, "archived");
    assert.equal(archived.worktreePath, null);
    assert.equal(existsSync(space.worktreePath), false);
    assert.match(manager.readSpaceContext(space.id), /Coordinate backend work/);
    assert.deepEqual(
      events.map((event) => event[0]),
      ["created", "updated", "removed"],
    );
  });

  it("pins a space independently and emits the updated space", () => {
    const space = manager.createSpace(repoDir, { name: "Pinned space" });
    const updates = [];
    manager.on("space:updated", (updated) => updates.push(updated));

    const pinned = manager.setSpacePinned(space.id, true);
    assert.equal(pinned.pinned, true);
    assert.equal(manager.getSpace(space.id).pinned, true);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, space.id);
    assert.equal(updates[0].pinned, true);

    assert.throws(() => manager.setSpacePinned("missing", true), /not found/);
  });

  it("auto-commits dirty worktrees, squash-merges, and persists completion metadata", () => {
    const space = manager.createSpace(repoDir, { name: "Complete me" });
    writeFileSync(join(space.worktreePath, "feature.txt"), "from the space\n");

    const result = manager.completeSpace(space.id, {
      mergeMethod: "squash",
      squashMessage: "Complete space work",
    });

    assert.equal(result.targetBranch, "main");
    assert.equal(result.mergeMethod, "squash");
    assert.match(readFileSync(join(repoDir, "feature.txt"), "utf8"), /from the space/);
    assert.equal(existsSync(space.worktreePath), false);

    const completed = manager.getSpace(space.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.mergeMethod, "squash");
    assert.equal(completed.targetBranch, "main");
    assert.ok(completed.mergeCommit);
    assert.match(manager.readSpaceContext(space.id), /Complete me/);
  });

  it("lists external worktrees as convertible and excludes already-spaced ones", () => {
    const externalWorktree = join(tempDir, "external-wt");
    execSync(`git worktree add -b external-branch ${externalWorktree}`, {
      cwd: repoDir,
      stdio: "pipe",
    });

    const before = manager.listConvertibleWorktrees(repoDir);
    assert.equal(before.length, 1);
    assert.equal(before[0].branch, "external-branch");

    // Native space worktree should not appear as convertible
    manager.createSpace(repoDir, { name: "Native" });
    const afterCreate = manager.listConvertibleWorktrees(repoDir);
    assert.equal(afterCreate.length, 1);
    assert.equal(afterCreate[0].branch, "external-branch");

    // Once converted, the external worktree disappears from the convertible list
    manager.convertWorktreeToSpace(repoDir, before[0].path, {
      name: "Adopted",
    });
    assert.equal(manager.listConvertibleWorktrees(repoDir).length, 0);
  });

  it("converts an external worktree into a full-lifecycle space and refuses double-convert", () => {
    const externalWorktree = join(tempDir, "external-wt-2");
    execSync(`git worktree add -b feature/x ${externalWorktree}`, {
      cwd: repoDir,
      stdio: "pipe",
    });

    const events = [];
    manager.on("space:created", (space) => events.push(space.name));

    const space = manager.convertWorktreeToSpace(repoDir, externalWorktree, {
      name: "Adopted feature",
      description: "Carry on the external work",
    });

    assert.equal(space.gitBranch, "feature/x");
    // Git canonicalizes worktree paths (e.g. /tmp → /private/tmp on macOS),
    // so compare against the realpath rather than the literal input.
    assert.equal(space.worktreePath, realpathSync(externalWorktree));
    assert.equal(space.isDefault, false);
    assert.equal(space.status, "active");
    assert.equal(existsSync(join(externalWorktree, ".relay", "space-context.md")), true);
    assert.match(manager.readSpaceContext(space.id), /Carry on the external work/);
    assert.deepEqual(events, ["Adopted feature"]);

    assert.throws(
      () =>
        manager.convertWorktreeToSpace(repoDir, externalWorktree, {
          name: "Again",
        }),
      /already tracked/,
    );
  });

  it("refuses to convert the primary worktree", () => {
    assert.throws(
      () => manager.convertWorktreeToSpace(repoDir, repoDir, { name: "Nope" }),
      /primary worktree/,
    );
  });
});
