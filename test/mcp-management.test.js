// Isolate worktrees/git env even when this file is run directly with `node --test`.
import "./test-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAddMcpServerInvocation,
  listClaudeProjectMcpServers,
} from "../dist/server/core/mcp-management.js";

describe("MCP management CLI invocations", () => {
  it("builds shellless Claude user-scope HTTP arguments", () => {
    assert.deepEqual(
      buildAddMcpServerInvocation({
        provider: "claude",
        name: "sentry",
        url: "https://mcp.sentry.dev/mcp",
        scope: "global",
      }),
      {
        args: [
          "mcp",
          "add",
          "--transport",
          "http",
          "--scope",
          "user",
          "sentry",
          "https://mcp.sentry.dev/mcp",
        ],
        cwd: undefined,
      },
    );
  });

  it("builds Codex HTTP arguments with an environment-variable token reference", () => {
    assert.deepEqual(
      buildAddMcpServerInvocation({
        provider: "codex",
        name: "github",
        url: "https://example.com/mcp",
        bearerTokenEnvVar: "GITHUB_TOKEN",
      }),
      {
        args: [
          "mcp",
          "add",
          "github",
          "--url",
          "https://example.com/mcp",
          "--bearer-token-env-var",
          "GITHUB_TOKEN",
        ],
      },
    );
  });

  it("rejects credentials in URLs and unsafe names", () => {
    assert.throws(
      () =>
        buildAddMcpServerInvocation({
          provider: "codex",
          name: "bad name",
          url: "https://example.com",
        }),
      /Server name/,
    );
    assert.throws(
      () =>
        buildAddMcpServerInvocation({
          provider: "codex",
          name: "safe",
          url: "https://user:secret@example.com",
        }),
      /Credentials/,
    );
  });

  it("builds stdio and SSE arguments without shell parsing", () => {
    assert.deepEqual(
      buildAddMcpServerInvocation({
        provider: "claude",
        name: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@example/mcp"],
      }).args,
      [
        "mcp",
        "add",
        "--transport",
        "stdio",
        "--scope",
        "user",
        "local",
        "--",
        "npx",
        "-y",
        "@example/mcp",
      ],
    );
    assert.deepEqual(
      buildAddMcpServerInvocation({
        provider: "claude",
        name: "events",
        transport: "sse",
        url: "https://example.com/sse",
      }).args,
      ["mcp", "add", "--transport", "sse", "--scope", "user", "events", "https://example.com/sse"],
    );
    assert.throws(
      () =>
        buildAddMcpServerInvocation({
          provider: "codex",
          name: "events",
          transport: "sse",
          url: "https://example.com/sse",
        }),
      /does not support SSE/,
    );
    assert.throws(
      () =>
        buildAddMcpServerInvocation({
          provider: "codex",
          name: "local",
          transport: "stdio",
          command: "node",
          bearerTokenEnvVar: "TOKEN",
        }),
      /only supported for HTTP/,
    );
  });

  it("requires a directory for Claude project-scoped mutations", () => {
    assert.throws(
      () =>
        buildAddMcpServerInvocation({
          provider: "claude",
          name: "local",
          transport: "stdio",
          command: "node",
          scope: "project",
        }),
      /Project directory/,
    );
  });

  it("reads only sanitized Project MCP configuration summaries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-mcp-test-"));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          remote: {
            type: "http",
            url: "https://example.com/mcp?token=hidden#fragment",
            headers: { Authorization: "secret" },
          },
          legacy: { type: "http", url: "https://user:secret@example.com/private?token=hidden" },
          local: { type: "stdio", command: "npx", env: { TOKEN: "secret" } },
        },
      }),
    );
    assert.deepEqual(await listClaudeProjectMcpServers(dir), [
      { name: "remote", transport: "http", target: "https://example.com/mcp", scope: "project" },
      {
        name: "legacy",
        transport: "http",
        target: "https://example.com/private",
        scope: "project",
      },
      { name: "local", transport: "stdio", target: "npx", scope: "project" },
    ]);
  });

  it("includes sanitized Claude local-scope servers for the Project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-mcp-local-test-"));
    const claudeConfig = join(dir, "claude.json");
    await writeFile(
      claudeConfig,
      JSON.stringify({
        projects: {
          [dir]: {
            mcpServers: {
              posthog: {
                command: "npx",
                args: ["secret-package"],
                env: { TOKEN: "hidden" },
              },
            },
          },
        },
      }),
    );
    assert.deepEqual(await listClaudeProjectMcpServers(dir, claudeConfig), [
      { name: "posthog", transport: "stdio", target: "npx", scope: "local" },
    ]);
  });
});
