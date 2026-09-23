// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { resolveConfig } from "../dist/server/config.js";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

const fixturesDir = join(import.meta.dirname, "fixtures");

function makeManager(tempDir) {
  return new InstanceManager(
    resolveConfig({
      password: "test",
      logger: noopLogger,
      maxProcesses: 20,
      dbPath: join(tempDir, "sessions.db"),
      providerDirs: {
        claude: join(tempDir, ".claude"),
        codex: join(tempDir, ".codex"),
      },
    }),
  );
}

describe("History Conversion", () => {
  let tempDir;
  let manager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-history-conversion-test-"));
    manager = makeManager(tempDir);
  });

  afterEach(() => {
    manager.stopAll();
  });

  it("reuses parsed transcript results across repeated cold parses", () => {
    const transcriptPath = join(fixturesDir, "basic-session.jsonl");

    const first = manager["parseProviderTranscriptCached"]("claude", transcriptPath);
    const second = manager["parseProviderTranscriptCached"]("claude", transcriptPath);

    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.notStrictEqual(first.parsed.history, second.parsed.history);
    assert.deepEqual(second.parsed.history, first.parsed.history);
  });

  it("restores user and assistant messages from JSONL", () => {
    const parsed = manager["parseJsonl"](join(fixturesDir, "basic-session.jsonl"));
    const userMessages = parsed.history.filter((entry) => entry.message.type === "user");
    const outputMessages = parsed.history.filter(
      (entry) => entry.message.type === "output" && entry.message.text && !entry.message.isWaiting,
    );

    assert.ok(userMessages.length >= 2);
    assert.equal(userMessages[0].message.text, "Hello, can you help me with this project?");
    assert.ok(outputMessages.length >= 1);
  });

  it("marks injected task-context prompts as internal during transcript replay", () => {
    const jsonlPath = join(tempDir, "internal-task-context.jsonl");
    writeFileSync(
      jsonlPath,
      [
        JSON.stringify({
          type: "system",
          subtype: "init",
          cwd: "/Users/test/.relay/worktrees/space-262013e4",
          timestamp: "2026-03-19T23:10:30.700Z",
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-03-19T23:10:30.791Z",
          message: {
            role: "user",
            content:
              "This project tracks tasks in .relay/tasks.json (Relay-managed snapshot JSON). Do not create a task for every request. Create a task only when explicitly asked, pick up an existing task when explicitly asked or when the request clearly matches one, and otherwise just do the work without creating a new task. Ask if unsure whether a request should map to a task. Fields: id (8-char hex), title, description (markdown), status (open|in_progress|done), priority (0-4), type (epic|task|bug), tags (string[]), parent (nullable task ID), blockedBy (task ID[]), createdAt, updatedAt (ISO timestamps). Blocked status is auto-derived from unresolved blockedBy refs. When asked to pick up a task (e.g. 'pick up task a1b2c3d4'), read .relay/tasks.json to find it.",
          },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-03-19T23:10:36.872Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Ready to help! What would you like to work on?" }],
          },
        }),
      ].join("\n"),
    );

    const parsed = manager["parseJsonl"](jsonlPath);
    const injected = parsed.history.find(
      (entry) =>
        entry.message.type === "user" &&
        entry.message.text.startsWith("This project tracks tasks in .relay/tasks.json"),
    );

    assert.ok(injected);
    assert.equal(injected?.message.internal, true);
  });

  it("extracts timestamps from JSONL entries", () => {
    const parsed = manager["parseJsonl"](join(fixturesDir, "basic-session.jsonl"));

    for (const entry of parsed.history) {
      assert.equal(typeof entry.timestamp, "number");
      assert.ok(!Number.isNaN(entry.timestamp));
      assert.ok(entry.timestamp > 0);
    }
  });

  it("converts JSONL init entries into session_init system events", () => {
    const parsed = manager["parseJsonl"](join(fixturesDir, "basic-session.jsonl"));
    const initEvent = parsed.history.find(
      (entry) => entry.message.type === "system_event" && entry.message.event === "session_init",
    );

    assert.ok(initEvent);
    assert.equal(initEvent?.message.payload?.cwd, "/Users/test/projects/my-app");
    assert.equal(initEvent?.message.raw?.subtype, "init");
  });

  it("preserves history across compact boundaries and records the boundary", () => {
    const parsed = manager["parseJsonl"](join(fixturesDir, "compact-session.jsonl"));
    const texts = parsed.history
      .filter((entry) => entry.message.type === "user")
      .map((entry) => entry.message.text);
    const boundary = parsed.history.find(
      (entry) =>
        entry.message.type === "system_event" && entry.message.event === "compact_boundary",
    );

    assert.ok(texts.includes("First message before compact"));
    assert.ok(texts.includes("Second message after compact"));
    assert.equal(boundary?.message.type, "system_event");
    assert.equal(boundary?.message.event, "compact_boundary");
  });

  it("converts thinking, tool_use, and tool_result blocks to activity messages", () => {
    const parsed = manager["parseJsonl"](join(fixturesDir, "tool-use-session.jsonl"));
    const thinking = parsed.history.find(
      (entry) => entry.message.type === "activity" && entry.message.activity === "thinking",
    );
    const toolUse = parsed.history.find(
      (entry) => entry.message.type === "activity" && entry.message.activity === "tool_use",
    );
    const toolResult = parsed.history.find(
      (entry) => entry.message.type === "activity" && entry.message.activity === "tool_result",
    );

    assert.equal(thinking?.message.description, "Reasoning...");
    assert.equal(toolUse?.message.tool, "Bash");
    assert.equal(toolUse?.message.description, "Running command");
    assert.equal(toolResult?.message.description, "Tool completed");
  });

  it("detects permission denial in tool_result", () => {
    const parsed = manager["parseJsonl"](join(fixturesDir, "permission-denied-session.jsonl"));
    const denial = parsed.history.find(
      (entry) =>
        entry.message.type === "activity" &&
        entry.message.activity === "tool_result" &&
        entry.message.permissionDenied,
    );

    assert.ok(denial);
    assert.equal(denial.message.description, "Permission denied");
    assert.equal(denial.message.permissionDenied, "Bash");
  });

  it("strips system-reminder tags from user messages", () => {
    const parsed = manager["parseJsonl"](join(fixturesDir, "internal-tags-session.jsonl"));
    const userMessage = parsed.history.find((entry) => entry.message.type === "user");

    assert.ok(userMessage);
    assert.ok(!userMessage.message.text.includes("<system-reminder>"));
    assert.ok(userMessage.message.text.includes("Hello there!"));
  });

  it("converts image blocks to [Image: source: path] format", () => {
    const parsed = manager["parseJsonl"](join(fixturesDir, "image-session.jsonl"));
    const userMessage = parsed.history.find((entry) => entry.message.type === "user");

    assert.ok(userMessage);
    assert.ok(userMessage.message.text.includes("[Image: source: /Users/test/screenshot.png]"));
    assert.ok(userMessage.message.text.includes("What do you see in this image?"));
  });

  it("falls back to Date.now() for entries without timestamps", () => {
    const now = Date.now();
    const parsed = manager["parseJsonl"](join(fixturesDir, "no-timestamp-session.jsonl"));

    assert.ok(parsed.history.length > 0);
    for (const entry of parsed.history) {
      assert.ok(!Number.isNaN(entry.timestamp));
      assert.ok(Math.abs(now - entry.timestamp) < 5000);
    }
  });

  it("does not rebuild sidebar file changes for files outside the workspace", () => {
    const jsonlPath = join(tempDir, "outside-workspace-file.jsonl");
    writeFileSync(
      jsonlPath,
      [
        JSON.stringify({
          type: "system",
          subtype: "init",
          cwd: "/Users/test/projects/my-app",
          timestamp: "2026-02-10T10:00:00.000Z",
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-02-10T10:00:01.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool_1",
                name: "Edit",
                input: {
                  file_path: "/Users/test/.claude/plans/session-plan.md",
                  old_string: "old",
                  new_string: "new",
                },
              },
            ],
          },
        }),
      ].join("\n"),
    );

    const parsed = manager["parseJsonl"](jsonlPath);
    const fileLists = parsed.history.filter(
      (entry) => entry.message.type === "activity" && entry.message.activity === "file_list",
    );
    const toolUses = parsed.history.filter(
      (entry) =>
        entry.message.type === "activity" &&
        entry.message.activity === "tool_use" &&
        entry.message.tool === "Edit",
    );

    assert.equal(fileLists.length, 0);
    assert.equal(toolUses.length, 1);
  });

  it("skips malformed lines without crashing", () => {
    const jsonlPath = join(tempDir, "malformed.jsonl");
    writeFileSync(
      jsonlPath,
      [
        '{"type":"system","subtype":"init","cwd":"/tmp/test","timestamp":"2026-02-10T10:00:00.000Z"}',
        "this is not json",
        '{"type":"user","message":{"role":"user","content":"Hello"},"timestamp":"2026-02-10T10:00:01.000Z"}',
        "{incomplete json...",
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}]},"timestamp":"2026-02-10T10:00:02.000Z"}',
      ].join("\n"),
    );

    const parsed = manager["parseJsonl"](jsonlPath);
    const userMessages = parsed.history.filter((entry) => entry.message.type === "user");

    assert.ok(userMessages.length >= 1);
  });

  it("handles empty JSONL file", () => {
    const jsonlPath = join(tempDir, "empty.jsonl");
    writeFileSync(jsonlPath, "");

    const parsed = manager["parseJsonl"](jsonlPath);
    assert.equal(parsed.history.length, 0);
  });

  it("caps history at 1000 entries", () => {
    const jsonlPath = join(tempDir, "large.jsonl");
    const lines = [
      '{"type":"system","subtype":"init","cwd":"/tmp/test","timestamp":"2026-02-10T10:00:00.000Z"}',
    ];
    for (let i = 0; i < 600; i++) {
      lines.push(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: `Message ${i}` },
          timestamp: `2026-02-10T10:${String(i % 60).padStart(2, "0")}:${String(Math.floor(i / 60)).padStart(2, "0")}.000Z`,
        }),
      );
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: `Reply ${i}` }] },
          timestamp: `2026-02-10T10:${String(i % 60).padStart(2, "0")}:${String(Math.floor(i / 60)).padStart(2, "0")}.500Z`,
        }),
      );
    }
    writeFileSync(jsonlPath, lines.join("\n"));

    const parsed = manager["parseJsonl"](jsonlPath);
    assert.ok(parsed.history.length <= 1000);
  });
});
