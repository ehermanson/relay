/**
 * Minimal MCP server over JSON-RPC 2.0, transport-agnostic.
 *
 * Relay's `/mcp` endpoint only needs the stateless subset of the Streamable
 * HTTP transport: `initialize`, `ping`, `tools/list`, `tools/call`, and
 * notifications. Every POST carries one message (or a legacy batch) and gets
 * a plain JSON response — no sessions, no server-initiated SSE stream.
 */

export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const MCP_LATEST_PROTOCOL_VERSION = MCP_SUPPORTED_PROTOCOL_VERSIONS[0];

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDefinition<Ctx> {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments (`type: "object"`). */
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  /**
   * Returns the structured result. Throw `McpToolError` for expected,
   * model-visible failures; anything else is reported as an internal error.
   */
  handler(args: Record<string, unknown>, ctx: Ctx): unknown | Promise<unknown>;
}

/** An expected tool failure, returned to the model as `isError` with a typed code. */
export class McpToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
  }
}

export interface McpServerDefinition<Ctx> {
  name: string;
  version: string;
  instructions?: string;
  tools: ReadonlyArray<McpToolDefinition<Ctx>>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type JsonRpcId = string | number | null;

/**
 * Handle one decoded HTTP body: a single message or a batch. Returns the
 * response body, or `null` when every message was a notification (the
 * transport then answers 202 Accepted with no body).
 */
export async function handleMcpPayload<Ctx>(
  payload: unknown,
  server: McpServerDefinition<Ctx>,
  ctx: Ctx,
  onError?: (error: unknown) => void,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return rpcError(null, JSONRPC_INVALID_REQUEST, "Empty batch");
    }
    const responses: JsonRpcResponse[] = [];
    for (const message of payload) {
      const response = await handleMcpMessage(message, server, ctx, onError);
      if (response) responses.push(response);
    }
    return responses.length > 0 ? responses : null;
  }
  return handleMcpMessage(payload, server, ctx, onError);
}

export async function handleMcpMessage<Ctx>(
  message: unknown,
  server: McpServerDefinition<Ctx>,
  ctx: Ctx,
  onError?: (error: unknown) => void,
): Promise<JsonRpcResponse | null> {
  if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    // A response object from the client (we never send requests) or garbage.
    if (isRecord(message) && message.jsonrpc === "2.0" && "id" in message && !("method" in message))
      return null;
    return rpcError(readId(message), JSONRPC_INVALID_REQUEST, "Invalid JSON-RPC request");
  }

  const isNotification = !("id" in message);
  const id = readId(message);
  const params = isRecord(message.params) ? message.params : {};

  if (isNotification) {
    // notifications/initialized, notifications/cancelled, … — nothing to do.
    return null;
  }

  try {
    switch (message.method) {
      case "initialize":
        return rpcResult(id, initializeResult(server, params));
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, {
          tools: server.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
          })),
        });
      case "tools/call":
        return rpcResult(id, await callTool(server, params, ctx, onError));
      default:
        return rpcError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${message.method}`);
    }
  } catch (error) {
    if (error instanceof InvalidParamsError) {
      return rpcError(id, JSONRPC_INVALID_PARAMS, error.message);
    }
    onError?.(error);
    return rpcError(id, JSONRPC_INTERNAL_ERROR, "Internal error");
  }
}

function initializeResult<Ctx>(server: McpServerDefinition<Ctx>, params: Record<string, unknown>) {
  const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
  const protocolVersion =
    requested && (MCP_SUPPORTED_PROTOCOL_VERSIONS as ReadonlyArray<string>).includes(requested)
      ? requested
      : MCP_LATEST_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: server.name, version: server.version },
    ...(server.instructions ? { instructions: server.instructions } : {}),
  };
}

class InvalidParamsError extends Error {}

async function callTool<Ctx>(
  server: McpServerDefinition<Ctx>,
  params: Record<string, unknown>,
  ctx: Ctx,
  onError?: (error: unknown) => void,
): Promise<unknown> {
  const name = params.name;
  if (typeof name !== "string") throw new InvalidParamsError("tools/call requires a tool name");
  const tool = server.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new InvalidParamsError(`Unknown tool: ${name}`);
  const args = params.arguments === undefined ? {} : params.arguments;
  if (!isRecord(args)) throw new InvalidParamsError("Tool arguments must be an object");

  try {
    const result = await tool.handler(args, ctx);
    return toolResult(result, false);
  } catch (error) {
    if (error instanceof McpToolError) {
      return toolResult({ error: { code: error.code, message: error.message } }, true);
    }
    onError?.(error);
    return toolResult(
      { error: { code: "orchestration_error", message: "Relay failed to run this tool." } },
      true,
    );
  }
}

function toolResult(value: unknown, isError: boolean) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isRecord(value) ? { structuredContent: value } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function readId(message: unknown): JsonRpcId {
  if (!isRecord(message)) return null;
  const id = message.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
