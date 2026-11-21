/**
 * Antigravity CLI Utilities
 *
 * Binary discovery, home-dir resolution and spawn environment for Google's
 * Antigravity CLI (`agy`). Relay drives it through `agy acp`, its Agent Client
 * Protocol server (see antigravity-session.ts).
 *
 * Relay runs `agy` against the user's own Gemini home (`~/.gemini`) and the
 * CLI's default app data dir (`antigravity-cli`), so a Relay chat and a
 * terminal `agy` share one sign-in and one conversation store: a conversation
 * started in either can be continued in the other.
 */

import { execFileSync } from "child_process";
import { accessSync, constants, existsSync, statSync } from "fs";
import { homedir } from "os";
import { delimiter, join, resolve } from "path";

/** Directory under the Gemini home where `agy` keeps its CLI state. */
export const ANTIGRAVITY_APP_DATA_DIR = "antigravity-cli";

/** Name Relay reports as the ACP client. */
export const RELAY_ANTIGRAVITY_CLIENT_NAME = "relay";

let cachedBinary: string | null | undefined;
let cachedVersion: { binary: string; version: string | null } | undefined;

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** The Gemini home `agy` uses when nothing overrides it. */
export function defaultAntigravityHomeDir(): string {
  return join(homedir(), ".gemini");
}

export function normalizeAntigravityHomeDir(dir: string): string {
  return resolve(expandHome(dir.trim()));
}

/**
 * The single resolution of "which Gemini home" Relay uses by default — for
 * reading conversations and for spawning `agy`. Precedence: ANTIGRAVITY_DIR
 * (Relay's explicit override) > GEMINI_HOME (the CLI's own switch) > ~/.gemini.
 */
export function resolveAntigravityHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.ANTIGRAVITY_DIR?.trim() || env.GEMINI_HOME?.trim();
  return raw ? normalizeAntigravityHomeDir(raw) : defaultAntigravityHomeDir();
}

/** `<home>/antigravity-cli`: conversations, brain (transcripts), cache. */
export function antigravityDataDir(home: string): string {
  return join(home, ANTIGRAVITY_APP_DATA_DIR);
}

/** The home the CLI itself picks under `env` (it never reads ANTIGRAVITY_DIR). */
function homeSeenByCli(env: NodeJS.ProcessEnv): string {
  const inherited = env.GEMINI_HOME?.trim();
  return inherited ? normalizeAntigravityHomeDir(inherited) : defaultAntigravityHomeDir();
}

/**
 * Environment for an `agy` spawn. Pins GEMINI_HOME only when `home` differs
 * from what the CLI would resolve anyway, and turns off the CLI's own
 * self-updater inside Relay's processes (Relay offers the update instead, and a
 * binary swapped under a running ACP server breaks it).
 */
export function buildAntigravitySpawnEnv(
  home?: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, AGY_CLI_DISABLE_AUTO_UPDATE: "1" };
  if (home?.trim()) {
    const target = normalizeAntigravityHomeDir(home);
    if (target !== homeSeenByCli(baseEnv)) env.GEMINI_HOME = target;
  }
  return env;
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

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Locate the `agy` binary. RELAY_ANTIGRAVITY_CLI_PATH overrides (also used by
 * tests); then PATH (what the user's shell runs); then the installer's default
 * location (`~/.local/bin/agy`), which a GUI-launched server may lack on PATH.
 */
export function findAntigravityBinary(): string | null {
  if (cachedBinary !== undefined) return cachedBinary;
  const override = process.env.RELAY_ANTIGRAVITY_CLI_PATH?.trim();
  if (override) {
    cachedBinary = expandHome(override);
    return cachedBinary;
  }
  const candidates = [
    findOnPath("agy"),
    join(homedir(), ".local", "bin", "agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ];
  cachedBinary = candidates.find((candidate) => candidate && isExecutableFile(candidate)) ?? null;
  return cachedBinary;
}

export function isAntigravityInstalled(): boolean {
  const binary = findAntigravityBinary();
  return binary !== null && existsSync(binary);
}

/** Forget the cached binary/version (after an update, and in tests). */
export function resetAntigravityBinaryCache(): void {
  cachedBinary = undefined;
  cachedVersion = undefined;
}

/** Parse `1.5.13` out of `agy --version` output (or an ACP `agentInfo.version`). */
export function parseAntigravityVersion(output: string | null | undefined): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(output ?? "");
  return match ? match[1] : null;
}

/** Installed CLI version (`agy --version`), cached per binary. Null when unknown. */
export function getAntigravityVersion(): string | null {
  const binary = findAntigravityBinary();
  if (!binary) return null;
  if (cachedVersion?.binary === binary) return cachedVersion.version;
  let version: string | null = null;
  try {
    version = parseAntigravityVersion(
      execFileSync(binary, ["--version"], {
        encoding: "utf-8",
        timeout: 15_000,
        env: buildAntigravitySpawnEnv(),
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    version = null;
  }
  cachedVersion = { binary, version };
  return version;
}

/** Compare dotted versions numerically; missing parts count as 0. */
export function compareAntigravityVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Oldest `agy` Relay drives. 1.5.0 is the first release whose ACP server has
 * per-model thinking levels, native plan mode, prompt steering and the
 * system-prompt append extension Relay relies on.
 */
export const MIN_ANTIGRAVITY_VERSION = "1.5.0";
