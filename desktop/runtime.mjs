import { randomUUID } from "node:crypto";

/** Supervise an isolated utility process without Electron-specific dependencies. */
export function createBackendSupervisor({
  spawn,
  onReady = () => {},
  onFailure = () => {},
  onExit = () => {},
  startupTimeoutMs = 60000,
  shutdownTimeoutMs = 12000,
  retryDelays = [250, 1000, 3000],
  retryWindowMs = 60000,
}) {
  let child, bootstrap, startPromise, resolveStart, rejectStart, retryTimer, startupTimer;
  let stopping = false;
  let ready = false;
  let failed = false;
  let stopPromise;
  const crashes = [];
  const pending = new Map();

  function rejectRequests(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }
  function fail(error) {
    if (failed || stopping) return;
    failed = true;
    clearTimeout(startupTimer);
    rejectStart?.(error);
    rejectRequests(error);
    child?.kill();
    onFailure(error);
  }
  function launch() {
    if (stopping || failed) return;
    ready = false;
    let current;
    try {
      current = spawn();
      child = current;
    } catch (error) {
      fail(error);
      return;
    }
    startupTimer = setTimeout(
      () => fail(new Error("Relay backend startup timed out")),
      startupTimeoutMs,
    );
    current.on("message", (message) => {
      if (child !== current || stopping || failed) return;
      if (message?.type === "ready") {
        clearTimeout(startupTimer);
        ready = true;
        void Promise.resolve()
          .then(() => onReady(message))
          .then(() => resolveStart?.(message), fail);
      } else if (message?.type === "response" && pending.has(message.requestId)) {
        const request = pending.get(message.requestId);
        pending.delete(message.requestId);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result);
      } else if (message?.type === "error") {
        fail(new Error(message.message || "Relay backend failed"));
      }
    });
    current.once("exit", (code) => {
      if (child !== current) return;
      clearTimeout(startupTimer);
      ready = false;
      child = undefined;
      rejectRequests(new Error("Relay backend restarted"));
      onExit(code);
      if (stopping || failed) return;
      const now = Date.now();
      while (crashes.length && now - crashes[0] > retryWindowMs) crashes.shift();
      crashes.push(now);
      if (crashes.length > retryDelays.length) {
        fail(new Error("Relay backend repeatedly stopped; automatic recovery has paused"));
        return;
      }
      retryTimer = setTimeout(launch, retryDelays[crashes.length - 1]);
    });
    try {
      current.postMessage({ ...bootstrap, type: "start" });
    } catch (error) {
      fail(error);
    }
  }
  return {
    get child() {
      return child;
    },
    get ready() {
      return ready;
    },
    start(value) {
      if (stopping) return Promise.reject(new Error("Relay backend is stopping"));
      if (startPromise) return startPromise;
      bootstrap = value;
      startPromise = new Promise((resolve, reject) => {
        resolveStart = resolve;
        rejectStart = reject;
      });
      launch();
      return startPromise;
    },
    request(type, payload = {}, timeoutMs = 10000) {
      if (!ready || !child || stopping || failed)
        return Promise.reject(new Error("Relay backend is unavailable"));
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("Relay backend request timed out"));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        try {
          child.postMessage({ ...payload, type, requestId });
        } catch (error) {
          pending.delete(requestId);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      clearTimeout(retryTimer);
      clearTimeout(startupTimer);
      rejectRequests(new Error("Relay backend is stopping"));
      rejectStart?.(new Error("Relay backend is stopping"));
      stopPromise = new Promise((resolve) => {
        const current = child;
        if (!current) {
          resolve();
          return;
        }
        const timeout = setTimeout(() => {
          current.kill();
          resolve();
        }, shutdownTimeoutMs);
        current.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        try {
          current.postMessage({ type: "stop" });
        } catch {
          clearTimeout(timeout);
          current.kill();
          resolve();
        }
      });
      return stopPromise;
    },
  };
}

/**
 * How local mode runs its own server.
 * - `data`: "private" keeps state in the desktop home; "shared" uses the same
 *   home as the Relay CLI, so the app and `relay start` see the same data
 *   (never at the same moment: the server state lock allows one writer).
 * - `share`: serve browsers and phones like `relay start` does (every
 *   interface, fixed `port`, the user's `password` or open mode, the saved
 *   named tunnel). Off: loopback only, behind a private per-launch password.
 */
export const DEFAULT_LOCAL_SERVER = Object.freeze({
  data: "private",
  share: false,
  port: 7777,
  password: null,
});

/** The message a second server gets from the server state lock. */
export const STATE_OWNED_MESSAGE =
  "Another Relay server is already using this data (for example `relay start`). Stop it and open Relay again, or connect to it instead.";

/**
 * Validate local-server settings from disk or the renderer. `password`:
 * omitted keeps the previous one, null or "" clears it, a string sets it.
 */
export function normalizeLocalServer(value, previous = DEFAULT_LOCAL_SERVER) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid local server settings");
  const known = ["data", "share", "port", "password"];
  if (Object.keys(value).some((key) => !known.includes(key)))
    throw new Error("Invalid local server settings");
  const data = value.data ?? previous.data;
  if (data !== "private" && data !== "shared") throw new Error("Choose where Relay keeps its data");
  const share = value.share ?? previous.share;
  if (typeof share !== "boolean") throw new Error("Invalid sharing setting");
  const port = value.port ?? previous.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Port must be a number from 1024 to 65535");
  let password = previous.password ?? null;
  if (value.password === null || value.password === "") password = null;
  else if (value.password !== undefined) {
    if (
      typeof value.password !== "string" ||
      value.password.length > 256 ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f]/.test(value.password)
    )
      throw new Error("Password must be at most 256 characters with no control characters");
    password = value.password;
  }
  return { data, share, port, password };
}

/** What the renderer may see: never the password itself. */
export function publicLocalServer(value) {
  return {
    data: value.data,
    share: value.share,
    port: value.port,
    hasPassword: Boolean(value.password),
  };
}

/** True for an origin on this computer's loopback interface. */
export function isLoopbackOrigin(value) {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

/** Explicitly attached servers retain their own normal password/cookie login. */
export function attachedServerURL(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Server URL must contain only an origin");
  const loopback = isLoopbackOrigin(url.origin);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    throw new Error("Attached servers require HTTPS or loopback HTTP");
  if (url.pathname !== "/") throw new Error("Server URL must contain only an origin");
  return url.origin;
}

/** Measure a settled interval separately from provider warmup and history indexing. */
export async function sampleIdleBackend(supervisor, intervalMs = 2000) {
  const before = await supervisor.request("metrics");
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
  const after = await supervisor.request("metrics");
  const elapsedSeconds = after.uptimeSeconds - before.uptimeSeconds;
  const cpuMicroseconds = after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system;
  if (elapsedSeconds <= 0 || cpuMicroseconds < 0)
    throw new Error("Backend restarted during its idle sample");
  return {
    intervalMs: elapsedSeconds * 1000,
    cpuPercent: (cpuMicroseconds / (elapsedSeconds * 1000000)) * 100,
    rssBytes: after.rssBytes,
  };
}
