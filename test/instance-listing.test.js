// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sortChatsByLastActivity,
  summaryFromManagedRow,
  summaryFromSessionRow,
  toChatSummaryInfo,
} from "../dist/server/core/instance-listing.js";

describe("instance-listing helpers", () => {
  it("builds a session summary from an external row", () => {
    const summary = summaryFromSessionRow({
      session_id: "session-1",
      instance_id: "instance-1",
      provider_name: "claude",
      name: "External chat",
      working_directory: "/tmp/project",
      jsonl_path: "/tmp/project/chat.jsonl",
      created_at: 1000,
      last_activity_at: 2000,
      type: "external",
      archived: 0,
      custom_title: 1,
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
      original_directory: null,
      parent_session_id: null,
      preferred_model: null,
      reasoning_budget: null,
      runtime_mode: "approval-required",
      last_message_text: null,
      last_message_from: null,
      last_message_at: null,
      git_info_branch: "feature",
      git_info_is_worktree: 0,
      space_id: null,
      project_id: "project-1",
      model: "claude-opus",
    });

    assert.equal(summary.id, "instance-1");
    assert.equal(summary.provider, "claude");
    assert.equal(summary.stats?.model, "claude-opus");
  });

  it("builds a managed summary only from explicit review payload metadata", () => {
    const summary = summaryFromManagedRow({
      instance_id: "managed-1",
      provider_name: "codex",
      provider_session_id: "session-1",
      name: 'Review the recent changes from "Ignored".',
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
      parent_session_id: "source-session",
      preferred_model: null,
      reasoning_budget: null,
      runtime_mode: "approval-required",
      resume_cursor_json: null,
      runtime_payload_json: JSON.stringify({
        review: {
          sourceSessionId: "source-session",
          sourceName: "Source",
          scope: "branch",
        },
        reviewInstanceId: "review-1",
      }),
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
    });

    assert.equal(summary.review?.sourceName, "Source");
    assert.equal(summary.reviewInstanceId, "review-1");
  });

  it("drops lastMessage from chat summaries and sorts by activity", () => {
    const older = {
      id: "older",
      provider: "claude",
      name: "Older",
      workingDirectory: "/tmp/project",
      status: "stopped",
      createdAt: 1000,
      lastActivityAt: 1000,
      lastMessage: { text: "hi", from: "user", timestamp: 1000 },
    };
    const newer = {
      id: "newer",
      provider: "claude",
      name: "Newer",
      workingDirectory: "/tmp/project",
      status: "stopped",
      createdAt: 1000,
      lastActivityAt: 2000,
    };

    assert.equal(toChatSummaryInfo(older).lastMessage, undefined);
    assert.deepEqual(
      sortChatsByLastActivity([older, newer]).map((chat) => chat.id),
      ["newer", "older"],
    );
  });
});
