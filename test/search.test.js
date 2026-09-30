// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SessionDB, accountLoginRootFilter, sanitizeSnippet } from "../dist/server/core/db.js";
import { extractSearchableText } from "../dist/server/core/instance-manager.js";

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

function makeRow(overrides = {}) {
  return {
    session_id: "sess-1",
    instance_id: "inst-1",
    provider_name: "claude",
    name: "Test Session",
    working_directory: "/tmp/test",
    jsonl_path: "/tmp/test.jsonl",
    created_at: 1000,
    last_activity_at: Date.now(),
    type: "external",
    archived: 0,
    custom_title: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
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

function makeManagedRow(overrides = {}) {
  return {
    instance_id: "m-1",
    provider_name: "codex",
    provider_session_id: null,
    name: "Managed Session",
    working_directory: "/tmp/test",
    created_at: 1000,
    last_activity_at: Date.now(),
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

// ---------------------------------------------------------------------------
// HistoryEntry helpers for extractSearchableText
// ---------------------------------------------------------------------------

function userEntry(text, opts = {}) {
  return {
    timestamp: Date.now(),
    message: { type: "user", text, ...opts },
  };
}

function outputEntry(text) {
  return {
    timestamp: Date.now(),
    message: { type: "output", text, isWaiting: false },
  };
}

function activityEntry(activity, description) {
  return {
    timestamp: Date.now(),
    message: { type: "activity", activity, description },
  };
}

// ---------------------------------------------------------------------------
// extractSearchableText
// ---------------------------------------------------------------------------

describe("extractSearchableText", () => {
  it("includes long user and assistant messages", () => {
    const longUser =
      "This is a detailed question about the routing architecture and how it handles nested layouts in our application";
    const longAssistant =
      "The routing system uses a tree-based approach where each node can define its own layout component and error boundary";
    const result = extractSearchableText([userEntry(longUser), outputEntry(longAssistant)]);
    assert.ok(result.includes(longUser));
    assert.ok(result.includes(longAssistant));
  });

  it("filters out short throwaway messages", () => {
    const result = extractSearchableText([
      userEntry("ok sounds good"),
      userEntry("yes"),
      userEntry("yeah lets go with that"),
      outputEntry("Got it."),
      outputEntry("Sure."),
    ]);
    assert.equal(result, "");
  });

  it("keeps short task references so linked chats stay searchable", () => {
    const result = extractSearchableText([userEntry("@task:a1b2c3d4:Fix%20login ")]);
    assert.equal(result, "@task:a1b2c3d4:Fix%20login ");
  });

  it("skips internal user messages", () => {
    const result = extractSearchableText([
      userEntry(
        "The relay server restarted while you were mid-turn. Please continue from where you left off.",
        { internal: true },
      ),
    ]);
    assert.equal(result, "");
  });

  it("strips task context wrapper and indexes only the real user text", () => {
    // buildFirstTurnTaskContextPrompt wraps user text with task tracking preamble
    const wrapped =
      "This project tracks tasks in .relay/tasks.json (Relay-managed snapshot JSON). " +
      "Do not create a task for every request. Create a task only when explicitly asked, pick up an existing task when explicitly asked or when the request clearly matches one, and otherwise just do the work without creating a new task. Ask if unsure whether a request should map to a task. " +
      "Fields: id (8-char hex), title, description (markdown), status (open|in_progress|done), " +
      "priority (0-4), type (epic|task|bug), tags (string[]), parent (nullable task ID), " +
      "blockedBy (task ID[]), createdAt, updatedAt (ISO timestamps). " +
      "Blocked status is auto-derived from unresolved blockedBy refs. " +
      "When asked to pick up a task (e.g. 'pick up task a1b2c3d4'), read .relay/tasks.json to find it." +
      "\n\n" +
      "Do not mention, restate, or acknowledge the task-tracking guidance unless the user directly asks about tasks. " +
      "Focus only on the user's request below.\n\n" +
      "User request:\nPlease refactor the authentication middleware to support multiple providers and add proper error handling for token refresh failures";

    const result = extractSearchableText([userEntry(wrapped)]);
    // Should contain the real user request, not the task tracking boilerplate
    assert.ok(result.includes("refactor the authentication middleware"));
    assert.ok(!result.includes("Relay-managed snapshot JSON"));
  });

  it("strips space context wrapper and indexes only the real user text", () => {
    const wrapped =
      "<space-context>\n## Space: test\n\nLots of space context here...\n</space-context>\n\n" +
      "User request:\nImplement the search feature with FTS5 backend and integrate it with the existing instance manager";
    const result = extractSearchableText([userEntry(wrapped)]);
    assert.ok(result.includes("Implement the search feature"));
    assert.ok(!result.includes("space-context"));
  });

  it("strips fallback runtime context wrapper and indexes only the real user text", () => {
    const wrapped =
      "Runtime context for this turn:\n\n" +
      "## Space: test (.relay/space-context.md)\n" +
      "Use the shared worktree and coordinate with sibling chats first.\n\n" +
      "User request:\nRefactor the provider registry so runtime context is handled consistently and stays separate from visible user-authored chat messages";
    const result = extractSearchableText([userEntry(wrapped)]);
    assert.ok(result.includes("Refactor the provider registry"));
    assert.ok(!result.includes("Runtime context for this turn"));
  });

  it("excludes tool_use and thinking activity messages", () => {
    const result = extractSearchableText([
      activityEntry("tool_use", "Reading file server/core/db.ts"),
      activityEntry(
        "thinking",
        "Let me think about this approach carefully and consider the tradeoffs between different options",
      ),
      activityEntry("tool_result", "File contents here..."),
    ]);
    assert.equal(result, "");
  });

  it("joins qualifying messages with newlines", () => {
    const a =
      "First substantial message that discusses the architecture of the system in detail with enough content";
    const b =
      "Second substantial message that covers the implementation approach and testing strategy for the feature";
    const result = extractSearchableText([userEntry(a), outputEntry(b)]);
    assert.equal(result, `${a}\n${b}`);
  });
});

// ---------------------------------------------------------------------------
// sanitizeSnippet
// ---------------------------------------------------------------------------

describe("sanitizeSnippet", () => {
  it("returns null for null input", () => {
    assert.equal(sanitizeSnippet(null), null);
  });

  it("preserves mark tags", () => {
    assert.equal(sanitizeSnippet("hello <mark>world</mark>"), "hello <mark>world</mark>");
  });

  it("strips non-mark HTML tags", () => {
    assert.equal(
      sanitizeSnippet('<script>alert("xss")</script>safe text'),
      "alert(&quot;xss&quot;)safe text",
    );
  });

  it("escapes angle brackets in text content", () => {
    assert.equal(sanitizeSnippet("a < b > c"), "a &lt; b &gt; c");
  });

  it("handles mixed mark and malicious tags", () => {
    const input = '<mark>good</mark><img onerror="evil">bad<mark>also good</mark>';
    const result = sanitizeSnippet(input);
    assert.ok(result.includes("<mark>good</mark>"));
    assert.ok(result.includes("<mark>also good</mark>"));
    assert.ok(!result.includes("<img"));
    assert.ok(!result.includes("onerror"));
  });

  it("escapes ampersands in text", () => {
    assert.equal(sanitizeSnippet("Tom & Jerry"), "Tom &amp; Jerry");
  });
});

// ---------------------------------------------------------------------------
// Search integration (SessionDB)
// ---------------------------------------------------------------------------

describe("SessionDB search", () => {
  let tempDir;
  let db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-search-test-"));
    db = new SessionDB(join(tempDir, "sessions.db"), noopLogger);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("basic search", () => {
    it("returns results matching title", () => {
      db.upsert(makeRow({ name: "routing architecture discussion" }));
      db.syncSearchIndexForInstance("inst-1");
      const results = db.search("routing");
      assert.equal(results.length, 1);
      assert.equal(results[0].instanceId, "inst-1");
      assert.equal(results[0].matchField, "title");
    });

    it("returns results matching summary", () => {
      db.upsert(makeRow({ summary: "Discussed FTS5 indexing strategies for the search feature" }));
      db.syncSearchIndexForInstance("inst-1");
      const results = db.search("FTS5");
      assert.equal(results.length, 1);
      assert.equal(results[0].matchField, "summary");
    });

    it("returns results matching last_message_text", () => {
      db.upsert(
        makeRow({ last_message_text: "The websocket reconnection logic needs a backoff strategy" }),
      );
      db.syncSearchIndexForInstance("inst-1");
      const results = db.search("websocket");
      assert.equal(results.length, 1);
      assert.equal(results[0].matchField, "message");
    });

    it("returns results matching transcript_content", () => {
      db.upsert(makeRow());
      db.updateSearchContent(
        "inst-1",
        "We should implement cursor-based pagination for the chat history endpoint to handle large transcripts efficiently",
      );
      db.syncSearchIndexForInstance("inst-1");
      const results = db.search("pagination");
      assert.equal(results.length, 1);
      assert.equal(results[0].matchField, "transcript");
    });

    it("finds chats by task reference in the search index", () => {
      db.upsert(makeRow({ project_id: "proj-1" }));
      db.updateSearchContent("inst-1", "@task:a1b2c3d4:Fix%20login ");
      db.syncSearchIndexForInstance("inst-1");

      const results = db.search("@task:a1b2c3d4", { projectId: "proj-1" });
      assert.equal(results.length, 1);
      assert.equal(results[0].instanceId, "inst-1");
      assert.equal(results[0].matchField, "transcript");
    });

    it("returns results matching git_branch", () => {
      db.upsert(makeRow({ git_branch: "feature/search-v1" }));
      db.syncSearchIndexForInstance("inst-1");
      const results = db.search("search-v1");
      assert.equal(results.length, 1);
    });

    it("returns empty for no match", () => {
      db.upsert(makeRow());
      db.syncSearchIndexForInstance("inst-1");
      const results = db.search("nonexistentterm");
      assert.equal(results.length, 0);
    });

    it("returns empty for empty query", () => {
      db.upsert(makeRow({ name: "test" }));
      db.syncSearchIndexForInstance("inst-1");
      assert.equal(db.search("").length, 0);
      assert.equal(db.search("   ").length, 0);
    });
  });

  describe("prefix matching", () => {
    it("prefix-matches the last token while typing", () => {
      db.upsert(makeRow({ name: "routing architecture discussion" }));
      db.syncSearchIndexForInstance("inst-1");
      assert.equal(db.search("rout").length, 1);
      assert.equal(db.search("architecture rout").length, 1);
    });

    it("matches the last token exactly when followed by trailing whitespace", () => {
      db.upsert(makeRow({ name: "routing architecture discussion" }));
      db.syncSearchIndexForInstance("inst-1");
      assert.equal(db.search("rout ").length, 0);
      assert.equal(db.search("routing ").length, 1);
    });
  });

  describe("OR fallback", () => {
    it("falls back to OR matching when no chat matches all terms", () => {
      db.upsert(
        makeRow({
          session_id: "s1",
          instance_id: "i1",
          jsonl_path: "/a.jsonl",
          name: "auth refactor",
        }),
      );
      db.upsert(
        makeRow({
          session_id: "s2",
          instance_id: "i2",
          jsonl_path: "/b.jsonl",
          name: "billing overhaul",
        }),
      );
      db.syncSearchIndexForInstance("i1");
      db.syncSearchIndexForInstance("i2");

      const results = db.search("auth billing");
      assert.equal(results.length, 2);
      assert.ok(results.every((r) => r.partial === true));
    });

    it("does not flag results as partial when all terms match", () => {
      db.upsert(makeRow({ name: "auth refactor discussion" }));
      db.syncSearchIndexForInstance("inst-1");
      const results = db.search("auth refactor");
      assert.equal(results.length, 1);
      assert.ok(!results[0].partial);
    });

    it("does not fall back for single-token queries", () => {
      db.upsert(makeRow({ name: "auth refactor" }));
      db.syncSearchIndexForInstance("inst-1");
      assert.equal(db.search("billing").length, 0);
    });
  });

  describe("project boost", () => {
    it("ranks the boosted project's results first in global search", () => {
      const now = Date.now();
      db.upsert(
        makeRow({
          session_id: "s1",
          instance_id: "i1",
          jsonl_path: "/a.jsonl",
          name: "auth refactor",
          project_id: "proj-1",
          last_activity_at: now,
        }),
      );
      db.upsert(
        makeRow({
          session_id: "s2",
          instance_id: "i2",
          jsonl_path: "/b.jsonl",
          name: "auth refactor",
          project_id: "proj-2",
          last_activity_at: now,
        }),
      );
      db.syncSearchIndexForInstance("i1");
      db.syncSearchIndexForInstance("i2");

      const boosted = db.search("auth", { boostProjectId: "proj-2" });
      assert.equal(boosted.length, 2);
      assert.equal(boosted[0].instanceId, "i2");

      const boostedOther = db.search("auth", { boostProjectId: "proj-1" });
      assert.equal(boostedOther[0].instanceId, "i1");
    });

    it("does not boost projectless rows when no boost project is given", () => {
      const now = Date.now();
      db.upsert(
        makeRow({
          session_id: "s1",
          instance_id: "i1",
          jsonl_path: "/a.jsonl",
          name: "auth refactor",
          project_id: null,
          last_activity_at: now - 1000,
        }),
      );
      db.upsert(
        makeRow({
          session_id: "s2",
          instance_id: "i2",
          jsonl_path: "/b.jsonl",
          name: "auth refactor",
          project_id: "proj-1",
          last_activity_at: now,
        }),
      );
      db.syncSearchIndexForInstance("i1");
      db.syncSearchIndexForInstance("i2");

      const results = db.search("auth");
      assert.equal(results.length, 2);
      assert.equal(results[0].instanceId, "i2");
    });
  });

  describe("field weighting", () => {
    it("ranks title matches above transcript matches", () => {
      const now = Date.now();
      db.upsert(
        makeRow({
          session_id: "s-title",
          instance_id: "i-title",
          jsonl_path: "/t.jsonl",
          name: "deployment pipeline setup",
          last_activity_at: now,
        }),
      );
      db.upsert(
        makeRow({
          session_id: "s-body",
          instance_id: "i-body",
          jsonl_path: "/b.jsonl",
          name: "unrelated chat",
          last_activity_at: now,
        }),
      );
      db.updateSearchContent(
        "i-body",
        "We briefly touched on the deployment process during this conversation about other things",
      );
      db.syncSearchIndexForInstance("i-title");
      db.syncSearchIndexForInstance("i-body");

      const results = db.search("deployment");
      assert.equal(results.length, 2);
      assert.equal(results[0].instanceId, "i-title", "title match should rank first");
    });
  });

  describe("recentChats", () => {
    it("returns chats ordered by recency", () => {
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        db.upsert(
          makeRow({
            session_id: `s${i}`,
            instance_id: `i${i}`,
            jsonl_path: `/p${i}.jsonl`,
            name: `chat ${i}`,
            last_activity_at: now - i * 60_000,
          }),
        );
        db.syncSearchIndexForInstance(`i${i}`);
      }
      const results = db.recentChats();
      assert.equal(results.length, 3);
      assert.deepEqual(
        results.map((r) => r.instanceId),
        ["i0", "i1", "i2"],
      );
      assert.equal(results[0].snippet, null);
      assert.equal(results[0].matchField, null);
    });

    it("filters by project and respects limit", () => {
      const now = Date.now();
      for (let i = 0; i < 4; i++) {
        db.upsert(
          makeRow({
            session_id: `s${i}`,
            instance_id: `i${i}`,
            jsonl_path: `/p${i}.jsonl`,
            name: `chat ${i}`,
            project_id: i % 2 === 0 ? "proj-a" : "proj-b",
            last_activity_at: now - i * 60_000,
          }),
        );
        db.syncSearchIndexForInstance(`i${i}`);
      }
      const projectResults = db.recentChats({ projectId: "proj-a" });
      assert.deepEqual(
        projectResults.map((r) => r.instanceId),
        ["i0", "i2"],
      );
      assert.equal(db.recentChats({ limit: 2 }).length, 2);
    });

    it("excludes archived chats", () => {
      db.upsert(makeRow({ name: "some chat" }));
      db.syncSearchIndexForInstance("inst-1");
      assert.equal(db.recentChats().length, 1);
      db.archive("sess-1");
      assert.equal(db.recentChats().length, 0);
    });

    it("floats pinned chats to the top, and setPinned resyncs the index", () => {
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        db.upsert(
          makeRow({
            session_id: `s${i}`,
            instance_id: `i${i}`,
            jsonl_path: `/p${i}.jsonl`,
            name: `chat ${i}`,
            last_activity_at: now - i * 60_000,
          }),
        );
        db.syncSearchIndexForInstance(`i${i}`);
      }
      db.setPinned("i2", true);
      assert.deepEqual(
        db.recentChats().map((r) => r.instanceId),
        ["i2", "i0", "i1"],
      );
      db.setPinned("i2", false);
      assert.deepEqual(
        db.recentChats().map((r) => r.instanceId),
        ["i0", "i1", "i2"],
      );
    });

    it("orders by max(last_message_at, last_activity_at), matching inbox recency", () => {
      const now = Date.now();
      // i1: tool-only activity bumped last_activity_at past its last message
      db.upsert(
        makeRow({
          session_id: "s1",
          instance_id: "i1",
          jsonl_path: "/a.jsonl",
          name: "bumped by activity only",
          last_activity_at: now,
          last_message_at: now - 120_000,
        }),
      );
      db.upsert(
        makeRow({
          session_id: "s2",
          instance_id: "i2",
          jsonl_path: "/b.jsonl",
          name: "recent message",
          last_activity_at: now - 60_000,
          last_message_at: now - 60_000,
        }),
      );
      db.syncSearchIndexForInstance("i1");
      db.syncSearchIndexForInstance("i2");
      const results = db.recentChats();
      assert.deepEqual(
        results.map((r) => r.instanceId),
        ["i1", "i2"],
      );
    });
  });

  describe("project scoping", () => {
    it("returns only results for the specified project", () => {
      db.upsert(
        makeRow({
          session_id: "s1",
          instance_id: "i1",
          jsonl_path: "/a.jsonl",
          name: "auth refactor",
          project_id: "proj-1",
        }),
      );
      db.upsert(
        makeRow({
          session_id: "s2",
          instance_id: "i2",
          jsonl_path: "/b.jsonl",
          name: "auth migration",
          project_id: "proj-2",
        }),
      );
      db.syncSearchIndexForInstance("i1");
      db.syncSearchIndexForInstance("i2");

      const scoped = db.search("auth", { projectId: "proj-1" });
      assert.equal(scoped.length, 1);
      assert.equal(scoped[0].instanceId, "i1");

      const global = db.search("auth");
      assert.equal(global.length, 2);
    });
  });

  describe("archived exclusion", () => {
    it("excludes archived sessions from results", () => {
      db.upsert(makeRow({ name: "important discussion about caching" }));
      db.syncSearchIndexForInstance("inst-1");

      assert.equal(db.search("caching").length, 1);

      db.archive("sess-1");
      assert.equal(db.search("caching").length, 0);
    });

    it("re-includes unarchived sessions", () => {
      db.upsert(makeRow({ name: "important discussion about caching" }));
      db.syncSearchIndexForInstance("inst-1");
      db.archive("sess-1");
      assert.equal(db.search("caching").length, 0);

      db.unarchive("sess-1");
      assert.equal(db.search("caching").length, 1);
    });
  });

  describe("limit", () => {
    it("respects the limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        db.upsert(
          makeRow({
            session_id: `s${i}`,
            instance_id: `i${i}`,
            jsonl_path: `/p${i}.jsonl`,
            name: `database migration task ${i}`,
          }),
        );
        db.syncSearchIndexForInstance(`i${i}`);
      }
      const results = db.search("database", { limit: 2 });
      assert.equal(results.length, 2);
    });
  });

  describe("managed vs session preference", () => {
    it("indexes managed row when both exist for same instance", () => {
      db.upsert(makeRow({ instance_id: "shared-1", name: "session version" }));
      db.upsertManaged(
        makeManagedRow({
          instance_id: "shared-1",
          name: "managed version with authentication details",
        }),
      );
      db.syncSearchIndexForInstance("shared-1");

      const results = db.search("authentication");
      assert.equal(results.length, 1);
      assert.equal(results[0].source, "managed");
    });

    it("falls back to session row when managed is archived", () => {
      db.upsert(makeRow({ instance_id: "shared-1", name: "session with middleware discussion" }));
      db.upsertManaged(
        makeManagedRow({
          instance_id: "shared-1",
          name: "managed version",
          archived: 1,
        }),
      );
      db.syncSearchIndexForInstance("shared-1");

      const results = db.search("middleware");
      assert.equal(results.length, 1);
      assert.equal(results[0].source, "session");
    });
  });

  describe("account (accountId) on results", () => {
    const DEFAULT_DIR = "/home/me/.claude";
    const WORK_DIR = "/home/me/.claude-work";
    const CODEX_WORK_DIR = "/home/me/.codex-work";
    /** Minimal `AccountStore.findForLogin` stand-in. */
    const accounts = {
      findForLogin(provider, configDir) {
        const dirs = {
          claude: { [DEFAULT_DIR]: "default", [WORK_DIR]: "work" },
          codex: { "/home/me/.codex": "default", [CODEX_WORK_DIR]: "work" },
        };
        const id = dirs[provider]?.[configDir];
        return id ? { id, label: id, logins: {} } : undefined;
      },
    };

    it("managed rows report their stored account_id; default rows carry none", () => {
      db.upsertManaged(
        makeManagedRow({
          instance_id: "m-work",
          provider_name: "claude",
          name: "work account deployment notes",
          config_dir: WORK_DIR,
          account_id: "work",
        }),
      );
      db.upsertManaged(
        makeManagedRow({
          instance_id: "m-default",
          provider_name: "claude",
          name: "default account deployment notes",
          config_dir: null,
          account_id: null,
        }),
      );
      db.upsertManaged(
        makeManagedRow({
          instance_id: "m-explicit-default",
          provider_name: "codex",
          name: "explicit default deployment notes",
          account_id: "default",
        }),
      );
      for (const id of ["m-work", "m-default", "m-explicit-default"])
        db.syncSearchIndexForInstance(id);

      const results = db.search("deployment", { accounts });
      const byId = new Map(results.map((r) => [r.instanceId, r]));
      assert.equal(byId.get("m-work").accountId, "work");
      assert.equal("accountId" in byId.get("m-default"), false);
      assert.equal("accountId" in byId.get("m-explicit-default"), false);
      assert.equal("configDir" in byId.get("m-work"), false, "the dir is no longer on the wire");

      // The stored account is reported even without an account lookup.
      const bare = db.search("deployment");
      assert.equal(bare.find((r) => r.instanceId === "m-work").accountId, "work");
      assert.equal(bare.find((r) => r.instanceId === "m-default").accountId, undefined);
    });

    it("managed rows written before accounts carried an id resolve it from their bound login", () => {
      db.upsertManaged(
        makeManagedRow({
          instance_id: "m-legacy-work",
          provider_name: "claude",
          name: "legacy work rollout plan",
          config_dir: WORK_DIR,
          account_id: null,
        }),
      );
      db.upsertManaged(
        makeManagedRow({
          instance_id: "m-legacy-default",
          provider_name: "claude",
          name: "legacy default rollout plan",
          config_dir: DEFAULT_DIR,
          account_id: null,
        }),
      );
      db.upsertManaged(
        makeManagedRow({
          instance_id: "m-legacy-gone",
          provider_name: "claude",
          name: "legacy orphan rollout plan",
          config_dir: "/home/me/.claude-gone",
          account_id: null,
        }),
      );
      for (const id of ["m-legacy-work", "m-legacy-default", "m-legacy-gone"])
        db.syncSearchIndexForInstance(id);

      const byId = new Map(db.search("rollout", { accounts }).map((r) => [r.instanceId, r]));
      assert.equal(byId.get("m-legacy-work").accountId, "work");
      assert.equal(byId.get("m-legacy-default").accountId, undefined, "own dir = default");
      assert.equal(byId.get("m-legacy-gone").accountId, undefined, "unregistered dir: no guess");

      // Without the lookup nothing can name the account — never guessed from the dir.
      assert.equal(
        db.search("rollout").find((r) => r.instanceId === "m-legacy-work").accountId,
        undefined,
      );
    });

    it("external rows resolve the account from (provider, transcript root)", () => {
      const rows = [
        ["work", "claude", `${WORK_DIR}/projects/-tmp-test/s-work.jsonl`],
        ["default", "claude", `${DEFAULT_DIR}/projects/-tmp-test/s-default.jsonl`],
        ["codex", "codex", "/home/me/.codex/sessions/2026/09/30/rollout-s-codex.jsonl"],
        ["codex-work", "codex", `${CODEX_WORK_DIR}/sessions/2026/09/30/rollout-s-codex-work.jsonl`],
        // A root no account owns: no accountId rather than a guess.
        ["orphan", "claude", "/home/me/.claude-gone/projects/-tmp-test/s-orphan.jsonl"],
      ];
      for (const [key, provider, jsonlPath] of rows) {
        db.upsert(
          makeRow({
            session_id: `s-${key}`,
            instance_id: `i-${key}`,
            provider_name: provider,
            name: `${key} migration plan`,
            jsonl_path: jsonlPath,
          }),
        );
        db.syncSearchIndexForInstance(`i-${key}`);
      }

      const results = db.search("migration", { accounts });
      const byId = new Map(results.map((r) => [r.instanceId, r]));
      assert.equal(results.length, 5);
      assert.equal(byId.get("i-work").accountId, "work");
      assert.equal(byId.get("i-codex-work").accountId, "work");
      assert.equal(byId.get("i-default").accountId, undefined);
      assert.equal(byId.get("i-codex").accountId, undefined);
      assert.equal(byId.get("i-orphan").accountId, undefined);

      // recentChats carries the same field.
      const recent = db.recentChats({ accounts });
      assert.equal(recent.find((r) => r.instanceId === "i-work").accountId, "work");
      assert.equal(recent.find((r) => r.instanceId === "i-default").accountId, undefined);

      // Without an account lookup an external root can't be resolved: no accountId.
      assert.equal(
        db.search("migration").find((r) => r.instanceId === "i-work").accountId,
        undefined,
      );
    });
  });

  describe("account scoping (loginRoots) inside the query", () => {
    const DEFAULT_DIR = "/home/me/.claude";
    const WORK_DIR = "/home/me/.claude-work";
    const CODEX_DIR = "/home/me/.codex";
    const CODEX_WORK_DIR = "/home/me/.codex-work";
    const accountList = [
      {
        id: "default",
        label: "Default",
        logins: { claude: { configDir: DEFAULT_DIR }, codex: { configDir: CODEX_DIR } },
      },
      {
        id: "work",
        label: "Work",
        logins: { claude: { configDir: WORK_DIR }, codex: { configDir: CODEX_WORK_DIR } },
      },
    ];
    const accounts = {
      findForLogin(provider, configDir) {
        return accountList.find((a) => a.logins[provider]?.configDir === configDir);
      },
    };
    const workFilter = () => accountLoginRootFilter(accountList, "work");
    const defaultFilter = () => accountLoginRootFilter(accountList, "default");

    /** A DB that knows the server's own dirs, like the one InstanceManager builds. */
    function openScopedDb() {
      db.close();
      db = new SessionDB(join(tempDir, "sessions.db"), noopLogger, {
        defaultLoginRoots: { claude: DEFAULT_DIR, codex: CODEX_DIR },
      });
    }

    function loginRootOf(instanceId) {
      const row = db.db
        .prepare("SELECT provider, login_root FROM search_index WHERE instance_id = ?")
        .get(instanceId);
      return row ? { provider: row.provider, login_root: row.login_root } : undefined;
    }

    it("files every doc under its (provider, login root)", () => {
      openScopedDb();
      db.upsertManaged(
        makeManagedRow({
          instance_id: "m-work",
          provider_name: "claude",
          config_dir: `${WORK_DIR}/`,
        }),
      );
      db.upsertManaged(
        makeManagedRow({ instance_id: "m-unbound", provider_name: "codex", config_dir: null }),
      );
      db.upsert(
        makeRow({
          session_id: "s-ext-work",
          instance_id: "i-ext-work",
          provider_name: "claude",
          jsonl_path: `${WORK_DIR}/projects/-tmp-test/s-ext-work.jsonl`,
        }),
      );
      db.upsert(
        makeRow({
          session_id: "s-ext-bare",
          instance_id: "i-ext-bare",
          provider_name: "codex",
          // No root marker in the path: falls back to the server's own dir.
          jsonl_path: "/tmp/rollout-bare.jsonl",
        }),
      );
      for (const id of ["m-work", "m-unbound", "i-ext-work", "i-ext-bare"])
        db.syncSearchIndexForInstance(id);

      assert.deepEqual(loginRootOf("m-work"), { provider: "claude", login_root: WORK_DIR });
      assert.deepEqual(loginRootOf("m-unbound"), { provider: "codex", login_root: CODEX_DIR });
      assert.deepEqual(loginRootOf("i-ext-work"), { provider: "claude", login_root: WORK_DIR });
      assert.deepEqual(loginRootOf("i-ext-bare"), { provider: "codex", login_root: CODEX_DIR });
    });

    it("returns another account's chats even when the default account's recent chats outrank them", () => {
      openScopedDb();
      const now = Date.now();
      // 25 fresh default-account chats: more than the limit, all ranking first
      // (the work chats are months old, so recency decay sinks them).
      const monthsAgo = 90 * 24 * 60 * 60 * 1000;
      for (let i = 0; i < 25; i++) {
        db.upsertManaged(
          makeManagedRow({
            instance_id: `m-personal-${i}`,
            provider_name: "claude",
            name: `personal deployment checklist ${i}`,
            config_dir: null,
            account_id: null,
            last_activity_at: now - i * 1000,
          }),
        );
        db.syncSearchIndexForInstance(`m-personal-${i}`);
      }
      db.upsertManaged(
        makeManagedRow({
          instance_id: "m-work-managed",
          provider_name: "claude",
          name: "work deployment checklist",
          config_dir: WORK_DIR,
          account_id: "work",
          last_activity_at: now - monthsAgo,
        }),
      );
      db.upsert(
        makeRow({
          session_id: "s-work-ext",
          instance_id: "i-work-ext",
          provider_name: "codex",
          name: "work codex deployment checklist",
          jsonl_path: `${CODEX_WORK_DIR}/sessions/2026/09/30/rollout-s-work-ext.jsonl`,
          last_activity_at: now - monthsAgo,
        }),
      );
      db.syncSearchIndexForInstance("m-work-managed");
      db.syncSearchIndexForInstance("i-work-ext");

      // Unfiltered: the top 20 are all personal — the finding.
      const unfiltered = db.search("deployment", { accounts, limit: 20 });
      assert.equal(unfiltered.length, 20);
      assert.ok(unfiltered.every((r) => r.instanceId.startsWith("m-personal-")));

      // Scoped to Work: both work chats, nothing else, still carrying accountId.
      const work = db.search("deployment", { accounts, limit: 20, loginRoots: workFilter() });
      assert.deepEqual(work.map((r) => r.instanceId).sort(), ["i-work-ext", "m-work-managed"]);
      assert.ok(work.every((r) => r.accountId === "work"));

      // Scoped to Default: only personal chats (still capped at the limit).
      const dflt = db.search("deployment", { accounts, limit: 20, loginRoots: defaultFilter() });
      assert.equal(dflt.length, 20);
      assert.ok(dflt.every((r) => r.instanceId.startsWith("m-personal-")));

      // recentChats (empty query) is scoped the same way.
      const recentWork = db.recentChats({ accounts, limit: 20, loginRoots: workFilter() });
      assert.deepEqual(recentWork.map((r) => r.instanceId).sort(), [
        "i-work-ext",
        "m-work-managed",
      ]);
      const recentDefault = db.recentChats({ accounts, limit: 20, loginRoots: defaultFilter() });
      assert.ok(recentDefault.every((r) => r.instanceId.startsWith("m-personal-")));

      // Project scoping composes with the account filter.
      db.upsertManaged(
        makeManagedRow({
          instance_id: "m-work-proj",
          provider_name: "claude",
          name: "work deployment in project",
          config_dir: WORK_DIR,
          account_id: "work",
          project_id: "proj-1",
        }),
      );
      db.syncSearchIndexForInstance("m-work-proj");
      const inProject = db.search("deployment", {
        accounts,
        projectId: "proj-1",
        loginRoots: workFilter(),
      });
      assert.deepEqual(
        inProject.map((r) => r.instanceId),
        ["m-work-proj"],
      );
      assert.deepEqual(db.recentChats({ projectId: "proj-1", loginRoots: defaultFilter() }), []);
    });

    it("the default account keeps chats under roots no account registers", () => {
      openScopedDb();
      db.upsert(
        makeRow({
          session_id: "s-orphan",
          instance_id: "i-orphan",
          provider_name: "claude",
          name: "orphan root retrospective",
          jsonl_path: "/home/me/.claude-gone/projects/-tmp-test/s-orphan.jsonl",
        }),
      );
      db.syncSearchIndexForInstance("i-orphan");
      assert.equal(db.search("retrospective", { loginRoots: defaultFilter() }).length, 1);
      assert.equal(db.search("retrospective", { loginRoots: workFilter() }).length, 0);
    });

    it("no accountId means no filter, and unknown ids are ignored", () => {
      assert.equal(accountLoginRootFilter(accountList, undefined), undefined);
      assert.equal(accountLoginRootFilter(accountList, ""), undefined);
      assert.equal(accountLoginRootFilter(accountList, "nobody"), undefined);
      assert.deepEqual(accountLoginRootFilter(accountList, "work"), {
        mode: "include",
        roots: [
          { provider: "claude", root: WORK_DIR },
          { provider: "codex", root: CODEX_WORK_DIR },
        ],
      });
      assert.deepEqual(accountLoginRootFilter(accountList, "default"), {
        mode: "exclude",
        roots: [
          { provider: "claude", root: WORK_DIR },
          { provider: "codex", root: CODEX_WORK_DIR },
        ],
      });
      // A lone default account excludes nothing: every chat is visible.
      assert.deepEqual(accountLoginRootFilter([accountList[0]], "default"), {
        mode: "exclude",
        roots: [],
      });

      openScopedDb();
      db.upsertManaged(
        makeManagedRow({
          instance_id: "m-a",
          provider_name: "claude",
          name: "alpha notes",
          config_dir: WORK_DIR,
        }),
      );
      db.upsertManaged(
        makeManagedRow({
          instance_id: "m-b",
          provider_name: "claude",
          name: "beta notes",
          config_dir: null,
        }),
      );
      db.syncSearchIndexForInstance("m-a");
      db.syncSearchIndexForInstance("m-b");
      assert.equal(db.search("notes").length, 2);
      assert.equal(db.search("notes", { loginRoots: undefined }).length, 2);
      assert.equal(db.search("notes", { loginRoots: { mode: "exclude", roots: [] } }).length, 2);
      // An account with no logins at all matches nothing rather than everything.
      assert.equal(db.search("notes", { loginRoots: { mode: "include", roots: [] } }).length, 0);
      assert.equal(db.recentChats({ loginRoots: { mode: "include", roots: [] } }).length, 0);
    });

    it("adding the login_root column migrates an older index on open", () => {
      db.upsertManaged(makeManagedRow({ instance_id: "m-old", name: "legacy index migration" }));
      db.syncSearchIndexForInstance("m-old");
      db.close();

      // Recreate the FTS table in its pre-`login_root` shape.
      const raw = new DatabaseSync(join(tempDir, "sessions.db"));
      raw.exec(`
        DROP TABLE search_index;
        DROP TABLE search_index_docs;
        CREATE VIRTUAL TABLE search_index USING fts5(
          instance_id UNINDEXED, source UNINDEXED, project_id UNINDEXED, space_id UNINDEXED,
          last_activity_at UNINDEXED, last_message_at UNINDEXED, created_at UNINDEXED,
          archived UNINDEXED, pinned UNINDEXED,
          title, summary, first_prompt, last_message_text, git_branch, transcript_content,
          tokenize='unicode61'
        );
      `);
      raw.close();

      db = new SessionDB(join(tempDir, "sessions.db"), noopLogger, {
        defaultLoginRoots: { claude: DEFAULT_DIR, codex: CODEX_DIR },
      });
      const columns = db.db
        .prepare("PRAGMA table_info(search_index)")
        .all()
        .map((c) => c.name);
      assert.ok(columns.includes("login_root"), `columns: ${columns.join(", ")}`);
      assert.ok(columns.includes("provider"));
      // The startup path rebuilds the index; the migrated doc is filed under its root.
      db.rebuildSearchIndex();
      assert.deepEqual(loginRootOf("m-old"), { provider: "codex", login_root: CODEX_DIR });
      assert.equal(db.search("migration", { loginRoots: defaultFilter() }).length, 1);
    });
  });

  describe("rebuildSearchIndex", () => {
    it("rebuilds from all active sessions and managed instances", () => {
      db.upsert(
        makeRow({
          session_id: "s1",
          instance_id: "i1",
          jsonl_path: "/a.jsonl",
          name: "graphql schema design",
        }),
      );
      db.upsert(
        makeRow({
          session_id: "s2",
          instance_id: "i2",
          jsonl_path: "/b.jsonl",
          name: "websocket reconnection",
          archived: 1,
        }),
      );
      db.upsertManaged(
        makeManagedRow({
          instance_id: "i3",
          name: "kubernetes deployment config",
        }),
      );

      db.rebuildSearchIndex();

      assert.equal(db.search("graphql").length, 1);
      assert.equal(db.search("websocket").length, 0); // archived
      assert.equal(db.search("kubernetes").length, 1);
    });

    it("preserves search_content through rebuild", () => {
      db.upsert(makeRow({ name: "test session" }));
      db.updateSearchContent(
        "inst-1",
        "This session discussed the migration strategy for moving from REST to GraphQL with a phased approach",
      );
      db.rebuildSearchIndex();

      const results = db.search("migration");
      assert.equal(results.length, 1);
      assert.equal(results[0].matchField, "transcript");
    });
  });

  describe("snippet sanitization in results", () => {
    it("returns sanitized snippets without injected HTML", () => {
      db.upsert(
        makeRow({
          last_message_text: 'Check the <script>alert("xss")</script> endpoint',
        }),
      );
      db.syncSearchIndexForInstance("inst-1");
      const results = db.search("endpoint");
      assert.equal(results.length, 1);
      if (results[0].snippet) {
        assert.ok(!results[0].snippet.includes("<script>"));
      }
    });
  });

  describe("recency weighting", () => {
    it("ranks recent results higher than old ones with same relevance", () => {
      const now = Date.now();
      db.upsert(
        makeRow({
          session_id: "old",
          instance_id: "i-old",
          jsonl_path: "/old.jsonl",
          name: "terraform infrastructure review",
          last_activity_at: now - 90 * 24 * 60 * 60 * 1000, // 90 days ago
        }),
      );
      db.upsert(
        makeRow({
          session_id: "new",
          instance_id: "i-new",
          jsonl_path: "/new.jsonl",
          name: "terraform infrastructure review",
          last_activity_at: now, // now
        }),
      );
      db.syncSearchIndexForInstance("i-old");
      db.syncSearchIndexForInstance("i-new");

      const results = db.search("terraform");
      assert.equal(results.length, 2);
      assert.equal(results[0].instanceId, "i-new", "recent result should rank first");
    });
  });

  describe("incremental sync", () => {
    it("replaces an instance's doc instead of duplicating it, across reopen", () => {
      db.upsert(makeRow({ name: "original quokka title" }));
      db.syncSearchIndexForInstance("inst-1");
      db.close();
      db = new SessionDB(join(tempDir, "sessions.db"), noopLogger);

      db.updateName("sess-1", "renamed wombat title", true);
      assert.equal(db.search("quokka").length, 0, "stale doc should be deleted by rowid");
      const results = db.search("wombat");
      assert.equal(results.length, 1);
      assert.equal(results[0].instanceId, "inst-1");
    });

    it("tracks which transcript state stored search text came from", () => {
      db.updateSearchContent("inst-1", "text", "1:/tmp/a.jsonl:100:5");
      assert.equal(db.hasSearchContentForSource("inst-1", "1:/tmp/a.jsonl:100:5"), true);
      assert.equal(db.hasSearchContentForSource("inst-1", "1:/tmp/a.jsonl:200:5"), false);

      db.updateSearchContent("inst-1", "text from memory");
      assert.equal(db.hasSearchContentForSource("inst-1", "1:/tmp/a.jsonl:100:5"), false);
    });
  });
});
