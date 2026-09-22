/**
 * Provider Version Probe
 *
 * Detects whether a provider's installed CLI (claude, codex) is behind the
 * latest published version. Used by provider-registry.ts to populate the
 * `versionAdvisory` field on ProviderCapabilities. The UI consumes that field
 * to fire a launch toast + render a settings card.
 *
 * Architecture:
 * - Install classification and command builders are pure; semver comparison
 *   lives in browser-safe semver.ts and is re-exported here.
 * - I/O helpers (`getInstalledVersion`, `fetchNpmLatest`) fail soft — they
 *   never throw to callers; on error they return `null` and leave the
 *   advisory in `status: "unknown"` so Settings can offer a recheck.
 * - npm and Homebrew metadata are cached in-memory for 1h; manual rechecks
 *   bypass both caches. Homebrew availability is separate from npm latest.
 *
 * No external deps — pure Node built-ins so the module can sit in core.
 */
import { execFile, type ExecFileException } from "node:child_process";
import { realpathSync } from "node:fs";
import { compareSemver } from "#core/semver.js";
export { compareSemver } from "#core/semver.js";
import type { ProviderInstallMethod, ProviderKind, ProviderVersionAdvisory } from "#core/types.js";

// ─── Per-provider metadata table ────────────────────────────────────────────

export interface ProviderPackageMetadata {
  /** npm package name */
  npmPackageName: string;
  /** Homebrew cask/formula name (if installable via brew) */
  homebrewFormula: string | null;
  /** If the binary supports `<bin> update` as a native self-update */
  nativeUpdate: { command: string; matches: (realpath: string) => boolean } | null;
}

const CLAUDE_NPM_PACKAGE = "@anthropic-ai/claude-code";
const CODEX_NPM_PACKAGE = "@openai/codex";

export const PROVIDER_PACKAGE_METADATA: Partial<Record<ProviderKind, ProviderPackageMetadata>> = {
  claude: {
    npmPackageName: CLAUDE_NPM_PACKAGE,
    homebrewFormula: "claude-code",
    nativeUpdate: {
      command: "claude update",
      matches: (realpath) => {
        const n = normalizeCommandPath(realpath);
        return n.endsWith("/.local/bin/claude") || n.includes("/.local/share/claude/");
      },
    },
  },
  codex: {
    npmPackageName: CODEX_NPM_PACKAGE,
    // Ships as a homebrew cask; `brew upgrade codex` handles casks too
    homebrewFormula: "codex",
    nativeUpdate: null,
  },
};

// ─── Pure helpers ───────────────────────────────────────────────────────────

export function normalizeCommandPath(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

/**
 * Classify how a binary was installed based on its realpath. Mirrors the
 * patterns used by mainstream package managers on macOS and Linux. Returns
 * "manual" when we can't confidently classify — the UI then shows the package
 * name + recommended npm command but labels it as the recommended install
 * method, not a detected one.
 *
 * Pure: takes a path string, returns a label. Does no I/O.
 */
export function classifyInstallMethod(
  realpath: string,
  metadata?: ProviderPackageMetadata,
): ProviderInstallMethod {
  const n = normalizeCommandPath(realpath);

  // Provider-specific native update (e.g. `claude update` for the native binary)
  if (metadata?.nativeUpdate?.matches(realpath)) return "native";

  // Bun global
  if (n.includes("/.bun/bin/")) return "bun";

  // pnpm global locations across platforms
  if (
    n.includes("/.local/share/pnpm/") ||
    n.includes("/library/pnpm/") ||
    n.includes("/local/share/pnpm/") ||
    n.includes("/appdata/local/pnpm/") ||
    n.includes("/pnpm/global/")
  ) {
    return "pnpm";
  }

  // Homebrew (cellar = installed package, /opt/homebrew/bin = symlink shim)
  if (
    n.includes("/cellar/") ||
    n.includes("/caskroom/") ||
    n.startsWith("/opt/homebrew/bin/") ||
    (n.startsWith("/usr/local/bin/") && (n.includes("/cellar/") || n.includes("/caskroom/")))
  ) {
    return "brew";
  }

  // npm global (real path lands under node_modules)
  if (
    n.includes("/node_modules/.bin/") ||
    n.includes("/lib/node_modules/") ||
    n.includes("/npm/node_modules/")
  ) {
    return "npm";
  }

  return "manual";
}

/**
 * Build the human-readable update command for an install method. Returns null
 * when we have no opinion (manual install with no known formula) — UI then
 * shows the recommended npm command and labels install method as "manual".
 */
export function buildUpdateCommand(
  method: ProviderInstallMethod,
  metadata: ProviderPackageMetadata,
): string | null {
  const pkg = metadata.npmPackageName;
  switch (method) {
    case "native":
      return metadata.nativeUpdate?.command ?? null;
    case "bun":
      return `bun i -g ${pkg}@latest`;
    case "pnpm":
      return `pnpm add -g ${pkg}@latest`;
    case "brew":
      return metadata.homebrewFormula ? `brew upgrade ${metadata.homebrewFormula}` : null;
    case "npm":
      return `npm install -g ${pkg}@latest`;
    case "manual":
      // No detected install method — recommend npm as the most portable option
      return `npm install -g ${pkg}@latest`;
  }
}

// ─── I/O helpers ────────────────────────────────────────────────────────────

const VERSION_PROBE_TIMEOUT_MS = 3_000;
const NPM_LATEST_TIMEOUT_MS = 4_000;
const NPM_LATEST_CACHE_TTL_MS = 60 * 60 * 1_000;

interface NpmLatestCacheEntry {
  expiresAt: number;
  version: string | null;
}
const npmLatestCache = new Map<string, NpmLatestCacheEntry>();

/**
 * Run `<binary> --version` and parse the first semver-looking token from the
 * output. Returns null on any failure (timeout, nonzero exit, unparseable
 * output, missing binary).
 */
export function getInstalledVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const child = execFile(
      binary,
      ["--version"],
      { timeout: VERSION_PROBE_TIMEOUT_MS, encoding: "utf8" },
      (err: ExecFileException | null, stdout, stderr) => {
        if (err) {
          finish(null);
          return;
        }
        const combined = `${stdout ?? ""}\n${stderr ?? ""}`;
        const match = combined.match(/\bv?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/);
        finish(match ? match[1] : null);
      },
    );
    child.on("error", () => finish(null));
  });
}

/**
 * Get the latest published version of an npm package. Cached in-memory for
 * 1h to avoid hammering the registry on each refresh cycle. Caller can pass
 * `{ force: true }` to bypass the cache (used by the manual recheck endpoint).
 * Returns null on any failure — caller falls back to status "unknown".
 */
export async function fetchNpmLatest(
  packageName: string,
  options: { force?: boolean } = {},
): Promise<string | null> {
  const now = Date.now();
  if (!options.force) {
    const cached = npmLatestCache.get(packageName);
    if (cached && cached.expiresAt > now) {
      return cached.version;
    }
  }

  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NPM_LATEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      npmLatestCache.set(packageName, { expiresAt: now + NPM_LATEST_CACHE_TTL_MS, version: null });
      return null;
    }
    const json = (await res.json()) as { version?: unknown };
    const version =
      typeof json.version === "string" && json.version.trim().length > 0
        ? json.version.trim()
        : null;
    npmLatestCache.set(packageName, { expiresAt: now + NPM_LATEST_CACHE_TTL_MS, version });
    return version;
  } catch {
    // Network error / abort / parse failure: cache the null briefly so we don't
    // retry on every refresh cycle, but expire quickly so a transient network
    // outage doesn't suppress advisories for the full hour.
    npmLatestCache.set(packageName, { expiresAt: now + 60_000, version: null });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Homebrew's distribution can trail npm. Match the installed cask/formula. */
const homebrewLatestCache = new Map<string, NpmLatestCacheEntry>();

export async function fetchHomebrewLatest(
  packageName: string,
  kind: "cask" | "formula",
  options: { force?: boolean } = {},
): Promise<string | null> {
  const url = `https://formulae.brew.sh/api/${kind}/${encodeURIComponent(packageName)}.json`;
  const now = Date.now();
  const cached = homebrewLatestCache.get(url);
  if (!options.force && cached && cached.expiresAt > now) return cached.version;
  let version: string | null = null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(NPM_LATEST_TIMEOUT_MS) });
    if (response.ok) {
      const data = (await response.json()) as {
        version?: unknown;
        versions?: { stable?: unknown };
      };
      const candidate = kind === "cask" ? data.version : data.versions?.stable;
      if (typeof candidate === "string" && /^v?\d+\.\d+\.\d+(?:[-+][\w.]+)?$/.test(candidate)) {
        version = candidate;
      }
    }
  } catch {
    // Unknown availability must never imply an installable update.
  }
  homebrewLatestCache.set(url, {
    expiresAt: now + (version ? NPM_LATEST_CACHE_TTL_MS : 60_000),
    version,
  });
  return version;
}

const UPDATE_COMMAND_TIMEOUT_MS = 10 * 60 * 1_000;
const UPDATE_OUTPUT_MAX_BUFFER = 10 * 1024 * 1024;

export interface UpdateCommandResult {
  ok: boolean;
  output: string;
}

export interface UpdateCommandInvocation {
  binary: string;
  args: string[];
}

export interface BuildUpdateInvocationOptions {
  /**
   * Absolute provider binary path discovered by Relay. Used for native updaters
   * so we update the same CLI Relay probed instead of whichever shim is first
   * on the server process PATH.
   */
  providerBinaryPath?: string | null;
}

/**
 * Convert the server-derived display command into a shell-less execFile argv.
 * Returns null when the command is empty or when a native updater cannot be
 * safely tied to the provider binary Relay actually discovered.
 */
export function buildUpdateInvocation(
  command: string,
  method: ProviderInstallMethod,
  options: BuildUpdateInvocationOptions = {},
): UpdateCommandInvocation | null {
  const [displayBinary, ...displayArgs] = command.trim().split(/\s+/);
  if (!displayBinary) return null;
  if (method === "native") {
    const providerBinaryPath = options.providerBinaryPath?.trim();
    if (!providerBinaryPath) return null;
    return { binary: providerBinaryPath, args: displayArgs };
  }
  return { binary: displayBinary, args: displayArgs };
}

/**
 * Execute a provider update command (e.g. `brew upgrade codex`). The command
 * string must always come from `buildUpdateCommand()` — never from the client
 * — so simple whitespace tokenization is safe (none of our commands need
 * quoting or shell expansion). Runs without a shell via execFile. Never
 * throws; failures (nonzero exit, timeout, missing binary) resolve with
 * `ok: false` and whatever output the command produced.
 */
export function executeUpdateCommand(
  command: string,
  method: ProviderInstallMethod = "manual",
  options: BuildUpdateInvocationOptions = {},
): Promise<UpdateCommandResult> {
  return new Promise((resolve) => {
    const invocation = buildUpdateInvocation(command, method, options);
    if (!invocation) {
      resolve({
        ok: false,
        output: command.trim() ? "Unsafe update command" : "Empty update command",
      });
      return;
    }
    execFile(
      invocation.binary,
      invocation.args,
      {
        timeout: UPDATE_COMMAND_TIMEOUT_MS,
        encoding: "utf8",
        maxBuffer: UPDATE_OUTPUT_MAX_BUFFER,
      },
      (err: ExecFileException | null, stdout, stderr) => {
        const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
        if (err) {
          const reason = err.killed ? "Update command timed out" : err.message;
          resolve({ ok: false, output: output || reason });
          return;
        }
        resolve({ ok: true, output });
      },
    );
  });
}

/**
 * Resolve a binary's realpath. Falls back to the original path if realpath
 * fails (e.g. broken symlink); caller's install-method classifier handles
 * unknown paths by returning "manual".
 */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// ─── Orchestration ──────────────────────────────────────────────────────────

export interface BuildVersionAdvisoryInput {
  provider: ProviderKind;
  binaryPath: string | null;
  /** Force-bypass distribution caches (used by manual recheck endpoint) */
  force?: boolean;
}

/**
 * Probe an installed provider and produce a version advisory. Never throws —
 * Missing installed/npm versions produce an unknown advisory; Homebrew
 * lookup failures leave availableVersion null and disable automatic updates.
 */
export async function buildVersionAdvisory(
  input: BuildVersionAdvisoryInput,
): Promise<ProviderVersionAdvisory> {
  const metadata = PROVIDER_PACKAGE_METADATA[input.provider];
  const checkedAt = new Date().toISOString();
  const baseUnknown: ProviderVersionAdvisory = {
    status: "unknown",
    currentVersion: null,
    latestVersion: null,
    packageName: metadata?.npmPackageName ?? null,
    updateCommand: null,
    installMethod: null,
    checkedAt: null,
  };

  if (!metadata || !input.binaryPath) {
    return baseUnknown;
  }

  const realpath = safeRealpath(input.binaryPath);
  const installMethod = classifyInstallMethod(realpath, metadata);
  const [currentVersion, latestVersion, brewVersion] = await Promise.all([
    getInstalledVersion(input.binaryPath),
    fetchNpmLatest(metadata.npmPackageName, { force: input.force }),
    installMethod === "brew" && metadata.homebrewFormula
      ? fetchHomebrewLatest(
          metadata.homebrewFormula,
          normalizeCommandPath(realpath).includes("/cellar/") ? "formula" : "cask",
          { force: input.force },
        )
      : Promise.resolve(null),
  ]);

  const availableVersion = installMethod === "brew" ? brewVersion : latestVersion;
  const updateCommand = buildUpdateCommand(installMethod, metadata);

  if (!currentVersion || !latestVersion) {
    return {
      ...baseUnknown,
      currentVersion,
      latestVersion,
      availableVersion,
      installMethod,
      updateCommand,
      checkedAt,
    };
  }

  const cmp = compareSemver(currentVersion, latestVersion);
  return {
    status: cmp < 0 ? "behind_latest" : "current",
    currentVersion,
    latestVersion,
    availableVersion,
    packageName: metadata.npmPackageName,
    updateCommand,
    installMethod,
    checkedAt,
  };
}
