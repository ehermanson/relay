// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
/**
 * Tests restore-specific history hydration behavior.
 * Direct JSONL conversion coverage lives in history-conversion.test.js.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InstanceManager } from "../dist/server/core/instance-manager.js";
import { SessionDB } from "../dist/server/core/db.js";
import { resolveConfig } from "../dist/server/config.js";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

const fixturesDir = join(import.meta.dirname, "fixtures");

function makeManager(tempDir, overrides = {}) {
  const config = resolveConfig({
    password: "test",
    logger: noopLogger,
    maxProcesses: 20,
    dbPath: join(tempDir, "sessions.db"),
    providerDirs: {
      claude: join(tempDir, ".claude"),
      codex: join(tempDir, ".codex"),
    },
    ...overrides,
  });
  return new InstanceManager(config);
}

function seedDB(tempDir, entries) {
  const dbPath = join(tempDir, "sessions.db");
  const db = new SessionDB(dbPath, noopLogger);
  for (const entry of entries) {
    db.upsert({
      session_id: entry.sessionId || "test-session",
      instance_id: entry.id || "test-id",
      provider_name: "claude",
      name: entry.name || "Test Session",
      working_directory: entry.workingDirectory || "/Users/test/projects/my-app",
      jsonl_path: entry.jsonlPath,
      created_at: entry.createdAt || Date.now(),
      last_activity_at: entry.lastActivityAt || entry.createdAt || Date.now(),
      type: entry.type || "external",
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
      last_message_text: entry.lastMessageText || null,
      last_message_from: entry.lastMessageFrom || null,
      last_message_at: entry.lastMessageAt || null,
      git_info_branch: entry.gitInfoBranch || null,
      git_info_is_worktree:
        entry.gitInfoIsWorktree === undefined ? null : entry.gitInfoIsWorktree ? 1 : 0,
      project_id: null,
      model: entry.model || null,
    });
  }
  db.close();
}

function makeExternalEntry(overrides) {
  return {
    id: "test-id",
    name: "Test Session",
    workingDirectory: "/Users/test/projects/my-app",
    sessionId: "test-session",
    createdAt: Date.now(),
    type: "external",
    ...overrides,
  };
}

function seedManagedDB(tempDir, entries) {
  const dbPath = join(tempDir, "sessions.db");
  const db = new SessionDB(dbPath, noopLogger);
  for (const entry of entries) {
    db.upsertManaged({
      instance_id: entry.id || "managed-id",
      provider_name: entry.provider || "codex",
      provider_session_id: entry.providerSessionId || null,
      name: entry.name || "Managed Session",
      working_directory: entry.workingDirectory || "/Users/test/projects/my-app",
      created_at: entry.createdAt || Date.now(),
      last_activity_at: entry.lastActivityAt || entry.createdAt || Date.now(),
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
      preferred_model: entry.preferredModel || null,
      reasoning_budget: null,
      runtime_mode: "approval-required",
      resume_cursor_json: entry.resumeCursorJson || null,
      runtime_payload_json:
        entry.runtimePayloadJson ||
        JSON.stringify({ cwd: entry.workingDirectory || "/Users/test/projects/my-app" }),
      model_options_json: null,
      original_git_branch: null,
      transcript_path: entry.transcriptPath || null,
      last_message_text: entry.lastMessageText || null,
      last_message_from: entry.lastMessageFrom || null,
      last_message_at: entry.lastMessageAt || null,
      git_info_branch: entry.gitInfoBranch || null,
      git_info_is_worktree:
        entry.gitInfoIsWorktree === undefined ? null : entry.gitInfoIsWorktree ? 1 : 0,
      project_id: null,
      model: entry.model || null,
    });
  }
  db.close();
}

describe("History Parsing via DB Restore", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-history-test-"));
  });

  afterEach(() => {
    // Clean up any managers
  });

  describe("lastMessage preview", () => {
    it("restores sidebar preview metadata from the database before hydration", () => {
      const lastMessageAt = Date.now() - 60_000;
      seedDB(tempDir, [
        makeExternalEntry({
          jsonlPath: join(fixturesDir, "basic-session.jsonl"),
          lastMessageText: "Persisted preview",
          lastMessageFrom: "user",
          lastMessageAt,
          gitInfoBranch: "main",
          gitInfoIsWorktree: false,
        }),
      ]);
      const manager = makeManager(tempDir);
      manager.restoreAndScan();

      const info = manager.getInstance("test-id");
      assert.ok(info.lastMessage, "Should have lastMessage");
      assert.equal(info.lastMessage.text, "Persisted preview");
      assert.equal(info.lastMessage.from, "user");
      assert.equal(info.lastMessage.timestamp, lastMessageAt);
      assert.deepEqual(info.gitInfo, { branch: "main", isWorktree: false });

      manager.stopAll();
    });
  });

  describe("AskUserQuestion answer replay", () => {
    it("reconstructs the answer as a chat message from the transcript", () => {
      const jsonlPath = join(tempDir, "ask-session.jsonl");
      const lines = [
        {
          type: "system",
          subtype: "init",
          cwd: "/Users/test/projects/my-app",
          timestamp: "2026-02-10T10:00:00.000Z",
          slug: "my-app",
        },
        {
          type: "user",
          message: { role: "user", content: "Set up the pre-commit hook." },
          timestamp: "2026-02-10T10:00:01.000Z",
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_ask_1",
                name: "AskUserQuestion",
                input: {
                  questions: [
                    { question: "Block commits or just report?", header: "Mode" },
                    { question: "Where should it run?", header: "Wiring" },
                  ],
                },
              },
            ],
          },
          timestamp: "2026-02-10T10:00:05.000Z",
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_ask_1",
                content:
                  'Your questions have been answered: "Block commits or just report?"="Just report", ' +
                  '"Where should it run?"="lint-staged entry". You can now continue with these answers in mind.',
              },
            ],
          },
          timestamp: "2026-02-10T10:00:06.000Z",
        },
      ];
      writeFileSync(jsonlPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

      seedDB(tempDir, [makeExternalEntry({ id: "ask-id", sessionId: "ask-session", jsonlPath })]);

      const manager = makeManager(tempDir);
      manager.restoreAndScan();
      const history = manager.getHistory("ask-id");

      const answer = history.find(
        (h) => h.message.type === "user" && h.message.text?.startsWith(">"),
      );
      assert.ok(answer, "Expected the answer reconstructed as a user message");
      assert.equal(
        answer.message.text,
        "> Block commits or just report?\n\nJust report\n\n> Where should it run?\n\nlint-staged entry",
      );

      // The tool_result activity must still be present so pending state clears on reload.
      const toolResult = history.find(
        (h) => h.message.type === "activity" && h.message.activity === "tool_result",
      );
      assert.ok(toolResult, "Expected the AskUserQuestion tool_result activity to remain");
      assert.equal(toolResult.message.resolution, "approved");

      manager.stopAll();
    });
  });

  describe("persisted model restore", () => {
    it("restores persisted model metadata for external and managed sessions before hydration", () => {
      seedDB(tempDir, [
        makeExternalEntry({
          id: "external-with-model",
          sessionId: "external-session",
          jsonlPath: join(fixturesDir, "basic-session.jsonl"),
          model: "claude-opus-4-6",
        }),
      ]);
      seedManagedDB(tempDir, [
        {
          id: "managed-with-model",
          provider: "codex",
          providerSessionId: "codex-test-session",
          transcriptPath: join(fixturesDir, "codex-managed-session.jsonl"),
          workingDirectory: "/Users/test/projects/my-app",
          model: "gpt-5.4",
        },
      ]);

      const manager = makeManager(tempDir);
      manager.restoreAndScan();

      const external = manager.getInstance("external-with-model");
      const managed = manager.getInstance("managed-with-model");

      assert.equal(external.stats?.model, "claude-opus-4-6");
      assert.equal(managed.stats?.model, "gpt-5.4");

      manager.stopAll();
    });
  });

  describe("managed Codex restore", () => {
    it("returns persisted Codex transcript history without booting on first open", () => {
      const transcriptPath = join(fixturesDir, "codex-managed-session.jsonl");
      seedManagedDB(tempDir, [
        {
          id: "codex-managed-id",
          provider: "codex",
          providerSessionId: "codex-test-session",
          name: "Codex Session",
          workingDirectory: "/Users/test/projects/my-app",
          transcriptPath,
          preferredModel: "gpt-5.4",
          resumeCursorJson: JSON.stringify({ sessionId: "codex-test-session" }),
        },
      ]);

      const manager = makeManager(tempDir);
      manager.restoreAndScan();

      const infoBefore = manager.getInstance("codex-managed-id");
      const instanceBefore = manager.instances.get("codex-managed-id");
      assert.equal(infoBefore.provider, "codex");
      assert.equal(infoBefore.sessionId, "codex-test-session");
      assert.equal(infoBefore.status, "stopped");
      assert.equal(instanceBefore.process, null);

      const history = manager.getHistory("codex-managed-id");
      const info = manager.getInstance("codex-managed-id");

      assert.equal(info.status, "stopped");
      assert.equal(manager.instances.get("codex-managed-id").process, null);
      assert.equal(manager.instances.get("codex-managed-id").hydrated, false);

      const userMessages = history.filter((h) => h.message.type === "user");
      assert.equal(userMessages.length, 1, "Only the actual chat message should be replayed");
      assert.equal(userMessages[0].message.text, "How do I build this?");

      const toolUse = history.find(
        (h) => h.message.type === "activity" && h.message.activity === "tool_use",
      );
      assert.ok(toolUse, "Expected a restored tool_use activity");
      assert.equal(toolUse.message.tool, "Bash");
      assert.equal(toolUse.message.description, "Running command");

      const toolResult = history.find(
        (h) => h.message.type === "activity" && h.message.activity === "tool_result",
      );
      assert.ok(toolResult, "Expected a restored tool_result activity");
      assert.equal(toolResult.message.description, "Command completed");

      manager.stopAll();
    });

    it("discovers the Codex transcript path from the provider session id on restore", () => {
      const codexSessionDir = join(tempDir, ".codex", "sessions", "2026", "03", "08");
      mkdirSync(codexSessionDir, { recursive: true });
      const transcriptPath = join(
        codexSessionDir,
        "rollout-2026-03-08T12-00-00-codex-test-session.jsonl",
      );
      writeFileSync(transcriptPath, readFileSync(join(fixturesDir, "codex-managed-session.jsonl")));

      seedManagedDB(tempDir, [
        {
          id: "codex-discovery-id",
          provider: "codex",
          providerSessionId: "codex-test-session",
          name: "Recovered Codex Session",
          workingDirectory: "/Users/test/projects/my-app",
          resumeCursorJson: JSON.stringify({ sessionId: "codex-test-session" }),
        },
      ]);

      const manager = makeManager(tempDir);
      manager.restoreAndScan();

      const history = manager.getHistory("codex-discovery-id");
      assert.ok(history.length > 0, "Managed Codex restore should discover transcript history");
      const instance = manager.instances.get("codex-discovery-id");
      assert.equal(instance.process, null);
      assert.equal(instance.jsonlPath, transcriptPath);
      assert.equal(instance.hydrated, false);

      manager.stopAll();
    });

    it("rebuilds changed files from Codex apply_patch transcript entries", () => {
      const transcriptPath = join(tempDir, "codex-files-session.jsonl");
      writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            timestamp: "2026-03-08T12:00:00.000Z",
            type: "session_meta",
            payload: {
              id: "codex-files-session",
              timestamp: "2026-03-08T12:00:00.000Z",
              cwd: "/Users/test/projects/my-app",
              originator: "codex_exec",
              source: "exec",
              model_provider: "openai",
            },
          }),
          JSON.stringify({
            timestamp: "2026-03-08T12:00:01.000Z",
            type: "response_item",
            payload: {
              type: "custom_tool_call",
              name: "apply_patch",
              call_id: "call-patch",
              input: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n*** End Patch\n",
            },
          }),
          JSON.stringify({
            timestamp: "2026-03-08T12:00:01.050Z",
            type: "response_item",
            payload: {
              type: "custom_tool_call_output",
              call_id: "call-patch",
              output: '{"output":"Success. Updated the following files:\\nM src/app.ts\\n"}',
            },
          }),
          "",
        ].join("\n"),
      );

      seedManagedDB(tempDir, [
        {
          id: "codex-files-id",
          provider: "codex",
          providerSessionId: "codex-files-session",
          name: "Codex Files Session",
          workingDirectory: "/Users/test/projects/my-app",
          transcriptPath,
          resumeCursorJson: JSON.stringify({ sessionId: "codex-files-session" }),
        },
      ]);

      const manager = makeManager(tempDir);
      manager.restoreAndScan();

      const history = manager.getHistory("codex-files-id");
      const instance = manager.instances.get("codex-files-id");

      const fileList = history.find(
        (entry) => entry.message.type === "activity" && entry.message.activity === "file_list",
      );
      assert.ok(fileList, "Expected a restored file_list activity");
      assert.deepEqual(fileList.message.files, [
        { path: "src/app.ts", editCount: 1, type: "edited" },
      ]);
      assert.equal(instance.files, undefined);
      assert.equal(instance.hydrated, false);

      manager.stopAll();
    });

    it("rebuilds task lists from Codex update_plan transcript entries", () => {
      const transcriptPath = join(tempDir, "codex-plan-session.jsonl");
      writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            timestamp: "2026-03-08T12:00:00.000Z",
            type: "session_meta",
            payload: {
              id: "codex-plan-session",
              timestamp: "2026-03-08T12:00:00.000Z",
              cwd: "/Users/test/projects/my-app",
              originator: "codex_exec",
              source: "exec",
              model_provider: "openai",
            },
          }),
          JSON.stringify({
            timestamp: "2026-03-08T12:00:01.000Z",
            type: "response_item",
            payload: {
              type: "function_call",
              name: "update_plan",
              call_id: "call-plan",
              arguments: JSON.stringify({
                explanation: "Plan update",
                plan: [
                  { step: "Inspect the code", status: "completed" },
                  { step: "Apply the fix", status: "inProgress" },
                  { step: "Run checks", status: "pending" },
                ],
              }),
            },
          }),
          JSON.stringify({
            timestamp: "2026-03-08T12:00:01.050Z",
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "call-plan",
              output: '{"body":"ok","success":true}',
            },
          }),
          "",
        ].join("\n"),
      );

      seedManagedDB(tempDir, [
        {
          id: "codex-plan-id",
          provider: "codex",
          providerSessionId: "codex-plan-session",
          name: "Codex Plan Session",
          workingDirectory: "/Users/test/projects/my-app",
          transcriptPath,
          resumeCursorJson: JSON.stringify({ sessionId: "codex-plan-session" }),
        },
      ]);

      const manager = makeManager(tempDir);
      manager.restoreAndScan();

      const history = manager.getHistory("codex-plan-id");
      const instance = manager.instances.get("codex-plan-id");

      const taskListEntries = history.filter(
        (entry) => entry.message.type === "activity" && entry.message.activity === "task_list",
      );
      assert.equal(taskListEntries.length, 1, "Expected one restored task_list activity");
      assert.deepEqual(taskListEntries[0].message.tasks, [
        { id: "plan-0", subject: "Inspect the code", status: "completed" },
        { id: "plan-1", subject: "Apply the fix", status: "in_progress" },
        { id: "plan-2", subject: "Run checks", status: "pending" },
      ]);
      assert.equal(instance.tasks, undefined);
      assert.equal(instance.hydrated, false);

      manager.stopAll();
    });

    it("restores pending plan review from Codex proposed_plan transcript entries", () => {
      const transcriptPath = join(tempDir, "codex-proposed-plan-session.jsonl");
      writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            timestamp: "2026-03-08T12:00:00.000Z",
            type: "session_meta",
            payload: {
              id: "codex-proposed-plan-session",
              timestamp: "2026-03-08T12:00:00.000Z",
              cwd: "/Users/test/projects/my-app",
              originator: "codex_exec",
              source: "exec",
              model_provider: "openai",
            },
          }),
          JSON.stringify({
            timestamp: "2026-03-08T12:00:01.000Z",
            type: "event_msg",
            payload: {
              type: "agent_message",
              message:
                "Here is the plan.\n<proposed_plan>\n# Test Plan\n- Inspect\n- Patch\n</proposed_plan>",
            },
          }),
          "",
        ].join("\n"),
      );

      seedManagedDB(tempDir, [
        {
          id: "codex-proposed-plan-id",
          provider: "codex",
          providerSessionId: "codex-proposed-plan-session",
          name: "Codex Proposed Plan Session",
          workingDirectory: "/Users/test/projects/my-app",
          transcriptPath,
          resumeCursorJson: JSON.stringify({ sessionId: "codex-proposed-plan-session" }),
        },
      ]);

      const manager = makeManager(tempDir);
      manager.restoreAndScan();

      const history = manager.getHistory("codex-proposed-plan-id");
      const instance = manager.instances.get("codex-proposed-plan-id");

      const planActivity = history.find(
        (entry) => entry.message.type === "activity" && entry.message.tool === "ExitPlanMode",
      );
      assert.ok(planActivity, "Expected restored ExitPlanMode activity");
      assert.equal(planActivity.message.input.plan, "# Test Plan\n- Inspect\n- Patch");
      assert.equal(instance.info.pendingPlan, undefined);
      assert.equal(instance.info.planContent, undefined);
      assert.equal(instance.hydrated, false);

      manager.stopAll();
    });

    it("archives incomplete managed rows that have no resumable binding", () => {
      seedManagedDB(tempDir, [
        {
          id: "empty-managed-id",
          provider: "claude",
          name: "Normal",
          workingDirectory: "/Users/test/projects/my-app",
          providerSessionId: null,
          resumeCursorJson: null,
          runtimePayloadJson: JSON.stringify({ cwd: "/Users/test/projects/my-app" }),
          transcriptPath: null,
        },
      ]);

      const manager = makeManager(tempDir);
      manager.restoreAndScan();

      assert.equal(manager.listInstances().length, 0);

      const db = new SessionDB(join(tempDir, "sessions.db"), noopLogger);
      try {
        const row = db.getManagedByInstanceId("empty-managed-id");
        assert.ok(row, "Expected placeholder row to remain in DB");
        assert.equal(row.archived, 1, "Incomplete managed row should be archived");
      } finally {
        db.close();
      }

      manager.stopAll();
    });
  });

  describe("event emission on restore", () => {
    it("emits instance:created for restored instances", () => {
      seedDB(tempDir, [makeExternalEntry({ jsonlPath: join(fixturesDir, "basic-session.jsonl") })]);
      const manager = makeManager(tempDir);

      const events = [];
      manager.on("instance:created", (id, info) => {
        events.push({ id, info });
      });

      manager.restoreAndScan();

      assert.equal(events.length, 1);
      assert.equal(events[0].id, "test-id");
      assert.equal(events[0].info.name, "Test Session");

      manager.stopAll();
    });
  });
});
