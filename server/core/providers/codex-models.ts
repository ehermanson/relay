import { spawn } from "node:child_process";
import type { Logger } from "#core/logger.js";
import type { ProviderModelOption } from "#core/types.js";
import {
  findCodexBinary,
  buildCodexSpawnEnv,
  RELAY_CODEX_ORIGINATOR,
} from "#core/providers/codex-cli.js";

type SpawnFn = typeof spawn;

interface CodexAppServerResponse {
  id?: number | string;
  result?: {
    data?: Array<{
      id?: string;
      model?: string;
      displayName?: string;
      description?: string;
      hidden?: boolean;
      isDefault?: boolean;
      availabilityNux?: { message?: string } | null;
      upgrade?: string | null;
    }>;
  };
  error?: {
    code?: number;
    message?: string;
  };
}

export interface DiscoverCodexModelsOptions {
  codexPath?: string;
  includeHidden?: boolean;
  logger?: Logger;
  spawnProcess?: SpawnFn;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Module-level cache of Codex-reported models. Populated by
 * `prewarmCodexModels()` at server startup and refreshed when callers opt in
 * via `discoverCodexModels({ cache: true })`. The Codex binary spawns a fresh
 * `app-server` subprocess on every model probe, so this cache is what lets
 * `/api/provider-models?provider=codex` serve hot instead of paying the
 * subprocess startup cost on the first UI request.
 */
let codexDiscoveredModels: ProviderModelOption[] | null = null;

/** When the model list was last probed (prewarm or staleness refresh). */
let codexModelsProbedAt = 0;

/** In-flight staleness refresh, deduped so concurrent callers share one probe. */
let codexModelsRefreshInFlight: Promise<void> | null = null;

/** Re-probe the model list this often — the reported list changes when the
 *  Codex CLI is updated (including via Relay's own provider-update flow), so a
 *  long-running server must not serve a boot-time snapshot forever. */
const CODEX_MODELS_REFRESH_INTERVAL_MS = 30 * 60_000;

/**
 * Return the cached Codex model list if `prewarmCodexModels()` (or a cached
 * `discoverCodexModels()` call) has populated it. Returns null otherwise so
 * callers know to fall back to a live probe.
 */
export function getCachedCodexModels(): ProviderModelOption[] | null {
  return codexDiscoveredModels;
}

/**
 * Fire-and-forget pre-warm: probe `codex app-server` for models and cache
 * the result. Safe to call at server startup; the Codex binary may be missing,
 * in which case this resolves with an empty list and we leave the cache empty
 * so the provider driver falls back to the builtin catalog.
 */
export async function prewarmCodexModels(options: DiscoverCodexModelsOptions = {}): Promise<void> {
  if (codexDiscoveredModels) return;
  try {
    const models = await discoverCodexModels(options);
    if (models.length > 0) {
      codexDiscoveredModels = models;
      codexModelsProbedAt = Date.now();
      options.logger?.info?.(`[CodexModels] Pre-warm discovered ${models.length} models`);
    } else {
      options.logger?.debug?.(
        "[CodexModels] Pre-warm returned no models (binary missing or empty list)",
      );
    }
  } catch (err) {
    options.logger?.debug?.(`[CodexModels] Pre-warm failed (non-fatal): ${err}`);
  }
}

/**
 * Re-probe the Codex model list when the cached snapshot is older than
 * CODEX_MODELS_REFRESH_INTERVAL_MS. Fire-and-forget from the provider driver's
 * getModels() when the cache is warm (callers get the current cache
 * immediately and the UI's next poll picks up the refreshed list), or awaited
 * on a cold cache. An empty probe result leaves the previous cache in place.
 */
export async function refreshCodexModelsIfStale(
  options: DiscoverCodexModelsOptions = {},
): Promise<void> {
  if (Date.now() - codexModelsProbedAt < CODEX_MODELS_REFRESH_INTERVAL_MS) return;
  if (codexModelsRefreshInFlight) return codexModelsRefreshInFlight;
  codexModelsRefreshInFlight = (async () => {
    try {
      const models = await discoverCodexModels(options);
      if (models.length > 0) {
        codexDiscoveredModels = models;
        options.logger?.info?.(`[CodexModels] Refreshed model discovery: ${models.length} models`);
      }
    } catch (err) {
      options.logger?.debug?.(`[CodexModels] model discovery refresh failed (non-fatal): ${err}`);
    } finally {
      // Stamp even on failure/empty so a broken environment retries once per
      // interval instead of spawning a probe on every picker open.
      codexModelsProbedAt = Date.now();
      codexModelsRefreshInFlight = null;
    }
  })();
  return codexModelsRefreshInFlight;
}

export async function discoverCodexModels(
  options: DiscoverCodexModelsOptions = {},
): Promise<ProviderModelOption[]> {
  const logger = options.logger;
  const spawnProcess = options.spawnProcess ?? spawn;
  const codexPath = options.codexPath ?? findCodexBinary();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const includeHidden = options.includeHidden ?? false;

  if (!codexPath) {
    return Promise.resolve([]);
  }

  return new Promise((resolve, reject) => {
    const child = spawnProcess(codexPath, ["app-server", "--listen", "stdio://"], {
      env: buildCodexSpawnEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    let stderr = "";
    let settled = false;
    let initialized = false;

    const finish = (err: Error | null, models?: ProviderModelOption[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
      if (err) reject(err);
      else resolve(models ?? []);
    };

    const onError = (err: Error) => {
      finish(err);
    };

    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
      finish(
        new Error(
          `Codex app-server exited before returning model metadata (${code ?? signal ?? "unknown"})${suffix}`,
        ),
      );
    };

    const sendRequest = (id: number, method: string, params: unknown) => {
      child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    };

    const handleLine = (line: string) => {
      let message: CodexAppServerResponse;
      try {
        message = JSON.parse(line) as CodexAppServerResponse;
      } catch {
        return;
      }

      if (message.error) {
        finish(
          new Error(
            `Codex app-server request failed: ${message.error.message ?? `code ${message.error.code ?? "unknown"}`}`,
          ),
        );
        return;
      }

      if (message.id === 1) {
        initialized = true;
        sendRequest(2, "model/list", { includeHidden, limit: 100 });
        return;
      }

      if (message.id !== 2 || !initialized) {
        return;
      }

      const models = (message.result?.data ?? [])
        .filter((item) => item.id && item.model)
        .map<ProviderModelOption>((item) => ({
          provider: "codex",
          id: item.model as string,
          label: item.displayName || (item.model as string),
          description: item.description || undefined,
          hidden: item.hidden ?? false,
          isDefault: item.isDefault ?? false,
          availabilityNote: item.availabilityNux?.message || undefined,
          upgradeTo: item.upgrade || undefined,
        }));

      if (models.length > 0) {
        codexDiscoveredModels = models.map((model) => ({ ...model }));
      }
      finish(null, models);
    };

    const onStdout = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) handleLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    };

    const onStderr = (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 4000) {
        stderr = stderr.slice(-4000);
      }
      logger?.debug?.(`[discoverCodexModels] stderr: ${text.trim()}`);
    };

    const timeout = setTimeout(() => {
      finish(new Error(`Timed out after ${timeoutMs}ms while discovering Codex models`));
    }, timeoutMs);

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
    child.on("close", onClose);
    // A codex binary that exits immediately (e.g. missing/broken install) turns
    // the initialize write below into an EPIPE on stdin. Without this listener
    // that surfaces as an unhandled 'error' → uncaughtException that crashes the
    // process; route it through the normal settle path instead.
    child.stdin?.on("error", onError);

    sendRequest(1, "initialize", {
      clientInfo: {
        name: RELAY_CODEX_ORIGINATOR,
        version: "0.0.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  });
}
