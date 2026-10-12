import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const executable = require("electron");
const root = resolve(import.meta.dirname, "..");
function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}
const runs = Number(argument("--runs", "3"));
if (!Number.isInteger(runs) || runs < 2 || runs > 20)
  throw new Error("Benchmark runs must be between 2 and 20");
const output = resolve(argument("--output", join(root, "desktop-release", "benchmark.json")));
const home = await mkdtemp(join(tmpdir(), "relay-desktop-benchmark-"));
const results = [];
const chats = Number(argument("--chats", "0"));
const messages = Number(argument("--messages", "0"));
if (
  !Number.isInteger(chats) ||
  chats < 0 ||
  chats > 10000 ||
  !Number.isInteger(messages) ||
  messages < 0 ||
  messages > 50000
)
  throw new Error("Synthetic history limits: 0–10000 Chats and 0–50000 messages");
if (messages && !chats) throw new Error("Synthetic messages require at least one Chat");
if (chats) {
  const directory = join(home, "providers", "codex", "sessions", "2026", "01", "01");
  const project = join(home, "benchmark-project");
  await mkdir(directory, { recursive: true });
  await mkdir(project, { recursive: true });
  const gitEnv = { ...process.env };
  delete gitEnv.GIT_DIR;
  delete gitEnv.GIT_WORK_TREE;
  delete gitEnv.GIT_INDEX_FILE;
  await promisify(execFile)("git", ["init", "--quiet", "--initial-branch=main", project], {
    env: gitEnv,
    timeout: 10000,
  });
  const date = new Date(Date.now() - 86400000);
  const timestamp = date.toISOString();
  for (let index = 0; index < chats; index++) {
    const id = randomUUID();
    const lines = [
      {
        timestamp,
        type: "session_meta",
        payload: { id, cwd: project, timestamp, originator: "desktop-benchmark", source: "cli" },
      },
      {
        timestamp,
        type: "event_msg",
        payload: {
          type: "user_message",
          message: `Benchmark Chat ${index + 1}: inspect the native shell performance`,
        },
      },
    ];
    for (let message = 0; message < (index === 0 ? Math.max(messages, 1) : 1); message++) {
      if (message)
        lines.push({
          timestamp,
          type: "event_msg",
          payload: {
            type: "user_message",
            message: `Benchmark follow-up ${message + 1}: continue inspecting native performance`,
          },
        });
      lines.push({
        timestamp,
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: `Message ${message + 1}: synthetic performance fixture.\n\nInspect files, run checks, and preserve Project and Space state.\n\n\`\`\`ts\nconst result = { chat: ${index}, message: ${message} };\n\`\`\`\n`,
        },
      });
    }
    const file = join(directory, `rollout-${id}.jsonl`);
    await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    await utimes(file, date, date);
  }
}

async function run(index) {
  const started = performance.now();
  const env = {
    ...process.env,
    RELAY_DESKTOP_HOME: home,
    RELAY_DESKTOP_SMOKE: "1",
    RELAY_DESKTOP_BENCHMARK: "1",
    RELAY_DESKTOP_BENCHMARK_MESSAGES: String(messages),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [join(root, "desktop", "main.mjs")], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let errors = "";
  child.stdout.on("data", (data) => {
    stdout = (stdout + data).slice(-1024 * 1024);
  });
  child.stderr.on("data", (data) => {
    errors = (errors + data).slice(-4096);
  });
  const code = await new Promise((resolveRun, reject) => {
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Benchmark launch ${index + 1} exceeded 60 seconds`));
    }, 60000);
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("exit", (value) => {
      clearTimeout(deadline);
      resolveRun(value);
    });
  });
  if (code !== 0) {
    console.error("Benchmark diagnostics:", stdout.slice(-4096));
    throw new Error(`Benchmark launch ${index + 1} failed (${code}): ${errors.slice(-500)}`);
  }
  const benchmark = stdout.split("\n").find((line) => line.startsWith("DESKTOP_METRICS "));
  if (!benchmark)
    throw new Error(
      "Desktop did not emit benchmark metrics; build the latest desktop sources first",
    );
  const smoke = stdout.split("\n").find((line) => line.startsWith("DESKTOP_SMOKE "));
  const port = JSON.parse(await readFile(join(home, "desktop-port.json"), "utf8")).port;
  const identity = JSON.parse(await readFile(join(home, "desktop-identity.json"), "utf8")).identity;
  const lockReleased = await readFile(
    join(home, "desktop-backend.lock", "owner.json"),
    "utf8",
  ).then(
    () => false,
    (error) => error.code === "ENOENT",
  );
  if (!lockReleased) throw new Error("Desktop did not release its state ownership after shutdown");
  if (index && (port !== results[0].port || identity !== results[0].owner))
    throw new Error("Desktop origin or outbox owner changed across restarts");
  if (index && !smoke?.includes('"prior":"persisted"'))
    throw new Error("Browser storage did not survive desktop restart");
  const metrics = JSON.parse(benchmark.slice("DESKTOP_METRICS ".length));
  const extraLine = stdout.split("\n").find((line) => line.startsWith("DESKTOP_BENCHMARK "));
  const extra = extraLine ? JSON.parse(extraLine.slice("DESKTOP_BENCHMARK ".length)) : {};
  const rendererLine = stdout
    .split("\n")
    .find((line) => line.startsWith("DESKTOP_RENDERER_BENCHMARK "));
  const cpuStart = metrics.backendStartup.cpu;
  const cpuEnd = metrics.backend.cpu;
  const idleSeconds = metrics.backend.uptimeSeconds - metrics.backendStartup.uptimeSeconds;
  return {
    index: index + 1,
    elapsedMs: Math.round(performance.now() - started),
    ...metrics,
    mainMemory: extra.memory ?? null,
    rendererMemory: extra.rendererMemory ?? null,
    rendererProfile: rendererLine
      ? JSON.parse(rendererLine.slice("DESKTOP_RENDERER_BENCHMARK ".length))
      : null,
    backendStartupWindowCPUPercent:
      ((cpuEnd.user + cpuEnd.system - cpuStart.user - cpuStart.system) / (idleSeconds * 1000000)) *
      100,
    port,
    owner: identity,
    terminalVerified: stdout.includes("Relay Desktop native terminal verified"),
    storagePersisted: index ? true : null,
  };
}

try {
  for (let index = 0; index < runs; index++) {
    const result = await run(index);
    if (!result.terminalVerified) throw new Error("Native terminal probe did not complete");
    results.push(result);
    console.log(
      `Desktop benchmark ${index + 1}/${runs}: ready ${result.startupMs}ms; backend ${Math.round(result.backendStartup.startupMs)}ms`,
    );
  }
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const report = {
    recordedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    runs,
    syntheticHistory: { chats, largestChatMessages: messages },
    summary: {
      medianStartupMs: median(results.map((result) => result.startupMs)),
      medianBackendStartupMs: median(results.map((result) => result.backendStartup.startupMs)),
      medianBackendRSSBytes: median(results.map((result) => result.backend.rssBytes)),
      medianBackendStartupWindowCPUPercent: median(
        results.map((result) => result.backendStartupWindowCPUPercent),
      ),
      medianNativeTerminalMiBPerSecond: median(
        results.map((result) => result.backendStartup.nativeTerminal.megabytesPerSecond),
      ),
      medianReportedProcessWorkingSetMiB: median(
        results.map(
          (result) =>
            result.processes.reduce((total, entry) => total + entry.memory.workingSetSize, 0) /
            1024,
        ),
      ),
      startupIncludesNativeTerminalValidation: true,
      persistentOriginAndOwner: true,
      persistentBrowserStorage: true,
      nativeTerminalVerified: true,
      ...(messages
        ? {
            medianChatRouteReadyMs: median(
              results.map((result) => result.rendererProfile.routeReadyMs),
            ),
            maximumScrollFrameMs: Math.max(
              ...results.map((result) => result.rendererProfile.maxFrameMs),
            ),
            medianSlowScrollFramesOver50ms: median(
              results.map((result) => result.rendererProfile.slowFramesOver50ms),
            ),
            peakRenderedChatRows: Math.max(
              ...results.map((result) => result.rendererProfile.peakRenderedRows),
            ),
            medianChatJSHeapBytes: median(
              results.map((result) => result.rendererProfile.usedJSHeapSize),
            ),
          }
        : {}),
    },
    results: results.map(({ owner: _owner, ...result }) => result),
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`Benchmark report: ${output}`);
} finally {
  await rm(home, { recursive: true, force: true });
}
