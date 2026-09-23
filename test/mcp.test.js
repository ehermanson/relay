// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMcpAuthentication,
  normalizeMcpConnectionState,
  overlayManagedMcpConfiguration,
  resolveMcpServersForChat,
} from "../dist/server/core/mcp.js";

const globalServer = {
  id: "codex:github",
  name: "github",
  provider: "codex",
  scope: "global",
  source: "provider",
  configured: true,
  connectionState: "connected",
  tools: [{ name: "search" }],
};

describe("MCP normalization", () => {
  it("keeps configured and chat availability separate", () => {
    const [server] = resolveMcpServersForChat(
      "codex",
      [globalServer],
      [
        {
          ...globalServer,
          scope: "chat",
          configured: undefined,
          available: false,
          connectionState: "needs_auth",
          tools: undefined,
        },
      ],
    );

    assert.equal(server.configured, true);
    assert.equal(server.available, false);
    assert.equal(server.connectionState, "needs_auth");
    assert.deepEqual(server.tools, [{ name: "search" }]);
  });

  it("distinguishes no knowledge from an empty snapshot", () => {
    assert.equal(resolveMcpServersForChat("codex", undefined, undefined), undefined);
    assert.deepEqual(resolveMcpServersForChat("codex", [], []), []);
  });

  it("never merges servers from another provider", () => {
    assert.deepEqual(resolveMcpServersForChat("claude", [globalServer], []), []);
  });

  it("normalizes authentication before generic failures", () => {
    assert.equal(normalizeMcpConnectionState("error", "login required"), "needs_auth");
    assert.equal(normalizeMcpConnectionState(undefined, undefined, undefined), "unknown");
    assert.equal(normalizeMcpConnectionState("not connected"), "failed");
    assert.equal(normalizeMcpConnectionState("not authenticated"), "needs_auth");
  });

  it("derives per-server authentication actions from Provider status", () => {
    assert.deepEqual(normalizeMcpAuthentication("oAuth", "connected"), {
      method: "oauth",
      login: true,
      logout: true,
    });
    assert.deepEqual(normalizeMcpAuthentication("bearerToken", "connected"), {
      method: "bearer_token",
      login: false,
      logout: false,
    });
    assert.deepEqual(normalizeMcpAuthentication("unsupported", "connected"), {
      method: "none",
      login: false,
      logout: false,
    });
    assert.deepEqual(normalizeMcpAuthentication(undefined, "needs_auth"), {
      method: "unknown",
      login: true,
      logout: false,
    });
  });

  it("keeps known global state when a Chat only reports a placeholder", () => {
    const [server] = resolveMcpServersForChat(
      "codex",
      [globalServer],
      [{ ...globalServer, scope: "chat", connectionState: "unknown", authentication: undefined }],
    );
    assert.equal(server.connectionState, "connected");
  });

  it("preserves fresh Provider metadata when recording a Relay-managed add", () => {
    const authentication = { method: "oauth", login: true, logout: false };
    const [server] = overlayManagedMcpConfiguration(
      [{ ...globalServer, authentication, detail: "Ready" }],
      "codex",
      "github",
    );
    assert.equal(server.source, "relay");
    assert.equal(server.connectionState, "connected");
    assert.deepEqual(server.authentication, authentication);
    assert.equal(server.detail, "Ready");
  });
});
