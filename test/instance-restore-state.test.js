// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildExternalRestoreState,
  buildManagedRestoreState,
} from "../dist/server/core/instance-restore-state.js";

describe("instance-restore-state helpers", () => {
  it("builds external restore state from a persisted session row", () => {
    const restored = buildExternalRestoreState({
      entry: {
        session_id: "session-1",
        instance_id: "instance-1",
        provider_name: "claude",
        name: "External",
        working_directory: "/tmp/project",
        jsonl_path: "/tmp/project/chat.jsonl",
        created_at: 1000,
        last_activity_at: 2000,
        type: "external",
        archived: 0,
        custom_title: 0,
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        summary: null,
        first_prompt: null,
        git_branch: "feature",
        message_count: 0,
        allowed_tools: "[]",
        worktree_path: null,
        original_directory: "/tmp/project",
        parent_session_id: null,
        preferred_model: null,
        reasoning_budget: null,
        runtime_mode: "approval-required",
        last_message_text: "hello",
        last_message_from: "user",
        last_message_at: 1500,
        git_info_branch: "feature",
        git_info_is_worktree: 0,
        space_id: null,
        project_id: "project-1",
        model: "claude-opus",
      },
      provider: "claude",
      workingDirectory: "/tmp/project",
      originalDirectory: "/tmp/project",
      gitBranch: "feature",
      defaultRuntimeMode: "approval-required",
    });

    assert.equal(restored.info.lastMessage?.text, "hello");
    assert.equal(restored.providerBinding.providerSessionId, "session-1");
  });

  it("carries the pinned and done markers onto restored instance info", () => {
    // Live WS instances override REST chat summaries in the sidebar, so a
    // restored instance that drops done_at would silently pop a done chat
    // back into the inbox on server restart.
    const base = {
      session_id: "session-2",
      instance_id: "instance-2",
      provider_name: "claude",
      name: "External",
      working_directory: "/tmp/project",
      jsonl_path: "/tmp/project/chat-2.jsonl",
      created_at: 1000,
      last_activity_at: 2000,
      type: "external",
      archived: 0,
      custom_title: 0,
      pinned: 1,
      done_at: 1800,
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
      original_directory: "/tmp/project",
      parent_session_id: null,
      preferred_model: null,
      reasoning_budget: null,
      runtime_mode: "approval-required",
      last_message_text: null,
      last_message_from: null,
      last_message_at: null,
      git_info_branch: null,
      git_info_is_worktree: 0,
      space_id: null,
      project_id: "project-1",
      model: null,
    };

    const restored = buildExternalRestoreState({
      entry: base,
      provider: "claude",
      workingDirectory: "/tmp/project",
      originalDirectory: "/tmp/project",
      defaultRuntimeMode: "approval-required",
    });

    assert.equal(restored.info.pinned, true);
    assert.equal(restored.info.doneAt, 1800);
  });

  it("leaves doneAt undefined when the chat was never marked done", () => {
    const restored = buildManagedRestoreState({
      entry: {
        instance_id: "managed-2",
        provider_name: "claude",
        provider_session_id: "provider-session-2",
        name: "Managed",
        working_directory: "/tmp/project",
        created_at: 1000,
        last_activity_at: 2000,
        archived: 0,
        custom_title: 0,
        pinned: 0,
        done_at: null,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        git_branch: null,
        worktree_path: null,
        original_directory: "/tmp/project",
        parent_session_id: null,
        preferred_model: null,
        reasoning_budget: null,
        runtime_mode: "approval-required",
        resume_cursor_json: null,
        runtime_payload_json: null,
        transcript_path: null,
        last_message_text: null,
        last_message_from: null,
        last_message_at: null,
        git_info_branch: null,
        git_info_is_worktree: 0,
        space_id: null,
        project_id: "project-1",
        model: null,
        model_options_json: null,
        original_git_branch: null,
      },
      workingDirectory: "/tmp/project",
      originalDirectory: "/tmp/project",
      defaultRuntimeMode: "approval-required",
    });

    assert.equal(restored.info.doneAt, undefined);
    assert.equal(restored.info.pinned, false);
  });

  it("builds managed restore state with bootstrap flags from runtime payload", () => {
    const restored = buildManagedRestoreState({
      entry: {
        instance_id: "managed-1",
        provider_name: "codex",
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
        original_directory: "/tmp/project",
        parent_session_id: null,
        preferred_model: null,
        reasoning_budget: null,
        runtime_mode: "approval-required",
        resume_cursor_json: null,
        runtime_payload_json: null,
        transcript_path: null,
        last_message_text: null,
        last_message_from: null,
        last_message_at: null,
        git_info_branch: null,
        git_info_is_worktree: null,
        space_id: null,
        project_id: "project-1",
        model: null,
        model_options_json: null,
        original_git_branch: null,
      },
      workingDirectory: "/tmp/project",
      originalDirectory: "/tmp/project",
      resumeCursor: { sessionId: "session-1" },
      runtimePayload: {
        sessionContext: {
          bootstrap: {
            blocks: [{ kind: "task_guidance", key: "t", title: "T", text: "x" }],
          },
        },
      },
      resumeSessionId: "session-1",
      transcriptPath: "/tmp/project/chat.jsonl",
      review: undefined,
    });

    assert.equal(restored.info.sessionId, "session-1");
    assert.equal(restored.taskContextInjected, true);
    assert.equal(restored.customInstructionsInjected, false);
  });
});
