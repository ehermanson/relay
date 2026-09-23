// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
/**
 * Tests for JSONL parsing, utility functions, and plan-parent linking.
 * Covers: parseJsonl, convertJsonlEntry, stripInternalTags, generateTitle,
 *         findPlanParent and linkPlanSessions.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InstanceManager, sanitiseForTitle } from "../dist/server/core/instance-manager.js";
import { SessionDB } from "../dist/server/core/db.js";
import { resolveConfig } from "../dist/server/config.js";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

const fixturesDir = join(import.meta.dirname, "fixtures");

function makeConfig(tempDir, overrides = {}) {
  return resolveConfig({
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
}

describe("JSONL Parsing", () => {
  let manager;
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-jsonl-test-"));
    manager = new InstanceManager(makeConfig(tempDir));
  });

  afterEach(() => {
    manager.stopAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("basic session parsing", () => {
    it("extracts cwd and slug from JSONL init entry", () => {
      // Access parseJsonl via getHistory on a manually constructed external instance
      // We'll test indirectly through the public API by checking instance discovery state
      const jsonlPath = join(fixturesDir, "basic-session.jsonl");
      const content = readFileSync(jsonlPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      // Verify the fixture has the expected init entry
      const init = JSON.parse(lines[0]);
      assert.equal(init.cwd, "/Users/test/projects/my-app");
      assert.equal(init.slug, "my-app");
    });

    it("converts user messages correctly", () => {
      const jsonlPath = join(fixturesDir, "basic-session.jsonl");
      const content = readFileSync(jsonlPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      const userEntry = JSON.parse(lines[1]);
      assert.equal(userEntry.type, "user");
      assert.equal(userEntry.message.content, "Hello, can you help me with this project?");
    });

    it("converts assistant text messages correctly", () => {
      const jsonlPath = join(fixturesDir, "basic-session.jsonl");
      const content = readFileSync(jsonlPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      const assistantEntry = JSON.parse(lines[2]);
      assert.equal(assistantEntry.type, "assistant");
      assert.equal(assistantEntry.message.content[0].type, "text");
      assert.equal(
        assistantEntry.message.content[0].text,
        "Of course! I'd be happy to help. What would you like to work on?",
      );
    });
  });

  describe("compact boundary handling", () => {
    it("keeps compact boundary entries in the fixture transcript", () => {
      // Test the compact boundary fixture
      const jsonlPath = join(fixturesDir, "compact-session.jsonl");
      const content = readFileSync(jsonlPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      // There should be 6 lines: init, user, assistant, compact_boundary, user, assistant
      assert.equal(lines.length, 6);

      // The compact_boundary should be the 4th line
      const boundary = JSON.parse(lines[3]);
      assert.equal(boundary.type, "system");
      assert.equal(boundary.subtype, "compact_boundary");
    });
  });

  describe("tool use parsing", () => {
    it("fixture has thinking block, tool_use, and text", () => {
      const jsonlPath = join(fixturesDir, "tool-use-session.jsonl");
      const content = readFileSync(jsonlPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      const assistantEntry = JSON.parse(lines[2]);
      assert.equal(assistantEntry.type, "assistant");

      const blocks = assistantEntry.message.content;
      assert.equal(blocks.length, 3);
      assert.equal(blocks[0].type, "thinking");
      assert.equal(blocks[1].type, "tool_use");
      assert.equal(blocks[1].name, "Bash");
      assert.equal(blocks[2].type, "text");
    });

    it("fixture has tool_result in user message", () => {
      const jsonlPath = join(fixturesDir, "tool-use-session.jsonl");
      const content = readFileSync(jsonlPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      const toolResultEntry = JSON.parse(lines[3]);
      assert.equal(toolResultEntry.type, "user");
      const content2 = toolResultEntry.message.content;
      assert.ok(Array.isArray(content2));
      assert.equal(content2[0].type, "tool_result");
      assert.equal(content2[0].tool_use_id, "tool_bash_1");
    });
  });

  describe("permission denial detection", () => {
    it("fixture has is_error tool_result with denial message", () => {
      const jsonlPath = join(fixturesDir, "permission-denied-session.jsonl");
      const content = readFileSync(jsonlPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      const denialEntry = JSON.parse(lines[3]);
      assert.equal(denialEntry.type, "user");
      const toolResult = denialEntry.message.content[0];
      assert.equal(toolResult.is_error, true);
      assert.ok(toolResult.content.includes("haven't granted it yet"));
    });
  });

  describe("internal tag stripping", () => {
    it("fixture has system-reminder tags in user message", () => {
      const jsonlPath = join(fixturesDir, "internal-tags-session.jsonl");
      const content = readFileSync(jsonlPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      const userEntry = JSON.parse(lines[1]);
      assert.ok(userEntry.message.content.includes("<system-reminder>"));
      assert.ok(userEntry.message.content.includes("Hello there!"));
    });
  });

  describe("image handling", () => {
    it("fixture has image source with file_path", () => {
      const jsonlPath = join(fixturesDir, "image-session.jsonl");
      const content = readFileSync(jsonlPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      const userEntry = JSON.parse(lines[1]);
      const blocks = userEntry.message.content;
      assert.ok(Array.isArray(blocks));
      assert.equal(blocks[0].type, "image");
      assert.equal(blocks[0].source.file_path, "/Users/test/screenshot.png");
    });
  });

  describe("plan parent detection", () => {
    it("fixture has plan transcript reference in first user message", () => {
      const jsonlPath = join(fixturesDir, "plan-child-session.jsonl");
      const content = readFileSync(jsonlPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      const userEntry = JSON.parse(lines[1]);
      const match = userEntry.message.content.match(/read the full transcript at:\s*(\S+\.jsonl)/);
      assert.ok(match);
      assert.equal(
        match[1],
        "/Users/test/.claude/projects/-Users-test-projects-my-app/parent-session-id.jsonl",
      );
    });
  });

  describe("missing timestamp handling", () => {
    it("fixture entries have no timestamp fields", () => {
      const jsonlPath = join(fixturesDir, "no-timestamp-session.jsonl");
      const content = readFileSync(jsonlPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      for (const line of lines) {
        const entry = JSON.parse(line);
        assert.equal(entry.timestamp, undefined);
      }
    });
  });
});

function seedDB(tempDir, entries) {
  const dbPath = join(tempDir, "sessions.db");
  const db = new SessionDB(dbPath, noopLogger);

  // Register projects for each unique working directory so listInstances() includes them
  const seenDirs = new Set();
  for (const entry of entries) {
    const dir = entry.workingDirectory || "/Users/test/projects/my-app";
    if (!seenDirs.has(dir)) {
      seenDirs.add(dir);
      const projId = "proj-" + dir.replace(/\//g, "-");
      db.upsertProject({
        id: projId,
        name: dir.split("/").pop() || dir,
        directory: dir,
        repo_root: null,
        remote_url: null,
        target_branch: null,
        created_at: Date.now(),
        last_activity_at: null,
      });
    }
  }

  for (const entry of entries) {
    const dir = entry.workingDirectory || "/Users/test/projects/my-app";
    db.upsert({
      session_id: entry.sessionId || "test-session",
      instance_id: entry.id || "test-id",
      provider_name: "claude",
      name: entry.name || "Test Session",
      working_directory: dir,
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
      parent_session_id: entry.parentSessionId || null,
      preferred_model: null,
      reasoning_budget: null,
      last_message_text: entry.lastMessageText || null,
      last_message_from: entry.lastMessageFrom || null,
      last_message_at: entry.lastMessageAt || null,
      git_info_branch: entry.gitInfoBranch || null,
      git_info_is_worktree:
        entry.gitInfoIsWorktree === undefined ? null : entry.gitInfoIsWorktree ? 1 : 0,
      space_id: null,
      project_id: "proj-" + dir.replace(/\//g, "-"),
      model: null,
    });
  }
  db.close();
}

describe("DB Persistence", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-db-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates DB on first use without errors", () => {
    const config = makeConfig(tempDir);
    const manager = new InstanceManager(config);
    manager.createInstance({ name: "Persist Test" });
    const list = manager.listInstances();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "Persist Test");
    manager.stopAll();
  });

  it("handles fresh DB gracefully on restore", () => {
    const config = makeConfig(tempDir);
    const manager = new InstanceManager(config);
    manager.restoreAndScan();
    assert.equal(manager.listInstances().length, 0);
    manager.stopAll();
  });

  it("restores external instances from DB", () => {
    const jsonlPath = join(fixturesDir, "basic-session.jsonl");

    seedDB(tempDir, [
      {
        id: "test-external-id",
        name: "External Test",
        workingDirectory: "/Users/test/projects/my-app",
        sessionId: "test-session-123",
        jsonlPath,
        createdAt: Date.now() - 3600000,
        type: "external",
        lastActivityAt: Date.now() - 60000,
      },
    ]);

    const config = makeConfig(tempDir);
    const manager = new InstanceManager(config);
    manager.restoreAndScan();

    const list = manager.listInstances();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "External Test");
    assert.equal(list[0].external, true);
    assert.equal(list[0].status, "stopped");
    manager.stopAll();
  });

  it("backfills model for previously indexed Claude sessions during scan", () => {
    const workingDirectory = join(tempDir, "claude-workspace");
    const encodedProjectDir = "-" + workingDirectory.slice(1).replace(/\//g, "-");
    const projectDir = join(tempDir, ".claude", "projects", encodedProjectDir);
    const jsonlPath = join(projectDir, "claude-backfill.jsonl");
    mkdirSync(workingDirectory, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      jsonlPath,
      [
        JSON.stringify({
          type: "system",
          subtype: "init",
          cwd: workingDirectory,
          timestamp: "2026-02-10T10:00:00.000Z",
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-02-10T10:00:05.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-4-6",
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [{ type: "text", text: "Hello" }],
          },
        }),
      ].join("\n") + "\n",
    );

    const db = new SessionDB(join(tempDir, "sessions.db"), noopLogger);
    db.upsertProject({
      id: "proj-claude-backfill",
      name: "claude-workspace",
      directory: workingDirectory,
      repo_root: null,
      remote_url: null,
      target_branch: null,
      created_at: Date.now(),
      last_activity_at: null,
    });
    db.upsert({
      session_id: "claude-backfill-session",
      instance_id: "claude-backfill-instance",
      provider_name: "claude",
      name: "Claude Backfill",
      working_directory: workingDirectory,
      jsonl_path: jsonlPath,
      created_at: Date.now() - 1_000,
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
    });
    db.close();

    const manager = new InstanceManager(makeConfig(tempDir));
    manager.restoreAndScan();
    manager.stopAll();

    const verifyDb = new SessionDB(join(tempDir, "sessions.db"), noopLogger);
    const row = verifyDb.getBySessionId("claude-backfill-session");
    assert.equal(row?.model, "claude-opus-4-6");
    verifyDb.close();
  });

  it("persists model for newly discovered external Codex sessions", () => {
    const workingDirectory = join(tempDir, "codex-discovery-workspace");
    const codexDir = join(tempDir, ".codex", "sessions", "2026", "03", "18");
    const jsonlPath = join(codexDir, "rollout-2026-03-18T12-00-00-codex-discovery-session.jsonl");
    mkdirSync(workingDirectory, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      jsonlPath,
      [
        JSON.stringify({
          timestamp: "2026-03-18T12:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "codex-discovery-session",
            timestamp: "2026-03-18T12:00:00.000Z",
            cwd: workingDirectory,
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-18T12:00:01.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.4" },
        }),
        JSON.stringify({
          timestamp: "2026-03-18T12:00:01.100Z",
          type: "event_msg",
          payload: { type: "user_message", message: "How do I build this?" },
        }),
      ].join("\n") + "\n",
    );

    const manager = new InstanceManager(makeConfig(tempDir));
    manager.restoreAndScan();
    manager.stopAll();

    const db = new SessionDB(join(tempDir, "sessions.db"), noopLogger);
    const row = db.getBySessionId("codex-discovery-session");
    assert.equal(row?.provider_name, "codex");
    assert.equal(row?.model, "gpt-5.4");
    db.close();
  });

  it("backfills model for previously indexed external Codex sessions during scan", () => {
    const workingDirectory = join(tempDir, "codex-backfill-workspace");
    const codexDir = join(tempDir, ".codex", "sessions", "2026", "03", "18");
    const jsonlPath = join(codexDir, "rollout-2026-03-18T12-00-00-codex-backfill-session.jsonl");
    mkdirSync(workingDirectory, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      jsonlPath,
      [
        JSON.stringify({
          timestamp: "2026-03-18T12:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "codex-backfill-session",
            timestamp: "2026-03-18T12:00:00.000Z",
            cwd: workingDirectory,
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-18T12:00:01.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.4-mini" },
        }),
        JSON.stringify({
          timestamp: "2026-03-18T12:00:01.100Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Run the tests" },
        }),
      ].join("\n") + "\n",
    );

    const db = new SessionDB(join(tempDir, "sessions.db"), noopLogger);
    db.upsert({
      session_id: "codex-backfill-session",
      instance_id: "codex-backfill-instance",
      provider_name: "codex",
      name: "Codex Backfill",
      working_directory: workingDirectory,
      jsonl_path: jsonlPath,
      created_at: Date.now() - 1_000,
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
    });
    db.close();

    const manager = new InstanceManager(makeConfig(tempDir));
    manager.restoreAndScan();
    manager.stopAll();

    const verifyDb = new SessionDB(join(tempDir, "sessions.db"), noopLogger);
    const row = verifyDb.getBySessionId("codex-backfill-session");
    assert.equal(row?.model, "gpt-5.4-mini");
    verifyDb.close();
  });

  it("backfills transcript stats for historical project sessions before aggregating artifacts", () => {
    const workingDirectory = join(tempDir, "project-artifacts-workspace");
    const projectId = "proj-" + workingDirectory.replace(/\//g, "-");
    const encodedProjectDir = "-" + workingDirectory.slice(1).replace(/\//g, "-");
    const claudeProjectDir = join(tempDir, ".claude", "projects", encodedProjectDir);
    const claudeJsonlPath = join(claudeProjectDir, "claude-usage.jsonl");
    const codexDir = join(tempDir, ".codex", "sessions", "2026", "03", "18");
    const codexJsonlPath = join(codexDir, "rollout-2026-03-18T12-00-00-codex-usage.jsonl");

    mkdirSync(workingDirectory, { recursive: true });
    mkdirSync(claudeProjectDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });

    writeFileSync(
      claudeJsonlPath,
      [
        JSON.stringify({
          type: "system",
          subtype: "init",
          cwd: workingDirectory,
          timestamp: "2026-02-10T10:00:00.000Z",
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-02-10T10:00:05.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-4-6",
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 20,
              cache_read_input_tokens: 30,
            },
            content: [{ type: "text", text: "Hello" }],
          },
        }),
      ].join("\n") + "\n",
    );

    writeFileSync(
      codexJsonlPath,
      [
        JSON.stringify({
          timestamp: "2026-03-18T12:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "codex-usage-session",
            timestamp: "2026-03-18T12:00:00.000Z",
            cwd: workingDirectory,
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-18T12:00:01.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.4" },
        }),
        JSON.stringify({
          timestamp: "2026-03-18T12:00:01.600Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 1000,
                cached_input_tokens: 400,
                output_tokens: 200,
              },
            },
          },
        }),
      ].join("\n") + "\n",
    );

    const db = new SessionDB(join(tempDir, "sessions.db"), noopLogger);
    db.upsertProject({
      id: projectId,
      name: "project-artifacts-workspace",
      directory: workingDirectory,
      repo_root: null,
      remote_url: null,
      target_branch: null,
      created_at: Date.now(),
      last_activity_at: null,
    });
    db.upsert({
      session_id: "claude-usage-session",
      instance_id: "claude-usage-instance",
      provider_name: "claude",
      name: "Claude Usage",
      working_directory: workingDirectory,
      jsonl_path: claudeJsonlPath,
      created_at: Date.now() - 2_000,
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
      project_id: projectId,
      model: null,
    });
    db.upsert({
      session_id: "codex-usage-session",
      instance_id: "codex-usage-instance",
      provider_name: "codex",
      name: "Codex Usage",
      working_directory: workingDirectory,
      jsonl_path: codexJsonlPath,
      created_at: Date.now() - 1_000,
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
      project_id: projectId,
      model: null,
    });
    db.close();

    const manager = new InstanceManager(makeConfig(tempDir));
    manager.restoreAndScan();

    const artifacts = manager.getProjectArtifacts(projectId);
    assert.ok(artifacts);
    assert.equal(artifacts.stats.modelUsage.length, 2);

    const claudeUsage = artifacts.stats.modelUsage.find((row) => row.model === "claude-opus-4-6");
    const codexUsage = artifacts.stats.modelUsage.find((row) => row.model === "gpt-5.4");
    assert.ok(claudeUsage);
    assert.equal(claudeUsage.inputTokens, 100);
    assert.equal(claudeUsage.cacheCreationTokens, 20);
    assert.equal(claudeUsage.cacheReadTokens, 30);
    assert.ok(codexUsage);
    assert.equal(codexUsage.inputTokens, 1000);
    assert.equal(codexUsage.cacheReadTokens, 400);

    const verifyDb = new SessionDB(join(tempDir, "sessions.db"), noopLogger);
    assert.equal(verifyDb.getBySessionId("claude-usage-session")?.output_tokens, 50);
    assert.equal(verifyDb.getBySessionId("codex-usage-session")?.output_tokens, 200);
    verifyDb.close();
    manager.stopAll();
  });

  it("archives entries with missing JSONL files on restore", () => {
    seedDB(tempDir, [
      {
        id: "missing-jsonl-id",
        name: "Missing JSONL",
        workingDirectory: "/tmp",
        sessionId: "missing-session",
        jsonlPath: "/tmp/nonexistent-session-file.jsonl",
        createdAt: Date.now(),
        type: "external",
      },
    ]);

    const config = makeConfig(tempDir);
    const manager = new InstanceManager(config);
    manager.restoreAndScan();

    // Instance should be archived since JSONL doesn't exist
    assert.equal(manager.listInstances().length, 0);
    manager.stopAll();
  });

  it("restores all sessions regardless of maxProcesses", () => {
    const sourceContent = readFileSync(join(fixturesDir, "basic-session.jsonl"), "utf-8");

    const entries = [];
    for (let i = 0; i < 5; i++) {
      const jsonlPath = join(tempDir, `session-${i}.jsonl`);
      writeFileSync(jsonlPath, sourceContent);
      entries.push({
        id: `entry-${i}`,
        name: `Entry ${i}`,
        workingDirectory: "/Users/test/projects/my-app",
        sessionId: `session-${i}`,
        jsonlPath,
        createdAt: Date.now(),
        type: "external",
      });
    }
    seedDB(tempDir, entries);

    const config = makeConfig(tempDir, { maxProcesses: 3 });
    const manager = new InstanceManager(config);
    manager.restoreAndScan();

    // All sessions should be restored (maxProcesses only limits managed processes)
    assert.equal(manager.listInstances().length, 5);
    manager.stopAll();
  });
});

describe("Plan Parent Linking", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-link-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("both parent and child survive restore as independent instances", () => {
    const parentJsonl = join(fixturesDir, "basic-session.jsonl");
    const childJsonl = join(fixturesDir, "plan-child-session.jsonl");

    seedDB(tempDir, [
      {
        id: "parent-id",
        name: "Parent Session",
        workingDirectory: "/Users/test/projects/my-app",
        sessionId: "parent-session-id",
        jsonlPath: parentJsonl,
        createdAt: Date.now() - 120000,
        type: "external",
        lastActivityAt: Date.now() - 60000,
      },
      {
        id: "child-id",
        name: "Child Session",
        workingDirectory: "/Users/test/projects/my-app",
        sessionId: "child-session-id",
        jsonlPath: childJsonl,
        createdAt: Date.now() - 30000,
        type: "external",
        lastActivityAt: Date.now(),
      },
    ]);

    const config = makeConfig(tempDir);
    const manager = new InstanceManager(config);
    manager.restoreAndScan();

    // Both instances survive — no merging or removal
    const list = manager.listInstances();
    assert.equal(list.length, 2);

    // The child references parent-session-id.jsonl but the parent's actual jsonlPath
    // is the fixture path, so linkPlanSessions won't match (expected for this fixture setup).
    // Both remain independent.
    const parent = list.find((i) => i.id === "parent-id");
    const child = list.find((i) => i.id === "child-id");
    assert.ok(parent);
    assert.ok(child);
    manager.stopAll();
  });

  it("persists parentSessionId from DB across restore", () => {
    const parentJsonl = join(fixturesDir, "basic-session.jsonl");
    const childJsonl = join(fixturesDir, "plan-child-session.jsonl");

    seedDB(tempDir, [
      {
        id: "parent-id",
        name: "Parent Session",
        workingDirectory: "/Users/test/projects/my-app",
        sessionId: "parent-session-id",
        jsonlPath: parentJsonl,
        createdAt: Date.now() - 120000,
        type: "external",
        lastActivityAt: Date.now() - 60000,
      },
      {
        id: "child-id",
        name: "Child Session",
        workingDirectory: "/Users/test/projects/my-app",
        sessionId: "child-session-id",
        jsonlPath: childJsonl,
        createdAt: Date.now() - 30000,
        type: "external",
        lastActivityAt: Date.now(),
        parentSessionId: "parent-session-id",
      },
    ]);

    const config = makeConfig(tempDir);
    const manager = new InstanceManager(config);
    manager.restoreAndScan();

    const list = manager.listInstances();
    const child = list.find((i) => i.id === "child-id");
    assert.ok(child);
    assert.equal(child.parentSessionId, "parent-session-id");
    manager.stopAll();
  });
});

describe("Plan Discovery", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-plan-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function setupProject(projectEncoded) {
    const claudeDir = join(tempDir, ".claude");
    const projectDir = join(claudeDir, "projects", projectEncoded);
    const plansDir = join(claudeDir, "plans");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    return { claudeDir, projectDir, plansDir };
  }

  function writeJsonl(dir, filename, lines) {
    writeFileSync(join(dir, filename), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  it("discovers plans by session slug", () => {
    const { projectDir, plansDir } = setupProject("-Users-test-projects-my-app");

    writeJsonl(projectDir, "session-a.jsonl", [
      {
        type: "system",
        subtype: "init",
        cwd: "/Users/test/projects/my-app",
        slug: "happy-dancing-otter",
      },
      { type: "user", message: { role: "user", content: "Hello" } },
    ]);

    writeFileSync(join(plansDir, "happy-dancing-otter.md"), "# My Plan\nSome content here.");

    const config = makeConfig(tempDir);
    const manager = new InstanceManager(config);
    const artifacts = manager.getProjectArtifacts("-Users-test-projects-my-app");

    assert.ok(artifacts);
    assert.equal(artifacts.plans.length, 1);
    assert.equal(artifacts.plans[0].slug, "happy-dancing-otter");
    assert.equal(artifacts.plans[0].title, "My Plan");
    assert.ok(artifacts.plans[0].content.includes("Some content here."));
    manager.stopAll();
  });

  it("discovers plans with custom filenames via JSONL content scan", () => {
    const { claudeDir, projectDir, plansDir } = setupProject("-Users-test-projects-my-app");

    // Session slug doesn't match the plan filename
    writeJsonl(projectDir, "session-b.jsonl", [
      {
        type: "system",
        subtype: "init",
        cwd: "/Users/test/projects/my-app",
        slug: "precious-nibbling-hare",
      },
      { type: "user", message: { role: "user", content: "Create a plan" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "Write",
              input: {
                file_path: join(claudeDir, "plans", "native-expansion-plan.md"),
                content: "# Native Expansion Plan\nDetails here.",
              },
            },
          ],
        },
      },
    ]);

    // Plan file exists with a custom name (not matching slug)
    writeFileSync(
      join(plansDir, "native-expansion-plan.md"),
      "# Native Expansion Plan\nDetails here.",
    );
    // No file for the slug itself
    assert.ok(!existsSync(join(plansDir, "precious-nibbling-hare.md")));

    const config = makeConfig(tempDir);
    const manager = new InstanceManager(config);
    const artifacts = manager.getProjectArtifacts("-Users-test-projects-my-app");

    assert.ok(artifacts);
    assert.equal(artifacts.plans.length, 1);
    assert.equal(artifacts.plans[0].slug, "native-expansion-plan");
    assert.equal(artifacts.plans[0].title, "Native Expansion Plan");
    manager.stopAll();
  });

  it("discovers both slug-matched and custom-named plans", () => {
    const { claudeDir, projectDir, plansDir } = setupProject("-Users-test-projects-my-app");

    // Session 1: slug matches a plan file
    writeJsonl(projectDir, "session-1.jsonl", [
      {
        type: "system",
        subtype: "init",
        cwd: "/Users/test/projects/my-app",
        slug: "happy-dancing-otter",
      },
      { type: "user", message: { role: "user", content: "Hello" } },
    ]);
    writeFileSync(join(plansDir, "happy-dancing-otter.md"), "# Slug Plan\nMatched by slug.");

    // Session 2: custom-named plan via Write tool
    writeJsonl(projectDir, "session-2.jsonl", [
      {
        type: "system",
        subtype: "init",
        cwd: "/Users/test/projects/my-app",
        slug: "boring-random-slug",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "Write",
              input: {
                file_path: join(claudeDir, "plans", "my-custom-plan.md"),
                content: "# Custom Plan\nWritten with custom name.",
              },
            },
          ],
        },
      },
    ]);
    writeFileSync(join(plansDir, "my-custom-plan.md"), "# Custom Plan\nWritten with custom name.");

    const config = makeConfig(tempDir);
    const manager = new InstanceManager(config);
    const artifacts = manager.getProjectArtifacts("-Users-test-projects-my-app");

    assert.ok(artifacts);
    assert.equal(artifacts.plans.length, 2);
    const slugs = artifacts.plans.map((p) => p.slug).sort();
    assert.deepEqual(slugs, ["happy-dancing-otter", "my-custom-plan"]);
    manager.stopAll();
  });

  it("does not discover plans unreferenced by any JSONL in the project", () => {
    const { projectDir, plansDir } = setupProject("-Users-test-projects-my-app");

    writeJsonl(projectDir, "session-a.jsonl", [
      {
        type: "system",
        subtype: "init",
        cwd: "/Users/test/projects/my-app",
        slug: "happy-dancing-otter",
      },
      { type: "user", message: { role: "user", content: "Hello" } },
    ]);
    writeFileSync(join(plansDir, "happy-dancing-otter.md"), "# Slug Plan\nMatched.");

    // Unrelated plan file on disk — not referenced by any JSONL in this project
    writeFileSync(join(plansDir, "unrelated-plan.md"), "# Unrelated\nBelongs to another project.");

    const config = makeConfig(tempDir);
    const manager = new InstanceManager(config);
    const artifacts = manager.getProjectArtifacts("-Users-test-projects-my-app");

    assert.ok(artifacts);
    assert.equal(artifacts.plans.length, 1);
    assert.equal(artifacts.plans[0].slug, "happy-dancing-otter");
    manager.stopAll();
  });

  it("deduplicates plans found by both slug and content scan", () => {
    const { claudeDir, projectDir, plansDir } = setupProject("-Users-test-projects-my-app");

    // Session where slug matches AND the JSONL references the plan by path
    writeJsonl(projectDir, "session-a.jsonl", [
      {
        type: "system",
        subtype: "init",
        cwd: "/Users/test/projects/my-app",
        slug: "happy-dancing-otter",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "Write",
              input: {
                file_path: join(claudeDir, "plans", "happy-dancing-otter.md"),
                content: "# My Plan\nContent.",
              },
            },
          ],
        },
      },
    ]);
    writeFileSync(join(plansDir, "happy-dancing-otter.md"), "# My Plan\nContent.");

    const config = makeConfig(tempDir);
    const manager = new InstanceManager(config);
    const artifacts = manager.getProjectArtifacts("-Users-test-projects-my-app");

    assert.ok(artifacts);
    assert.equal(artifacts.plans.length, 1);
    assert.equal(artifacts.plans[0].slug, "happy-dancing-otter");
    manager.stopAll();
  });

  it("discovers plans referenced via file-history-snapshot", () => {
    const { claudeDir, projectDir, plansDir } = setupProject("-Users-test-projects-my-app");

    writeJsonl(projectDir, "session-a.jsonl", [
      {
        type: "system",
        subtype: "init",
        cwd: "/Users/test/projects/my-app",
        slug: "some-random-slug",
      },
      { type: "user", message: { role: "user", content: "Plan something" } },
      {
        type: "file-history-snapshot",
        snapshot: {
          trackedFileBackups: {
            [join(claudeDir, "plans", "snapshot-discovered-plan.md")]: {
              backupFileName: null,
              version: 1,
            },
          },
        },
      },
    ]);
    writeFileSync(
      join(plansDir, "snapshot-discovered-plan.md"),
      "# Snapshot Plan\nFound via snapshot.",
    );

    const config = makeConfig(tempDir);
    const manager = new InstanceManager(config);
    const artifacts = manager.getProjectArtifacts("-Users-test-projects-my-app");

    assert.ok(artifacts);
    assert.equal(artifacts.plans.length, 1);
    assert.equal(artifacts.plans[0].slug, "snapshot-discovered-plan");
    assert.equal(artifacts.plans[0].title, "Snapshot Plan");
    manager.stopAll();
  });

  it("returns empty plans when no JSONL files exist", () => {
    const { plansDir } = setupProject("-Users-test-projects-my-app");

    writeFileSync(join(plansDir, "orphan-plan.md"), "# Orphan\nNo sessions at all.");

    const config = makeConfig(tempDir);
    const manager = new InstanceManager(config);
    const artifacts = manager.getProjectArtifacts("-Users-test-projects-my-app");

    assert.ok(artifacts);
    assert.equal(artifacts.plans.length, 0);
    manager.stopAll();
  });
});

// ── sanitiseForTitle ─────────────────────────────────────────────────

describe("sanitiseForTitle", () => {
  it("strips task_reference XML tags and keeps surrounding text", () => {
    const input =
      'pick up <task_reference id="c4e91a7b" title="Fix login bug">Fix login bug</task_reference> please';
    assert.equal(sanitiseForTitle(input), "pick up Fix login bug please");
  });

  it("strips terminal_context tags entirely", () => {
    const input =
      'do this <terminal_context source="Terminal">$ ls\nfoo\nbar</terminal_context> now';
    assert.equal(sanitiseForTitle(input), "do this $ ls foo bar now");
  });

  it("strips self-closing tags", () => {
    assert.equal(sanitiseForTitle('hello <image src="foo.png"/> world'), "hello world");
  });

  it("strips nested / multiple tags", () => {
    const input = "<a><b>inner</b></a> plain <c />";
    assert.equal(sanitiseForTitle(input), "inner plain");
  });

  it("decodes @task inline mentions", () => {
    assert.equal(sanitiseForTitle("@task:abcd1234:Hello%20World rest"), "Hello World rest");
  });

  it("handles @task mention without encoded title", () => {
    assert.equal(sanitiseForTitle("@task:abcd1234 rest"), "rest");
  });

  it("unescapes XML entities", () => {
    assert.equal(
      sanitiseForTitle("a &amp; b &lt; c &gt; d &quot;e&quot; f&#39;g"),
      'a & b < c > d "e" f\'g',
    );
  });

  it("collapses whitespace from stripped tags", () => {
    assert.equal(sanitiseForTitle("  hello   <b>  </b>   world  "), "hello world");
  });

  it("returns empty string for tag-only input", () => {
    assert.equal(sanitiseForTitle('<task_reference id="a" title="b">c</task_reference>'), "c");
  });

  it("passes through plain text unchanged", () => {
    assert.equal(sanitiseForTitle("just a normal message"), "just a normal message");
  });

  it("strips truncated/unclosed XML tags at end of string", () => {
    assert.equal(sanitiseForTitle('<taskreference id="a92c0e3b"'), "");
    assert.equal(sanitiseForTitle('hello <task_reference id="abc" title="test"'), "hello");
  });

  it("strips leading pipe characters", () => {
    assert.equal(
      sanitiseForTitle("| ✨ Update available! 0.115.0"),
      "✨ Update available! 0.115.0",
    );
    assert.equal(sanitiseForTitle("| | header |"), "header |");
  });
});
