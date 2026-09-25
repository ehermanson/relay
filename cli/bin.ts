#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createRelay } from "#server/index.js";
import { startTunnel, stopTunnel } from "#server/tunnel.js";
import { UpdateManager } from "#server/update-manager.js";
import { runTasksCommand } from "#cli/tasks.js";
import { resolveClaudeConfigDir } from "#core/providers/claude-cli.js";

const CLI_CHILD_MODE_ENV_VAR = "RELAY_CLI_CHILD_MODE";
const CLI_UPDATE_RESTART_EXIT_CODE = 75;

const args = process.argv.slice(2);

if (process.env[CLI_CHILD_MODE_ENV_VAR] === "1") {
  const exitCode = await runRelayRuntime(args);
  process.exit(exitCode);
}

const projectRoot = import.meta.dirname.includes(`${path.sep}dist${path.sep}`)
  ? path.join(import.meta.dirname, "..", "..")
  : path.join(import.meta.dirname, "..");
const packageJsonPath = path.join(projectRoot, "package.json");
const packageJson = fs.readFileSync(packageJsonPath, "utf8");
const childScriptPath = process.argv[1];

while (true) {
  const childResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [...process.execArgv, childScriptPath, ...args], {
        stdio: "inherit",
        env: {
          ...process.env,
          [CLI_CHILD_MODE_ENV_VAR]: "1",
          RELAY_PACKAGE_JSON: packageJson,
        },
      });

      const forwardSignal = (signal: NodeJS.Signals) => {
        if (child.exitCode !== null) return;
        child.kill(signal);
      };

      const onSigint = () => {
        forwardSignal("SIGINT");
      };
      const onSigterm = () => {
        forwardSignal("SIGTERM");
      };

      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigterm);

      child.once("error", (error) => {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
        reject(error);
      });

      child.once("exit", (code, signal) => {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
        resolve({ code, signal });
      });
    },
  );

  if (childResult.signal === null && childResult.code === CLI_UPDATE_RESTART_EXIT_CODE) {
    console.log("[Relay] Update installed, restarting in the same terminal session");
    continue;
  }

  process.exit(childResult.code ?? (childResult.signal ? 1 : 0));
}

function parseFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function resolveProjectRoot(): string {
  return import.meta.dirname.includes(`${path.sep}dist${path.sep}`)
    ? path.join(import.meta.dirname, "..", "..")
    : path.join(import.meta.dirname, "..");
}

async function runRelayRuntime(argv: string[]): Promise<number> {
  const command = argv[0];

  if (command === "--help" || command === "-h") {
    printUsage();
    return 0;
  }
  if (command === "tasks") {
    return runTasksCommand(argv.slice(1));
  }
  if (command && command !== "start") {
    console.error(`Unknown command: ${command}\n`);
    printUsage();
    return 1;
  }

  return startServer(command === "start" ? argv.slice(1) : argv);
}

function printUsage(): void {
  console.log(`Usage:
  relay start [--port <number>] [--password <string>] [--tunnel]
  relay tasks [--dir <path>] <command> [options]

Options:
  --port <number>     Server port (default: 7777)
  --password <string> Require password for authentication
  --tunnel            Start a cloudflared tunnel to this Relay server

Run \`relay tasks --help\` for offline task-file commands.

Notes:
  - When no password is set, the server runs in open mode (no login required).
    Set a password if you plan to expose the server over a tunnel or network.
  - The tunnel exposes the same Relay server; it is not a separate runtime mode.`);
}

async function startServer(cliArgs: string[]): Promise<number> {
  const password = parseFlag(cliArgs, "--password") || process.env.RELAY_PASSWORD || undefined;
  const port = parseInt(parseFlag(cliArgs, "--port") || process.env.PORT || "7777");
  const enableTunnel = hasFlag(cliArgs, "--tunnel") || process.env.TUNNEL === "true";
  const home = homedir();

  if (enableTunnel && !password) {
    console.warn(
      "Warning: Starting tunnel without a password. Anyone with the URL can access Relay.\n" +
        "  Set a password with: relay start --password <secret> --tunnel\n",
    );
  }

  const maxProcesses = parseInt(process.env.MAX_PROCESSES || "15");
  process.setMaxListeners(maxProcesses + 20);

  let restartRequested = false;
  let shutdownFn: (() => void) | null = null;

  const updateManager = new UpdateManager({
    installDir: resolveProjectRoot(),
    currentVersion: JSON.parse(process.env.RELAY_PACKAGE_JSON ?? '{"version":"0.0.0"}').version,
    logger: console,
    requestRestart: () => {
      restartRequested = true;
      shutdownFn?.();
    },
  });
  await updateManager.init();

  const relay = createRelay({
    password,
    port,
    sessionMaxAge: parseInt(process.env.SESSION_MAX_AGE || String(7 * 24 * 60 * 60 * 1000)),
    workingDirectory: process.env.WORKING_DIR || process.cwd(),
    maxProcesses,
    serveUI: true,
    ...(process.env.SESSION_FILE ? { sessionFile: process.env.SESSION_FILE } : {}),
    ...(process.env.DB_PATH ? { dbPath: process.env.DB_PATH } : {}),
    providerDirs: {
      claude: resolveClaudeConfigDir(),
      codex: process.env.CODEX_DIR ?? join(home, ".codex"),
    },
    updateManager,
  });

  try {
    await relay.start();
    if (process.env.DEV) {
      console.log(`Relay UI at http://localhost:${process.env.VITE_PORT || "5173"}\n`);
    } else if (enableTunnel) {
      startTunnel(port);
    }
  } catch (err) {
    console.error(`\n  Failed to start Relay: ${(err as Error).message}`);
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(
        `  Port ${port} is already in use. Try a different port with: relay start --port 8888`,
      );
      console.error(`  To inspect the current listener: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    }
    return 1;
  }

  let stopping = false;

  function shutdown() {
    if (stopping) return;
    stopping = true;
    console.log("\nShutting down...");

    stopTunnel();

    const forceExit = setTimeout(
      () => process.exit(restartRequested ? CLI_UPDATE_RESTART_EXIT_CODE : 1),
      10_000,
    );
    forceExit.unref();

    relay.stop().then(
      () => process.exit(restartRequested ? CLI_UPDATE_RESTART_EXIT_CODE : 0),
      () => process.exit(restartRequested ? CLI_UPDATE_RESTART_EXIT_CODE : 1),
    );
  }

  shutdownFn = shutdown;

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (reason) => {
    console.error("[FATAL] Unhandled rejection:", reason);
  });

  return await new Promise<number>(() => {});
}
