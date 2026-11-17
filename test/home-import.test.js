import "./test-env.js";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionDB } from "../dist/server/core/db.js";
import { importRelayHome } from "../dist/server/core/home-import.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A home with a current-schema database, plus a raw handle to fill it. */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "relay-home-import-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const dbPath = join(home, "sessions.db");
  new SessionDB(dbPath, logger).close();
  const raw = (fn) => {
    const db = new DatabaseSync(dbPath);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  return { home, dbPath, raw };
}
function addProject(db, { id, directory, slug }) {
  db.prepare(
    "INSERT INTO projects (id, name, slug, directory, created_at) VALUES (?, ?, ?, ?, 1)",
  ).run(id, slug, slug, directory);
}
function addChat(db, { id, session, project, pinned = 0 }) {
  db.prepare(
    `INSERT INTO managed_sessions
       (instance_id, provider_name, provider_session_id, name, working_directory, created_at, last_activity_at, project_id, pinned)
     VALUES (?, 'claude', ?, ?, '/work', 1, 1, ?, ?)`,
  ).run(id, session, `chat ${id}`, project, pinned);
}
const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;

describe("importing another Relay home", () => {
  it("adds projects and chats, re-points chats at a project already registered here", () => {
    const from = makeHome();
    const to = makeHome();
    from.raw((db) => {
      addProject(db, { id: "p-app", directory: "/work/app", slug: "app" });
      addProject(db, { id: "p-new", directory: "/work/new", slug: "new" });
      addChat(db, { id: "chat-1", session: "s-1", project: "p-app", pinned: 1 });
      addChat(db, { id: "chat-2", session: "s-2", project: "p-new" });
      db.prepare(
        "INSERT INTO session_events (instance_id, timestamp, event, payload_json) VALUES ('chat-1', 5, 'model_switched', '{}')",
      ).run();
      db.prepare(
        "INSERT INTO workstreams (id, account_id, name, created_at, updated_at) VALUES ('w-1', 'default', 'GraphQL', 1, 1)",
      ).run();
      db.prepare(
        "INSERT INTO workstream_members (workstream_id, instance_id, joined_at) VALUES ('w-1', 'chat-2', 1)",
      ).run();
    });
    to.raw((db) => {
      // Same directory, different id: the target's row wins.
      addProject(db, { id: "p-here", directory: "/work/app", slug: "app" });
      db.prepare(
        "INSERT INTO removed_projects (directory, removed_at) VALUES ('/work/new', 1)",
      ).run();
    });
    mkdirSync(join(from.home, "html-renders", "chat-1"), { recursive: true });
    writeFileSync(join(from.home, "html-renders", "chat-1", "a.html"), "<p>hi</p>");

    const result = importRelayHome({
      fromDbPath: from.dbPath,
      toDbPath: to.dbPath,
      logger,
      now: 42,
    });
    assert.equal(result.projects, 1);
    assert.equal(result.chats, 2);
    assert.equal(result.backupPath, `${to.dbPath}.pre-import.42`);
    assert.ok(existsSync(result.backupPath));
    assert.equal(
      readFileSync(join(to.home, "html-renders", "chat-1", "a.html"), "utf8"),
      "<p>hi</p>",
    );

    to.raw((db) => {
      const chat1 = db
        .prepare("SELECT project_id, pinned FROM managed_sessions WHERE instance_id = 'chat-1'")
        .get();
      assert.equal(chat1.project_id, "p-here");
      assert.equal(chat1.pinned, 1);
      assert.equal(
        db.prepare("SELECT project_id FROM managed_sessions WHERE instance_id = 'chat-2'").get()
          .project_id,
        "p-new",
      );
      assert.equal(count(db, "SELECT COUNT(*) n FROM projects"), 2);
      assert.equal(count(db, "SELECT COUNT(*) n FROM removed_projects"), 0);
      assert.equal(
        count(db, "SELECT COUNT(*) n FROM session_events WHERE instance_id = 'chat-1'"),
        1,
      );
      assert.equal(
        count(db, "SELECT COUNT(*) n FROM workstream_members WHERE instance_id = 'chat-2'"),
        1,
      );
      assert.equal(count(db, "SELECT COUNT(*) n FROM workstreams WHERE id = 'w-1'"), 1);
    });
    // The backup is the target as it was.
    const backup = new DatabaseSync(result.backupPath);
    assert.equal(count(backup, "SELECT COUNT(*) n FROM managed_sessions"), 0);
    backup.close();
  });

  it("never overwrites or duplicates, and a second run changes nothing", () => {
    const from = makeHome();
    const to = makeHome();
    from.raw((db) => {
      addProject(db, { id: "p-1", directory: "/work/one", slug: "one" });
      addProject(db, { id: "p-2", directory: "/work/two", slug: "taken" });
      addChat(db, { id: "same-id", session: "s-a", project: "p-1" });
      addChat(db, { id: "other-id", session: "s-shared", project: "p-1" });
      addChat(db, { id: "fresh", session: "s-fresh", project: "p-2" });
      db.prepare(
        "INSERT INTO session_events (instance_id, timestamp, event) VALUES ('fresh', 1, 'model_switched')",
      ).run();
    });
    to.raw((db) => {
      addProject(db, { id: "p-x", directory: "/work/elsewhere", slug: "taken" });
      addChat(db, { id: "same-id", session: "s-mine", project: "p-x" });
      addChat(db, { id: "mine", session: "s-shared", project: "p-x" });
    });
    const first = importRelayHome({ fromDbPath: from.dbPath, toDbPath: to.dbPath, logger, now: 1 });
    assert.equal(first.chats, 1);
    assert.equal(first.projects, 2);
    to.raw((db) => {
      assert.equal(
        db
          .prepare(
            "SELECT provider_session_id s FROM managed_sessions WHERE instance_id = 'same-id'",
          )
          .get().s,
        "s-mine",
      );
      assert.equal(
        count(db, "SELECT COUNT(*) n FROM managed_sessions WHERE provider_session_id = 's-shared'"),
        1,
      );
      // A slug in use here is dropped for the newcomer, not stolen.
      assert.equal(db.prepare("SELECT slug FROM projects WHERE id = 'p-2'").get().slug, null);
      assert.equal(db.prepare("SELECT slug FROM projects WHERE id = 'p-x'").get().slug, "taken");
    });
    const second = importRelayHome({
      fromDbPath: from.dbPath,
      toDbPath: to.dbPath,
      logger,
      now: 2,
    });
    assert.equal(second.chats, 0);
    assert.equal(second.projects, 0);
    to.raw((db) => {
      assert.equal(count(db, "SELECT COUNT(*) n FROM managed_sessions"), 3);
      assert.equal(
        count(db, "SELECT COUNT(*) n FROM session_events WHERE instance_id = 'fresh'"),
        1,
      );
    });
    // The source is only read.
    from.raw((db) => assert.equal(count(db, "SELECT COUNT(*) n FROM managed_sessions"), 3));
  });

  it("refuses a home with no database and leaves the target alone", () => {
    const to = makeHome();
    assert.throws(
      () =>
        importRelayHome({ fromDbPath: join(to.home, "missing.db"), toDbPath: to.dbPath, logger }),
      /no data to import/,
    );
  });
});
