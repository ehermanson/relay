import { readdirSync, statSync, type Dirent } from "fs";
import { join, relative } from "path";
import { GIT_TIMEOUTS, runGit } from "#core/git-runner.js";

export interface WorkspaceEntry {
  path: string;
  kind: "file" | "directory";
}

const CACHE_TTL_MS = 15_000;
const MAX_INDEX_FILES = 25_000;
const MAX_RESULTS = 25;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);

const workspaceCache = new Map<
  string,
  { expiresAt: number; files: string[]; directories: string[] }
>();

function normalizeEntryPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

async function listGitFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await runGit(
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: root,
        readOnly: true,
        timeoutMs: GIT_TIMEOUTS.fast,
        operation: "git ls-files",
        // Huge repos: keep what fits instead of failing — the index is capped anyway.
        truncateOutput: true,
      },
    );
    return stdout
      .split("\0")
      .map((line) => normalizeEntryPath(line))
      .filter(Boolean)
      .slice(0, MAX_INDEX_FILES);
  } catch {
    return [];
  }
}

function walkFiles(root: string): string[] {
  const result: string[] = [];
  const queue = [root];

  while (queue.length > 0 && result.length < MAX_INDEX_FILES) {
    const dir = queue.shift();
    if (!dir) break;

    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;

      const rel = normalizeEntryPath(relative(root, join(dir, entry.name)));
      if (rel) result.push(rel);
      if (result.length >= MAX_INDEX_FILES) break;
    }
  }

  return result;
}

function deriveDirectories(files: string[]): string[] {
  const directories = new Set<string>();

  for (const file of files) {
    const parts = file.split("/");
    if (parts.length < 2) continue;
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join("/");
      if (dir) directories.add(dir);
    }
  }

  return Array.from(directories);
}

async function getWorkspaceIndex(
  root: string,
): Promise<{ files: string[]; directories: string[] }> {
  const now = Date.now();
  const cached = workspaceCache.get(root);
  if (cached && cached.expiresAt > now) {
    return { files: cached.files, directories: cached.directories };
  }

  const files = await listGitFiles(root);
  const resolvedFiles = files.length > 0 ? files : walkFiles(root);
  const directories = deriveDirectories(resolvedFiles);
  const value = {
    expiresAt: now + CACHE_TTL_MS,
    files: resolvedFiles,
    directories,
  };
  workspaceCache.set(root, value);
  return value;
}

function scoreEntry(entry: WorkspaceEntry, query: string): number {
  if (!query) {
    const depth = entry.path.split("/").length;
    return 1000 - depth * 10 - entry.path.length / 100;
  }

  const pathValue = entry.path.toLowerCase();
  const basename = pathValue.split("/").pop() || pathValue;

  if (pathValue === query) return 1200;
  if (basename === query) return 1100;
  if (pathValue.startsWith(query)) return 900;
  if (basename.startsWith(query)) return 850;
  if (pathValue.includes(`/${query}`)) return 700;
  if (basename.includes(query)) return 650;
  if (pathValue.includes(query)) return 500;
  return -1;
}

export async function searchWorkspaceEntries(
  root: string,
  rawQuery: string,
): Promise<WorkspaceEntry[]> {
  try {
    const stat = statSync(root);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }

  const query = normalizeEntryPath(rawQuery.trim().replace(/^@+/, "").toLowerCase());
  const { files, directories } = await getWorkspaceIndex(root);
  const entries: WorkspaceEntry[] = [
    ...directories.map((path) => ({ path, kind: "directory" as const })),
    ...files.map((path) => ({ path, kind: "file" as const })),
  ];

  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.entry.path.localeCompare(b.entry.path);
    })
    .slice(0, MAX_RESULTS)
    .map((item) => item.entry);
}
