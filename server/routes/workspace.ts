import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import type { Hono } from "hono";
import type { AppEnv, HttpDeps } from "#server/route-types.js";

export function registerWorkspaceRoutes(app: Hono<AppEnv>, deps: HttpDeps): void {
  const { instanceManager } = deps;

  app.get("/api/directories", (c) => {
    return c.json({
      defaultDirectory: instanceManager.defaultWorkingDirectory,
      directories: instanceManager.getKnownDirectories(),
    });
  });

  app.get("/api/git-repos", async (c) => {
    return c.json({ repos: await deps.getGitRepos() });
  });

  app.get("/api/browse", (c) => {
    const home = homedir();
    const raw = c.req.query("prefix") || "";
    const gitOnly = c.req.query("gitOnly") === "1";
    const prefix = raw && raw !== "/" ? raw : home + "/";
    const resolved = path.resolve(prefix);

    if (!resolved.startsWith(home)) {
      return c.json({ error: "Path must be under home directory" }, 400);
    }

    let dirToRead: string;
    let partial: string;
    try {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory() && prefix.endsWith("/")) {
        dirToRead = resolved;
        partial = "";
      } else {
        dirToRead = path.dirname(resolved);
        partial = path.basename(resolved);
      }
    } catch {
      dirToRead = path.dirname(resolved);
      partial = path.basename(resolved);
    }

    try {
      const entries = fs.readdirSync(dirToRead, { withFileTypes: true });
      const lowerPartial = partial.toLowerCase();
      const dirs = entries
        .filter((entry) => {
          if (!entry.isDirectory()) return false;
          if (entry.name.startsWith(".")) return false;
          if (!partial) return true;
          return entry.name.toLowerCase().startsWith(lowerPartial);
        })
        .slice(0, 50)
        .map((entry) => path.join(dirToRead, entry.name));

      if (gitOnly) {
        const gitRepos: string[] = [];
        const nonGit: string[] = [];
        for (const dir of dirs) {
          if (fs.existsSync(path.join(dir, ".git"))) {
            gitRepos.push(dir);
          } else {
            nonGit.push(dir);
          }
        }
        return c.json({
          home,
          directories: [...gitRepos, ...nonGit].slice(0, 20),
          gitRepos,
        });
      }

      return c.json({ home, directories: dirs.slice(0, 20) });
    } catch {
      return c.json({ home, directories: [], ...(gitOnly ? { gitRepos: [] } : {}) });
    }
  });

  app.get("/api/workspace-entries", async (c) => {
    const instanceId = c.req.query("instanceId") || "";
    const query = c.req.query("q") || "";
    if (!instanceId) {
      return c.json({ error: "instanceId is required" }, 400);
    }
    const entries = await instanceManager.getWorkspaceEntries(instanceId, query);
    if (!entries) {
      return c.json({ error: "Instance not found" }, 404);
    }
    return c.json({ entries });
  });
}
