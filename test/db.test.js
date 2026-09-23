// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SessionDB } from "../dist/server/core/db.js";

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeRow(overrides = {}) {
  return {
    session_id: "sess-1",
    instance_id: "inst-1",
    provider_name: "claude",
    name: "Test Session",
    working_directory: "/tmp/test",
    jsonl_path: "/tmp/test.jsonl",
    created_at: 1000,
    last_activity_at: 2000,
    type: "external",
    archived: 0,
    custom_title: 0,
    input_tokens: 100,
    output_tokens: 200,
    cache_creation_tokens: 50,
    cache_read_tokens: 30,
    summary: null,
    first_prompt: null,
    git_branch: null,
    message_count: 0,
    allowed_tools: "[]",
    worktree_path: null,
    original_directory: null,
    parent_session_id: null,
    preferred_model: null,
    reasoning_budget: null,
    runtime_mode: null,
    last_message_text: null,
    last_message_from: null,
    last_message_at: null,
    git_info_branch: null,
    git_info_is_worktree: null,
    space_id: null,
    project_id: null,
    model: null,
    ...overrides,
  };
}

function makeSpaceRow(overrides = {}) {
  return {
    id: "space-1",
    project_directory: "/tmp/test",
    name: "My Space",
    git_branch: "relay-space/abcd1234",
    worktree_path: "/tmp/worktree",
    is_default: 0,
    status: "active",
    created_at: 1000,
    last_activity_at: 2000,
    merge_commit: null,
    merge_method: null,
    merged_at: null,
    target_branch: null,
    remote_status: null,
    pr_url: null,
    ...overrides,
  };
}

describe("SessionDB", () => {
  let tempDir;
  let db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-db-test-"));
    db = new SessionDB(join(tempDir, "sessions.db"), noopLogger);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("construction", () => {
    it("creates DB and tables on construction", () => {
      // DB was created in beforeEach; verify we can query the sessions table
      const rows = db.getAllActive();
      assert.ok(Array.isArray(rows));
      assert.equal(rows.length, 0);
    });

    it("resets transaction depth after nested success and rollback", () => {
      assert.equal(db.transactionDepth, 0);

      db.withTransaction(() => {
        db.withTransaction(() => {});
      });
      assert.equal(db.transactionDepth, 0);

      assert.throws(() => {
        db.withTransaction(() => {
          db.withTransaction(() => {
            throw new Error("nested boom");
          });
        });
      }, /nested boom/);
      assert.equal(db.transactionDepth, 0);
    });

    it("idempotently adds pinned to an existing spaces table", () => {
      db.close();
      const legacyPath = join(tempDir, "legacy-spaces.db");
      const legacy = new DatabaseSync(legacyPath);
      legacy.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version (version) VALUES (26);
        CREATE TABLE spaces (
          id TEXT PRIMARY KEY,
          project_directory TEXT NOT NULL,
          name TEXT NOT NULL,
          git_branch TEXT,
          worktree_path TEXT,
          is_default INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          last_activity_at INTEGER NOT NULL,
          merge_commit TEXT,
          merge_method TEXT,
          merged_at INTEGER,
          target_branch TEXT,
          remote_status TEXT,
          pr_url TEXT
        );
      `);
      legacy.close();

      db = new SessionDB(legacyPath, noopLogger);
      db.upsertSpace(makeSpaceRow());
      assert.equal(db.getSpace("space-1")?.pinned, 0);
      db.close();

      db = new SessionDB(legacyPath, noopLogger);
      assert.equal(db.getSpace("space-1")?.pinned, 0);
    });
  });

  describe("outbox receipts", () => {
    it("preserves accepted and uncertain sends across a database reopen", () => {
      assert.equal(db.reserveOutboxReceipt("send-1", "chat-1"), "new");
      assert.equal(db.reserveOutboxReceipt("send-1", "chat-1"), "reserved");
      db.acceptOutboxReceipt("send-1");
      assert.equal(db.reserveOutboxReceipt("send-1", "chat-1"), "accepted");

      assert.equal(db.reserveOutboxReceipt("send-2", "chat-2"), "new");
      db.close();
      db = new SessionDB(join(tempDir, "sessions.db"), noopLogger);
      assert.deepEqual(db.getOutboxReceipt("send-1"), { instanceId: "chat-1", state: "accepted" });
      assert.deepEqual(db.getOutboxReceipt("send-2"), { instanceId: "chat-2", state: "reserved" });
      assert.throws(() => db.reserveOutboxReceipt("send-1", "chat-2"));
      db.releaseOutboxReceipt("send-2");
      assert.equal(db.getOutboxReceipt("send-2"), null);
    });
  });

  describe("upsert", () => {
    it("inserts a new row", () => {
      db.upsert(makeRow());
      const row = db.getBySessionId("sess-1");
      assert.ok(row);
      assert.equal(row.session_id, "sess-1");
      assert.equal(row.instance_id, "inst-1");
      assert.equal(row.name, "Test Session");
      assert.equal(row.working_directory, "/tmp/test");
      assert.equal(row.input_tokens, 100);
      assert.equal(row.output_tokens, 200);
    });

    it("updates on conflict (same session_id)", () => {
      db.upsert(makeRow());
      db.upsert(makeRow({ name: "Updated Name", input_tokens: 500 }));
      const row = db.getBySessionId("sess-1");
      assert.equal(row.name, "Updated Name");
      assert.equal(row.input_tokens, 500);
      // Should still be only one row
      assert.equal(db.getAllActive().length, 1);
    });
  });

  describe("getBySessionId", () => {
    it("returns the row for an existing session", () => {
      db.upsert(makeRow());
      const row = db.getBySessionId("sess-1");
      assert.ok(row);
      assert.equal(row.session_id, "sess-1");
    });

    it("returns undefined for a non-existent session", () => {
      assert.equal(db.getBySessionId("nonexistent"), undefined);
    });
  });

  describe("getByInstanceId", () => {
    it("returns the row for an existing instance", () => {
      db.upsert(makeRow());
      const row = db.getByInstanceId("inst-1");
      assert.ok(row);
      assert.equal(row.instance_id, "inst-1");
    });

    it("returns undefined for a non-existent instance", () => {
      assert.equal(db.getByInstanceId("nonexistent"), undefined);
    });
  });

  describe("getByJsonlPath", () => {
    it("returns the row for an existing jsonl path", () => {
      db.upsert(makeRow());
      const row = db.getByJsonlPath("/tmp/test.jsonl");
      assert.ok(row);
      assert.equal(row.jsonl_path, "/tmp/test.jsonl");
    });

    it("returns undefined for a non-existent path", () => {
      assert.equal(db.getByJsonlPath("/no/such/file.jsonl"), undefined);
    });
  });

  describe("getAllActive", () => {
    it("returns only non-archived rows", () => {
      db.upsert(makeRow({ session_id: "s1", instance_id: "i1", jsonl_path: "/a.jsonl" }));
      db.upsert(
        makeRow({ session_id: "s2", instance_id: "i2", jsonl_path: "/b.jsonl", archived: 1 }),
      );
      db.upsert(makeRow({ session_id: "s3", instance_id: "i3", jsonl_path: "/c.jsonl" }));

      const active = db.getAllActive();
      assert.equal(active.length, 2);
      const ids = active.map((r) => r.session_id);
      assert.ok(ids.includes("s1"));
      assert.ok(ids.includes("s3"));
      assert.ok(!ids.includes("s2"));
    });

    it("returns empty array when no rows exist", () => {
      assert.deepEqual(db.getAllActive(), []);
    });
  });

  describe("archive / unarchive", () => {
    it("archives a session", () => {
      db.upsert(makeRow());
      db.archive("sess-1");
      const row = db.getBySessionId("sess-1");
      assert.equal(row.archived, 1);
      assert.equal(db.getAllActive().length, 0);
    });

    it("unarchives a session", () => {
      db.upsert(makeRow({ archived: 1 }));
      assert.equal(db.getAllActive().length, 0);
      db.unarchive("sess-1");
      assert.equal(db.getAllActive().length, 1);
      const row = db.getBySessionId("sess-1");
      assert.equal(row.archived, 0);
    });
  });

  describe("updateStats", () => {
    it("updates token and cost stats", () => {
      db.upsert(makeRow());
      db.updateStats("sess-1", {
        inputTokens: 999,
        outputTokens: 888,
        cacheCreationTokens: 777,
        cacheReadTokens: 666,
      });
      const row = db.getBySessionId("sess-1");
      assert.equal(row.input_tokens, 999);
      assert.equal(row.output_tokens, 888);
      assert.equal(row.cache_creation_tokens, 777);
      assert.equal(row.cache_read_tokens, 666);
    });
  });

  describe("updateLastActivity", () => {
    it("updates the last_activity_at timestamp", () => {
      db.upsert(makeRow());
      db.updateLastActivity("sess-1", 99999);
      const row = db.getBySessionId("sess-1");
      assert.equal(row.last_activity_at, 99999);
    });
  });

  describe("updateSessionModel", () => {
    it("updates the persisted model for a session", () => {
      db.upsert(makeRow());
      db.updateSessionModel("sess-1", "claude-opus-4-6");
      const row = db.getBySessionId("sess-1");
      assert.equal(row.model, "claude-opus-4-6");
    });
  });

  describe("updateName", () => {
    it("updates name and custom_title flag", () => {
      db.upsert(makeRow());
      db.updateName("sess-1", "New Name", true);
      const row = db.getBySessionId("sess-1");
      assert.equal(row.name, "New Name");
      assert.equal(row.custom_title, 1);
    });

    it("clears custom_title when false", () => {
      db.upsert(makeRow({ custom_title: 1 }));
      db.updateName("sess-1", "Auto Name", false);
      const row = db.getBySessionId("sess-1");
      assert.equal(row.name, "Auto Name");
      assert.equal(row.custom_title, 0);
    });
  });

  describe("setPinned", () => {
    it("pins and unpins by instance_id", () => {
      db.upsert(makeRow());
      assert.equal(db.setPinned("inst-1", true), true);
      assert.equal(db.getBySessionId("sess-1").pinned, 1);
      assert.equal(db.setPinned("inst-1", false), true);
      assert.equal(db.getBySessionId("sess-1").pinned, 0);
    });

    it("returns false when no row matches", () => {
      assert.equal(db.setPinned("unknown", true), false);
    });

    it("survives a subsequent upsert of the same session", () => {
      db.upsert(makeRow());
      db.setPinned("inst-1", true);
      // Routine saves (which don't know about pinned) must not clobber the pin
      db.upsert(makeRow({ name: "Updated Name" }));
      const row = db.getBySessionId("sess-1");
      assert.equal(row.name, "Updated Name");
      assert.equal(row.pinned, 1);
    });
  });

  describe("setDone", () => {
    it("stores and clears the done timestamp by instance_id", () => {
      db.upsert(makeRow());
      assert.equal(db.setDone("inst-1", 1700000000000), true);
      assert.equal(db.getBySessionId("sess-1").done_at, 1700000000000);
      assert.equal(db.setDone("inst-1", null), true);
      assert.equal(db.getBySessionId("sess-1").done_at, null);
    });

    it("returns false when no row matches", () => {
      assert.equal(db.setDone("unknown", 1700000000000), false);
    });

    it("survives a subsequent upsert of the same session", () => {
      db.upsert(makeRow());
      db.setDone("inst-1", 1700000000000);
      // Routine saves don't know about done_at and must not clear it
      db.upsert(makeRow({ name: "Updated Name" }));
      const row = db.getBySessionId("sess-1");
      assert.equal(row.name, "Updated Name");
      assert.equal(row.done_at, 1700000000000);
    });
  });

  describe("setDoneBulk", () => {
    it("stamps every matching chat with the same timestamp", () => {
      db.upsert(makeRow({ session_id: "s1", instance_id: "i1", jsonl_path: "/a.jsonl" }));
      db.upsert(makeRow({ session_id: "s2", instance_id: "i2", jsonl_path: "/b.jsonl" }));

      const updated = db.setDoneBulk(["i1", "i2"], 1700000000000);

      assert.deepEqual(updated, ["i1", "i2"]);
      assert.equal(db.getBySessionId("s1").done_at, 1700000000000);
      assert.equal(db.getBySessionId("s2").done_at, 1700000000000);
    });

    it("reports only the ids it reached, ignoring unknown ones", () => {
      db.upsert(makeRow({ session_id: "s1", instance_id: "i1", jsonl_path: "/a.jsonl" }));
      assert.deepEqual(db.setDoneBulk(["i1", "gone"], 1700000000000), ["i1"]);
    });

    it("clears the marker for many chats at once", () => {
      db.upsert(makeRow({ session_id: "s1", instance_id: "i1", jsonl_path: "/a.jsonl" }));
      db.setDoneBulk(["i1"], 1700000000000);
      assert.deepEqual(db.setDoneBulk(["i1"], null), ["i1"]);
      assert.equal(db.getBySessionId("s1").done_at, null);
    });

    it("no-ops on an empty id list", () => {
      assert.deepEqual(db.setDoneBulk([], 1700000000000), []);
    });
  });

  describe("getJsonlPaths", () => {
    it("returns a Set of all jsonl paths", () => {
      db.upsert(makeRow({ session_id: "s1", instance_id: "i1", jsonl_path: "/a.jsonl" }));
      db.upsert(makeRow({ session_id: "s2", instance_id: "i2", jsonl_path: "/b.jsonl" }));
      db.upsert(makeRow({ session_id: "s3", instance_id: "i3", jsonl_path: "/c.jsonl" }));

      const paths = db.getJsonlPaths();
      assert.ok(paths instanceof Set);
      assert.equal(paths.size, 3);
      assert.ok(paths.has("/a.jsonl"));
      assert.ok(paths.has("/b.jsonl"));
      assert.ok(paths.has("/c.jsonl"));
    });

    it("returns empty set when no rows exist", () => {
      const paths = db.getJsonlPaths();
      assert.equal(paths.size, 0);
    });
  });

  describe("updateSpaceName", () => {
    it("updates the persisted space name and activity timestamp", () => {
      db.upsertSpace(makeSpaceRow());
      db.updateSpaceName("space-1", "Renamed Space", 99999);
      const row = db.getSpace("space-1");
      assert.equal(row?.name, "Renamed Space");
      assert.equal(row?.last_activity_at, 99999);
    });
  });

  describe("setSpacePinned", () => {
    it("persists independently and survives a routine space upsert", () => {
      db.upsertSpace(makeSpaceRow());
      assert.equal(db.setSpacePinned("space-1", true), true);
      assert.equal(db.getSpace("space-1")?.pinned, 1);

      db.upsertSpace(makeSpaceRow({ name: "Updated Space", last_activity_at: 3000 }));
      assert.equal(db.getSpace("space-1")?.pinned, 1);

      assert.equal(db.setSpacePinned("space-1", false), true);
      assert.equal(db.getSpace("space-1")?.pinned, 0);
      assert.equal(db.setSpacePinned("missing", true), false);
    });
  });

  describe("reassignSpacesToProjectDirectory", () => {
    it("merges duplicate default spaces without violating the unique index", () => {
      db.upsertSpace(
        makeSpaceRow({
          id: "default-target",
          project_directory: "/tmp/canonical",
          name: "main",
          is_default: 1,
          git_branch: null,
          worktree_path: null,
        }),
      );
      db.upsertSpace(
        makeSpaceRow({
          id: "default-previous",
          project_directory: "/tmp/worktree-project",
          name: "main",
          is_default: 1,
          git_branch: null,
          worktree_path: null,
        }),
      );
      db.upsert(
        makeRow({
          session_id: "sess-default-merge",
          instance_id: "inst-default-merge",
          jsonl_path: "/tmp/default-merge.jsonl",
          space_id: "default-previous",
        }),
      );

      db.reassignSpacesToProjectDirectory("/tmp/canonical", "/tmp/worktree-project");

      const canonicalSpaces = db.getSpacesByProject("/tmp/canonical");
      assert.equal(canonicalSpaces.filter((space) => space.is_default === 1).length, 1);
      assert.equal(db.getSpace("default-previous"), undefined);
      assert.equal(db.getBySessionId("sess-default-merge")?.space_id, "default-target");
    });
  });

  describe("deleteBySessionId", () => {
    it("deletes a row by session_id", () => {
      db.upsert(makeRow());
      db.deleteBySessionId("sess-1");
      assert.equal(db.getBySessionId("sess-1"), undefined);
      assert.equal(db.getAllActive().length, 0);
    });

    it("does nothing for non-existent session", () => {
      db.deleteBySessionId("nonexistent");
      // Should not throw
    });
  });

  describe("clear", () => {
    it("removes all rows", () => {
      db.upsert(makeRow({ session_id: "s1", instance_id: "i1", jsonl_path: "/a.jsonl" }));
      db.upsert(makeRow({ session_id: "s2", instance_id: "i2", jsonl_path: "/b.jsonl" }));
      assert.equal(db.getAllActive().length, 2);
      db.clear();
      assert.equal(db.getAllActive().length, 0);
    });
  });

  describe("session events", () => {
    it("inserts and reads events ordered by timestamp", () => {
      db.insertSessionEvent("i1", 2000, "model_switched", JSON.stringify({ toModel: "b" }));
      db.insertSessionEvent("i1", 1000, "model_switched", JSON.stringify({ toModel: "a" }));
      db.insertSessionEvent("i2", 1500, "model_switched", null);

      const rows = db.getSessionEvents("i1");
      assert.equal(rows.length, 2);
      assert.equal(rows[0].timestamp, 1000);
      assert.equal(JSON.parse(rows[0].payload_json).toModel, "a");
      assert.equal(rows[1].timestamp, 2000);
      assert.equal(db.getSessionEvents("i2").length, 1);
      assert.equal(db.getSessionEvents("missing").length, 0);
    });

    it("deleteManagedByInstanceId removes the instance's events", () => {
      db.insertSessionEvent("i1", 1000, "model_switched", null);
      db.insertSessionEvent("i2", 1000, "model_switched", null);
      db.deleteManagedByInstanceId("i1");
      assert.equal(db.getSessionEvents("i1").length, 0);
      assert.equal(db.getSessionEvents("i2").length, 1);
    });

    it("clear removes all events", () => {
      db.insertSessionEvent("i1", 1000, "model_switched", null);
      db.clear();
      assert.equal(db.getSessionEvents("i1").length, 0);
    });
  });

  describe("upsertMany", () => {
    it("inserts multiple rows in a transaction", () => {
      db.upsertMany([
        makeRow({ session_id: "s1", instance_id: "i1", jsonl_path: "/a.jsonl" }),
        makeRow({ session_id: "s2", instance_id: "i2", jsonl_path: "/b.jsonl" }),
        makeRow({ session_id: "s3", instance_id: "i3", jsonl_path: "/c.jsonl" }),
      ]);
      assert.equal(db.getAllActive().length, 3);
    });

    it("updates existing rows on conflict", () => {
      db.upsert(
        makeRow({ session_id: "s1", instance_id: "i1", jsonl_path: "/a.jsonl", name: "Old" }),
      );
      db.upsertMany([
        makeRow({ session_id: "s1", instance_id: "i1", jsonl_path: "/a.jsonl", name: "New" }),
        makeRow({ session_id: "s2", instance_id: "i2", jsonl_path: "/b.jsonl" }),
      ]);
      assert.equal(db.getAllActive().length, 2);
      assert.equal(db.getBySessionId("s1").name, "New");
    });
  });

  describe("getByProjectId", () => {
    it("returns only rows matching the given project_id", () => {
      db.upsert(
        makeRow({
          session_id: "s1",
          instance_id: "i1",
          jsonl_path: "/a.jsonl",
          project_id: "proj-1",
        }),
      );
      db.upsert(
        makeRow({
          session_id: "s2",
          instance_id: "i2",
          jsonl_path: "/b.jsonl",
          project_id: "proj-2",
        }),
      );
      db.upsert(
        makeRow({
          session_id: "s3",
          instance_id: "i3",
          jsonl_path: "/c.jsonl",
          project_id: "proj-1",
        }),
      );
      const rows = db.getByProjectId("proj-1");
      assert.equal(rows.length, 2);
      const ids = rows.map((r) => r.instance_id).sort();
      assert.deepEqual(ids, ["i1", "i3"]);
    });

    it("excludes archived rows", () => {
      db.upsert(
        makeRow({
          session_id: "s1",
          instance_id: "i1",
          jsonl_path: "/a.jsonl",
          project_id: "proj-1",
        }),
      );
      db.upsert(
        makeRow({
          session_id: "s2",
          instance_id: "i2",
          jsonl_path: "/b.jsonl",
          project_id: "proj-1",
          archived: 1,
        }),
      );
      assert.equal(db.getByProjectId("proj-1").length, 1);
    });

    it("returns empty array for unknown project", () => {
      assert.equal(db.getByProjectId("nonexistent").length, 0);
    });

    it("excludes rows with null project_id", () => {
      db.upsert(
        makeRow({ session_id: "s1", instance_id: "i1", jsonl_path: "/a.jsonl", project_id: null }),
      );
      assert.equal(db.getByProjectId("proj-1").length, 0);
    });
  });

  describe("getBySpaceId", () => {
    it("returns only rows matching the given space_id", () => {
      db.upsert(
        makeRow({ session_id: "s1", instance_id: "i1", jsonl_path: "/a.jsonl", space_id: "sp-1" }),
      );
      db.upsert(
        makeRow({ session_id: "s2", instance_id: "i2", jsonl_path: "/b.jsonl", space_id: "sp-2" }),
      );
      db.upsert(
        makeRow({ session_id: "s3", instance_id: "i3", jsonl_path: "/c.jsonl", space_id: "sp-1" }),
      );
      const rows = db.getBySpaceId("sp-1");
      assert.equal(rows.length, 2);
      const ids = rows.map((r) => r.instance_id).sort();
      assert.deepEqual(ids, ["i1", "i3"]);
    });

    it("excludes archived rows", () => {
      db.upsert(
        makeRow({ session_id: "s1", instance_id: "i1", jsonl_path: "/a.jsonl", space_id: "sp-1" }),
      );
      db.upsert(
        makeRow({
          session_id: "s2",
          instance_id: "i2",
          jsonl_path: "/b.jsonl",
          space_id: "sp-1",
          archived: 1,
        }),
      );
      assert.equal(db.getBySpaceId("sp-1").length, 1);
    });
  });

  describe("getManagedByProjectId", () => {
    function makeManagedRow(overrides = {}) {
      return {
        instance_id: "m-1",
        provider_name: "codex",
        provider_session_id: null,
        name: "Managed Session",
        working_directory: "/tmp/test",
        created_at: 1000,
        last_activity_at: 2000,
        archived: 0,
        custom_title: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        git_branch: null,
        worktree_path: null,
        original_directory: null,
        parent_session_id: null,
        preferred_model: null,
        reasoning_budget: null,
        runtime_mode: "approval-required",
        resume_cursor_json: null,
        runtime_payload_json: "{}",
        model_options_json: null,
        original_git_branch: null,
        transcript_path: null,
        last_message_text: null,
        last_message_from: null,
        last_message_at: null,
        git_info_branch: null,
        git_info_is_worktree: null,
        space_id: null,
        project_id: null,
        model: null,
        ...overrides,
      };
    }

    it("returns only managed rows matching the given project_id", () => {
      db.upsertManaged(makeManagedRow({ instance_id: "m-1", project_id: "proj-1" }));
      db.upsertManaged(makeManagedRow({ instance_id: "m-2", project_id: "proj-2" }));
      db.upsertManaged(makeManagedRow({ instance_id: "m-3", project_id: "proj-1" }));
      const rows = db.getManagedByProjectId("proj-1");
      assert.equal(rows.length, 2);
      const ids = rows.map((r) => r.instance_id).sort();
      assert.deepEqual(ids, ["m-1", "m-3"]);
    });

    it("excludes archived managed rows", () => {
      db.upsertManaged(makeManagedRow({ instance_id: "m-1", project_id: "proj-1" }));
      db.upsertManaged(makeManagedRow({ instance_id: "m-2", project_id: "proj-1", archived: 1 }));
      assert.equal(db.getManagedByProjectId("proj-1").length, 1);
    });

    it("returns empty array for unknown project", () => {
      assert.equal(db.getManagedByProjectId("nonexistent").length, 0);
    });

    it("setPinned pins managed rows and survives a subsequent upsert", () => {
      db.upsertManaged(makeManagedRow({ instance_id: "m-1", project_id: "proj-1" }));
      assert.equal(db.setPinned("m-1", true), true);
      db.upsertManaged(makeManagedRow({ instance_id: "m-1", project_id: "proj-1", name: "New" }));
      const row = db.getManagedByProjectId("proj-1")[0];
      assert.equal(row.name, "New");
      assert.equal(row.pinned, 1);
    });

    it("returns only managed rows matching the given space_id", () => {
      db.upsertManaged(makeManagedRow({ instance_id: "m-1", space_id: "sp-1" }));
      db.upsertManaged(makeManagedRow({ instance_id: "m-2", space_id: "sp-2" }));
      db.upsertManaged(makeManagedRow({ instance_id: "m-3", space_id: "sp-1" }));
      const rows = db.getManagedBySpaceId("sp-1");
      assert.equal(rows.length, 2);
      const ids = rows.map((r) => r.instance_id).sort();
      assert.deepEqual(ids, ["m-1", "m-3"]);
    });
  });

  describe("getAll", () => {
    it("excludes archived by default", () => {
      db.upsert(makeRow({ session_id: "s1", instance_id: "i1", jsonl_path: "/a.jsonl" }));
      db.upsert(
        makeRow({ session_id: "s2", instance_id: "i2", jsonl_path: "/b.jsonl", archived: 1 }),
      );
      assert.equal(db.getAll().length, 1);
    });

    it("includes archived when requested", () => {
      db.upsert(makeRow({ session_id: "s1", instance_id: "i1", jsonl_path: "/a.jsonl" }));
      db.upsert(
        makeRow({ session_id: "s2", instance_id: "i2", jsonl_path: "/b.jsonl", archived: 1 }),
      );
      assert.equal(db.getAll(true).length, 2);
    });
  });
});
