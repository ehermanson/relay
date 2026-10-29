import type { Hono } from "hono";
import { parseBearerToken } from "#core/orchestration/credentials.js";
import {
  handleMcpPayload,
  JSONRPC_PARSE_ERROR,
  rpcError,
} from "#core/orchestration/mcp-protocol.js";
import { createRelayMcpServer } from "#core/orchestration/tools.js";
import { readBodyBuffer } from "#server/hono-utils.js";
import type { AppEnv, HttpDeps } from "#server/route-types.js";

/** JSON-RPC bodies are tiny; anything bigger is not a legitimate MCP client. */
const MCP_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Relay's own MCP endpoint (stateless Streamable HTTP, JSON responses only).
 *
 * It sits outside the browser's cookie auth on purpose: provider CLIs can't
 * hold a Relay login. The per-chat bearer token is the only credential, and
 * it identifies the calling chat. Tunnels terminate on localhost, so a
 * loopback check would prove nothing; requests carrying a browser `Origin`
 * are refused so a web page can't drive the endpoint either.
 */
export function registerMcpRoutes(app: Hono<AppEnv>, deps: HttpDeps): void {
  const { instanceManager, config } = deps;
  const server = createRelayMcpServer(deps.packageVersion);

  app.post("/mcp", async (c) => {
    if (c.req.header("origin")) {
      return c.json({ error: "Browser requests are not accepted" }, 403);
    }
    const callerId = instanceManager.resolveOrchestrationCaller(
      parseBearerToken(c.req.header("authorization")),
    );
    if (!callerId) {
      c.header("WWW-Authenticate", 'Bearer realm="relay"');
      return c.json({ error: "Unauthorized" }, 401);
    }

    let payload: unknown;
    try {
      const body = await readBodyBuffer(c, MCP_MAX_BODY_BYTES);
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return c.json(rpcError(null, JSONRPC_PARSE_ERROR, "Parse error"), 400);
    }

    const response = await handleMcpPayload(
      payload,
      server,
      { host: instanceManager.getOrchestrationHost(), callerId },
      (error) => config.logger.error("[MCP] Tool error:", error),
    );
    if (response === null) return c.body(null, 202);
    return c.json(response);
  });

  // No server-initiated stream and no sessions: GET (SSE) and DELETE are unsupported.
  const notAllowed = () => new Response(null, { status: 405, headers: { Allow: "POST" } });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
