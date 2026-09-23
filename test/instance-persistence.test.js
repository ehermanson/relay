// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildBackfilledManagedRow,
  buildBackfilledSessionRow,
  compareManagedCanonicalRows,
  hasPersistedTokenUsage,
  isSameManagedSessionIdentity,
  mergeBackfilledStats,
  toManagedInstanceRow,
  toSessionRow,
} from "../dist/server/core/instance-persistence.js";

describe("instance-persistence helpers", () => {
  it("builds persisted session and managed rows from instance state", () => {
    const info = {
      id: "instance-1",
      provider: "claude",
      name: "Chat",
      workingDirectory: "/tmp/project",
      status: "idle",
      createdAt: 1000,
      lastActivityAt: 2000,
      customTitle: true,
      runtimeMode: "approval-required",
      lastMessage: { text: "hello", from: "user", timestamp: 1500 },
      gitInfo: { branch: "feature", isWorktree: false },
      projectId: "project-1",
      reviewInstanceId: "review-1",
    };

    const sessionRow = toSessionRow({
      info,
      sessionId: "session-1",
      jsonlPath: "/tmp/project/chat.jsonl",
    });
    const managedRow = toManagedInstanceRow({
      info,
      binding: {
        provider: "claude",
        providerSessionId: "session-1",
        resumeCursor: { sessionId: "session-1" },
        runtimePayload: { foo: "bar" },
        transcriptPath: "/tmp/project/chat.jsonl",
      },
      sessionId: "session-1",
      jsonlPath: "/tmp/project/chat.jsonl",
      defaultRuntimeMode: "approval-required",
    });

    assert.equal(sessionRow.session_id, "session-1");
    assert.equal(managedRow.provider_session_id, "session-1");
    assert.match(managedRow.runtime_payload_json ?? "", /reviewInstanceId/);
  });

  it("detects persisted token usage and compares managed duplicate identity", () => {
    assert.equal(
      hasPersistedTokenUsage({
        input_tokens: 0,
        output_tokens: 1,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
      }),
      true,
    );

    const older = {
      instance_id: "older",
      provider_session_id: "session-1",
      transcript_path: "/tmp/chat.jsonl",
      last_activity_at: 1000,
      resume_cursor_json: null,
      created_at: 1000,
    };
    const newer = {
      instance_id: "newer",
      provider_session_id: "session-1",
      transcript_path: "/tmp/chat.jsonl",
      last_activity_at: 2000,
      resume_cursor_json: JSON.stringify({ sessionId: "session-1" }),
      created_at: 2000,
    };

    assert.equal(isSameManagedSessionIdentity(older, newer), true);
    assert.equal(compareManagedCanonicalRows(newer, older) > 0, true);
  });

  it("merges transcript backfill stats and only rewrites rows when values change", () => {
    const merged = mergeBackfilledStats(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        model: "claude-sonnet",
        contextWindow: 200_000,
      },
      {
        inputTokens: 3,
        outputTokens: 4,
        cacheCreationTokens: 1,
        cacheReadTokens: 2,
      },
    );
    assert.deepEqual(merged, {
      inputTokens: 3,
      outputTokens: 4,
      cacheCreationTokens: 1,
      cacheReadTokens: 2,
      model: "claude-sonnet",
      contextWindow: 200_000,
      contextTokens: undefined,
      contextCategories: undefined,
      reasoningTokens: undefined,
    });

    assert.deepEqual(
      mergeBackfilledStats(undefined, {
        inputTokens: 7,
        outputTokens: 8,
        cacheCreationTokens: 1,
        cacheReadTokens: 2,
      }),
      {
        inputTokens: 7,
        outputTokens: 8,
        cacheCreationTokens: 1,
        cacheReadTokens: 2,
        model: undefined,
        contextWindow: undefined,
        contextTokens: undefined,
        contextCategories: undefined,
        reasoningTokens: undefined,
      },
    );

    const sessionRow = {
      session_id: "session-1",
      instance_id: "instance-1",
      provider_name: "claude",
      name: "Chat",
      working_directory: "/tmp/project",
      jsonl_path: "/tmp/project/chat.jsonl",
      created_at: 1000,
      last_activity_at: 2000,
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
      runtime_mode: null,
      last_message_text: null,
      last_message_from: null,
      last_message_at: null,
      git_info_branch: null,
      git_info_is_worktree: null,
      space_id: null,
      project_id: null,
      model: null,
    };
    const managedRow = {
      instance_id: "managed-1",
      provider_name: "claude",
      provider_session_id: "session-1",
      name: "Managed",
      working_directory: "/tmp/project",
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
      runtime_mode: null,
      resume_cursor_json: null,
      runtime_payload_json: null,
      transcript_path: null,
      last_message_text: null,
      last_message_from: null,
      last_message_at: null,
      git_info_branch: null,
      git_info_is_worktree: null,
      space_id: null,
      project_id: null,
      model: null,
      model_options_json: null,
      original_git_branch: null,
    };

    assert.equal(
      buildBackfilledSessionRow(sessionRow, {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }),
      null,
    );
    assert.equal(
      buildBackfilledManagedRow(
        managedRow,
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        "/tmp/project/chat.jsonl",
      )?.transcript_path,
      "/tmp/project/chat.jsonl",
    );
  });
});
