/**
 * Server configuration for Relay
 *
 * Extends CoreConfig with HTTP/auth-specific fields.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { relayDir, type CoreConfig } from "#core/config.js";
import { defaultLogger } from "#core/logger.js";
import type { UpdateManager } from "#server/update-manager.js";
import { resolveClaudeConfigDir } from "#core/providers/claude-cli.js";

/**
 * Fully resolved server configuration (all fields required).
 * Extends CoreConfig with server-specific fields.
 */
export interface RelayConfig extends CoreConfig {
  /** Port to run the server on */
  port: number;
  /** Password for authentication (undefined = open mode, no auth required) */
  password: string | undefined;
  /** Session lifetime in milliseconds */
  sessionMaxAge: number;
  /** Whether to serve the built-in web UI at / and /chat */
  serveUI: boolean;
  /** Max auth attempts per IP within the rate limit window */
  rateLimitMax: number;
  /** Rate limit window in milliseconds */
  rateLimitWindow: number;
  /** Path to the session persistence file */
  sessionFile: string;
}

/**
 * User-facing options. Everything has defaults.
 * When password is omitted, the server runs in open mode (no auth required).
 */
export type RelayOptions = Partial<RelayConfig> & {
  /** Alias for workingDirectory */
  defaultWorkingDirectory?: string;
  /** Optional install/update manager used by the UI updater flow. */
  updateManager?: UpdateManager;
};

/**
 * Merge user options with defaults to produce a full config.
 */
export function resolveConfig(options: RelayOptions): RelayConfig {
  const home = homedir();
  return {
    port: options.port ?? 7777,
    password: options.password,
    sessionMaxAge: options.sessionMaxAge ?? 7 * 24 * 60 * 60 * 1000,
    defaultRuntimeMode: options.defaultRuntimeMode ?? "full-access",
    processTimeout: options.processTimeout ?? 30 * 60 * 1000,
    workingDirectory: options.workingDirectory ?? options.defaultWorkingDirectory ?? process.cwd(),
    serveUI: options.serveUI ?? true,
    logger: options.logger ?? defaultLogger,
    rateLimitMax: options.rateLimitMax ?? 5,
    rateLimitWindow: options.rateLimitWindow ?? 60 * 1000,
    maxProcesses: options.maxProcesses ?? 15,
    sessionFile: options.sessionFile ?? join(relayDir, "sessions.json"),
    dbPath: options.dbPath ?? join(relayDir, "sessions.db"),
    providerDirs: options.providerDirs ?? {
      claude: resolveClaudeConfigDir(),
      codex: join(home, ".codex"),
    },
  };
}
