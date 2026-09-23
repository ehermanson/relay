/**
 * HTTP Request Handler for Relay
 *
 * Factory function that creates the HTTP request handler.
 * Separated from server creation so consumers can compose their own server.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import type { AuthManager } from "#server/auth.js";
import type { InstanceManager } from "#core/instance-manager.js";
import type { RelayConfig } from "#server/config.js";
import type {
  NativeOpenRequest,
  NativeOpenTargetsResponse,
  ProviderCapabilities,
  ProviderDescriptor,
  ProviderKind,
  ProviderModelOption,
} from "#core/types.js";
import { ProjectOpener } from "#server/project-opener.js";
import { requireAuthMiddleware, sessionMiddleware } from "#server/hono-utils.js";
import {
  registerProtectedSystemRoutes,
  registerPublicSystemRoutes,
} from "#server/routes/auth-system.js";
import { registerInstanceRoutes } from "#server/routes/instances.js";
import { registerNativeOpenRoutes } from "#server/routes/native-open.js";
import { registerProjectRoutes } from "#server/routes/projects.js";
import { registerProviderRoutes } from "#server/routes/providers.js";
import { registerSpaceRoutes } from "#server/routes/spaces.js";
import { registerUiRoutes } from "#server/routes/ui.js";
import { registerUploadRoutes } from "#server/routes/uploads.js";
import { registerOutboxRoutes } from "#server/routes/outbox.js";
import { registerPushRoutes } from "#server/routes/push.js";
import { registerSettingsRoutes } from "#server/routes/settings.js";
import { registerSearchRoutes } from "#server/routes/search.js";
import { registerWorkspaceRoutes } from "#server/routes/workspace.js";
import { registerSpinOffRoutes } from "#server/routes/spin-offs.js";
import { registerSystemUpdateRoutes } from "#server/routes/system-update.js";
import type { AppEnv, HttpDeps } from "#server/route-types.js";
import { UpdateManager } from "#server/update-manager.js";

// From dist: dist/server/http.js → ../../ = project root
// From source: server/http.ts → ../ = project root
const projectRoot = import.meta.dirname.includes(`${path.sep}dist${path.sep}`)
  ? path.join(import.meta.dirname, "..", "..")
  : path.join(import.meta.dirname, "..");
const uiDistDir = path.join(projectRoot, "app", "dist");
const indexHtmlPath = path.join(uiDistDir, "index.html");
const packageJsonPath = path.join(projectRoot, "package.json");
const packageVersion: string = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")).version;

/** Detect whether the relay server itself is running from a git worktree. */
function getSelfGitInfo(): { branch: string; isWorktree: boolean; worktreePath?: string } | null {
  try {
    const repoRoot = projectRoot;
    const opts = { cwd: repoRoot, timeout: 2000, encoding: "utf8" as const };
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], opts).trim();
    const gitDir = path.resolve(
      repoRoot,
      execFileSync("git", ["rev-parse", "--git-dir"], opts).trim(),
    );
    const gitCommonDir = path.resolve(
      repoRoot,
      execFileSync("git", ["rev-parse", "--git-common-dir"], opts).trim(),
    );
    const isWorktree = gitDir !== gitCommonDir;
    return { branch, isWorktree, worktreePath: isWorktree ? repoRoot : undefined };
  } catch {
    return null;
  }
}

const selfGitInfo = getSelfGitInfo();

interface RequestHandlerOverrides {
  getProviderModels?: (provider: ProviderKind) => Promise<ProviderModelOption[]>;
  getProviderCapabilities?: (provider: ProviderKind) => ProviderCapabilities;
  getAvailableProviders?: () => ProviderDescriptor[];
  getOpenTargets?: (targetPath: string) => Promise<NativeOpenTargetsResponse>;
  openNativePath?: (request: NativeOpenRequest) => Promise<void>;
  updateManager?: UpdateManager;
  pushNotifications?: import("#server/push-notifications.js").PushNotifications;
}

function createGitRepoLister() {
  const cache: {
    expiresAt: number;
    pending?: Promise<string[]>;
    value?: string[];
  } = {
    expiresAt: 0,
  };

  return async function getGitRepos(): Promise<string[]> {
    const now = Date.now();
    if (cache.value && cache.expiresAt > now) {
      return [...cache.value];
    }
    if (cache.pending) {
      return [...(await cache.pending)];
    }

    const pending = (async () => {
      const home = homedir();
      const repos: string[] = [];
      const visited = new Set<string>();
      const maxRepos = 200;
      const maxDepth = 4;
      const skip = new Set([
        "node_modules",
        ".git",
        ".hg",
        ".svn",
        "vendor",
        "venv",
        ".venv",
        "__pycache__",
        "dist",
        "build",
        ".cache",
        ".npm",
        ".cargo",
        ".rustup",
        "Library",
        "Applications",
        ".Trash",
        "Pictures",
        "Music",
        "Movies",
        "Public",
        ".local",
        ".config",
        "snap",
        ".snap",
        ".wine",
        ".steam",
      ]);
      const queue = [
        "projects",
        "repos",
        "code",
        "src",
        "work",
        "dev",
        "go/src",
        "Developer",
        "Documents",
        "Desktop",
      ].map((segment) => ({ dir: path.join(home, segment), depth: 0 }));

      while (queue.length > 0 && repos.length < maxRepos) {
        const current = queue.shift();
        if (!current || current.depth > maxDepth) {
          continue;
        }

        let resolved: string;
        try {
          resolved = await fs.promises.realpath(current.dir);
        } catch {
          continue;
        }
        if (visited.has(resolved)) {
          continue;
        }
        visited.add(resolved);

        let entries: fs.Dirent[];
        try {
          entries = await fs.promises.readdir(resolved, { withFileTypes: true });
        } catch {
          continue;
        }

        if (entries.some((entry) => entry.name === ".git")) {
          repos.push(resolved);
          continue;
        }

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith(".")) continue;
          if (skip.has(entry.name)) continue;
          queue.push({
            dir: path.join(resolved, entry.name),
            depth: current.depth + 1,
          });
        }
      }

      repos.sort((a, b) => {
        const aName = a.split("/").pop()!.toLowerCase();
        const bName = b.split("/").pop()!.toLowerCase();
        return aName.localeCompare(bName);
      });
      return repos;
    })()
      .then((repos) => {
        cache.value = repos;
        cache.expiresAt = Date.now() + 30_000;
        delete cache.pending;
        return repos;
      })
      .catch((err) => {
        delete cache.pending;
        throw err;
      });

    cache.pending = pending;
    return [...(await pending)];
  };
}

export function createRequestHandler(
  config: RelayConfig,
  auth: AuthManager,
  instanceManager: InstanceManager,
  getConnectionCount?: () => number,
  overrides: RequestHandlerOverrides = {},
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const log = config.logger;
  const startedAt = Date.now();
  const projectOpener = new ProjectOpener({
    preferencesFile: path.join(path.dirname(config.dbPath), "project-open-preferences.json"),
  });
  const providerModelCache = new Map<
    ProviderKind,
    { expiresAt: number; pending?: Promise<ProviderModelOption[]>; value?: ProviderModelOption[] }
  >();
  const getProviderModels =
    overrides.getProviderModels ??
    (async (provider: ProviderKind): Promise<ProviderModelOption[]> => {
      const cached = providerModelCache.get(provider);
      const now = Date.now();
      if (cached?.value && cached.expiresAt > now) {
        return cached.value.map((model) => ({ ...model }));
      }
      if (cached?.pending) {
        return cached.pending;
      }

      const pending = instanceManager
        .getProviderModels(provider)
        .then((value) => {
          providerModelCache.set(provider, {
            expiresAt: Date.now() + 60_000,
            value,
          });
          return value.map((model) => ({ ...model }));
        })
        .catch((err) => {
          providerModelCache.delete(provider);
          throw err;
        });

      providerModelCache.set(provider, {
        expiresAt: now + 5_000,
        pending,
      });
      return pending;
    });

  const updateManager =
    overrides.updateManager ??
    new UpdateManager({
      installDir: projectRoot,
      currentVersion: packageVersion,
      logger: log,
      requestRestart: () => {},
      restartSupported: false,
    });

  const deps: HttpDeps = {
    config,
    auth,
    instanceManager,
    startedAt,
    packageVersion,
    selfGitInfo,
    uiDistDir,
    indexHtmlPath,
    getConnectionCount,
    getProviderModels,
    getProviderCapabilities:
      overrides.getProviderCapabilities ??
      ((provider: ProviderKind): ProviderCapabilities =>
        instanceManager.getProviderCapabilities(provider)),
    getAvailableProviders:
      overrides.getAvailableProviders ?? (() => instanceManager.getAvailableProviders()),
    getOpenTargets:
      overrides.getOpenTargets ?? ((targetPath: string) => projectOpener.listTargets(targetPath)),
    openNativePath:
      overrides.openNativePath ?? ((request: NativeOpenRequest) => projectOpener.open(request)),
    getGitRepos: createGitRepoLister(),
    updateManager,
    pushNotifications: overrides.pushNotifications,
  };

  const app = new Hono<AppEnv>();

  app.use(async (c, next) => sessionMiddleware(auth, c, next));
  app.use("/api/*", requireAuthMiddleware);
  registerPublicSystemRoutes(app, deps);
  registerProtectedSystemRoutes(app, deps);
  registerInstanceRoutes(app, deps);
  registerProjectRoutes(app, deps);
  registerSpaceRoutes(app, deps);
  registerSpinOffRoutes(app, deps);
  registerWorkspaceRoutes(app, deps);
  registerProviderRoutes(app, deps);
  registerNativeOpenRoutes(app, deps);
  registerUploadRoutes(app, deps);
  registerOutboxRoutes(app, deps);
  registerPushRoutes(app, deps);
  registerSearchRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerSystemUpdateRoutes(app, deps);
  registerUiRoutes(app, deps);

  app.onError((error, c) => {
    log.error("Request error:", error);
    return c.html("<h1>500 Internal Server Error</h1>", 500);
  });

  return getRequestListener(app.fetch);
}
