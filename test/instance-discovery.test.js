// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildKnownJsonlMap,
  collectActiveExternalSessions,
  emptyDiscoveryPollStats,
  formatSlowDiscoveryWarning,
  normalizeDiscoveryResult,
} from "../dist/server/core/instance-discovery.js";

describe("instance-discovery helpers", () => {
  it("normalizes raw discovery results and builds default stats", () => {
    const normalized = normalizeDiscoveryResult([
      {
        provider: "claude",
        sessionId: "session-1",
        transcriptPath: "/tmp/one.jsonl",
        cwd: "/tmp/project",
      },
    ]);

    assert.equal(normalized.sessions.length, 1);
    assert.deepEqual(emptyDiscoveryPollStats(), {
      externalSessionCount: 0,
      activeSessionCount: 0,
      staleCheckedCount: 0,
      endedCount: 0,
      providerTimings: [],
    });
  });

  it("filters active external sessions and reserves known jsonl paths", () => {
    const active = collectActiveExternalSessions({
      sessions: [
        {
          provider: "claude",
          sessionId: "managed-session",
          transcriptPath: "/tmp/managed.jsonl",
          cwd: "/tmp/project",
        },
        {
          provider: "claude",
          sessionId: "external-session",
          transcriptPath: "/tmp/external.jsonl",
          cwd: "/tmp/project",
        },
        {
          provider: "claude",
          sessionId: "ignored-session",
          transcriptPath: "/tmp/ignored.jsonl",
          cwd: "/tmp/other",
        },
      ],
      managedProviderSessionIds: new Set(["managed-session"]),
      isRegisteredProject: (cwd) => cwd === "/tmp/project",
    });

    assert.deepEqual([...active.keys()], ["/tmp/external.jsonl"]);

    const known = buildKnownJsonlMap({
      instances: [{ id: "external-1", externalJsonlPath: "/tmp/external.jsonl" }],
      managedTranscriptPaths: new Set(["/tmp/managed.jsonl"]),
    });
    assert.equal(known.get("/tmp/external.jsonl"), "external-1");
    assert.equal(known.get("/tmp/managed.jsonl"), "__reserved_managed__");
  });

  it("formats the slow discovery warning message", () => {
    const warning = formatSlowDiscoveryWarning({
      totalMs: 1200,
      discoverMs: 800,
      stats: {
        externalSessionCount: 3,
        activeSessionCount: 2,
        staleCheckedCount: 1,
        endedCount: 1,
        providerTimings: [{ provider: "claude", ms: 400, sessionCount: 2 }],
      },
      gitRefreshMs: 150,
      gitRefreshCount: 4,
    });

    assert.match(warning, /\[Discover\] slow: 1200ms/);
    assert.match(warning, /providers=claude:400ms\/2/);
    assert.match(warning, /git=150ms\/4/);
  });
});
