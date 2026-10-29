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
import { acquireServerStateLock } from "#server/state-lock.js";

export class Relay {
  readonly config: RelayConfig;

  /** The actual listener address, including the OS-assigned port when port is zero. */
  get address(): import("node:net").AddressInfo | null {
    const address = this.server.address();
    return address && typeof address !== "string" ? address : null;
  }

  getRuntimeStatus(): { activeCount: number; pendingCount: number; terminalCount: number } {
    return {
      ...this.instanceManager.getRuntimeStatus(),
      terminalCount:
        this.terminalManager?.listTerminals().filter((terminal) => !terminal.exited).length ?? 0,
    };
  }

  getMemoryDiagnostics() {
    return this.instanceManager.getMemoryDiagnostics();
  }

  reconcile(): Promise<void> {
    return this.instanceManager.reconcile();
  }

  quiesceForUpdate(): boolean {
    if (this.getRuntimeStatus().terminalCount) return false;
    if (!this.instanceManager.quiesceIfIdle()) return false;
    this.quiescing = true;
    // Stop transports synchronously with the idle decision. Main receives the
    // acknowledgement before requesting final graceful process shutdown.
    // WebSocket clients get a 1001 close frame ("Relay is updating") so they
    // see a clean goodbye instead of an abnormal drop — destroying their TCP
    // sockets immediately would discard the frame before it flushes. Plain
    // HTTP sockets are destroyed now; a short unref'd fallback hard-kills any
    // WS connection that hasn't completed the close handshake.
    const clients = [...this.wss.clients];
    const wsSockets = new Set<import("node:net").Socket>();
    for (const client of clients) {
      const socket = (client as unknown as { _socket?: import("node:net").Socket })._socket;
      if (socket) wsSockets.add(socket);
      client.close(1001, "Relay is updating");
    }
    for (const socket of this.sockets) {
      if (!wsSockets.has(socket)) socket.destroy();
    }
    setTimeout(() => {
      for (const client of clients) client.terminate();
      for (const socket of wsSockets) if (!socket.destroyed) socket.destroy();
    }, 1000).unref();
    this.wss.close();
    return true;
  }

  private server: http.Server;
  private wss: WebSocketServer;
  private auth: AuthManager;
  private instanceManager: InstanceManager;
  private terminalManager: TerminalManager | null = null;
  private sockets = new Set<import("node:net").Socket>();
  private quiescing = false;
  private releaseStateLock: () => void;
  private backgroundStartupDelayMs: number;
  private backgroundStartupTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(options: RelayOptions) {
    this.config = resolveConfig(options);
    this.backgroundStartupDelayMs = options.backgroundStartupDelayMs ?? 0;
    this.releaseStateLock = acquireServerStateLock(this.config.dbPath);
    try {
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
          getTunnelUrl: options.getTunnelUrl,
        },
      );
      this.server = http.createServer((request, response) => {
        if (this.quiescing) {
          response.writeHead(503, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "Relay is updating; retry after it reconnects" }));
          return;
        }
        return handler(request, response);
      });

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
    } catch (error) {
      // The InstanceManager opened the SQLite DB; close it before releasing
      // the state lock so a failed construction leaves nothing behind. The
      // cast is deliberate: the field is unassigned when construction failed
      // before (or inside) `new InstanceManager`.
      const instanceManager = (this as unknown as { instanceManager?: InstanceManager })
        .instanceManager;
      try {
        instanceManager?.stopAll();
      } catch {
        // Best-effort cleanup — the construction error below is the real failure.
      }
      this.releaseStateLock();
      throw error;
    }
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
    // Sessions started from here on get Relay's MCP tools (needs the real port).
    this.instanceManager.setOrchestrationEndpoint(relayMcpUrl(this.config.host, this.config.port));

    // Background: scan filesystem for new sessions, then start discovery polling.
    // Not awaited — server is already listening.
    const scan = () => {
      this.backgroundStartupTimer = null;
      void this.instanceManager
        .scanInBackground()
        .then(() => {
          if (this.stopping) return;
          this.instanceManager.startDiscovery();
        })
        .catch((error) => {
          this.config.logger.warn("[Relay] Background session scan failed:", error);
        });
    };
    if (this.backgroundStartupDelayMs > 0)
      this.backgroundStartupTimer = setTimeout(scan, this.backgroundStartupDelayMs);
    else scan();
  }

  /**
   * Gracefully stop the server and kill any running Claude processes.
   */
  stop(): Promise<void> {
    this.stopping = true;
    if (this.backgroundStartupTimer) clearTimeout(this.backgroundStartupTimer);
    this.backgroundStartupTimer = null;
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

          // Release the state lock no matter how teardown goes — a failure in
          // closeAll/stopAllGracefully must not leave the lock held.
          let stopped: Promise<void>;
          try {
            this.terminalManager?.closeAll();
            stopped = this.instanceManager.stopAllGracefully();
          } catch (error) {
            this.releaseStateLock();
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          stopped.then(
            () => {
              this.releaseStateLock();
              resolve();
            },
            (error) => {
              this.releaseStateLock();
              reject(error);
            },
          );
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
        const address = this.address;
        if (address) this.config.port = address.port;
        this.config.logger.info(`Relay listening on http://localhost:${this.config.port}`);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      try {
        this.server.listen(this.config.port, this.config.host);
      } catch (err) {
        this.server.removeListener("error", onError);
        this.server.removeListener("listening", onListening);
        reject(err as Error);
      }
    });
  }
}

/**
 * URL provider CLIs on this machine use to reach `/mcp`. A wildcard bind
 * (or none) is reached over IPv4 loopback; an explicit host is used as-is.
 */
export function relayMcpUrl(host: string | undefined, port: number): string {
  const wildcard = !host || host === "0.0.0.0" || host === "::" || host === "[::]";
  const target = wildcard
    ? "127.0.0.1"
    : host.includes(":") && !host.startsWith("[")
      ? `[${host}]`
      : host;
  return `http://${target}:${port}/mcp`;
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
