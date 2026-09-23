// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  attachReviewLinks,
  getAttachedReviewIds,
  pickPreferredAttachedReview,
  reviewBelongsToSource,
} from "../dist/server/core/review-sessions.js";

function makeChat(overrides = {}) {
  return {
    id: "chat-1",
    provider: "claude",
    name: "Chat",
    workingDirectory: "/tmp/project",
    status: "stopped",
    createdAt: 1000,
    lastActivityAt: 1000,
    ...overrides,
  };
}

describe("review-sessions helpers", () => {
  it("matches review sessions to a source by instance or session identity", () => {
    const source = makeChat({ id: "source-1", sessionId: "source-session" });
    const byInstance = makeChat({
      id: "review-1",
      review: { sourceInstanceId: "source-1", sourceName: "Source", scope: "branch" },
    });
    const bySession = makeChat({
      id: "review-2",
      sessionId: "review-session",
      review: {
        sourceSessionId: "source-session",
        sourceName: "Source",
        scope: "branch",
      },
    });

    assert.equal(reviewBelongsToSource(source, byInstance), true);
    assert.equal(reviewBelongsToSource(source, bySession), true);
  });

  it("preserves a preferred attached review when recomputing sidecar links", () => {
    const source = makeChat({
      id: "source-1",
      sessionId: "source-session",
      reviewInstanceId: "review-older",
    });
    const older = makeChat({
      id: "review-older",
      createdAt: 1000,
      lastActivityAt: 1000,
      review: {
        sourceInstanceId: "source-1",
        sourceSessionId: "source-session",
        sourceName: "Source",
        scope: "branch",
      },
    });
    const newer = makeChat({
      id: "review-newer",
      createdAt: 2000,
      lastActivityAt: 2000,
      review: {
        sourceInstanceId: "source-1",
        sourceSessionId: "source-session",
        sourceName: "Source",
        scope: "branch",
      },
    });

    const linked = attachReviewLinks([source, older, newer]);
    const preferred = pickPreferredAttachedReview(source, [older, newer], source.reviewInstanceId);

    assert.equal(linked[0].reviewInstanceId, "review-older");
    assert.equal(preferred?.id, "review-older");
    assert.deepEqual(getAttachedReviewIds(source, [older, newer]), [
      "review-newer",
      "review-older",
    ]);
  });
});
