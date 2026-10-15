import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createBackendUpdateService } from "./update-service.mjs";
import { acquireStateLock } from "./state-lock.mjs";

// The Relay home is resolved at module initialization. Do not statically import
// server modules: main must choose the isolated desktop home first.
const parent = process.parentPort;
if (!parent) throw new Error("The desktop backend requires an Electron utility process");

let relay;
let authDirectory;
let starting;
let stopping = false;
let releaseStateLock;
let nativeTerminalMetrics;
const bootAt = performance.now();

const send = (message) => parent.postMessage(message);
const execute = promisify(execFile);

async function restoreShellPath() {
  if (process.platform === "win32") return;
  const shell = isAbsolute(process.env.SHELL ?? "")
    ? process.env.SHELL
    : process.platform === "darwin"
      ? "/bin/zsh"
      : "/bin/sh";
  try {
    // Fixed script and argv: Project paths and messages never enter shell code.
    // Login/interactive initialization finds CLI installs from Finder launches.
    const { stdout } = await execute(shell, ["-ilc", 'printf "\\0RELAY_PATH\\0%s\\0" "$PATH"'], {
      timeout: 3000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    const path = stdout.split("\0RELAY_PATH\0").at(-1)?.split("\0")[0];
    if (stdout.includes("\0RELAY_PATH\0") && path) process.env.PATH = path;
  } catch {
    // A broken or slow shell configuration must not prevent desktop startup.
    console.warn("Login shell PATH unavailable; using inherited PATH");
  }
}

async function readDesktopPort(home) {
  try {
    const value = JSON.parse(await readFile(join(home, "desktop-port.json"), "utf8"));
    if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
      throw new Error("Invalid desktop listener port");
    }
    return value.port;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

async function saveDesktopPort(home, port) {
  const temporary = join(home, `desktop-port-${process.pid}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ port })}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, join(home, "desktop-port.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readDesktopIdentity(home) {
  const file = join(home, "desktop-identity.json");
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (typeof value.identity !== "string" || !/^[a-f0-9]{64}$/.test(value.identity)) {
      throw new Error("Invalid desktop owner identity");
    }
    return value.identity;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const identity = randomBytes(32).toString("hex");
    // Main's single-instance lock serializes initialization for this home.
    await writeFile(file, `${JSON.stringify({ identity })}\n`, { mode: 0o600, flag: "wx" });
    return identity;
  }
}

async function verifyNativeTerminal() {
  const { createNodePtyFactory } = await import("../dist/server/core/pty-adapters/node-pty.js");
  const factory = await createNodePtyFactory();
  const terminal = factory({
    shell: process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : "/bin/sh",
    cwd: homedir(),
    cols: 80,
    rows: 24,
  });
  const started = performance.now();
  let outputBytes = 0;
  const throughput = process.env.RELAY_DESKTOP_BENCHMARK === "1";
  await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => {
        terminal.kill();
        reject(new Error("Native terminal probe timed out"));
      },
      throughput ? 15000 : 5000,
    );
    terminal.on("data", (data) => {
      outputBytes += Buffer.byteLength(data);
      output = (output + data).slice(-4096);
    });
    terminal.on("exit", (code) => {
      clearTimeout(timeout);
      if (
        code === 0 &&
        output.includes("RELAY_PTY_OK") &&
        (!throughput || outputBytes >= 1024 * 1024)
      )
        resolve();
      else reject(new Error("Native terminal probe failed"));
    });
    const command = throughput
      ? process.platform === "win32"
        ? "for /L %i in (1,1,16384) do @echo 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\r\necho RELAY_PTY_OK\r\nexit\r\n"
        : '/usr/bin/awk \'BEGIN {for(i=0;i<16384;i++) printf "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; printf "\\nRELAY_PTY_OK\\n"}\'; exit 0\n'
      : process.platform === "win32"
        ? "echo RELAY_PTY_OK\r\nexit\r\n"
        : "printf 'RELAY_%s\\n' 'PTY_OK'; exit 0\n";
    terminal.write(command);
  });
  console.log("Relay Desktop native terminal verified");
  const durationMs = performance.now() - started;
  return {
    outputBytes,
    durationMs,
    megabytesPerSecond: outputBytes / (1024 * 1024) / (durationMs / 1000),
  };
}

async function start(message) {
  if (typeof message.home !== "string" || !isAbsolute(message.home)) {
    throw new Error("Desktop state requires an absolute home directory");
  }
  if (typeof message.password !== "string" || message.password.length < 32) {
    throw new Error("Desktop authentication requires a strong ephemeral password");
  }
  process.env.RELAY_HOME = message.home;
  await mkdir(message.home, { recursive: true, mode: 0o700 });
  releaseStateLock = await acquireStateLock(message.home);
  const port = await readDesktopPort(message.home);
  const outboxIdentity = await readDesktopIdentity(message.home);
  await restoreShellPath();
  // Fail explicitly rather than silently falling back to an incompatible DB.
  const { DatabaseSync } = await import("node:sqlite");
  const probe = new DatabaseSync(":memory:");
  probe.close();
  authDirectory = await mkdtemp(join(tmpdir(), "relay-desktop-auth-"));
  const { createRelay } = await import("../dist/server/index.js");
  const updateManager = await createBackendUpdateService({
    parent,
    startMessage: message,
    installDir: join(import.meta.dirname, ".."),
    getRuntimeStatus: () => relay.getRuntimeStatus(),
  });
  relay = createRelay({
    updateManager,
    host: "127.0.0.1",
    port,
    outboxIdentity,
    backgroundStartupDelayMs: 2000,
    password: message.password,
    // Authentication is scoped to this process lifetime; the private session
    // file is removed at quit. A long-running desktop window never needs to
    // prompt the user for its unknowable bootstrap password.
    sessionMaxAge: 100 * 365 * 24 * 60 * 60 * 1000,
    sessionFile: join(authDirectory, "sessions.json"),
    workingDirectory: homedir(),
    ...(process.env.RELAY_DESKTOP_BENCHMARK === "1"
      ? {
          providerDirs: {
            claude: join(message.home, "providers", "claude"),
            codex: join(message.home, "providers", "codex"),
          },
        }
      : {}),
  });
  await relay.start();
  if (process.env.RELAY_DESKTOP_SMOKE === "1") nativeTerminalMetrics = await verifyNativeTerminal();
  if (stopping) return;
  const address = relay.address;
  if (!address) throw new Error("Desktop backend did not acquire a listener");
  // Origin stability keeps localStorage, IndexedDB drafts/outbox and browser
  // permissions attached to this desktop installation across restarts.
  if (port === 0) await saveDesktopPort(message.home, address.port);
  const url = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${url}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: message.password }),
  });
  const cookie = response.headers.get("set-cookie");
  if (!response.ok || !cookie) throw new Error("Desktop backend authentication failed");
  if (!stopping)
    send({
      type: "ready",
      url,
      cookie,
      metrics: {
        startupMs: performance.now() - bootAt,
        rssBytes: process.memoryUsage().rss,
        memory: process.memoryUsage(),
        caches: relay.getMemoryDiagnostics?.() ?? null,
        cpu: process.cpuUsage(),
        uptimeSeconds: process.uptime(),
        nativeTerminal: nativeTerminalMetrics,
      },
    });
}

async function stop() {
  if (stopping) return;
  stopping = true;
  // Parent also enforces a shutdown deadline; this protects orphaned children.
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  try {
    await starting?.catch(() => {});
    if (relay?.address) await relay.stop();
    if (authDirectory) await rm(authDirectory, { recursive: true, force: true });
    await releaseStateLock?.();
    send({ type: "stopped" });
    process.exit(0);
  } catch {
    send({ type: "error", message: "Desktop backend shutdown failed" });
    process.exit(1);
  }
}

parent.on("message", async ({ data: message }) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "start" && !starting && !stopping) {
    starting = start(message);
    void starting.catch((error) => {
      // Never send arbitrary exception text: provider errors can contain env data.
      console.error("Desktop backend startup failed:", error?.code ?? error?.name ?? "Error");
      send({
        type: "error",
        message:
          error?.code === "EADDRINUSE"
            ? "Relay Desktop's saved local port is occupied. Close the other listener and restart Relay Desktop."
            : "Desktop backend could not start. Check its runtime and logs.",
      });
      void stop();
    });
  } else if (message.type === "stop") {
    void stop();
  } else if (message.type === "status" && relay && !stopping) {
    send({ type: "response", requestId: message.requestId, result: relay.getRuntimeStatus() });
  } else if (message.type === "metrics" && relay && !stopping) {
    if (message.collectGarbage && process.env.RELAY_DESKTOP_BENCHMARK === "1") {
      const { setFlagsFromString } = await import("node:v8");
      const { runInNewContext } = await import("node:vm");
      setFlagsFromString("--expose_gc");
      runInNewContext("gc")();
    }
    send({
      type: "response",
      requestId: message.requestId,
      result: {
        rssBytes: process.memoryUsage().rss,
        memory: process.memoryUsage(),
        caches: relay.getMemoryDiagnostics?.() ?? null,
        cpu: process.cpuUsage(),
        uptimeSeconds: process.uptime(),
      },
    });
  } else if (message.type === "reconcile" && relay && !stopping) {
    void relay.reconcile().then(
      () =>
        send({ type: "response", requestId: message.requestId, result: relay.getRuntimeStatus() }),
      () =>
        send({
          type: "response",
          requestId: message.requestId,
          error: "Session reconciliation failed",
        }),
    );
  } else if (message.type === "prepare-update" && relay && !stopping) {
    if (!relay.quiesceForUpdate()) {
      send({
        type: "prepare-update-result",
        id: message.id,
        ok: false,
        error: "Finish running Chats, pending input, and terminals before updating Relay",
      });
    } else {
      send({ type: "prepare-update-result", id: message.id, ok: true });
    }
  }
});
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
