// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseManagedRestoreState } from "../dist/server/core/managed-session-restore.js";

describe("managed-session-restore helpers", () => {
  it("parses restore state from managed rows and ignores invalid JSON", () => {
    const parsed = parseManagedRestoreState({
      instance_id: "managed-1",
      provider_name: "codex",
      provider_session_id: "session-1",
      name: "Managed chat",
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
      runtime_mode: "approval-required",
      resume_cursor_json: JSON.stringify({ sessionId: "session-1" }),
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
      project_id: null,
      model: null,
      model_options_json: "{bad json",
      original_git_branch: null,
    });

    assert.deepEqual(parsed.resumeCursor, { sessionId: "session-1" });
    assert.equal(parsed.review?.sourceName, "Source");
    assert.equal(parsed.reviewInstanceId, "review-1");
    assert.equal(parsed.modelOptions, undefined);
  });
});
