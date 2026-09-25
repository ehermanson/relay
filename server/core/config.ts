/**
 * Core configuration for Relay
 *
 * Defines the subset of config needed by the core library (process management,
 * instance orchestration) without any server-specific fields.
 */

import { join, resolve } from "path";
import { homedir } from "os";
import { defaultLogger, type Logger } from "#core/logger.js";
import type { ProviderKind, ProviderRuntimeMode } from "#core/types.js";
import { resolveClaudeConfigDir } from "#core/providers/claude-cli.js";

/**
 * Core configuration — the subset needed by ClaudeProcess and InstanceManager.
 * The server layer extends this with HTTP/auth-specific fields.
 */
export interface CoreConfig {
  /** Working directory for Claude processes */
  workingDirectory: string;
  /** Default runtime mode for new sessions when one isn't specified */
  defaultRuntimeMode: ProviderRuntimeMode;
  /** Process timeout in milliseconds (0 = no timeout) */
  processTimeout: number;
  /** Maximum number of concurrent managed Claude processes */
  maxProcesses: number;
  /** Logger implementation */
  logger: Logger;
  /** Path to the SQLite database for session persistence */
  dbPath: string;
  /** Provider-specific data directories (e.g. { claude: "~/.claude", codex: "~/.codex" }) */
  providerDirs: Partial<Record<ProviderKind, string>>;
}

/**
 * Options for standalone core usage (without the server layer).
 */
export type CoreOptions = Partial<CoreConfig>;

/**
 * Merge user options with defaults to produce a full core config.
 */
function resolveRelayDir(): string {
  if (process.env.RELAY_HOME) {
    return resolve(process.env.RELAY_HOME);
  }
  return join(homedir(), ".relay");
}

/** Base directory for Relay state: ~/.relay by default, or RELAY_HOME when explicitly set. */
export const relayDir = resolveRelayDir();

export function resolveCoreConfig(options: CoreOptions = {}): CoreConfig {
  const home = homedir();
  return {
    workingDirectory: options.workingDirectory ?? process.cwd(),
    defaultRuntimeMode: options.defaultRuntimeMode ?? "full-access",
    processTimeout: options.processTimeout ?? 30 * 60 * 1000,
    maxProcesses: options.maxProcesses ?? 15,
    logger: options.logger ?? defaultLogger,
    dbPath: options.dbPath ?? join(relayDir, "sessions.db"),
    providerDirs: options.providerDirs ?? {
      claude: resolveClaudeConfigDir(),
      codex: join(home, ".codex"),
    },
  };
}
