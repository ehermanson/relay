import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildClaudeSpawnEnv,
  findClaudeBinary,
  resolveClaudeConfigDir,
  resolveClaudeGlobalConfigPath,
} from "#core/providers/claude-cli.js";
import { findCodexBinary } from "#core/providers/codex-cli.js";
import type { ProviderKind } from "#core/types.js";

const execFileAsync = promisify(execFile);
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const mutationsInFlight = new Set<ProviderKind>();

async function exclusiveMutation(
  provider: ProviderKind,
  operation: () => Promise<void>,
): Promise<void> {
  if (mutationsInFlight.has(provider))
    throw new Error(`Another ${provider} MCP change is already running`);
  mutationsInFlight.add(provider);
  try {
    await operation();
  } finally {
    mutationsInFlight.delete(provider);
  }
}

export interface AddMcpServerInput {
  provider: ProviderKind;
  name: string;
  transport?: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  scope?: "global" | "project";
  projectDirectory?: string;
  bearerTokenEnvVar?: string;
}

export interface McpCliInvocation {
  args: string[];
  cwd?: string;
}

export interface McpConfigSummary {
  name: string;
  transport: "http" | "sse" | "stdio" | "unknown";
  target?: string;
  scope: "local" | "project";
}

export async function listClaudeProjectMcpServers(
  projectDirectory: string,
  claudeConfigPath = resolveClaudeGlobalConfigPath(resolveClaudeConfigDir()),
): Promise<McpConfigSummary[]> {
  const servers = new Map<string, McpConfigSummary>();
  const addServers = (
    configured: Record<string, Record<string, unknown>> | undefined,
    scope: McpConfigSummary["scope"],
  ) => {
    for (const [name, config] of Object.entries(configured ?? {})) {
      const type =
        config.type === "http" || config.type === "sse" || config.type === "stdio"
          ? config.type
          : typeof config.command === "string"
            ? "stdio"
            : typeof config.url === "string"
              ? "http"
              : "unknown";
      servers.set(name, {
        name,
        transport: type,
        target: sanitizeConfigTarget(config),
        scope,
      });
    }
  };
  try {
    const parsed = JSON.parse(await readFile(claudeConfigPath, "utf8")) as {
      projects?: Record<string, { mcpServers?: Record<string, Record<string, unknown>> }>;
    };
    addServers(parsed.projects?.[projectDirectory]?.mcpServers, "local");
  } catch {
    // Missing or malformed user config contributes no local Project servers.
  }
  try {
    const parsed = JSON.parse(await readFile(join(projectDirectory, ".mcp.json"), "utf8")) as {
      mcpServers?: Record<string, Record<string, unknown>>;
    };
    addServers(parsed.mcpServers, "project");
  } catch {
    // Missing or malformed shared config contributes no Project servers.
  }
  return [...servers.values()];
}

function sanitizeConfigTarget(config: Record<string, unknown>): string | undefined {
  if (typeof config.command === "string") return config.command;
  if (typeof config.url !== "string") return undefined;
  try {
    const url = new URL(config.url);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function validateName(name: string): string {
  const value = name.trim();
  if (!SERVER_NAME_PATTERN.test(value)) {
    throw new Error("Server name must be 1-63 letters, numbers, dots, underscores, or dashes");
  }
  return value;
}

function validateHttpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Enter a valid MCP server URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("MCP server URL must use HTTP or HTTPS");
  }
  if (url.username || url.password)
    throw new Error("Credentials are not allowed in MCP server URLs");
  return url.toString();
}

function binaryFor(provider: ProviderKind): string {
  const binary =
    provider === "claude" ? findClaudeBinary() : provider === "codex" ? findCodexBinary() : null;
  if (!binary) throw new Error(`${provider} is not installed`);
  return binary;
}

async function run(
  binary: string,
  args: string[],
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
  timeout = 30_000,
): Promise<void> {
  try {
    await execFileAsync(binary, args, { cwd, env, timeout, maxBuffer: 1024 * 1024 });
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
    throw new Error(stderr || "Provider failed to update MCP configuration");
  }
}

export async function addMcpServer(input: AddMcpServerInput): Promise<void> {
  await exclusiveMutation(input.provider, async () => {
    const binary = binaryFor(input.provider);
    const invocation = buildAddMcpServerInvocation(input);
    // `claude mcp add` writes into the config dir — pin it to the one Relay indexes.
    const env =
      input.provider === "claude" ? buildClaudeSpawnEnv(resolveClaudeConfigDir()) : process.env;
    await run(binary, invocation.args, invocation.cwd, env);
  });
}

export function buildAddMcpServerInvocation(input: AddMcpServerInput): McpCliInvocation {
  const name = validateName(input.name);
  const transport = input.transport ?? "http";
  const url = transport === "stdio" ? undefined : validateHttpUrl(input.url ?? "");
  const command = input.command?.trim();
  if (transport === "stdio" && !command) throw new Error("Command is required for stdio servers");
  if ((command?.length ?? 0) > 1024) throw new Error("MCP command is too long");
  if ((input.args?.length ?? 0) > 64 || input.args?.some((arg) => arg.length > 4096)) {
    throw new Error("MCP command arguments exceed the supported limit");
  }
  if (input.args?.some((arg) => arg.includes("\0")))
    throw new Error("MCP arguments cannot contain null bytes");

  if (input.provider === "claude") {
    const scope = input.scope === "project" ? "project" : "user";
    if (scope === "project" && !input.projectDirectory)
      throw new Error("Project directory is required");
    return {
      args:
        transport === "stdio"
          ? [
              "mcp",
              "add",
              "--transport",
              "stdio",
              "--scope",
              scope,
              name,
              "--",
              command!,
              ...(input.args ?? []),
            ]
          : ["mcp", "add", "--transport", transport, "--scope", scope, name, url!],
      cwd: input.projectDirectory,
    };
  }
  if (input.provider === "codex") {
    if (transport === "sse") throw new Error("Codex does not support SSE MCP configuration");
    if (transport === "stdio" && input.bearerTokenEnvVar)
      throw new Error("Bearer token environment variables are only supported for HTTP servers");
    const args =
      transport === "stdio"
        ? ["mcp", "add", name, "--", command!, ...(input.args ?? [])]
        : ["mcp", "add", name, "--url", url!];
    if (input.bearerTokenEnvVar) {
      const envName = input.bearerTokenEnvVar.trim();
      if (!ENV_NAME_PATTERN.test(envName))
        throw new Error("Bearer token environment variable is invalid");
      args.push("--bearer-token-env-var", envName);
    }
    return { args };
  }
  throw new Error("Provider does not support MCP server management");
}
