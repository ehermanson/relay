/**
 * Codex CLI Utilities
 *
 * Binary discovery and installation detection for the Codex CLI.
 * Used by codex-app-server.ts and codex-models.ts.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";

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

/**
 * Build the environment for spawning a Codex process. Inherits the current
 * process env and, when unset, injects CODEX_CODE_MODE_HOST_PATH pointing at the
 * bundled code-mode host binary so Codex "code mode" works without the user
 * having to export it manually. A user-provided value always wins.
 */
export function buildCodexSpawnEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (baseEnv.CODEX_CODE_MODE_HOST_PATH) return baseEnv;
  const hostPath = findCodexCodeModeHost();
  if (!hostPath) return baseEnv;
  return { ...baseEnv, CODEX_CODE_MODE_HOST_PATH: hostPath };
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
