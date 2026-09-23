// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getReviewSessionFromRuntimePayload } from "../dist/server/core/session-context.js";

describe("getReviewSessionFromRuntimePayload", () => {
  it("returns undefined for invalid payloads", () => {
    assert.equal(getReviewSessionFromRuntimePayload(undefined), undefined);
    assert.equal(getReviewSessionFromRuntimePayload({ review: null }), undefined);
    assert.equal(
      getReviewSessionFromRuntimePayload({
        review: { sourceName: "", scope: "session-files" },
      }),
      undefined,
    );
    assert.equal(
      getReviewSessionFromRuntimePayload({
        review: { sourceName: "Review", scope: "bad-scope" },
      }),
      undefined,
    );
  });

  it("sanitizes file paths and preserves valid review metadata", () => {
    assert.deepEqual(
      getReviewSessionFromRuntimePayload({
        review: {
          sourceInstanceId: "source-1",
          sourceSessionId: "session-1",
          sourceName: "Source Chat",
          scope: "session-files",
          filePaths: ["app/src/foo.ts", 42, null, "server/bar.ts"],
        },
      }),
      {
        sourceInstanceId: "source-1",
        sourceSessionId: "session-1",
        sourceName: "Source Chat",
        scope: "session-files",
        filePaths: ["app/src/foo.ts", "server/bar.ts"],
      },
    );
  });
});
