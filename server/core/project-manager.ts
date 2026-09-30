/**
 * ProjectManager — manages explicit project registration for Relay.
 *
 * Projects are the organizing primitive: sessions are scoped to projects,
 * external discovery only watches registered project directories.
 * All projects must be git repositories.
 */

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, realpathSync } from "fs";
import { basename, join } from "path";
import { EventEmitter } from "events";

import { SessionDB } from "#core/db.js";
import type { ProjectRow } from "#core/db.js";
import type { Account, Project, SuggestionsConfig } from "#core/types.js";
import { DEFAULT_ACCOUNT_ID } from "#core/types.js";
import type { Logger } from "#core/logger.js";
import { normalizeAccountIds } from "#core/accounts.js";
import { AccountStore } from "#core/account-store.js";
import {
  gitInit,
  isGitRepo,
  getRepoRoot,
  getRemoteUrl,
  readGitHeadInfo,
  isRelayWorktreePath,
  resolveWorktreeOrigin,
  isGitWorktree,
  resolveAnyWorktreeOrigin,
} from "#core/git.js";

export interface ProjectManagerEvents {
  "project:created": [project: Project];
  "project:updated": [project: Project];
  "project:removed": [projectId: string];
}

export interface ProjectManager {
  on<E extends keyof ProjectManagerEvents>(
    event: E,
    listener: (...args: ProjectManagerEvents[E]) => void,
  ): this;
  emit<E extends keyof ProjectManagerEvents>(event: E, ...args: ProjectManagerEvents[E]): boolean;
  off<E extends keyof ProjectManagerEvents>(
    event: E,
    listener: (...args: ProjectManagerEvents[E]) => void,
  ): this;
}

/**
 * Convert an arbitrary string into a URL-safe slug. Lowercases, replaces any
 * non-alphanumeric run with a single hyphen, and trims leading/trailing hyphens.
 * Returns `"project"` as a last-resort fallback when the input has no safe chars.
 */
function slugify(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "project";
}

/**
 * Generate a unique project slug from `directory`, suffixing with `-2`, `-3`, …
 * on collision. `excludeId` lets callers regenerate the slug for an existing
 * project row without colliding with itself.
 */
function generateUniqueSlug(
  directory: string,
  existingSlugs: Iterable<string>,
  excludeSlug?: string,
): string {
  const base = slugify(basename(directory));
  const taken = new Set(existingSlugs);
  if (excludeSlug) taken.delete(excludeSlug);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Stored membership, normalized: an empty/invalid list means the default account only. */
function parseAccountIds(raw: string | null | undefined): string[] {
  const parsed = parseJson<unknown>(raw ?? null);
  return normalizeAccountIds(Array.isArray(parsed) ? parsed : null);
}

/**
 * Membership as stored: `null` when it is exactly the default account, so a
 * single-account install never grows data it doesn't use.
 */
function serializeAccountIds(ids: string[]): string | null {
  const normalized = normalizeAccountIds(ids);
  if (normalized.length === 1 && normalized[0] === DEFAULT_ACCOUNT_ID) return null;
  return JSON.stringify(normalized);
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    directory: row.directory,
    repoRoot: row.repo_root,
    remoteUrl: row.remote_url,
    targetBranch: row.target_branch,
    customInstructions: row.custom_instructions,
    defaultSpaceBranch: row.default_space_branch,
    spaceBranchSource: (row.space_branch_source as "local" | "remote") ?? null,
    defaultProvider: row.default_provider,
    defaultModel: row.default_model,
    // Deprecated: the column stays for old rows but is never read again.
    accountIds: parseAccountIds(row.account_ids_json),
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    suggestions: parseJson<SuggestionsConfig>(row.suggestions_json),
  };
}

/**
 * The accounts a project may belong to — `AccountStore` in production
 * (`InstanceManager.accounts`), a stub in tests.
 */
export interface ProjectAccountsSource {
  list(): Pick<Account, "id">[];
}

export class ProjectManager extends EventEmitter {
  private db: SessionDB;
  private logger: Logger;
  /** Where the known account ids come from (see `ProjectAccountsSource`). */
  private accounts: ProjectAccountsSource;

  constructor(db: SessionDB, logger: Logger, options: { accounts?: ProjectAccountsSource } = {}) {
    super();
    this.db = db;
    this.logger = logger;
    // Account ids don't depend on the default account's logins, so a store
    // over the same DB with no default logins lists exactly the same ids as
    // the manager's — membership validation works with or without injection.
    this.accounts = options.accounts ?? new AccountStore(db, () => ({}));
    this.backfillSlugs();
    this.normalizeRegisteredProjects();
  }

  /**
   * One-time backfill: any project row without a slug gets one derived from its
   * directory basename, with collision suffixing against already-assigned slugs.
   * Idempotent — skips rows that already have a slug.
   */
  private backfillSlugs(): void {
    const rows = this.db.getAllProjects();
    const assigned = new Set<string>();
    for (const row of rows) {
      if (typeof row.slug === "string" && row.slug.length > 0) {
        assigned.add(row.slug);
      }
    }
    let filled = 0;
    for (const row of rows) {
      if (typeof row.slug === "string" && row.slug.length > 0) continue;
      const slug = generateUniqueSlug(row.directory, assigned);
      assigned.add(slug);
      this.db.upsertProject({ ...row, slug });
      filled++;
    }
    if (filled > 0) {
      this.logger.info(`[ProjectManager] Backfilled slug for ${filled} project(s)`);
    }
  }

  /** Snapshot of all currently-assigned slugs (used for collision-free generation). */
  private collectExistingSlugs(): Set<string> {
    return new Set(
      this.db
        .getAllProjects()
        .map((row) => row.slug)
        .filter((slug): slug is string => typeof slug === "string" && slug.length > 0),
    );
  }

  /**
   * On startup, fold any projects registered at worktree paths (relay or
   * external like .t3) into their parent repo project. Worktrees should
   * never be their own project — they belong to the parent.
   */
  private normalizeRegisteredProjects(): void {
    for (const project of this.db.getAllProjects()) {
      if (!isGitWorktree(project.directory)) {
        continue;
      }

      // Resolve the worktree to its parent repo
      const origin = isRelayWorktreePath(project.directory)
        ? resolveWorktreeOrigin(project.directory)
        : resolveAnyWorktreeOrigin(project.directory);
      if (!origin || origin === project.directory) {
        // Can't resolve — remove the orphaned worktree project
        this.db.assignSessionsToProject(null, project.directory);
        this.db.deleteProject(project.id);
        this.logger.info(
          `[ProjectManager] Removed unresolvable worktree project ${project.directory}`,
        );
        continue;
      }

      const canonicalDirectory = getRepoRoot(origin) ?? origin;
      const existing = this.db.getProjectByDirectory(canonicalDirectory);

      if (existing && existing.id !== project.id) {
        // Parent project exists — fold sessions into it
        this.db.assignSessionsToProject(existing.id, project.directory);
        this.db.reassignSpacesToProjectDirectory(canonicalDirectory, project.directory);
        this.db.deleteProject(project.id);
        this.logger.info(
          `[ProjectManager] Folded worktree project ${project.directory} into ${canonicalDirectory}`,
        );
        continue;
      }

      // No parent project registered — normalize this project to point at the parent repo.
      // Slug is sticky: we don't regenerate it when the directory pointer changes here.
      const normalized: ProjectRow = {
        ...project,
        name:
          project.name === basename(project.directory)
            ? basename(canonicalDirectory)
            : project.name,
        directory: canonicalDirectory,
        repo_root: canonicalDirectory,
        target_branch: project.target_branch ?? readGitHeadInfo(canonicalDirectory)?.branch ?? null,
      };

      this.db.upsertProject(normalized);
      this.scheduleGitInfoRefresh(normalized.id);
      this.db.assignSessionsToProject(normalized.id, project.directory);
      this.db.reassignSpacesToProjectDirectory(canonicalDirectory, project.directory);
      this.logger.info(
        `[ProjectManager] Normalized worktree project ${project.directory} to ${canonicalDirectory}`,
      );
    }
  }

  /**
   * Rebuild missing project registrations from session rows already in SQLite.
   * This recovers the sidebar/project model after the projects table is lost
   * but session metadata is still present.
   */
  recoverProjectsFromSessionDirectories(): number {
    const existingByDirectory = new Map(
      this.db.getAllProjects().map((project) => [project.directory, project] as const),
    );
    const assignedSlugs = this.collectExistingSlugs();
    const removedDirectories = this.db.getRemovedProjectDirectories();
    let recovered = 0;

    for (const sessionDirectory of this.db.getDistinctSessionDirectories()) {
      const resolved = this.canonicalizeSessionDirectory(sessionDirectory);
      if (!resolved) {
        continue;
      }
      const { repoRoot, canonicalDirectory } = resolved;

      let project = existingByDirectory.get(canonicalDirectory);
      if (!project) {
        // Explicitly removed by the user — only re-adding the project (addProject)
        // may bring it back, never session-history recovery.
        if (removedDirectories.has(canonicalDirectory)) {
          continue;
        }

        // For worktree-rooted sessions, don't auto-create a project for
        // the parent repo — only attach to an already-registered project.
        if (isGitWorktree(sessionDirectory) || isGitWorktree(repoRoot)) {
          continue;
        }

        const now = Date.now();
        const slug = generateUniqueSlug(canonicalDirectory, assignedSlugs);
        assignedSlugs.add(slug);
        project = {
          id: randomUUID(),
          name: basename(canonicalDirectory),
          slug,
          directory: canonicalDirectory,
          repo_root: canonicalDirectory,
          // Filled in asynchronously by scheduleGitInfoRefresh (needs git).
          remote_url: null,
          target_branch: readGitHeadInfo(canonicalDirectory)?.branch ?? null,
          custom_instructions: null,
          default_space_branch: null,
          space_branch_source: null,
          default_provider: null,
          default_model: null,
          created_at: now,
          last_activity_at: null,
          suggestions_json: null,
        };
        this.db.upsertProject(project);
        this.scheduleGitInfoRefresh(project.id);
        existingByDirectory.set(canonicalDirectory, project);
        recovered++;
        this.emit("project:created", rowToProject(project));
      }

      this.db.assignSessionsToProject(project.id, sessionDirectory);
      if (sessionDirectory !== canonicalDirectory) {
        this.db.assignSessionsToProject(project.id, canonicalDirectory);
      }
    }

    if (recovered > 0) {
      this.logger.info(
        `[ProjectManager] Recovered ${recovered} project registration(s) from session history`,
      );
    }

    return recovered;
  }

  /**
   * Resolve a session working directory to its repo root and the canonical
   * project directory (worktree paths resolve to the parent repo).
   * Returns null for directories outside any git repository.
   */
  private canonicalizeSessionDirectory(
    sessionDirectory: string,
  ): { repoRoot: string; canonicalDirectory: string } | null {
    const repoRoot = getRepoRoot(sessionDirectory);
    if (!repoRoot) {
      return null;
    }
    const canonicalDirectory = isRelayWorktreePath(repoRoot)
      ? (resolveWorktreeOrigin(repoRoot) ?? repoRoot)
      : isGitWorktree(repoRoot)
        ? (resolveAnyWorktreeOrigin(repoRoot) ?? repoRoot)
        : repoRoot;
    return { repoRoot, canonicalDirectory };
  }

  /**
   * Register a new project. Directory must be a git repository.
   * Returns the created project, or the existing one if already registered.
   *
   * `accountId` is the account registering it (the browser's active account;
   * absent/`default` = the default account). A directory that is already
   * registered under another account gains membership in this one — the
   * same repo may belong to several accounts, never to two project rows.
   */
  addProject(
    directory: string,
    opts?: { name?: string; targetBranch?: string; accountId?: string | null },
  ): Project {
    if (!existsSync(directory)) {
      throw new Error(`Directory does not exist: ${directory}`);
    }

    if (!isGitRepo(directory)) {
      throw new Error(`Not a git repository: ${directory}`);
    }

    const repoRoot = getRepoRoot(directory);
    if (!repoRoot) {
      throw new Error(`Could not resolve git repository root: ${directory}`);
    }
    const canonicalDirectory = isRelayWorktreePath(repoRoot)
      ? (resolveWorktreeOrigin(repoRoot) ?? repoRoot)
      : isGitWorktree(repoRoot)
        ? (resolveAnyWorktreeOrigin(repoRoot) ?? repoRoot)
        : repoRoot;

    // Explicit registration always clears a prior removal tombstone
    this.db.clearRemovedProjectDirectory(canonicalDirectory);

    const accountId = this.requireKnownAccountId(opts?.accountId);

    // Check for existing registration — adding under another account is a
    // membership change, not a duplicate.
    const existing = this.db.getProjectByDirectory(canonicalDirectory);
    if (existing) {
      const current = parseAccountIds(existing.account_ids_json);
      if (current.includes(accountId)) return rowToProject(existing);
      const row: ProjectRow = {
        ...existing,
        account_ids_json: serializeAccountIds([...current, accountId]),
      };
      this.db.upsertProject(row);
      const project = rowToProject(row);
      this.logger.info(
        `[ProjectManager] Added project ${project.name} to account ${accountId} (${canonicalDirectory})`,
      );
      this.emit("project:updated", project);
      return project;
    }

    // The remote URL needs git; it's filled in asynchronously right after
    // registration (scheduleGitInfoRefresh) so registration never blocks.
    const remoteUrl = null;
    const targetBranch = opts?.targetBranch ?? readGitHeadInfo(canonicalDirectory)?.branch ?? null;

    const now = Date.now();
    const slug = generateUniqueSlug(canonicalDirectory, this.collectExistingSlugs());
    const row: ProjectRow = {
      id: randomUUID(),
      name: opts?.name || basename(canonicalDirectory),
      slug,
      directory: canonicalDirectory,
      repo_root: canonicalDirectory,
      remote_url: remoteUrl,
      target_branch: targetBranch,
      custom_instructions: null,
      default_space_branch: null,
      space_branch_source: null,
      default_provider: null,
      default_model: null,
      account_ids_json: serializeAccountIds([accountId]),
      created_at: now,
      last_activity_at: null,
      suggestions_json: null,
    };

    this.db.upsertProject(row);

    // Backfill project_id on any existing sessions rooted in this repo,
    // including subdirectory and worktree sessions from before a removal
    this.db.assignSessionsToProject(row.id, canonicalDirectory);
    for (const sessionDirectory of this.db.getDistinctSessionDirectories()) {
      if (sessionDirectory === canonicalDirectory) continue;
      if (
        this.canonicalizeSessionDirectory(sessionDirectory)?.canonicalDirectory ===
        canonicalDirectory
      ) {
        this.db.assignSessionsToProject(row.id, sessionDirectory);
      }
    }

    const project = rowToProject(row);
    this.logger.info(
      `[ProjectManager] Registered project: ${project.name} (${canonicalDirectory})`,
    );
    this.emit("project:created", project);
    this.scheduleGitInfoRefresh(project.id);
    return project;
  }

  /**
   * Create a new project directory, initialize a git repo, and register it.
   */
  async initProject(
    parentDirectory: string,
    name: string,
    options: { accountId?: string | null } = {},
  ): Promise<Project> {
    if (!existsSync(parentDirectory)) {
      throw new Error(`Parent directory does not exist: ${parentDirectory}`);
    }

    // Sanitize name
    if (!name || /[/\\]/.test(name) || name === "." || name === "..") {
      throw new Error(`Invalid project name: ${name}`);
    }

    const targetDir = join(parentDirectory, name);
    if (existsSync(targetDir)) {
      throw new Error(`Directory already exists: ${targetDir}`);
    }

    mkdirSync(targetDir, { recursive: true });
    await gitInit(targetDir);

    return this.addProject(targetDir, { name, accountId: options.accountId });
  }

  /** Remove a project and dissociate its sessions. */
  removeProject(id: string): boolean {
    const existing = this.db.getProject(id);
    if (!existing) return false;

    // Clear by project_id so subdirectory/worktree sessions associated during
    // recovery don't keep a dangling reference to the deleted project
    this.db.unassignSessionsFromProject(id);

    // Tombstone the directory so recoverProjectsFromSessionDirectories() doesn't
    // resurrect the project from the orphaned session rows on the next scan.
    this.db.addRemovedProjectDirectory(existing.directory, Date.now());

    this.db.deleteProject(id);
    this.logger.info(`[ProjectManager] Removed project: ${existing.name}`);
    this.emit("project:removed", id);
    return true;
  }

  /** List all registered projects. */
  listProjects(): Project[] {
    return this.db.getAllProjects().map(rowToProject);
  }

  /**
   * Get a project by ID or slug. Tries UUID lookup first, then falls back to
   * slug — this is the single resolver used by API routes so that human-readable
   * URLs (`/projects/relay`) and legacy UUID URLs both work.
   */
  getProject(idOrSlug: string): Project | undefined {
    const byId = this.db.getProject(idOrSlug);
    if (byId) return rowToProject(byId);
    const bySlug = this.db.getProjectBySlug(idOrSlug);
    return bySlug ? rowToProject(bySlug) : undefined;
  }

  /** Get a project by its directory path. */
  getProjectByDirectory(directory: string): Project | undefined {
    const row = this.db.getProjectByDirectory(directory);
    if (row) return rowToProject(row);

    let resolvedDirectory: string;
    try {
      resolvedDirectory = realpathSync(directory);
    } catch {
      return undefined;
    }

    for (const candidate of this.db.getAllProjects()) {
      try {
        if (realpathSync(candidate.directory) === resolvedDirectory) {
          return rowToProject(candidate);
        }
      } catch {
        // Ignore stale or unreadable project directories while comparing.
      }
    }

    return undefined;
  }

  /** Update project settings. */
  updateProject(
    id: string,
    updates: {
      name?: string;
      targetBranch?: string | null;
      customInstructions?: string | null;
      defaultSpaceBranch?: string | null;
      spaceBranchSource?: "local" | "remote" | null;
      defaultProvider?: string | null;
      defaultModel?: string | null;
      /**
       * Account membership. Validated against the known account ids (throws
       * on an unknown id), deduped; empty ⇒ the default account only.
       */
      accountIds?: string[] | null;
      suggestions?: SuggestionsConfig | null;
    },
  ): Project | undefined {
    const existing = this.db.getProject(id);
    if (!existing) return undefined;

    let accountIdsJson = existing.account_ids_json ?? null;
    if (updates.accountIds !== undefined) {
      if (updates.accountIds !== null && !Array.isArray(updates.accountIds)) {
        throw new Error("accountIds must be a list of account ids");
      }
      const normalized = normalizeAccountIds(updates.accountIds);
      const known = this.knownAccountIds();
      const unknown = normalized.filter((accountId) => !known.has(accountId));
      if (unknown.length) {
        throw new Error(`Unknown account${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
      }
      accountIdsJson = serializeAccountIds(normalized);
    }

    const row: ProjectRow = {
      ...existing,
      name: updates.name ?? existing.name,
      target_branch:
        updates.targetBranch !== undefined ? updates.targetBranch : existing.target_branch,
      custom_instructions:
        updates.customInstructions !== undefined
          ? updates.customInstructions
          : existing.custom_instructions,
      default_space_branch:
        updates.defaultSpaceBranch !== undefined
          ? updates.defaultSpaceBranch
          : existing.default_space_branch,
      space_branch_source:
        updates.spaceBranchSource !== undefined
          ? updates.spaceBranchSource
          : existing.space_branch_source,
      default_provider:
        updates.defaultProvider !== undefined ? updates.defaultProvider : existing.default_provider,
      default_model:
        updates.defaultModel !== undefined ? updates.defaultModel : existing.default_model,
      account_ids_json: accountIdsJson,
      suggestions_json:
        "suggestions" in updates
          ? updates.suggestions
            ? JSON.stringify(updates.suggestions)
            : null
          : existing.suggestions_json,
    };

    this.db.upsertProject(row);
    const project = rowToProject(row);
    this.emit("project:updated", project);
    return project;
  }

  /**
   * Drop a removed account from every project's membership. A project left
   * with no accounts falls back to the default account. Returns the number of
   * projects changed. Chats already bound to the account's config dir are
   * untouched — they still work, they just aren't under a named account.
   */
  removeAccountFromProjects(accountId: string): number {
    if (!accountId || accountId === DEFAULT_ACCOUNT_ID) return 0;
    let changed = 0;
    for (const existing of this.db.getAllProjects()) {
      const current = parseAccountIds(existing.account_ids_json);
      if (!current.includes(accountId)) continue;
      const row: ProjectRow = {
        ...existing,
        account_ids_json: serializeAccountIds(current.filter((id) => id !== accountId)),
      };
      this.db.upsertProject(row);
      changed++;
      this.emit("project:updated", rowToProject(row));
    }
    if (changed > 0) {
      this.logger.info(`[ProjectManager] Removed account ${accountId} from ${changed} project(s)`);
    }
    return changed;
  }

  /** Inject the shared account store (the manager's), replacing the built-in one. */
  setAccountsSource(accounts: ProjectAccountsSource): void {
    this.accounts = accounts;
  }

  /** Every account id a project may belong to: the default plus stored accounts. */
  private knownAccountIds(): Set<string> {
    const ids = new Set<string>([DEFAULT_ACCOUNT_ID]);
    for (const account of this.accounts.list()) ids.add(account.id);
    return ids;
  }

  /** Validate the account a project is being registered under; absent ⇒ default. */
  private requireKnownAccountId(accountId: string | null | undefined): string {
    const trimmed = typeof accountId === "string" ? accountId.trim() : "";
    if (!trimmed) return DEFAULT_ACCOUNT_ID;
    if (!this.knownAccountIds().has(trimmed)) throw new Error(`Unknown account: ${trimmed}`);
    return trimmed;
  }

  /**
   * Refresh cached git metadata (repo root, remote URL) for a project.
   * Emits `project:updated` when anything changed. A git failure keeps the
   * previously cached remote URL.
   */
  async refreshGitInfo(id: string): Promise<Project | undefined> {
    const existing = this.db.getProject(id);
    if (!existing) return undefined;

    let repoRoot = existing.repo_root;
    let remoteUrl = existing.remote_url;

    if (isGitRepo(existing.directory)) {
      repoRoot = getRepoRoot(existing.directory);
      try {
        remoteUrl = await getRemoteUrl(existing.directory);
      } catch (err) {
        this.logger.debug(
          `[ProjectManager] Could not read remote URL for ${existing.directory}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Re-read: the row may have changed (or been removed) while git ran.
    const latest = this.db.getProject(id);
    if (!latest) return undefined;
    if (latest.repo_root === repoRoot && latest.remote_url === remoteUrl) {
      return rowToProject(latest);
    }
    const row: ProjectRow = { ...latest, repo_root: repoRoot, remote_url: remoteUrl };
    this.db.upsertProject(row);
    const project = rowToProject(row);
    this.emit("project:updated", project);
    return project;
  }

  /** Fire-and-forget `refreshGitInfo` for paths that must stay synchronous. */
  private scheduleGitInfoRefresh(id: string): void {
    void this.refreshGitInfo(id).catch((err) => {
      this.logger.debug(
        `[ProjectManager] Git metadata refresh failed for ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  /** Update last_activity_at for a project. */
  touchProject(id: string): void {
    this.db.updateProjectActivity(id, Date.now());
  }

  /** Get the set of registered project directories (for scoped discovery). */
  getRegisteredDirectories(): Set<string> {
    return new Set(this.db.getAllProjects().map((p: ProjectRow) => p.directory));
  }
}
