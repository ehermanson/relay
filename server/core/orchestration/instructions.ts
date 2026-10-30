/**
 * Names and agent-facing guidance for Relay's own MCP server.
 *
 * The server is injected into every managed session whose provider advertises
 * `supportsRelayOrchestration`. Keep the guidance short: it lands in every
 * session's system prompt, and Codex truncates developer-instruction entries
 * over ~4 KB.
 */

/** Server key the provider sees. Tools surface as `mcp__relay__<tool>` in Claude. */
export const RELAY_MCP_SERVER_NAME = "relay";

/** Claude's tool-name prefix for this server (`mcp__<server>__<tool>`). */
export const RELAY_MCP_CLAUDE_TOOL_PREFIX = `mcp__${RELAY_MCP_SERVER_NAME}__`;

/**
 * Env var carrying a chat's bearer token: Codex reads it via
 * `bearer_token_env_var`, Claude Code expands it in the MCP header. Keep the
 * `TOKEN` in the name — agents' shell tools inherit the provider env, and
 * Codex's default shell-env policy drops `*TOKEN*` variables from commands.
 */
export const RELAY_MCP_TOKEN_ENV = "RELAY_MCP_TOKEN";

/**
 * Per-call tool timeout both providers get for Relay's server, above the
 * longest `delegate_task` wait (`DELEGATE_WAIT_MAX_MS`). Codex defaults to 60s.
 */
export const RELAY_MCP_TOOL_TIMEOUT_MS = 900_000;

/** Tool names served by Relay's MCP server, in listing order. */
export const RELAY_TOOL_NAMES = [
  "relay_capabilities",
  "delegate_task",
  "task_status",
  "task_cancel",
  "chat_list",
  "chat_read",
  "chat_send",
  "chat_wait",
] as const;

/** Link form agents use to refer to a chat; the UI resolves it to the live title. */
export function relayChatLink(instanceId: string): string {
  return `relay://chat/${instanceId}`;
}

export const RELAY_ORCHESTRATION_INSTRUCTIONS = `## Relay orchestration

You are running inside Relay, which hosts several agent chats side by side. The \`${RELAY_MCP_SERVER_NAME}\` MCP tools let you read and message other chats in this project and delegate tasks to child chats.

- Ordinary coding tasks need no Relay tools.
- Prefer your own built-in subagents for work on your own provider that finishes this turn. Use \`delegate_task\` to run a task on another provider or model, for background work that outlives this turn, or when the user asks for a Relay delegate.
- Call \`relay_capabilities\` once before your first delegation. If the provider or model you need is unavailable, say so; never silently fall back to another one.
- A child sees only its \`task\`, so write a complete, self-contained brief.
- After an async \`delegate_task\`, end your turn: completion wakes you with the result. Never poll, sleep, or watch for it. Cancel delegates you no longer need with \`task_cancel\`. If delegation fails with \`capacity\`, report it rather than retrying.
- \`chat_list\` lists the project's chats; \`chat_read\` reads one chat's conversation. Given a chat link or id, read it before you answer about it.
- \`chat_send\` messages another chat (a follow-up for a child, or a chat the user pointed you to); then \`chat_wait\` returns its reply. Message other chats only when the user or your task calls for it, and never answer a chat that is waiting on its user. Messaging a finished delegate reopens its task; its reply comes back as a task update unless you \`chat_wait\` for it.
- Refer to a chat by its \`link\` (\`relay://chat/<id>\`), verbatim — never by title or bare id.
- If you are a delegated child, do the work yourself. Start no delegates unless your task says to.`;

/** Claude defers MCP tools behind ToolSearch; tell it how to load them. */
export const RELAY_ORCHESTRATION_CLAUDE_NOTE = `If the Relay tools are not loaded yet, load them with ToolSearch \`select:${RELAY_TOOL_NAMES.map((tool) => `${RELAY_MCP_CLAUDE_TOOL_PREFIX}${tool}`).join(",")}\`.`;

/**
 * Drop Relay's own server from a session's MCP status list: it is Relay
 * plumbing, not something the user configured, and must not show up in the
 * chat's MCP panel. Only applied to live-session reports, where Relay injected it.
 */
export function withoutRelayMcpServer<T extends { name: string }>(
  servers: T[] | undefined,
): T[] | undefined {
  return servers?.filter((server) => server.name !== RELAY_MCP_SERVER_NAME);
}

/** Returned in the MCP `initialize` result; some clients surface it to the model. */
export const RELAY_MCP_SERVER_INSTRUCTIONS =
  "Relay cross-chat tools: read and message other chats, and delegate tasks to child chats on any provider. After an async delegate_task, end your turn; completion wakes you. Refer to chats by their relay://chat/<id> link. Ordinary coding needs none of these tools.";
