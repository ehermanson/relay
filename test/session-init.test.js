// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeSessionInitPayload } from "../dist/server/core/session-init.js";

describe("normalizeSessionInitPayload", () => {
  it("preserves slash command metadata from object payloads", () => {
    const payload = normalizeSessionInitPayload({
      slashCommands: [
        { name: "review", description: "Review a PR", argumentHint: "pr-or-branch" },
        "plain-command",
      ],
    });

    assert.deepEqual(payload?.slashCommands, [
      { name: "review", description: "Review a PR", input: { hint: "pr-or-branch" } },
      { name: "plain-command" },
    ]);
    assert.deepEqual(payload?.commands, ["review", "plain-command"]);
  });

  it("preserves skill metadata from object payloads", () => {
    const payload = normalizeSessionInitPayload({
      skills: [
        {
          name: "review-follow-up",
          description: "Review follow-up changes",
          shortDescription: "Review follow-up",
          invocationPrefix: "$",
          enabled: false,
        },
      ],
    });

    assert.deepEqual(payload?.skills, [
      {
        name: "review-follow-up",
        description: "Review follow-up changes",
        shortDescription: "Review follow-up",
        invocationPrefix: "$",
        enabled: false,
      },
    ]);
    assert.deepEqual(payload?.commands, ["review-follow-up"]);
  });

  it("normalizes MCP servers as available to the Claude chat", () => {
    const payload = normalizeSessionInitPayload({
      mcp_servers: {
        github: { status: "connected", connected: true },
        sentry: { status: "needs auth" },
      },
    });

    assert.deepEqual(payload?.mcpServers, [
      {
        id: "claude:github",
        name: "github",
        provider: "claude",
        scope: "chat",
        source: "provider",
        available: true,
        connectionState: "connected",
        status: "connected",
        authStatus: undefined,
        connected: true,
      },
      {
        id: "claude:sentry",
        name: "sentry",
        provider: "claude",
        scope: "chat",
        source: "provider",
        available: true,
        connectionState: "needs_auth",
        authentication: { method: "unknown", login: true, logout: false },
        status: "needs auth",
        authStatus: undefined,
        connected: undefined,
      },
    ]);
  });

  it("distinguishes omitted MCP data from an authoritative empty snapshot", () => {
    assert.equal(normalizeSessionInitPayload({ model: "claude-opus-4-6" })?.mcpServers, undefined);
    assert.deepEqual(normalizeSessionInitPayload({ mcp_servers: {} })?.mcpServers, []);
    assert.deepEqual(normalizeSessionInitPayload({ mcp_servers: [] })?.mcpServers, []);
  });
});
