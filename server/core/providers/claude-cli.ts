/**
 * Claude Code CLI Utilities
 *
 * Binary discovery and installation detection for the Claude Code CLI.
 * Used by provider-registry.ts to determine if the Claude provider is available.
 */

import { execSync } from "child_process";
import { accessSync, constants, statSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

let cachedClaudeBinary: string | null | undefined;

export function findClaudeBinary(): string | null {
  if (cachedClaudeBinary !== undefined) return cachedClaudeBinary;

  // Explicit override for non-standard install locations (and for tests, which
  // must not depend on the host having the Claude CLI installed on PATH).
  const override = process.env.RELAY_CLAUDE_CLI_PATH;
  if (override && isExecutableFile(override)) {
    cachedClaudeBinary = override;
    return cachedClaudeBinary;
  }

  // PATH first: the `claude` the user's own shell resolves is the one whose
  // login, settings and version they see in a terminal. On a machine with two
  // installs, picking a well-known path ahead of PATH spawned a different
  // binary than the terminal's — with a different credential store, so a
  // work login that /status showed fine read as logged out inside Relay.
  try {
    // `which` runs under /bin/sh here, so it never prints a zsh alias — but a
    // user-supplied path can be one ("claude: aliased to …"), hence the check.
    const result = execSync("which claude", { encoding: "utf-8" }).trim().split("\n")[0] ?? "";
    if (result && isExecutableFile(result)) {
      cachedClaudeBinary = result;
      return cachedClaudeBinary;
    }
  } catch {
    // ignore — fall back to well-known install locations (minimal PATH under a service)
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

  cachedClaudeBinary = null;
  return cachedClaudeBinary;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
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
 * How the CLI must see `CLAUDE_CONFIG_DIR` for a config dir. Claude Code keys
 * its stored credentials (and its global config) by whether the variable is
 * set — an *explicit* `CLAUDE_CONFIG_DIR=~/.claude` is a different login from
 * the unset default, even though both are the same directory. Users who keep
 * several accounts typically alias `claude` to set the variable for every
 * account, so their "default" login lives under the explicit keying and the
 * unset keying is empty. Non-default dirs are always explicit; for the default
 * dir the mode is whatever the login probe found signed in (recorded here),
 * falling back to the server's own env (explicitly set → explicit).
 */
export type ClaudeConfigDirEnvMode = "implicit" | "explicit";

const envModeByDir = new Map<string, ClaudeConfigDirEnvMode>();

export function claudeConfigDirEnvMode(
  configDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): ClaudeConfigDirEnvMode {
  const target = resolve(expandHome(configDir));
  if (target !== defaultClaudeConfigDir()) return "explicit";
  const recorded = envModeByDir.get(target);
  if (recorded) return recorded;
  const inherited = baseEnv.CLAUDE_CONFIG_DIR?.trim();
  return inherited && resolve(expandHome(inherited)) === target ? "explicit" : "implicit";
}

/** Remember which keying a login probe found signed in for the default dir. */
export function recordClaudeConfigDirEnvMode(
  configDir: string,
  mode: ClaudeConfigDirEnvMode,
): void {
  envModeByDir.set(resolve(expandHome(configDir)), mode);
}

/** Test seam. */
export function clearClaudeConfigDirEnvModes(): void {
  envModeByDir.clear();
}

/**
 * Env for every Claude CLI spawn. Pins `CLAUDE_CONFIG_DIR` to `configDir`
 * (explicit mode) or removes it (implicit mode — the CLI's own default keying)
 * so the CLI runs against the same dir Relay indexes, under the keying that
 * actually holds the login. Returns `baseEnv` itself when it already agrees.
 */
export function buildClaudeSpawnEnv(
  configDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  mode: ClaudeConfigDirEnvMode = claudeConfigDirEnvMode(configDir, baseEnv),
): NodeJS.ProcessEnv {
  const target = resolve(expandHome(configDir));
  const inherited = baseEnv.CLAUDE_CONFIG_DIR?.trim();
  const current = inherited ? resolve(expandHome(inherited)) : undefined;
  if (mode === "explicit") {
    if (current === target) return baseEnv;
    return { ...baseEnv, CLAUDE_CONFIG_DIR: target };
  }
  if (current === undefined) return baseEnv;
  const env = { ...baseEnv };
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}
