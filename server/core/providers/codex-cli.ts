/**
 * Codex CLI Utilities
 *
 * Binary discovery and installation detection for the Codex CLI.
 * Used by codex-app-server.ts and codex-models.ts.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

let cachedCodexBinary: string | null | undefined;

/**
 * Candidate locations for the `codex-code-mode-host` helper binary that Codex's
 * "code mode" shells out to. The macOS ChatGPT.app bundles it but does not put
 * it on PATH, so a plain `codex app-server` invocation fails with
 * "failed to spawn code-mode host ...: No such file or directory". We locate the
 * bundled binary and hand it to Codex via CODEX_CODE_MODE_HOST_PATH.
 */
const CODE_MODE_HOST_CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host",
  `${process.env.HOME}/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host`,
];

let cachedCodeModeHostPath: string | null | undefined;

/**
 * Locate the `codex-code-mode-host` helper binary, or null if none is found.
 * Result is cached for the process lifetime.
 */
/**
 * Name Relay reports as the app-server client. Codex persists it as the
 * rollout's `session_meta.originator`, which is how discovery tells Relay's
 * own threads apart from genuinely external ones.
 */
export const RELAY_CODEX_ORIGINATOR = "relay";

export function findCodexCodeModeHost(): string | null {
  if (cachedCodeModeHostPath !== undefined) return cachedCodeModeHostPath;
  for (const candidate of CODE_MODE_HOST_CANDIDATES) {
    if (candidate && existsSync(candidate)) {
      cachedCodeModeHostPath = candidate;
      return cachedCodeModeHostPath;
    }
  }
  cachedCodeModeHostPath = null;
  return cachedCodeModeHostPath;
}

/** Codex's own home when CODEX_HOME is unset. */
export function defaultCodexHomeDir(): string {
  return join(homedir(), ".codex");
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** Absolute, `~`-expanded, trailing-slash-free form of a Codex home (cache keys, comparisons). */
export function normalizeCodexHomeDir(codexHome: string): string {
  return resolve(expandHome(codexHome.trim()));
}

/**
 * The single resolution of "which Codex home" Relay uses by default — for
 * reading (rollouts under `sessions/`) and for spawning `codex app-server`.
 * Precedence: CODEX_DIR (Relay's explicit override) > CODEX_HOME (the CLI's own
 * switch, which is how several logins coexist on one machine) > ~/.codex.
 * Mirrors `resolveClaudeConfigDir`.
 */
export function resolveCodexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CODEX_DIR?.trim() || env.CODEX_HOME?.trim();
  return raw ? normalizeCodexHomeDir(raw) : defaultCodexHomeDir();
}

/** The home the Codex CLI itself would pick under `env` (it never reads CODEX_DIR). */
function codexHomeSeenByCli(env: NodeJS.ProcessEnv): string {
  const inherited = env.CODEX_HOME?.trim();
  return inherited ? normalizeCodexHomeDir(inherited) : defaultCodexHomeDir();
}

/**
 * Build the environment for spawning a Codex process.
 *
 * - Injects CODEX_CODE_MODE_HOST_PATH (when unset) pointing at the bundled
 *   code-mode host binary so Codex "code mode" works without the user having
 *   to export it manually. A user-provided value always wins.
 * - Pins CODEX_HOME to `codexHome` (one login per home: `auth.json`,
 *   `config.toml`, `sessions/`) **only when it differs** from the home the CLI
 *   would already resolve under `baseEnv`. When they agree — every spawn of a
 *   single-account install — the variable is left exactly as inherited, so
 *   the child env is identical to what it was before account logins existed.
 *
 * Returns `baseEnv` itself when nothing needs to change.
 */
export function buildCodexSpawnEnv(
  codexHome?: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  let env = baseEnv;
  if (codexHome?.trim()) {
    const target = normalizeCodexHomeDir(codexHome);
    if (target !== codexHomeSeenByCli(baseEnv)) {
      env = { ...env, CODEX_HOME: target };
    }
  }
  if (!env.CODEX_CODE_MODE_HOST_PATH) {
    const hostPath = findCodexCodeModeHost();
    if (hostPath) env = { ...env, CODEX_CODE_MODE_HOST_PATH: hostPath };
  }
  return env;
}

export function findCodexBinary(): string | null {
  if (cachedCodexBinary !== undefined) return cachedCodexBinary;

  // Explicit override for non-standard install locations (and for tests, which
  // must not depend on the host having the Codex CLI installed on PATH).
  const override = process.env.RELAY_CODEX_CLI_PATH;
  if (override) {
    cachedCodexBinary = override;
    return cachedCodexBinary;
  }

  const candidates = [
    `${process.env.HOME}/.local/bin/codex`,
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
  ];

  for (const candidate of candidates) {
    try {
      if (execSync(`test -x "${candidate}" && echo ok`, { encoding: "utf-8" }).trim() === "ok") {
        cachedCodexBinary = candidate;
        return cachedCodexBinary;
      }
    } catch {
      // ignore and continue
    }
  }

  try {
    const result = execSync("which codex", { encoding: "utf-8" }).trim();
    if (result) {
      cachedCodexBinary = result;
      return cachedCodexBinary;
    }
  } catch {
    // ignore
  }

  cachedCodexBinary = null;
  return cachedCodexBinary;
}

export function isCodexInstalled(): boolean {
  return findCodexBinary() !== null;
}
