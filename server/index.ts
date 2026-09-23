/**
 * Relay — Server Layer
 *
 * Full server with HTTP, WebSocket, auth, tunnel, and UI serving.
 * Re-exports everything from the core library for convenience.
 *
 * @example
 * ```ts
 * import { createRelay } from "relay/server";
 *
 * const relay = createRelay({
 *   password: process.env.PASSWORD!,
 *   port: 8080,
 *   defaultRuntimeMode: "full-access",
 *   workingDirectory: "/path/to/project",
 * });
 *
 * await relay.start();
 * // relay is now listening on http://localhost:8080
 *
 * // later...
 * await relay.stop();
 * ```
 */

import http from "node:http";
import type { WebSocketServer } from "ws";
import { resolveConfig, type RelayOptions, type RelayConfig } from "#server/config.js";
import { AuthManager } from "#server/auth.js";
import { InstanceManager } from "#core/instance-manager.js";
import { TerminalManager } from "#core/terminal-manager.js";
import { createWebSocketServer } from "#server/websocket.js";
import { createRequestHandler } from "#server/http.js";
import { PushNotifications } from "#server/push-notifications.js";

export class Relay {
  readonly config: RelayConfig;

  private server: http.Server;
  private wss: WebSocketServer;
  private auth: AuthManager;
  private instanceManager: InstanceManager;
  private terminalManager: TerminalManager | null = null;
  private sockets = new Set<import("node:net").Socket>();

  constructor(options: RelayOptions) {
    this.config = resolveConfig(options);
    this.auth = new AuthManager(this.config);
    this.instanceManager = new InstanceManager(this.config);
    let pushNotifications: PushNotifications | undefined;
    try {
      pushNotifications = new PushNotifications(this.auth, this.instanceManager, this.config);
    } catch (error) {
      this.config.logger.warn(
        "Background notifications unavailable:",
        error instanceof Error ? error.message : String(error),
      );
    }

    // Use a lazy getter so the request handler can reference the WS connection count
    // even though the WSS is created after the HTTP server.
    let wsGetConnectionCount: (() => number) | null = null;

    const handler = createRequestHandler(
      this.config,
      this.auth,
      this.instanceManager,
      () => (wsGetConnectionCount ? wsGetConnectionCount() : 0),
      {
        ...(options.updateManager ? { updateManager: options.updateManager } : {}),
        pushNotifications,
      },
    );
    this.server = http.createServer(handler);

    // Track connections for clean shutdown
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });

    // Terminal manager is initialized lazily in start() — pass a getter so the WSS
    // can reference it once available.
    const getTerminalManager = () => this.terminalManager ?? undefined;

    const wsHandle = createWebSocketServer(
      this.server,
      this.instanceManager,
      this.auth,
      this.config,
      getTerminalManager,
    );
    this.wss = wsHandle.wss;
    // Prevent WSS from crashing on HTTP server errors (e.g. EADDRINUSE during restart)
    this.wss.on("error", () => {});
    wsGetConnectionCount = wsHandle.getConnectionCount;
  }

  /**
   * Start listening for connections.
   *
   * Startup sequence:
   * 1. Initialize SDK provider
   * 2. Restore instances from DB cache (fast, ~50ms)
   * 3. Start HTTP server — UI is available immediately
   * 4. Background: filesystem scan discovers new sessions, then starts discovery polling
   */
  async start(): Promise<void> {
    await this.instanceManager.initSdkProvider();
    // Kick off Codex pre-warm in parallel with the rest of boot — model list
    // and account/rate-limit snapshot are both fetched via short-lived
    // `codex app-server` subprocesses; no need to await before serving HTTP.
    this.instanceManager.initCodexProvider();
    this.instanceManager.restoreInstances(); // DB-only, fast

    // Initialize terminal support (non-fatal if node-pty is unavailable)
    try {
      const { createNodePtyFactory } = await import("#core/pty-adapters/node-pty.js");
      const factory = await createNodePtyFactory();
      this.terminalManager = new TerminalManager(factory, this.config.logger);
      this.config.logger.info("Terminal support enabled (node-pty)");
    } catch (err) {
      this.config.logger.warn(
        "Terminal support unavailable:",
        err instanceof Error ? err.message : String(err),
      );
    }

    await this.listenWithRetry();

    // Background: scan filesystem for new sessions, then start discovery polling.
    // Not awaited — server is already listening.
    this.instanceManager.scanInBackground().then(() => {
      this.instanceManager.startDiscovery();
      // Maintenance: clear space worktree dirs whose repository is gone.
      // After the scan so recovered space rows count as references.
      this.instanceManager
        .getSpaceManager()
        .sweepOrphanedWorktrees()
        .catch((err) => {
          this.config.logger.warn(
            "[Relay] Orphaned worktree sweep failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
    });
  }

  /**
   * Gracefully stop the server and kill any running Claude processes.
   */
  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Release the listening socket first so dev restarts can rebind promptly,
      // then tear down managed sessions and the rest of the process state.
      for (const client of this.wss.clients) {
        client.close(1001, "Server shutting down");
      }
      for (const socket of this.sockets) {
        socket.destroy();
      }
      this.sockets.clear();

      this.wss.close(() => {
        this.server.close((err) => {
          if (err) {
            reject(err);
            return;
          }

          this.terminalManager?.closeAll();
          this.instanceManager.stopAllGracefully().then(resolve, reject);
        });
      });
    });
  }

  private async listenWithRetry(): Promise<void> {
    const maxAttempts = process.env.DEV ? 12 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.listenOnce();
        return;
      } catch (err) {
        const error = err as NodeJS.ErrnoException;
        const shouldRetry = error.code === "EADDRINUSE" && attempt < maxAttempts;
        if (!shouldRetry) throw err;

        this.config.logger.warn(
          `[Relay] Port ${this.config.port} still busy during dev restart; retrying (${attempt}/${maxAttempts - 1})`,
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  private listenOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.removeListener("error", onError);
        this.config.logger.info(`Relay listening on http://localhost:${this.config.port}`);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      try {
        this.server.listen(this.config.port);
      } catch (err) {
        this.server.removeListener("error", onError);
        this.server.removeListener("listening", onListening);
        reject(err as Error);
      }
    });
  }
}

/**
 * Create a new Relay instance.
 */
export function createRelay(options: RelayOptions): Relay {
  return new Relay(options);
}

// Re-export everything from core for convenience
export * from "#core/index.js";

// Server-specific exports
export { AuthManager } from "#server/auth.js";
export type { RelayOptions, RelayConfig } from "#server/config.js";
export { resolveConfig } from "#server/config.js";
export { createRequestHandler } from "#server/http.js";
export { createWebSocketServer } from "#server/websocket.js";
export type { WebSocketServerHandle } from "#server/websocket.js";
export { startTunnel, stopTunnel } from "#server/tunnel.js";
