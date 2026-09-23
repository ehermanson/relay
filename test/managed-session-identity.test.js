// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPersistedRuntimePayload,
  collectManagedSessionKeys,
  isManagedShadowInstance,
  isManagedShadowSessionRow,
  mergeProviderBinding,
} from "../dist/server/core/managed-session-identity.js";

describe("managed-session-identity helpers", () => {
  it("merges runtime payload fields without dropping existing keys", () => {
    const merged = mergeProviderBinding(
      {
        provider: "codex",
        providerSessionId: "session-1",
        runtimePayload: { sessionContext: { bootstrap: { blocks: [] } } },
      },
      {
        provider: "codex",
        transcriptPath: "/tmp/session.jsonl",
        runtimePayload: { reviewInstanceId: "review-1" },
      },
    );

    assert.deepEqual(merged?.runtimePayload, {
      sessionContext: { bootstrap: { blocks: [] } },
      reviewInstanceId: "review-1",
    });
    assert.equal(merged?.transcriptPath, "/tmp/session.jsonl");
  });

  it("builds persisted runtime payload from source-owned review fields", () => {
    const payload = buildPersistedRuntimePayload(
      { transient: true },
      {
        id: "source-1",
        provider: "claude",
        name: "Source",
        workingDirectory: "/tmp/project",
        status: "stopped",
        createdAt: 1000,
        lastActivityAt: 1000,
        sessionContext: { bootstrap: { blocks: [] } },
        reviewInstanceId: "review-1",
      },
    );

    assert.deepEqual(payload, {
      transient: true,
      sessionContext: { bootstrap: { blocks: [] } },
      reviewInstanceId: "review-1",
    });
  });

  it("collects managed keys and detects managed shadows for rows and live externals", () => {
    const keys = collectManagedSessionKeys({
      persistedRows: [
        {
          provider_session_id: "managed-session",
          transcript_path: "/tmp/managed.jsonl",
        },
      ],
      liveInstances: [
        {
          external: false,
          providerBinding: {
            provider: "claude",
            providerSessionId: "live-session",
            transcriptPath: "/tmp/live.jsonl",
          },
        },
      ],
    });

    assert.equal(
      isManagedShadowSessionRow(
        {
          session_id: "managed-session",
          jsonl_path: "/tmp/external.jsonl",
        },
        keys,
      ),
      true,
    );
    assert.equal(
      isManagedShadowInstance(
        {
          external: true,
          sessionId: "external-session",
          externalJsonlPath: "/tmp/live.jsonl",
        },
        keys,
      ),
      true,
    );
  });
});
