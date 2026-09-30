// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
/**
 * Project ↔ account membership (`Project.accountIds`, `projects.account_ids_json`):
 *  - a new project belongs to the account registering it (absent ⇒ default)
 *  - registering an already-known directory under another account is a
 *    membership union, never a duplicate row
 *  - updateProject({ accountIds }) validates against the known account ids
 *  - removing an account drops it everywhere; an emptied project falls back
 *    to the default account
 *  - a default-only membership is stored as NULL so single-account installs
 *    never grow data
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionDB } from "../dist/server/core/db.js";
import { noopLogger } from "../dist/server/core/logger.js";
import { ProjectManager } from "../dist/server/core/project-manager.js";
import { DEFAULT_ACCOUNT_ID } from "../dist/server/core/types.js";

function makeGitRepo(parent, name) {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

const ACCOUNTS = [
  { id: "work", label: "Work", logins: { claude: { configDir: "/tmp/.claude-work" } } },
  { id: "personal", label: "Personal", logins: { codex: { configDir: "/tmp/.codex-personal" } } },
];

describe("ProjectManager account membership", () => {
  const cleanup = [];

  afterEach(() => {
    while (cleanup.length > 0) cleanup.pop()();
  });

  function setup() {
    const tmp = mkdtempSync(join(tmpdir(), "relay-project-accounts-"));
    const db = new SessionDB(join(tmp, "sessions.db"), noopLogger);
    db.updateGlobalSettings({ accounts_json: JSON.stringify(ACCOUNTS) });
    const manager = new ProjectManager(db, noopLogger);
    cleanup.push(() => {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    });
    const storedJson = (id) => db.getProject(id).account_ids_json;
    return { tmp, db, manager, storedJson };
  }

  it("a project added without an account belongs to the default and stores NULL", () => {
    const { tmp, manager, storedJson } = setup();
    const repo = makeGitRepo(tmp, "plain");

    const project = manager.addProject(repo);
    assert.deepEqual(project.accountIds, [DEFAULT_ACCOUNT_ID]);
    assert.equal(storedJson(project.id), null, "default-only membership is not persisted");
    assert.equal("defaultProfileId" in project, false, "the deprecated field is gone");

    // An explicit "default" is the same as no account.
    const again = manager.addProject(repo, { accountId: DEFAULT_ACCOUNT_ID });
    assert.equal(again.id, project.id);
    assert.deepEqual(again.accountIds, [DEFAULT_ACCOUNT_ID]);
    assert.equal(storedJson(project.id), null);
    assert.equal(manager.listProjects().length, 1);
  });

  it("a project added under an account belongs to that account only", () => {
    const { tmp, manager, storedJson } = setup();
    const repo = makeGitRepo(tmp, "work-app");

    const project = manager.addProject(repo, { accountId: "work" });
    assert.deepEqual(project.accountIds, ["work"]);
    assert.deepEqual(JSON.parse(storedJson(project.id)), ["work"]);
    assert.deepEqual(manager.getProject(project.id).accountIds, ["work"]);
  });

  it("re-adding a known directory under another account is a membership union, not a duplicate", () => {
    const { tmp, manager, storedJson } = setup();
    const repo = makeGitRepo(tmp, "shared");
    const first = manager.addProject(repo, { accountId: "work" });

    const updated = [];
    manager.on("project:updated", (p) => updated.push(p));

    const second = manager.addProject(repo, { accountId: "personal" });
    assert.equal(second.id, first.id, "same row");
    assert.deepEqual(second.accountIds, ["work", "personal"]);
    assert.equal(manager.listProjects().length, 1);
    assert.equal(updated.length, 1);

    // The default account can join too, and joining twice is a no-op.
    const third = manager.addProject(repo);
    assert.deepEqual(third.accountIds, ["work", "personal", DEFAULT_ACCOUNT_ID]);
    assert.deepEqual(manager.addProject(repo, { accountId: "work" }).accountIds, [
      "work",
      "personal",
      DEFAULT_ACCOUNT_ID,
    ]);
    assert.equal(updated.length, 2);
    assert.deepEqual(JSON.parse(storedJson(first.id)), ["work", "personal", DEFAULT_ACCOUNT_ID]);
  });

  it("rejects registering under an unknown account", () => {
    const { tmp, manager } = setup();
    const repo = makeGitRepo(tmp, "nope");
    assert.throws(() => manager.addProject(repo, { accountId: "ghost" }), /Unknown account: ghost/);
    assert.equal(manager.listProjects().length, 0);
  });

  it("updateProject({ accountIds }) validates, dedupes, and treats empty as default-only", () => {
    const { tmp, manager, storedJson } = setup();
    const project = manager.addProject(makeGitRepo(tmp, "app"));

    assert.throws(
      () => manager.updateProject(project.id, { accountIds: ["work", "ghost"] }),
      /Unknown account: ghost/,
    );
    assert.deepEqual(manager.getProject(project.id).accountIds, [DEFAULT_ACCOUNT_ID]);

    const set = manager.updateProject(project.id, {
      accountIds: ["work", " work ", "personal", ""],
    });
    assert.deepEqual(set.accountIds, ["work", "personal"]);
    assert.deepEqual(JSON.parse(storedJson(project.id)), ["work", "personal"]);

    // Other updates leave membership alone.
    const renamed = manager.updateProject(project.id, { name: "App" });
    assert.deepEqual(renamed.accountIds, ["work", "personal"]);

    // Empty (or null) ⇒ default only, stored as NULL again.
    assert.deepEqual(manager.updateProject(project.id, { accountIds: [] }).accountIds, [
      DEFAULT_ACCOUNT_ID,
    ]);
    assert.equal(storedJson(project.id), null);
    manager.updateProject(project.id, { accountIds: ["work"] });
    assert.deepEqual(manager.updateProject(project.id, { accountIds: null }).accountIds, [
      DEFAULT_ACCOUNT_ID,
    ]);
    assert.equal(storedJson(project.id), null);

    // Explicit default alongside another account is kept as written.
    const both = manager.updateProject(project.id, {
      accountIds: [DEFAULT_ACCOUNT_ID, "work"],
    });
    assert.deepEqual(both.accountIds, [DEFAULT_ACCOUNT_ID, "work"]);
    assert.deepEqual(JSON.parse(storedJson(project.id)), [DEFAULT_ACCOUNT_ID, "work"]);
  });

  it("removeAccountFromProjects drops the account everywhere; an emptied project falls back to default", () => {
    const { tmp, manager, storedJson } = setup();
    const onlyWork = manager.addProject(makeGitRepo(tmp, "only-work"), { accountId: "work" });
    const both = manager.addProject(makeGitRepo(tmp, "both"), { accountId: "work" });
    manager.addProject(join(tmp, "both"), { accountId: "personal" });
    const untouched = manager.addProject(makeGitRepo(tmp, "personal-only"), {
      accountId: "personal",
    });
    const updated = [];
    manager.on("project:updated", (p) => updated.push(p.id));

    assert.equal(manager.removeAccountFromProjects("work"), 2);
    assert.deepEqual(manager.getProject(onlyWork.id).accountIds, [DEFAULT_ACCOUNT_ID]);
    assert.equal(storedJson(onlyWork.id), null, "fallback to default is stored as NULL");
    assert.deepEqual(manager.getProject(both.id).accountIds, ["personal"]);
    assert.deepEqual(manager.getProject(untouched.id).accountIds, ["personal"]);
    assert.deepEqual(updated.sort(), [onlyWork.id, both.id].sort());

    // Idempotent, and the default account is never removed.
    assert.equal(manager.removeAccountFromProjects("work"), 0);
    assert.equal(manager.removeAccountFromProjects(DEFAULT_ACCOUNT_ID), 0);
    assert.deepEqual(manager.getProject(onlyWork.id).accountIds, [DEFAULT_ACCOUNT_ID]);
  });

  it("reads legacy/odd stored membership defensively", () => {
    const { tmp, manager, db } = setup();
    const project = manager.addProject(makeGitRepo(tmp, "legacy"));
    const row = db.getProject(project.id);

    db.upsertProject({ ...row, account_ids_json: "not json" });
    assert.deepEqual(manager.getProject(project.id).accountIds, [DEFAULT_ACCOUNT_ID]);
    db.upsertProject({ ...row, account_ids_json: "[]" });
    assert.deepEqual(manager.getProject(project.id).accountIds, [DEFAULT_ACCOUNT_ID]);
    db.upsertProject({ ...row, account_ids_json: JSON.stringify(["work", "work", 7, ""]) });
    assert.deepEqual(manager.getProject(project.id).accountIds, ["work"]);
  });

  it("known ids come from the injected accounts source (test seam / the manager's store)", () => {
    const { tmp, db, manager } = setup();
    const repo = makeGitRepo(tmp, "seam");
    manager.setAccountsSource({ list: () => [{ id: "default" }, { id: "injected" }] });
    assert.deepEqual(manager.addProject(repo, { accountId: "injected" }).accountIds, ["injected"]);
    assert.throws(() => manager.addProject(repo, { accountId: "work" }), /Unknown account: work/);

    const viaOption = new ProjectManager(db, noopLogger, {
      accounts: { list: () => [{ id: "only" }] },
    });
    assert.throws(
      () => viaOption.addProject(makeGitRepo(tmp, "seam-2"), { accountId: "work" }),
      /Unknown account: work/,
    );
  });

  it("accepts ids migrated from the legacy per-provider profile list", () => {
    const { tmp, db, manager } = setup();
    db.updateGlobalSettings({
      accounts_json: null,
      provider_profiles_json: JSON.stringify([
        { id: "legacy", provider: "claude", label: "Legacy", configDir: "/tmp/.claude-legacy" },
      ]),
    });
    const project = manager.addProject(makeGitRepo(tmp, "legacy"), { accountId: "legacy" });
    assert.deepEqual(project.accountIds, ["legacy"]);
  });

  it("an update never rebinds the deprecated default_profile_id column (rows read back carry it)", () => {
    const { tmp, db, manager } = setup();
    const project = manager.addProject(makeGitRepo(tmp, "roundtrip"));
    // A row read with SELECT * includes the column; writing it back must not throw.
    assert.doesNotThrow(() => db.upsertProject(db.getProject(project.id)));
    assert.equal(manager.updateProject(project.id, { name: "Renamed" }).name, "Renamed");
  });
});
