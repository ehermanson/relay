import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  convertCodexTranscriptEntry,
  extractCodexConversationMessage,
  parseCodexTranscript,
  findCodexTranscriptPath,
} from "../dist/server/core/providers/codex-transcript.js";

function createContext() {
  return {
    pendingCalls: new Map(),
    tasks: new Map(),
    files: new Map(),
    cwd: "/tmp/project",
    stats: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
  };
}

describe("convertCodexTranscriptEntry", () => {
  describe("user messages", () => {
    it("converts event_msg user_message to UserMessage", () => {
      const ctx = createContext();
      const results = convertCodexTranscriptEntry(
        {
          type: "event_msg",
          timestamp: "2026-01-01T00:00:00Z",
          payload: { type: "user_message", message: "Hello world" },
        },
        ctx,
      );
      assert.equal(results.length, 1);
      assert.equal(results[0].message.type, "user");
      assert.equal(results[0].message.text, "Hello world");
    });

    it("marks injected task-context prompts as internal", () => {
      const ctx = createContext();
      const results = convertCodexTranscriptEntry(
        {
          type: "event_msg",
          timestamp: "2026-01-01T00:00:00Z",
          payload: {
            type: "user_message",
            message:
              "This project tracks tasks in .relay/tasks.json (Relay-managed snapshot JSON). Do not create a task for every request. Create a task only when explicitly asked, pick up an existing task when explicitly asked or when the request clearly matches one, and otherwise just do the work without creating a new task. Ask if unsure whether a request should map to a task. Fields: id (8-char hex), title, description (markdown), status (open|in_progress|done), priority (0-4), type (epic|task|bug), tags (string[]), parent (nullable task ID), blockedBy (task ID[]), createdAt, updatedAt (ISO timestamps). Blocked status is auto-derived from unresolved blockedBy refs. When asked to pick up a task (e.g. 'pick up task a1b2c3d4'), read .relay/tasks.json to find it.",
          },
        },
        ctx,
      );
      assert.equal(results.length, 1);
      assert.equal(results[0].message.type, "user");
      assert.equal(results[0].message.internal, true);
    });

    it("skips empty user messages", () => {
      const ctx = createContext();
      const results = convertCodexTranscriptEntry(
        {
          type: "event_msg",
          payload: { type: "user_message", message: "   " },
        },
        ctx,
      );
      assert.equal(results.length, 0);
    });
  });

  describe("agent messages", () => {
    it("converts agent_message to OutputMessage", () => {
      const ctx = createContext();
      const results = convertCodexTranscriptEntry(
        {
          type: "event_msg",
          payload: { type: "agent_message", message: "I'll help with that." },
        },
        ctx,
      );
      assert.equal(results.length, 1);
      assert.equal(results[0].message.type, "output");
      assert.equal(results[0].message.text, "I'll help with that.");
    });

    it("normalizes proposed_plan blocks into ExitPlanMode activity", () => {
      const ctx = createContext();
      const results = convertCodexTranscriptEntry(
        {
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "Intro\n<proposed_plan>\n# Test Plan\n- Step 1\n</proposed_plan>\nOutro",
          },
        },
        ctx,
      );

      assert.equal(results.length, 3);
      assert.equal(results[0].message.type, "output");
      assert.equal(results[0].message.text, "Intro\n");
      assert.equal(results[1].message.type, "activity");
      assert.equal(results[1].message.tool, "ExitPlanMode");
      assert.equal(results[1].message.input.plan, "# Test Plan\n- Step 1");
      assert.equal(results[2].message.type, "output");
      assert.equal(results[2].message.text, "\nOutro");
    });

    it("converts agent_reasoning to thinking activity", () => {
      const ctx = createContext();
      const results = convertCodexTranscriptEntry(
        {
          type: "event_msg",
          payload: { type: "agent_reasoning", text: "Let me think about this..." },
        },
        ctx,
      );
      assert.equal(results.length, 1);
      assert.equal(results[0].message.activity, "thinking");
    });
  });

  describe("generated images", () => {
    it("converts image_generation_end to a GenerateImage activity", () => {
      const ctx = createContext();
      const savedPath = "/Users/me/.codex/generated_images/sess/ig_abc.png";
      const results = convertCodexTranscriptEntry(
        {
          type: "event_msg",
          payload: { type: "image_generation_end", saved_path: savedPath, result: "iVBOR..." },
        },
        ctx,
      );
      assert.equal(results.length, 1);
      assert.equal(results[0].message.type, "activity");
      assert.equal(results[0].message.tool, "GenerateImage");
      assert.equal(results[0].message.input.file_path, savedPath);
      assert.equal(results[0].message.inputDescription, "ig_abc.png");
    });

    it("ignores image_generation_end without a saved_path", () => {
      const ctx = createContext();
      const results = convertCodexTranscriptEntry(
        { type: "event_msg", payload: { type: "image_generation_end", result: "iVBOR..." } },
        ctx,
      );
      assert.equal(results.length, 0);
    });
  });

  describe("function calls and results", () => {
    it("converts function_call to tool_use activity", () => {
      const ctx = createContext();
      const results = convertCodexTranscriptEntry(
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "call-1",
            arguments: '{"cmd":"ls -la"}',
          },
        },
        ctx,
      );
      assert.equal(results.length, 1);
      assert.equal(results[0].message.activity, "tool_use");
      assert.equal(results[0].message.tool, "Bash");
      // Should have stored the pending call
      assert.ok(ctx.pendingCalls.has("call-1"));
    });

    it("converts function_call_output to tool_result activity", () => {
      const ctx = createContext();
      ctx.pendingCalls.set("call-1", { name: "exec_command", arguments: '{"cmd":"ls"}' });

      const results = convertCodexTranscriptEntry(
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-1",
            output: "file1.txt\nfile2.txt",
          },
        },
        ctx,
      );
      assert.equal(results.length, 1);
      assert.equal(results[0].message.activity, "tool_result");
      assert.equal(results[0].message.toolUseId, "call-1");
      assert.equal(results[0].message.tool, "Bash");
      // Pending call should be cleared
      assert.ok(!ctx.pendingCalls.has("call-1"));
    });

    it("detects failed exec_command from exit code", () => {
      const ctx = createContext();
      ctx.pendingCalls.set("call-1", { name: "exec_command", arguments: '{"cmd":"false"}' });

      const results = convertCodexTranscriptEntry(
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-1",
            output: "Process exited with code 1",
          },
        },
        ctx,
      );
      assert.equal(results[0].message.description, "Command failed");
    });

    it("normalizes request_user_input into AskUserQuestion activities", () => {
      const ctx = createContext();
      const promptResults = convertCodexTranscriptEntry(
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            call_id: "ask-1",
            arguments:
              '{"questions":[{"id":"color","header":"Palette","question":"Pick a color","options":[{"label":"Blue","description":"Recommended"}]}]}',
          },
        },
        ctx,
      );

      assert.equal(promptResults.length, 1);
      assert.equal(promptResults[0].message.tool, "AskUserQuestion");
      assert.equal(promptResults[0].message.description, "Question");
      assert.equal(promptResults[0].message.inputDescription, "Pick a color");

      const resultResults = convertCodexTranscriptEntry(
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "ask-1",
            output: '{"answers":{"color":{"answers":["Blue"]}}}',
          },
        },
        ctx,
      );

      assert.equal(resultResults.length, 1);
      assert.equal(resultResults[0].message.tool, "AskUserQuestion");
      assert.equal(resultResults[0].message.resolution, "approved");
    });
  });

  describe("apply_patch file tracking", () => {
    it("extracts added files from patch input", () => {
      const ctx = createContext();
      const patch = `*** Add File: src/new.ts
+console.log("hello");`;

      convertCodexTranscriptEntry(
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "apply_patch",
            call_id: "p1",
            input: patch,
          },
        },
        ctx,
      );
      assert.ok(ctx.files.has("src/new.ts"));
      assert.equal(ctx.files.get("src/new.ts").type, "added");
    });

    it("extracts updated files from patch input", () => {
      const ctx = createContext();
      const patch = `*** Update File: src/existing.ts
@@ -1,3 +1,3 @@
-old line
+new line`;

      convertCodexTranscriptEntry(
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "apply_patch",
            call_id: "p2",
            input: patch,
          },
        },
        ctx,
      );
      assert.ok(ctx.files.has("src/existing.ts"));
      assert.equal(ctx.files.get("src/existing.ts").type, "edited");
    });

    it("ignores apply_patch changes outside the current workspace", () => {
      const ctx = createContext();
      const patch = `*** Update File: /Users/test/.claude/plans/session-plan.md
@@ -1,3 +1,3 @@
-old line
+new line`;

      convertCodexTranscriptEntry(
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "apply_patch",
            call_id: "p3",
            input: patch,
          },
        },
        ctx,
      );

      assert.equal(ctx.files.size, 0);
    });

    it("reconstructs Write and Edit activities from apply_patch input", () => {
      const ctx = createContext();
      const patch = `*** Begin Patch
*** Add File: src/new.tsx
+export function Demo() {
+  return <div>Hello</div>;
+}
*** Update File: src/existing.ts
@@
-old line
+new line
*** End Patch`;

      const results = convertCodexTranscriptEntry(
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "apply_patch",
            call_id: "p4",
            input: patch,
          },
        },
        ctx,
      );

      const write = results.find((entry) => entry.message.tool === "Write");
      const edit = results.find((entry) => entry.message.tool === "Edit");
      const fileList = results.find((entry) => entry.message.activity === "file_list");

      assert.ok(write, "expected reconstructed Write activity");
      assert.equal(write.message.input.file_path, "src/new.tsx");
      assert.match(write.message.input.content, /return <div>Hello<\/div>;/);

      assert.ok(edit, "expected reconstructed Edit activity");
      assert.equal(edit.message.input.file_path, "src/existing.ts");
      assert.match(edit.message.input.diff, /new line/);

      assert.ok(fileList, "expected file_list activity");
      assert.equal(fileList.message.files.length, 2);
    });
  });

  describe("token tracking", () => {
    it("accumulates token counts from token_count events", () => {
      const ctx = createContext();
      convertCodexTranscriptEntry(
        {
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 1000,
                output_tokens: 500,
                cached_input_tokens: 200,
              },
              last_token_usage: {
                total_tokens: 1000,
                input_tokens: 800,
                cached_input_tokens: 200,
              },
              model_context_window: 128000,
            },
          },
        },
        ctx,
      );
      assert.equal(ctx.stats.inputTokens, 1000);
      assert.equal(ctx.stats.outputTokens, 500);
      assert.equal(ctx.stats.cacheReadTokens, 200);
      assert.equal(ctx.stats.contextTokens, 1000);
      assert.equal(ctx.stats.contextWindow, 128000);
    });

    it("captures model from turn_context event", () => {
      const ctx = createContext();
      convertCodexTranscriptEntry(
        {
          type: "event_msg",
          payload: { type: "turn_context", model: "gpt-5.3-codex" },
        },
        ctx,
      );
      assert.equal(ctx.stats.model, "gpt-5.3-codex");
    });

    it("captures model from top-level turn_context entry", () => {
      const ctx = createContext();
      convertCodexTranscriptEntry(
        {
          type: "turn_context",
          payload: { model: "gpt-5.4" },
        },
        ctx,
      );
      assert.equal(ctx.stats.model, "gpt-5.4");
    });
  });

  describe("plan updates", () => {
    it("suppresses update_plan tool results", () => {
      const ctx = createContext();
      ctx.pendingCalls.set("plan-1", { name: "update_plan" });

      const results = convertCodexTranscriptEntry(
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "plan-1",
            output: "Plan updated",
          },
        },
        ctx,
      );
      assert.equal(results.length, 0);
    });
  });

  describe("edge cases", () => {
    it("handles missing payload gracefully", () => {
      const ctx = createContext();
      const results = convertCodexTranscriptEntry({ type: "response_item" }, ctx);
      assert.equal(results.length, 0);
    });

    it("handles unknown event types gracefully", () => {
      const ctx = createContext();
      const results = convertCodexTranscriptEntry({ type: "unknown_type", payload: {} }, ctx);
      assert.equal(results.length, 0);
    });

    it("uses current time for missing timestamps", () => {
      const ctx = createContext();
      const before = Date.now();
      const results = convertCodexTranscriptEntry(
        {
          type: "event_msg",
          payload: { type: "user_message", message: "hi" },
        },
        ctx,
      );
      const after = Date.now();
      assert.ok(results[0].timestamp >= before && results[0].timestamp <= after);
    });
  });
});

// Codex CLI 0.153+ stopped writing `user_message` / `agent_message` /
// `agent_reasoning` events; conversation turns arrive as `item_completed`
// with typed v2 thread items instead.
describe("convertCodexTranscriptEntry (0.153+ item_completed rollouts)", () => {
  const itemCompleted = (item, timestamp = "2026-09-05T03:03:14.239Z") => ({
    type: "event_msg",
    timestamp,
    payload: { type: "item_completed", thread_id: "t1", turn_id: "turn1", item },
  });

  it("converts UserMessage items to UserMessage", () => {
    const ctx = createContext();
    const results = convertCodexTranscriptEntry(
      itemCompleted({
        type: "UserMessage",
        id: "u1",
        content: [{ type: "text", text: "figure out the best way to do this" }],
      }),
      ctx,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].message.type, "user");
    assert.equal(results[0].message.text, "figure out the best way to do this");
    assert.equal(results[0].message.internal, undefined);
  });

  it("marks injected task-context prompts as internal in UserMessage items", () => {
    const ctx = createContext();
    const results = convertCodexTranscriptEntry(
      itemCompleted({
        type: "UserMessage",
        content: [
          {
            type: "text",
            text: "This project tracks tasks in .relay/tasks.json (Relay-managed snapshot JSON). Do not create a task for every request. Create a task only when explicitly asked, pick up an existing task when explicitly asked or when the request clearly matches one, and otherwise just do the work without creating a new task. Ask if unsure whether a request should map to a task. Fields: id (8-char hex), title, description (markdown), status (open|in_progress|done), priority (0-4), type (epic|task|bug), tags (string[]), parent (nullable task ID), blockedBy (task ID[]), createdAt, updatedAt (ISO timestamps). Blocked status is auto-derived from unresolved blockedBy refs. When asked to pick up a task (e.g. 'pick up task a1b2c3d4'), read .relay/tasks.json to find it.",
          },
        ],
      }),
      ctx,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].message.internal, true);
  });

  it("converts AgentMessage items (capitalised Text parts) to OutputMessage", () => {
    const ctx = createContext();
    const results = convertCodexTranscriptEntry(
      itemCompleted({
        type: "AgentMessage",
        id: "a1",
        content: [{ type: "Text", text: "I’ll read the project rules first.\n" }],
        phase: "commentary",
      }),
      ctx,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].message.type, "output");
    assert.equal(results[0].message.text, "I’ll read the project rules first.\n");
  });

  it("converts Reasoning items with summary text to thinking activity", () => {
    const ctx = createContext();
    const results = convertCodexTranscriptEntry(
      itemCompleted({
        type: "Reasoning",
        id: "r1",
        summary_text: ["**Designing local motion smoothing**", "**Refining reconciliation**"],
        raw_content: [],
      }),
      ctx,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].message.type, "activity");
    assert.equal(results[0].message.activity, "thinking");
    assert.match(results[0].message.detail, /Designing local motion smoothing/);
    assert.match(results[0].message.detail, /Refining reconciliation/);
  });

  it("ignores Reasoning items with no summary (encrypted content only)", () => {
    const ctx = createContext();
    const results = convertCodexTranscriptEntry(
      itemCompleted({ type: "Reasoning", id: "r2", summary_text: [], raw_content: [] }),
      ctx,
    );
    assert.equal(results.length, 0);
  });

  it("ignores item types already represented by response_item tool calls", () => {
    const ctx = createContext();
    convertCodexTranscriptEntry(
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "c1",
          arguments: '{"cmd":"pwd"}',
        },
      },
      ctx,
    );
    for (const item of [
      { type: "CommandExecution", id: "c1", command: ["/bin/zsh", "-lc", "pwd"], stdout: "/x" },
      { type: "FileChange", id: "f1", changes: {} },
      { type: "ContextCompaction", id: "cc1" },
    ]) {
      assert.equal(convertCodexTranscriptEntry(itemCompleted(item), ctx).length, 0, item.type);
    }
  });

  it("does not surface Codex's user-role injections from response_item messages", () => {
    const ctx = createContext();
    const results = convertCodexTranscriptEntry(
      {
        type: "response_item",
        timestamp: "2026-09-05T03:03:13.770Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<recommended_plugins>\nHere is a list…" }],
        },
      },
      ctx,
    );
    assert.equal(results.length, 0);
  });
});

describe("extractCodexConversationMessage", () => {
  it("reads legacy events and item_completed items alike", () => {
    assert.deepEqual(
      extractCodexConversationMessage({
        type: "event_msg",
        payload: { type: "user_message", message: "hi" },
      }),
      { role: "user", text: "hi" },
    );
    assert.deepEqual(
      extractCodexConversationMessage({
        type: "event_msg",
        payload: { type: "agent_message", message: "hello" },
      }),
      { role: "assistant", text: "hello" },
    );
    assert.deepEqual(
      extractCodexConversationMessage({
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "AgentMessage", content: [{ type: "Text", text: "done" }] },
        },
      }),
      { role: "assistant", text: "done" },
    );
    assert.equal(
      extractCodexConversationMessage({
        type: "event_msg",
        payload: { type: "item_completed", item: { type: "CommandExecution" } },
      }),
      null,
    );
    assert.equal(extractCodexConversationMessage({ type: "token_usage_record" }), null);
  });
});

describe("parseCodexTranscript", () => {
  it("exposes the session start from session_meta as createdAt", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-codex-"));
    const filePath = join(dir, "transcript.jsonl");
    writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-09-05T03:03:13.449Z",
          type: "session_meta",
          payload: {
            id: "sess-1",
            cwd: "/home/user/project",
            timestamp: "2026-09-05T03:01:44.388Z",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-09-05T03:03:14.239Z",
          payload: {
            type: "item_completed",
            item: { type: "UserMessage", content: [{ type: "text", text: "Fix the bug" }] },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-09-05T03:03:18.328Z",
          payload: {
            type: "item_completed",
            item: { type: "AgentMessage", content: [{ type: "Text", text: "On it." }] },
          },
        }),
      ].join("\n"),
    );
    try {
      const result = parseCodexTranscript(filePath);
      assert.equal(result.createdAt, Date.parse("2026-09-05T03:01:44.388Z"));
      assert.equal(result.history.length, 2);
      assert.equal(result.history[0].message.type, "user");
      assert.equal(result.history[1].message.type, "output");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses a full transcript file", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-codex-"));
    const filePath = join(dir, "transcript.jsonl");
    const lines = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "sess-1", cwd: "/home/user/project" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:00Z",
        payload: { type: "user_message", message: "Fix the bug" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:01Z",
        payload: { type: "agent_message", message: "I'll fix it." },
      }),
    ];
    writeFileSync(filePath, lines.join("\n"));

    try {
      const result = parseCodexTranscript(filePath);
      assert.equal(result.cwd, "/home/user/project");
      assert.equal(result.history.length, 2);
      assert.equal(result.history[0].message.type, "user");
      assert.equal(result.history[1].message.type, "output");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks injected task-context prompts as internal when parsing a full transcript", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-codex-"));
    const filePath = join(dir, "transcript.jsonl");
    const lines = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "sess-1", cwd: "/home/user/project" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:00Z",
        payload: {
          type: "user_message",
          message:
            "This project tracks tasks in .relay/tasks.json (Relay-managed snapshot JSON). Do not create a task for every request. Create a task only when explicitly asked, pick up an existing task when explicitly asked or when the request clearly matches one, and otherwise just do the work without creating a new task. Ask if unsure whether a request should map to a task. Fields: id (8-char hex), title, description (markdown), status (open|in_progress|done), priority (0-4), type (epic|task|bug), tags (string[]), parent (nullable task ID), blockedBy (task ID[]), createdAt, updatedAt (ISO timestamps). Blocked status is auto-derived from unresolved blockedBy refs. When asked to pick up a task (e.g. 'pick up task a1b2c3d4'), read .relay/tasks.json to find it.",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:01Z",
        payload: { type: "agent_message", message: "I'll help with that." },
      }),
    ];
    writeFileSync(filePath, lines.join("\n"));

    try {
      const result = parseCodexTranscript(filePath);
      assert.equal(result.history.length, 2);
      assert.equal(result.history[0].message.type, "user");
      assert.equal(result.history[0].message.internal, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty result for nonexistent file", () => {
    const result = parseCodexTranscript("/nonexistent/file.jsonl");
    assert.equal(result.cwd, "");
    assert.equal(result.history.length, 0);
  });

  it("skips malformed lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-codex-"));
    const filePath = join(dir, "bad.jsonl");
    writeFileSync(
      filePath,
      [
        "not json",
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: "valid" },
        }),
        "{broken json",
      ].join("\n"),
    );

    try {
      const result = parseCodexTranscript(filePath);
      assert.equal(result.history.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findCodexTranscriptPath", () => {
  it("finds a transcript by session ID in the filename", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-codex-find-"));
    const sessionsDir = join(dir, "sessions", "2026", "01", "01");
    mkdirSync(sessionsDir, { recursive: true });
    const filePath = join(sessionsDir, "sess-abc123.jsonl");
    writeFileSync(
      filePath,
      JSON.stringify({ type: "session_meta", payload: { id: "sess-abc123" } }),
    );

    try {
      const found = findCodexTranscriptPath(dir, "sess-abc123");
      assert.equal(found, filePath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when session ID not found", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-codex-find-"));
    mkdirSync(join(dir, "sessions"), { recursive: true });

    try {
      const found = findCodexTranscriptPath(dir, "nonexistent");
      assert.equal(found, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when sessions dir doesn't exist", () => {
    const found = findCodexTranscriptPath("/nonexistent", "sess-1");
    assert.equal(found, undefined);
  });
});

describe("code-mode custom tools", () => {
  it("preserves exec source and text block output with a matching call ID", () => {
    const ctx = createContext();
    const code = 'text(await tools.exec_command({cmd: "ls"}));';
    const [use] = convertCodexTranscriptEntry(
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "code-1",
          input: code,
        },
      },
      ctx,
    );
    assert.equal(use.message.tool, "ExecuteCode");
    assert.deepEqual(use.message.input, { code });
    const [result] = convertCodexTranscriptEntry(
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "code-1",
          output: [
            { type: "input_text", text: "Script completed\nOutput:\n" },
            { type: "input_text", text: "file.ts\nOutput:\nkeep this nested output" },
            { type: "input_image", image_url: "data:image/png;base64,private-image" },
          ],
        },
      },
      ctx,
    );
    assert.equal(result.message.toolUseId, use.message.toolUseId);
    assert.match(result.message.detail, /file.ts\nOutput:\nkeep this nested output/);
    assert.ok(!result.message.detail.includes("private-image"));
  });
  it("retains unknown freeform tool arguments", () => {
    const [entry] = convertCodexTranscriptEntry(
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "custom",
          call_id: "custom-1",
          input: "freeform input",
        },
      },
      createContext(),
    );
    assert.deepEqual(entry.message.input, { input: "freeform input" });
  });
});

describe("native command labels in replay", () => {
  const command = ["/bin/zsh", "-lc", "cat '/tmp/my file.ts'"];
  const event = (id = "exec-inner") => ({
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: "CommandExecution",
        id,
        command,
        parsed_cmd: [{ type: "read", name: "my file.ts", path: "/tmp/my file.ts" }],
        status: "completed",
        exit_code: 0,
        aggregated_output: "const x = 1;",
      },
    },
  });
  it("restores inner command metadata, exact arguments, and captured output", () => {
    const ctx = createContext();
    const entries = convertCodexTranscriptEntry(event(), ctx);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].message.inputDescription, "Read my file.ts");
    assert.equal(
      entries[0].message.input.command,
      `/bin/zsh -lc 'cat '\"'\"'/tmp/my file.ts'\"'\"''`,
    );
    assert.equal(entries[1].message.detail, "const x = 1;");
    assert.equal(entries[1].message.toolUseId, entries[0].message.toolUseId);
    assert.deepEqual(convertCodexTranscriptEntry(event(), ctx), []);
  });
  it("does not duplicate direct exec_command calls with native events", () => {
    const ctx = createContext();
    const [call] = convertCodexTranscriptEntry(
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-1",
          arguments: '{"cmd":"git push origin main"}',
        },
      },
      ctx,
    );
    assert.equal(call.message.inputDescription, "Push changes");
    assert.equal(call.message.input.command, "git push origin main");
    assert.deepEqual(convertCodexTranscriptEntry(event("call-1"), ctx), []);
  });
  it("preserves command failures", () => {
    const failed = event();
    failed.payload.item.exit_code = 1;
    assert.equal(
      convertCodexTranscriptEntry(failed, createContext())[1].message.description,
      "Tool error",
    );
  });
});

// =============================================================================
// Multi-agent replay (SubAgentActivity / CollabAgentToolCall / agent reports)
// =============================================================================

import { readCodexAgentHistory } from "../dist/server/core/providers/codex-transcript.js";

const PARENT_ID = "01a0b0fb-61c5-73f1-a055-9fcb783d1fa4";
const CHILD_ID = "01a0b0fb-a1fa-7d73-964f-eee5057ea230";
// Synthetic Fernet-shaped token; never a real ciphertext from disk.
const FAKE_ENCRYPTED = "gAAAAA" + "Qz9".repeat(24);

function eventItem(ts, threadId, item) {
  return {
    timestamp: ts,
    type: "event_msg",
    payload: { type: "item_completed", thread_id: threadId, turn_id: "turn-1", item },
  };
}

function parentRolloutLines() {
  return [
    {
      timestamp: "2026-09-17T20:07:39.000Z",
      type: "session_meta",
      payload: { id: PARENT_ID, timestamp: "2026-09-17T20:07:39.000Z", cwd: "/tmp/project", cli_version: "0.154.0" },
    },
    {
      timestamp: "2026-09-17T20:07:56.141Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        namespace: "collaboration",
        arguments: JSON.stringify({ task_name: "jev_research", message: FAKE_ENCRYPTED }),
        call_id: "call_spawn",
      },
    },
    eventItem("2026-09-17T20:07:56.258Z", PARENT_ID, {
      type: "SubAgentActivity",
      id: "call_spawn",
      kind: "started",
      agent_thread_id: CHILD_ID,
      agent_path: "/root/jev_research",
    }),
    {
      timestamp: "2026-09-17T20:07:56.260Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_spawn",
        output: JSON.stringify({ task_name: "/root/jev_research" }),
      },
    },
    {
      timestamp: "2026-09-17T20:08:30.988Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "send_message",
        namespace: "collaboration",
        arguments: JSON.stringify({ target: "jev_research", message: FAKE_ENCRYPTED }),
        call_id: "call_msg",
      },
    },
    eventItem("2026-09-17T20:08:30.996Z", PARENT_ID, {
      type: "SubAgentActivity",
      id: "call_msg",
      kind: "interacted",
      agent_thread_id: CHILD_ID,
      agent_path: "/root/jev_research",
    }),
    {
      timestamp: "2026-09-17T20:08:47.694Z",
      type: "response_item",
      payload: {
        type: "agent_message",
        id: "amsg_1",
        author: "/root/jev_research",
        recipient: "/root",
        content: [
          { type: "input_text", text: "Message Type: MESSAGE\nTask name: /root\nSender: /root/jev_research\nPayload:\n" },
          { type: "encrypted_content", encrypted_content: FAKE_ENCRYPTED },
        ],
      },
    },
    {
      timestamp: "2026-09-17T20:09:10.345Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "wait_agent",
        namespace: "collaboration",
        arguments: JSON.stringify({ timeout_ms: 10000 }),
        call_id: "call_wait",
      },
    },
    eventItem("2026-09-17T20:09:20.352Z", PARENT_ID, {
      type: "CollabAgentToolCall",
      id: "call_wait",
      tool: "wait",
      status: "completed",
      sender_thread_id: PARENT_ID,
      receiver_thread_ids: [],
      receiver_agents: [],
      agents_states: {},
    }),
    {
      timestamp: "2026-09-17T20:09:20.360Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call_wait", output: "{\"status\":\"timeout\"}" },
    },
    {
      timestamp: "2026-09-17T20:15:53.791Z",
      type: "response_item",
      payload: {
        type: "agent_message",
        id: "amsg_2",
        author: "/root/jev_research",
        recipient: "/root",
        content: [
          {
            type: "input_text",
            text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/jev_research\nPayload:\nSaved research notes.\n\n- Good classifier candidate.",
          },
          { type: "encrypted_content", encrypted_content: FAKE_ENCRYPTED },
        ],
      },
    },
    eventItem("2026-09-17T20:16:03.747Z", PARENT_ID, {
      type: "SubAgentActivity",
      id: "subagent-completed-xyz",
      kind: "completed",
      agent_thread_id: CHILD_ID,
      agent_path: "/root/jev_research",
    }),
  ];
}

describe("multi-agent replay (parent rollout)", () => {
  it("yields collab tool_uses, agent_updates, and a FINAL_ANSWER result without ciphertext", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-codex-agents-"));
    try {
      const filePath = join(dir, `rollout-2026-09-17T16-07-39-${PARENT_ID}.jsonl`);
      writeFileSync(filePath, parentRolloutLines().map((l) => JSON.stringify(l)).join("\n"));
      const result = parseCodexTranscript(filePath);
      const messages = result.history.map((h) => h.message);

      assert.equal(
        JSON.stringify(messages).includes("gAAAAA"),
        false,
        "no encrypted blob anywhere in replayed history",
      );

      const spawnUse = messages.find((m) => m.type === "activity" && m.toolUseId === "call_spawn" && m.activity === "tool_use");
      assert.ok(spawnUse, "spawn tool_use present");
      assert.equal(spawnUse.tool, "spawn_agent");
      assert.equal(spawnUse.description, "Spawning agent");
      assert.deepEqual(spawnUse.input, { task_name: "jev_research" });
      assert.equal(
        messages.filter((m) => m.type === "activity" && m.toolUseId === "call_spawn" && m.activity === "tool_use").length,
        1,
        "SubAgentActivity(started) does not duplicate the spawn tool_use",
      );
      const spawnResult = messages.find((m) => m.type === "activity" && m.toolUseId === "call_spawn" && m.activity === "tool_result");
      assert.ok(spawnResult, "function_call_output yields the tool_result");

      const updates = messages.filter((m) => m.type === "agent_update").map((m) => m.agent);
      assert.ok(updates.length >= 4);
      assert.ok(updates.every((a) => a.agentId === CHILD_ID));
      assert.equal(updates[0].originToolUseId, "call_spawn");
      assert.equal(updates[0].status, "running");
      assert.equal(updates[0].name, "jev_research");
      assert.equal(updates[0].relation, "child");
      assert.ok(updates.some((a) => a.lastActivity === "Message exchanged"));
      assert.ok(updates.some((a) => a.lastActivity === "Sent a message"), "encrypted MESSAGE bumps lastActivity only");
      const final = updates.find((a) => a.result);
      assert.ok(final, "FINAL_ANSWER produces a result");
      assert.equal(final.status, "completed");
      assert.match(final.result, /^Saved research notes\./);
      assert.ok(typeof final.endedAt === "number");
      assert.equal(updates[updates.length - 1].status, "completed");

      assert.equal(
        messages.filter((m) => m.type === "user").length,
        0,
        "encrypted MESSAGE never becomes a user bubble",
      );

      const waitUses = messages.filter((m) => m.type === "activity" && m.toolUseId === "call_wait" && m.activity === "tool_use");
      assert.equal(waitUses.length, 1, "wait function_call and CollabAgentToolCall dedupe by id");
      assert.equal(waitUses[0].tool, "wait_agent");
      assert.equal(waitUses[0].description, "Waiting for agents");
      const waitResults = messages.filter((m) => m.type === "activity" && m.toolUseId === "call_wait" && m.activity === "tool_result");
      assert.equal(waitResults.length, 1, "CollabAgentToolCall and function_call_output yield one tool_result");

      // Not a sub-agent rollout: the user-role response_item is never read as an assignment.
      assert.equal(result.firstUserPrompt, undefined);
      for (const m of messages.filter((m) => m.type === "agent_update")) {
        assert.ok(m.raw === undefined || (typeof m.raw.type === "string" && m.raw.agents_states === undefined));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits exactly one collab tool_result when the output precedes the typed item", () => {
    const ctx = createContext();
    const entries = [
      {
        timestamp: "2026-09-17T20:09:10.345Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "wait_agent",
          namespace: "collaboration",
          arguments: JSON.stringify({ timeout_ms: 10000 }),
          call_id: "call_wait_2",
        },
      },
      {
        timestamp: "2026-09-17T20:09:20.360Z",
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call_wait_2", output: "{\"status\":\"timeout\"}" },
      },
      eventItem("2026-09-17T20:09:20.362Z", PARENT_ID, {
        type: "CollabAgentToolCall",
        id: "call_wait_2",
        tool: "wait",
        status: "completed",
        sender_thread_id: PARENT_ID,
        receiver_thread_ids: [],
        agents_states: {},
      }),
    ];
    const messages = entries.flatMap((e) => convertCodexTranscriptEntry(e, ctx)).map((r) => r.message);
    assert.equal(messages.filter((m) => m.activity === "tool_use").length, 1);
    assert.equal(messages.filter((m) => m.activity === "tool_result").length, 1);
  });

  it("moves children out of running from a wait's agents_states (string and object variants)", () => {
    const ctx = createContext();
    const A = "thread-a";
    const B = "thread-b";
    const messages = convertCodexTranscriptEntry(
      eventItem("2026-09-17T20:09:20.352Z", PARENT_ID, {
        type: "CollabAgentToolCall",
        id: "call_wait_3",
        tool: "wait",
        status: "completed",
        sender_thread_id: PARENT_ID,
        receiver_thread_ids: [A, B],
        agents_states: { [A]: { completed: "All done." }, [B]: "errored" },
      }),
      ctx,
    ).map((r) => r.message);
    const updates = messages.filter((m) => m.type === "agent_update").map((m) => m.agent);
    const a = updates.find((u) => u.agentId === A);
    const b = updates.find((u) => u.agentId === B);
    assert.equal(a.status, "completed");
    assert.equal(a.result, "All done.");
    assert.equal(b.status, "failed");
    assert.ok(!JSON.stringify(messages.filter((m) => m.type === "agent_update").map((m) => m.raw)).includes("All done."));
  });

  it("renders a plaintext MESSAGE report as an agent-authored user message", () => {
    const ctx = createContext();
    convertCodexTranscriptEntry(
      eventItem("2026-09-17T20:07:56.258Z", PARENT_ID, {
        type: "SubAgentActivity",
        id: "call_spawn",
        kind: "started",
        agent_thread_id: CHILD_ID,
        agent_path: "/root/jev_research",
      }),
      ctx,
    );
    const results = convertCodexTranscriptEntry(
      {
        timestamp: "2026-09-17T20:08:47.694Z",
        type: "response_item",
        payload: {
          type: "agent_message",
          author: "/root/jev_research",
          recipient: "/root",
          content: [
            {
              type: "input_text",
              text: "Message Type: MESSAGE\nTask name: /root\nSender: /root/jev_research\nPayload:\nHalfway there, two files left.",
            },
          ],
        },
      },
      ctx,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].message.type, "user");
    assert.equal(results[0].message.text, "Halfway there, two files left.");
    assert.deepEqual(results[0].message.author, { kind: "agent", name: "jev_research", agentId: CHILD_ID });
  });

  it("maps a camelCase collabAgentToolCall spawn with model onto an agent_update", () => {
    const ctx = createContext();
    const results = convertCodexTranscriptEntry(
      eventItem("2026-09-17T20:07:56.258Z", PARENT_ID, {
        type: "CollabAgentToolCall",
        id: "call_spawn_cc",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: PARENT_ID,
        receiverThreadIds: [CHILD_ID],
        prompt: "Research Jev pricing",
        model: "gpt-5.3-codex-spark",
        reasoningEffort: "low",
        agentsStates: { [CHILD_ID]: { agentThreadId: CHILD_ID, agentPath: "/root/pricing" } },
      }),
      ctx,
    );
    const types = results.map((r) => r.message.type + ":" + (r.message.activity ?? ""));
    assert.deepEqual(types, ["activity:tool_use", "agent_update:", "activity:tool_result"]);
    const agent = results[1].message.agent;
    assert.equal(agent.agentId, CHILD_ID);
    assert.equal(agent.name, "pricing");
    assert.equal(agent.model, "gpt-5.3-codex-spark");
    assert.equal(agent.reasoningEffort, "low");
    assert.equal(agent.assignment, "Research Jev pricing");
    assert.equal(agent.status, "running");
    assert.equal(results[0].message.input.prompt, "Research Jev pricing");
  });

  it("does not require a namespace for known collaboration function names", () => {
    const ctx = createContext();
    const results = convertCodexTranscriptEntry(
      {
        timestamp: "2026-09-17T20:07:56.141Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "close_agent",
          arguments: JSON.stringify({ target: "jev_research" }),
          call_id: "call_close",
        },
      },
      ctx,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].message.tool, "close_agent");
    assert.equal(results[0].message.description, "Stopping agent");
    assert.equal(results[0].message.inputDescription, "jev_research");
  });
});

describe("readCodexAgentHistory", () => {
  function childRolloutLines() {
    return [
      {
        timestamp: "2026-09-17T20:07:56.226Z",
        type: "session_meta",
        payload: {
          session_id: PARENT_ID,
          id: CHILD_ID,
          parent_thread_id: PARENT_ID,
          timestamp: "2026-09-17T20:07:56.201Z",
          cwd: "/tmp/project",
          originator: "relay",
          cli_version: "0.154.0",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: PARENT_ID,
                depth: 1,
                agent_path: "/root/jev_research",
                agent_nickname: "Avicenna",
                agent_role: "researcher",
              },
            },
          },
          thread_source: "subagent",
          agent_nickname: "Avicenna",
          agent_path: "/root/jev_research",
        },
      },
      {
        timestamp: "2026-09-17T20:07:56.227Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<recommended_plugins>\nHere is a list…\n</recommended_plugins>" },
            { type: "input_text", text: "# AGENTS.md instructions for /tmp/project\n…" },
            { type: "input_text", text: "<environment_context>\n  <cwd>/tmp/project</cwd>\n</environment_context>" },
          ],
        },
      },
      {
        timestamp: "2026-09-17T20:07:56.227Z",
        type: "turn_context",
        payload: { turn_id: "turn-1", cwd: "/tmp/project", model: "gpt-5.3-codex-spark" },
      },
      {
        timestamp: "2026-09-17T20:07:56.227Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Research whether Jev fits our prompt classifier." }],
        },
      },
      {
        timestamp: "2026-09-17T20:07:57.507Z",
        type: "response_item",
        payload: {
          type: "agent_message",
          author: "/root",
          recipient: "/root/jev_research",
          content: [
            { type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/jev_research\nSender: /root\nPayload:\n" },
            { type: "encrypted_content", encrypted_content: FAKE_ENCRYPTED },
          ],
        },
      },
      eventItem("2026-09-17T20:08:02.000Z", CHILD_ID, {
        type: "CommandExecution",
        id: "cmd-1",
        command: ["rg", "classifier", "src"],
        status: "completed",
        exit_code: 0,
        aggregated_output: "src/guard.ts:12",
      }),
      eventItem("2026-09-17T20:08:46.883Z", CHILD_ID, {
        type: "SubAgentActivity",
        id: "call_back",
        kind: "interacted",
        agent_thread_id: PARENT_ID,
        agent_path: "/root",
      }),
      eventItem("2026-09-17T20:09:00.000Z", CHILD_ID, {
        type: "AgentMessage",
        id: "am-1",
        content: [{ type: "text", text: "Jev looks viable." }],
      }),
    ];
  }

  it("returns attributed entries led by a session_meta-derived agent_update", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-codex-child-"));
    try {
      mkdirSync(join(dir, "sessions", "2026", "09", "17"), { recursive: true });
      writeFileSync(
        join(dir, "sessions", "2026", "09", "17", `rollout-2026-09-17T16-07-56-${CHILD_ID}.jsonl`),
        childRolloutLines().map((l) => JSON.stringify(l)).join("\n"),
      );

      const history = await readCodexAgentHistory(dir, CHILD_ID);
      assert.ok(history, "history found by thread id");
      assert.equal(JSON.stringify(history).includes("gAAAAA"), false);

      const first = history[0].message;
      assert.equal(first.type, "agent_update");
      assert.equal(first.agent.agentId, CHILD_ID);
      assert.equal(first.agent.providerAgentId, CHILD_ID);
      assert.equal(first.agent.name, "jev_research");
      assert.equal(first.agent.role, "researcher");
      assert.equal(first.agent.model, "gpt-5.3-codex-spark");
      assert.equal(first.agent.assignment, "Research whether Jev fits our prompt classifier.");
      assert.equal(first.agent.parentAgentId, undefined, "direct child of the root has no parentAgentId");
      assert.equal(first.agent.relation, "child");

      const assignment = history[1].message;
      assert.equal(assignment.type, "user");
      assert.equal(assignment.text, "Research whether Jev fits our prompt classifier.");
      assert.equal(assignment.agentId, CHILD_ID);
      assert.equal(assignment.author.kind, "agent");

      const rest = history.slice(2).map((h) => h.message);
      assert.ok(rest.length >= 3, "command tool_use/result + agent message");
      for (const message of rest) {
        assert.notEqual(message.type, "agent_update", "interactions with the parent are not agents of this transcript");
        assert.equal(message.agentId, CHILD_ID, `${message.type} attributed to child`);
      }
      assert.ok(rest.some((m) => m.type === "output" && m.text === "Jev looks viable."));
      assert.ok(rest.some((m) => m.type === "activity" && m.toolUseId === "cmd-1"));
      assert.ok(
        !rest.some((m) => m.type === "user" && m.text.includes("recommended_plugins")),
        "injected context never surfaces",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets parentAgentId for nested children and returns null when missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-codex-child-"));
    try {
      mkdirSync(join(dir, "sessions"), { recursive: true });
      assert.equal(await readCodexAgentHistory(dir, "does-not-exist"), null);

      const GRANDCHILD = "01a0b0fb-cccc-7d73-964f-eee5057ea230";
      const lines = childRolloutLines();
      lines[0].payload.id = GRANDCHILD;
      lines[0].payload.parent_thread_id = CHILD_ID;
      lines[0].payload.source.subagent.thread_spawn.parent_thread_id = CHILD_ID;
      lines[0].payload.source.subagent.thread_spawn.depth = 2;
      lines[0].payload.source.subagent.thread_spawn.agent_path = "/root/jev_research/pricing";
      writeFileSync(
        join(dir, "sessions", `rollout-2026-09-17T16-08-00-${GRANDCHILD}.jsonl`),
        lines.map((l) => JSON.stringify(l)).join("\n"),
      );
      const history = await readCodexAgentHistory(dir, GRANDCHILD, { rootThreadId: PARENT_ID });
      assert.ok(history);
      assert.equal(history[0].message.agent.agentId, GRANDCHILD);
      assert.equal(history[0].message.agent.parentAgentId, CHILD_ID);
      assert.equal(history[0].message.agent.name, "pricing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caches by rollout mtime+size and re-reads when the child file grows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-codex-child-cache-"));
    try {
      const sessionsDir = join(dir, "sessions", "2026", "09", "17");
      mkdirSync(sessionsDir, { recursive: true });
      const CACHED = "01a0b0fb-dddd-7d73-964f-eee5057ea230";
      const lines = childRolloutLines();
      lines[0].payload.id = CACHED;
      const filePath = join(sessionsDir, `rollout-2026-09-17T16-09-00-${CACHED}.jsonl`);
      writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n"));

      const first = await readCodexAgentHistory(dir, CACHED);
      const second = await readCodexAgentHistory(dir, CACHED);
      assert.ok(first);
      assert.equal(second, first, "unchanged file serves the cached parse");

      // Append a turn; a different size invalidates even within the same mtime tick.
      const extra = eventItem("2026-09-17T20:10:00.000Z", CACHED, {
        type: "AgentMessage",
        id: "am-2",
        content: [{ type: "text", text: "Second thought." }],
      });
      writeFileSync(filePath, [...lines, extra].map((l) => JSON.stringify(l)).join("\n"));
      const third = await readCodexAgentHistory(dir, CACHED);
      assert.notEqual(third, first);
      assert.ok(third.some((h) => h.message.type === "output" && h.message.text === "Second thought."));

      // A vanished rollout drops the cached path and returns null again.
      rmSync(filePath);
      assert.equal(await readCodexAgentHistory(dir, CACHED), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
