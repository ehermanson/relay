/** Cloudflare connectors for temporary links and configured permanent URLs. */
import { spawn, type ChildProcess } from "node:child_process";
import type { NamedTunnelSettings } from "#server/tunnel-settings.js";

export interface TunnelOptions {
  named?: NamedTunnelSettings;
  onUrl?: (url: string | null) => void;
}

interface TunnelDependencies {
  spawn?: typeof spawn;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

/** Each supervisor owns its process and retry timer; stopping cannot resurrect a connector. */
export function createTunnelSupervisor(
  localPort: number,
  options: TunnelOptions = {},
  dependencies: TunnelDependencies = {},
): { stop: () => void } {
  const spawnProcess = dependencies.spawn ?? spawn;
  const log = dependencies.log ?? console.log;
  const warn = dependencies.warn ?? console.error;
  const schedule = dependencies.setTimeout ?? setTimeout;
  const cancel = dependencies.clearTimeout ?? clearTimeout;
  let stopped = false;
  let child: ChildProcess | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;

  function launch() {
    if (stopped) return;
    log(
      options.named
        ? `  Connecting permanent URL: ${options.named.publicUrl}`
        : "  Starting cloudflared tunnel...",
    );
    const args = options.named
      ? ["tunnel", "--no-autoupdate", "run", "--token-file", options.named.tokenFile]
      : ["tunnel", "--url", `http://localhost:${localPort}`];
    const env = { ...process.env };
    // cloudflared's TUNNEL_TOKEN takes precedence over --token-file. A saved connector
    // must never accidentally join a different tunnel inherited from the shell.
    if (options.named) {
      delete env.TUNNEL_TOKEN;
      delete env.TUNNEL_TOKEN_FILE;
    }
    const connector = spawnProcess("cloudflared", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    child = connector;
    let unavailable = false;
    let stderrBuffer = "";
    let announced = false;

    connector.on("error", (error: NodeJS.ErrnoException) => {
      unavailable = error.code === "ENOENT";
      warn(
        unavailable
          ? "  cloudflared not found. Install it with brew install cloudflared (macOS), then restart Relay."
          : "  Tunnel connector failed to start. Check cloudflared and your tunnel configuration.",
      );
    });
    connector.stderr?.on("data", (data: Buffer) => {
      if (stopped || child !== connector) return;
      stderrBuffer = (stderrBuffer + data.toString()).slice(-32_768);
      // Do not print raw connector output: it can contain credentials or request details.
      if (options.named) {
        if (stderrBuffer.includes("Registered tunnel connection")) {
          failures = 0;
          if (!announced) {
            announced = true;
            log(`\n  Permanent URL: ${options.named.publicUrl}\n`);
          }
        }
      } else if (!announced) {
        const match = stderrBuffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) {
          announced = true;
          failures = 0;
          options.onUrl?.(match[0]);
          log(`\n  Tunnel URL: ${match[0]}\n`);
        }
      }
    });
    connector.once("close", () => {
      if (child !== connector) return;
      child = null;
      if (!options.named) options.onUrl?.(null);
      if (stopped || unavailable) return;
      const delay = Math.min(1_000 * 2 ** Math.min(failures++, 5), 30_000);
      warn(`  Tunnel disconnected. Reconnecting in ${delay / 1_000}s.`);
      retryTimer = schedule(() => {
        retryTimer = null;
        launch();
      }, delay);
      retryTimer.unref();
    });
  }

  options.onUrl?.(options.named?.publicUrl ?? null);
  launch();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (retryTimer) cancel(retryTimer);
      retryTimer = null;
      child?.kill();
      child = null;
      options.onUrl?.(null);
    },
  };
}

let activeTunnel: ReturnType<typeof createTunnelSupervisor> | null = null;

/** Existing callers still get a quick tunnel; a saved named identity opts into a stable URL. */
export function startTunnel(localPort: number, options: TunnelOptions = {}): void {
  stopTunnel();
  activeTunnel = createTunnelSupervisor(localPort, options);
}

export function stopTunnel(): void {
  activeTunnel?.stop();
  activeTunnel = null;
}
