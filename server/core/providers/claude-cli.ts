/**
 * Claude Code CLI Utilities
 *
 * Binary discovery and installation detection for the Claude Code CLI.
 * Used by provider-registry.ts to determine if the Claude provider is available.
 */

import { execSync } from "child_process";
import { homedir } from "os";
import { join, resolve } from "path";

let cachedClaudeBinary: string | null | undefined;

export function findClaudeBinary(): string | null {
  if (cachedClaudeBinary !== undefined) return cachedClaudeBinary;

  // Explicit override for non-standard install locations (and for tests, which
  // must not depend on the host having the Claude CLI installed on PATH).
  const override = process.env.RELAY_CLAUDE_CLI_PATH;
  if (override) {
    cachedClaudeBinary = override;
    return cachedClaudeBinary;
  }

  const candidates = [
    `${process.env.HOME}/.local/bin/claude`,
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];

  for (const candidate of candidates) {
    try {
      if (execSync(`test -x "${candidate}" && echo ok`, { encoding: "utf-8" }).trim() === "ok") {
        cachedClaudeBinary = candidate;
        return cachedClaudeBinary;
      }
    } catch {
      // ignore and continue
    }
  }

  try {
    const result = execSync("which claude", { encoding: "utf-8" }).trim();
    if (result) {
      cachedClaudeBinary = result;
      return cachedClaudeBinary;
    }
  } catch {
    // ignore
  }

  cachedClaudeBinary = null;
  return cachedClaudeBinary;
}

export function isClaudeInstalled(): boolean {
  return findClaudeBinary() !== null;
}

/** Claude Code's own config dir when CLAUDE_CONFIG_DIR is unset. */
export function defaultClaudeConfigDir(): string {
  return join(homedir(), ".claude");
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/**
 * The single resolution of "which Claude config dir" Relay uses — for reading
 * (transcript root, plans, skills, .claude.json) and for spawning the CLI.
 * Precedence: CLAUDE_DIR (Relay's explicit override) > CLAUDE_CONFIG_DIR (the
 * CLI's own switch, which is how several accounts coexist on one machine) >
 * ~/.claude. Discovery and spawns resolving this independently is exactly how
 * terminal chats from one account and new chats under another showed up in
 * the same Relay.
 */
export function resolveClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CLAUDE_DIR?.trim() || env.CLAUDE_CONFIG_DIR?.trim();
  return raw ? resolve(expandHome(raw)) : defaultClaudeConfigDir();
}

/**
 * Where the CLI keeps its global config (MCP servers, project entries): next
 * to the home dir for the default location, inside the config dir otherwise.
 */
export function resolveClaudeGlobalConfigPath(configDir: string): string {
  const target = resolve(expandHome(configDir));
  return target === defaultClaudeConfigDir()
    ? join(homedir(), ".claude.json")
    : join(target, ".claude.json");
}

/**
 * Env for every Claude CLI spawn. Pins CLAUDE_CONFIG_DIR to `configDir` so the
 * CLI runs against the same dir Relay indexes and watches. Returns `baseEnv`
 * itself when it already agrees. When the target is the CLI's default dir the
 * variable is removed rather than set to it — an explicit CLAUDE_CONFIG_DIR
 * changes how the CLI keys its stored credentials, so the default must stay
 * the CLI's own default.
 */
export function buildClaudeSpawnEnv(
  configDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const target = resolve(expandHome(configDir));
  const inherited = baseEnv.CLAUDE_CONFIG_DIR?.trim();
  const current = inherited ? resolve(expandHome(inherited)) : defaultClaudeConfigDir();
  if (current === target) return baseEnv;
  const env = { ...baseEnv };
  if (target === defaultClaudeConfigDir()) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = target;
  return env;
}
