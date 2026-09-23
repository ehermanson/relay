/**
 * SpaceManager — Space lifecycle management for Relay
 *
 * A Space groups multiple concurrent agent chats within a shared git worktree/branch.
 * Every project has an implicit "main" space (no worktree, default branch).
 * Additional spaces create dedicated worktrees for isolation.
 */

import { randomUUID } from "crypto";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  realpathSync,
  readdirSync,
} from "fs";
import { rm } from "fs/promises";
import { basename, join, resolve } from "path";
import { EventEmitter } from "events";

import type { SessionDB } from "#core/db.js";
import { relayDir } from "#core/config.js";
import type { SpaceRow } from "#core/db.js";
import type { Logger } from "#core/logger.js";
import type {
  SpaceInfo,
  SpaceStatus,
  MergeMethod,
  SpacePrStatus,
  SpacePrStatusResponse,
} from "#core/types.js";
import type { SpaceOwnershipCandidate } from "#core/instance-restore.js";
import {
  isGitRepo,
  getRepoRoot,
  getDefaultBranch,
  getCurrentBranch,
  addWorktree,
  removeWorktree,
  isWorktreeDirty,
  isAncestor,
  commitAll,
  mergeBranchIntoTarget,
  MergeTargetError,
  getStatusSummary,
  resolveLocalTargetBranch,
  inspectWorktreeGitPointer,
  getWorktreeDiff,
  gitPush,
  getWorktreeBase,
  resolveGitDirs,
  resolveWorktreeOrigin,
  listWorktrees,
  withRepoLock,
  type WorktreeEntry,
  type WorktreeRemovalResult,
} from "#core/git.js";
import { GitCommandError, isGitCommandError, runGit, GIT_TIMEOUTS } from "#core/git-runner.js";
import {
  PrStatusReader,
  checkGhAvailability,
  createPullRequest,
  findOpenPullRequest,
  remoteStatusForPr,
} from "#core/space-pr.js";

function parsePrStatus(json: string | null | undefined): SpacePrStatus | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as SpacePrStatus;
    return parsed && typeof parsed === "object" && typeof parsed.url === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Why a Complete was refused. `conflict` carries the conflicting paths. */
export type SpaceCompletionErrorCode =
  | "conflict"
  | "target_missing"
  | "target_checked_out"
  | "target_dirty"
  | "checkout_blocked"
  | "ref_moved"
  | "unsupported";

/** Complete refused before anything was merged (the space stays active). */
export class SpaceCompletionError extends Error {
  readonly code: SpaceCompletionErrorCode;
  readonly targetBranch: string;
  readonly conflicts: string[];
  readonly worktreePath: string | null;
  constructor(opts: {
    code: SpaceCompletionErrorCode;
    message: string;
    targetBranch: string;
    conflicts?: string[];
    worktreePath?: string | null;
  }) {
    super(opts.message);
    this.name = "SpaceCompletionError";
    this.code = opts.code;
    this.targetBranch = opts.targetBranch;
    this.conflicts = opts.conflicts ?? [];
    this.worktreePath = opts.worktreePath ?? null;
  }
}

export interface PushSpaceResult {
  pushed: boolean;
  prUrl?: string;
  /** `created` = new PR; `opened_existing` = an open PR for this branch already existed. */
  prAction?: "created" | "opened_existing";
  error?: string;
  errorKind?: string;
  ghNotFound?: boolean;
  ghNotAuthenticated?: boolean;
}

export interface CompleteSpaceResult {
  targetBranch: string;
  mergeCommit?: string;
  mergeMethod: MergeMethod;
  /** Checkout whose files were fast-forwarded, or null when only the branch ref moved. */
  updatedCheckout?: string | null;
  /** True when the space branch was already contained in the target. */
  alreadyMerged?: boolean;
  worktreeRemoval?: WorktreeRemovalResult;
}

export interface OrphanWorktreeSweepResult {
  removed: string[];
  /** Valid worktrees under the base that no space row references (logged, never removed). */
  unreferenced: string[];
  /** Dangling worktrees kept because an active space still references them. */
  keptReferenced: string[];
}

function rowToInfo(row: SpaceRow, chatCount: number): SpaceInfo {
  return {
    id: row.id,
    projectDirectory: row.project_directory,
    name: row.name,
    gitBranch: row.git_branch,
    worktreePath: row.worktree_path,
    missingWorktreePath: null,
    isDefault: row.is_default === 1,
    status: row.status as SpaceStatus,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    chatCount,
    pinned: row.pinned === 1,
    mergeCommit: row.merge_commit,
    mergeMethod: row.merge_method as MergeMethod | null,
    mergedAt: row.merged_at,
    targetBranch: row.target_branch,
    remoteStatus: row.remote_status,
    prUrl: row.pr_url,
    baseBranch: row.base_branch ?? null,
    prStatus: parsePrStatus(row.pr_status_json),
  };
}

export interface SpaceManagerEvents {
  "space:created": [space: SpaceInfo];
  "space:updated": [space: SpaceInfo];
  "space:completed": [
    spaceId: string,
    projectDirectory: string,
    targetBranch: string,
    mergeMethod: string,
    mergeCommit?: string,
  ];
  "space:removed": [spaceId: string, projectDirectory: string];
}

export interface SpaceManager {
  on<E extends keyof SpaceManagerEvents>(
    event: E,
    listener: (...args: SpaceManagerEvents[E]) => void,
  ): this;
  emit<E extends keyof SpaceManagerEvents>(event: E, ...args: SpaceManagerEvents[E]): boolean;
  off<E extends keyof SpaceManagerEvents>(
    event: E,
    listener: (...args: SpaceManagerEvents[E]) => void,
  ): this;
}

export class SpaceManager extends EventEmitter {
  private db: SessionDB;
  private logger: Logger;
  private prStatusReader: PrStatusReader;
  private stopSpaceChats: ((spaceId: string) => number) | null = null;
  private repoStatusInvalidator: ((dir: string) => void) | null = null;

  constructor(db: SessionDB, logger: Logger, opts?: { prStatusReader?: PrStatusReader }) {
    super();
    this.db = db;
    this.logger = logger;
    this.prStatusReader = opts?.prStatusReader ?? new PrStatusReader();
  }

  /**
   * Register how to stop (never delete) a space's running chats. Complete,
   * mark-merged, and Archive call it before auto-committing and removing the
   * worktree so no agent is writing into a directory that disappears.
   * Injected by InstanceManager to avoid an import cycle.
   */
  setSpaceChatStopper(stopper: ((spaceId: string) => number) | null): void {
    this.stopSpaceChats = stopper;
  }

  /** Register the repo-status invalidation hook (called after merges/pushes). */
  setRepoStatusInvalidator(invalidate: ((dir: string) => void) | null): void {
    this.repoStatusInvalidator = invalidate;
  }

  private invalidateRepoStatus(...dirs: Array<string | null | undefined>): void {
    if (!this.repoStatusInvalidator) return;
    for (const dir of new Set(dirs.filter((d): d is string => Boolean(d)))) {
      try {
        this.repoStatusInvalidator(dir);
      } catch (err) {
        this.logger.debug(
          `[SpaceManager] Repo status invalidation failed for ${dir}: ${String(err)}`,
        );
      }
    }
  }

  private stopChatsInSpace(spaceId: string): void {
    if (!this.stopSpaceChats) return;
    try {
      const stopped = this.stopSpaceChats(spaceId);
      if (stopped > 0) {
        this.logger.info(`[SpaceManager] Stopped ${stopped} running chat(s) in space ${spaceId}`);
      }
    } catch (err) {
      this.logger.warn(
        `[SpaceManager] Failed to stop chats in space ${spaceId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private logWorktreeRemoval(spaceId: string, path: string, result: WorktreeRemovalResult): void {
    if (result.removed) {
      if (result.method === "fallback-delete") {
        this.logger.warn(
          `[SpaceManager] git could not remove worktree ${path} for space ${spaceId}; deleted the untracked directory instead`,
        );
      }
      return;
    }
    this.logger.warn(
      `[SpaceManager] Failed to remove worktree ${path} for space ${spaceId}: ${result.error ?? "unknown error"}`,
    );
  }

  /**
   * The local branch this space merges into — the one Complete, the diff,
   * and PR creation all use. Prefers the base branch recorded at creation;
   * older rows are backfilled (once, persisted) from the project's/global
   * default space branch, then the repository's default branch.
   */
  async resolveTargetBranch(row: SpaceRow, repoRoot: string): Promise<string> {
    if (row.base_branch) return row.base_branch;
    const project = this.db.getProjectByDirectory(row.project_directory);
    const configured =
      project?.default_space_branch || this.db.getGlobalSettings().default_space_branch || null;
    const resolved =
      (await resolveLocalTargetBranch(repoRoot, configured).catch(() => null)) ||
      (await getDefaultBranch(repoRoot));
    if (resolved) {
      if (row.is_default === 0 && row.status === "active") {
        this.db.setSpaceBaseBranch(row.id, resolved);
      }
      return resolved;
    }
    return (await getCurrentBranch(repoRoot).catch(() => null)) || "main";
  }

  private getExistingWorktreePath(worktreePath: string | null): string | null {
    if (!worktreePath) return null;
    return existsSync(worktreePath) && isGitRepo(worktreePath) ? worktreePath : null;
  }

  private toInfo(row: SpaceRow): SpaceInfo {
    const worktreePath = this.getExistingWorktreePath(row.worktree_path);
    const status =
      row.status === "active" && row.is_default === 0 && !worktreePath ? "broken" : row.status;
    const info = rowToInfo(
      {
        ...row,
        status,
        worktree_path: worktreePath,
      },
      this.db.getSpaceChatCount(row.id),
    );
    if (status === "broken") {
      info.missingWorktreePath = row.worktree_path;
    }
    return info;
  }

  private deriveRecoveredSpaceId(row: {
    space_id: string | null;
    worktree_path: string | null;
    git_branch: string | null;
  }): string | null {
    if (row.space_id) return row.space_id;

    const worktreeBase = row.worktree_path ? basename(row.worktree_path) : null;
    if (worktreeBase?.startsWith("space-")) {
      return `recovered-${worktreeBase}`;
    }

    const branchSuffix = row.git_branch?.match(/^relay-space\/(.+)$/)?.[1];
    if (branchSuffix) {
      return `recovered-space-${branchSuffix}`;
    }

    return null;
  }

  private deriveRecoveredSpaceName(row: {
    git_branch: string | null;
    worktree_path: string | null;
  }): string {
    return row.git_branch ?? row.worktree_path ?? "Recovered space";
  }

  private normalizeProjectDirectory(
    projectDirectory: string | null | undefined,
    worktreePath?: string | null,
  ): string | null {
    if (projectDirectory) {
      const origin = resolveWorktreeOrigin(projectDirectory);
      if (origin) return origin;
    }
    if (worktreePath) {
      const origin = resolveWorktreeOrigin(worktreePath);
      if (origin) return origin;
    }
    return projectDirectory ?? worktreePath ?? null;
  }

  private findMatchingSpaceRow(
    existingSpaces: Iterable<SpaceRow>,
    row: { project_directory: string; git_branch: string | null; worktree_path: string | null },
  ): SpaceRow | null {
    for (const existing of existingSpaces) {
      if (existing.project_directory !== row.project_directory) continue;
      if (row.git_branch && existing.git_branch === row.git_branch) return existing;
      if (row.worktree_path && existing.worktree_path === row.worktree_path) return existing;
    }
    return null;
  }

  /**
   * Infer a recovered space's lifecycle from metadata alone. Returns
   * `needsGitCheck` when only git can tell whether the branch was merged;
   * that check runs asynchronously afterwards (`refineRecoveredSpaces`).
   */
  private inferRecoveredSpaceStatus(row: {
    project_directory: string;
    git_branch: string | null;
    worktree_path: string | null;
    git_info_branch: string | null;
    last_activity_at: number;
  }): Pick<SpaceRow, "status" | "worktree_path" | "merged_at" | "target_branch"> & {
    needsGitCheck?: boolean;
  } {
    const worktreePath = this.getExistingWorktreePath(row.worktree_path);
    if (worktreePath) {
      return {
        status: "active",
        worktree_path: worktreePath,
        merged_at: null,
        target_branch: null,
      };
    }

    if (row.git_info_branch && row.git_branch && row.git_info_branch !== row.git_branch) {
      return {
        status: "completed",
        worktree_path: null,
        merged_at: row.last_activity_at,
        target_branch: row.git_info_branch,
      };
    }

    const repoRoot = getRepoRoot(row.project_directory);
    return {
      status: "active",
      worktree_path: null,
      merged_at: null,
      target_branch: null,
      needsGitCheck: Boolean(repoRoot && row.git_branch),
    };
  }

  /**
   * Async follow-up for recovered legacy spaces whose merge state needs git:
   * mark a still-active, worktree-less space completed when its branch is
   * already contained in the repository's default (or current) branch.
   */
  private async refineRecoveredSpaces(ids: string[]): Promise<void> {
    for (const id of ids) {
      try {
        const row = this.db.getSpace(id);
        if (!row || row.status !== "active" || row.worktree_path || !row.git_branch) continue;
        const repoRoot = getRepoRoot(row.project_directory);
        if (!repoRoot) continue;
        const targetBranch =
          (await getDefaultBranch(repoRoot)) ||
          (await getCurrentBranch(repoRoot).catch(() => null));
        if (!targetBranch || targetBranch === row.git_branch) continue;
        if (!(await isAncestor(repoRoot, row.git_branch, targetBranch))) continue;
        const latest = this.db.getSpace(id);
        if (!latest || latest.status !== "active" || latest.worktree_path) continue;
        this.db.upsertSpace({
          ...latest,
          status: "completed",
          merged_at: latest.last_activity_at,
          target_branch: targetBranch,
        });
        this.emit("space:updated", this.toInfo(this.db.getSpace(id)!));
      } catch (err) {
        this.logger.debug(
          `[SpaceManager] Could not infer merge state for recovered space ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /**
   * Get or lazily create the implicit default space for a project.
   * The default space has no worktree — it represents the main branch.
   */
  getOrCreateDefaultSpace(projectDirectory: string): SpaceInfo {
    const existing = this.db.getDefaultSpace(projectDirectory);
    if (existing) {
      return rowToInfo(existing, this.db.getSpaceChatCount(existing.id));
    }

    const now = Date.now();
    const row: SpaceRow = {
      id: randomUUID(),
      project_directory: projectDirectory,
      name: "main",
      git_branch: null,
      worktree_path: null,
      is_default: 1,
      status: "active",
      created_at: now,
      last_activity_at: now,
      merge_commit: null,
      merge_method: null,
      merged_at: null,
      target_branch: null,
      remote_status: null,
      pr_url: null,
    };
    this.db.upsertSpace(row);
    this.logger.info(`[SpaceManager] Created default space for ${projectDirectory}`);
    return this.toInfo(row);
  }

  /**
   * Create a new space with its own git worktree.
   * Requires the project to be a git repository.
   */
  async createSpace(
    projectDirectory: string,
    opts?: { name?: string; baseBranch?: string; description?: string },
  ): Promise<SpaceInfo> {
    if (!isGitRepo(projectDirectory)) {
      throw new Error("Cannot create space: project is not a git repository");
    }

    const repoRoot = getRepoRoot(projectDirectory);
    if (!repoRoot) {
      throw new Error("Cannot determine git repository root");
    }

    // Ensure default space exists
    this.getOrCreateDefaultSpace(projectDirectory);

    const id = randomUUID();
    const shortId = id.slice(0, 8);
    const branchName = `relay-space/${shortId}`;

    // Create the worktree
    const worktreeBase = getWorktreeBase();
    const worktreePath = join(worktreeBase, `space-${shortId}`);

    let targetBranch: string | null = null;
    try {
      const defaultBranch = await getDefaultBranch(repoRoot);
      const baseBranch =
        opts?.baseBranch ||
        defaultBranch ||
        (await getCurrentBranch(repoRoot).catch(() => null)) ||
        "HEAD";
      await addWorktree(repoRoot, worktreePath, branchName, baseBranch);
      // Record the local branch this space merges back into (`origin/main`
      // → `main`, `HEAD` → the current branch). Complete, the diff, and PR
      // base all use it.
      targetBranch =
        (await resolveLocalTargetBranch(repoRoot, baseBranch).catch(() => null)) || defaultBranch;
    } catch (err) {
      throw new Error(
        `Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const spaceName = opts?.name || branchName;
    const now = Date.now();
    const row: SpaceRow = {
      id,
      project_directory: projectDirectory,
      name: spaceName,
      git_branch: branchName,
      worktree_path: worktreePath,
      is_default: 0,
      status: "active",
      created_at: now,
      last_activity_at: now,
      merge_commit: null,
      merge_method: null,
      merged_at: null,
      target_branch: null,
      remote_status: null,
      pr_url: null,
      base_branch: targetBranch,
    };

    try {
      // Seed the shared space context file
      this.seedSpaceContext(worktreePath, spaceName, opts?.description);

      // Exclude .relay/ from git in the worktree
      this.excludeRelayDir(worktreePath);

      this.db.upsertSpace(row);
    } catch (err) {
      const cleanup = await removeWorktree(repoRoot, worktreePath, branchName).catch(
        (cleanupErr: unknown): WorktreeRemovalResult => ({
          removed: false,
          method: "failed",
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        }),
      );
      this.logWorktreeRemoval(id, worktreePath, cleanup);
      throw err;
    }
    this.logger.info(
      `[SpaceManager] Created space "${spaceName}" (${id}) with worktree at ${worktreePath}`,
    );
    const info = this.toInfo(row);
    this.emit("space:created", info);
    return info;
  }

  /**
   * List git worktrees of the project that are not yet tracked as a Space and
   * are eligible for conversion (skips primary checkout, bare, detached, and
   * branchless entries).
   */
  async listConvertibleWorktrees(projectDirectory: string): Promise<WorktreeEntry[]> {
    if (!isGitRepo(projectDirectory)) return [];
    const repoRoot = getRepoRoot(projectDirectory);
    if (!repoRoot) return [];

    const trackedPaths = new Set<string>();
    for (const row of this.db.getSpacesByProjectAll(projectDirectory)) {
      if (!row.worktree_path) continue;
      trackedPaths.add(row.worktree_path);
      try {
        trackedPaths.add(realpathSync(row.worktree_path));
      } catch {
        // worktree dir may not exist on disk anymore
      }
    }

    return (await listWorktrees(repoRoot)).filter((w) => {
      if (w.isPrimary || w.isBare || w.isDetached || !w.branch) return false;
      if (trackedPaths.has(w.path)) return false;
      try {
        if (trackedPaths.has(realpathSync(w.path))) return false;
      } catch {
        // path missing — fall through, still treat as convertible
      }
      return true;
    });
  }

  /**
   * Convert an existing git worktree (created outside Relay) into a
   * full-lifecycle Space. The worktree's current branch + path are reused;
   * no `git worktree add` is run.
   */
  async convertWorktreeToSpace(
    projectDirectory: string,
    worktreePath: string,
    opts?: { name?: string; description?: string },
  ): Promise<SpaceInfo> {
    if (!isGitRepo(projectDirectory)) {
      throw new Error("Cannot convert worktree: project is not a git repository");
    }
    const repoRoot = getRepoRoot(projectDirectory);
    if (!repoRoot) {
      throw new Error("Cannot determine git repository root");
    }

    let canonicalRequest = worktreePath;
    try {
      canonicalRequest = realpathSync(worktreePath);
    } catch {
      // keep raw
    }
    const worktrees = await listWorktrees(repoRoot);
    const candidate = worktrees.find((w) => {
      if (w.path === worktreePath || w.path === canonicalRequest) return true;
      try {
        return realpathSync(w.path) === canonicalRequest;
      } catch {
        return false;
      }
    });
    if (!candidate) {
      throw new Error("Worktree not found for this project");
    }
    if (candidate.isPrimary) {
      throw new Error("Cannot convert the primary worktree");
    }
    if (candidate.isBare || candidate.isDetached || !candidate.branch) {
      throw new Error("Worktree must be on a branch to convert");
    }
    if (this.db.getSpaceByWorktreePath(candidate.path)) {
      throw new Error("This worktree is already tracked as a Space");
    }

    this.getOrCreateDefaultSpace(projectDirectory);

    const id = randomUUID();
    const spaceName = opts?.name?.trim() || candidate.branch;
    const now = Date.now();
    const row: SpaceRow = {
      id,
      project_directory: projectDirectory,
      name: spaceName,
      git_branch: candidate.branch,
      worktree_path: candidate.path,
      is_default: 0,
      status: "active",
      created_at: now,
      last_activity_at: now,
      merge_commit: null,
      merge_method: null,
      merged_at: null,
      target_branch: null,
      remote_status: null,
      pr_url: null,
    };

    this.seedSpaceContext(candidate.path, spaceName, opts?.description);
    this.excludeRelayDir(candidate.path);
    this.db.upsertSpace(row);

    this.logger.info(
      `[SpaceManager] Converted worktree at ${candidate.path} (${candidate.branch}) into space "${spaceName}" (${id})`,
    );
    const info = this.toInfo(row);
    this.emit("space:created", info);
    return info;
  }

  /**
   * List all active spaces for a project.
   */
  listSpaces(projectDirectory: string): SpaceInfo[] {
    if (isGitRepo(projectDirectory)) {
      this.getOrCreateDefaultSpace(projectDirectory);
    }
    const rows = this.db.getSpacesByProject(projectDirectory);
    return rows.map((row) => this.toInfo(row));
  }

  /**
   * List all non-default spaces including closed (completed/archived).
   */
  listAllSpaces(projectDirectory: string): SpaceInfo[] {
    if (isGitRepo(projectDirectory)) {
      this.getOrCreateDefaultSpace(projectDirectory);
    }
    const rows = this.db.getSpacesByProjectAll(projectDirectory);
    return rows.map((row) => this.toInfo(row));
  }

  /**
   * Non-default spaces as ownership-inference candidates, straight from the
   * DB. Restore matches every persisted chat against these, so this skips
   * what `listAllSpaces` does per call — git probes, worktree existence
   * checks, chat counts, and default-space creation — none of which the
   * match reads. The stored worktree path is kept whether or not it exists,
   * since inference matches live and missing worktree paths alike.
   */
  listOwnershipCandidates(projectDirectory: string): SpaceOwnershipCandidate[] {
    return this.db.getSpacesByProjectAll(projectDirectory).map((row) => ({
      id: row.id,
      projectDirectory: row.project_directory,
      gitBranch: row.git_branch,
      worktreePath: row.worktree_path,
      isDefault: row.is_default === 1,
    }));
  }

  recoverSpacesFromSessionMetadata(): number {
    // Compatibility-only recovery for legacy/orphaned rows. Current spaces
    // should already exist explicitly in the `spaces` table and should not
    // require reconstruction from session metadata in normal operation.
    const activeRows = this.db.getAllActive();
    const managedRows = this.db.getAllManagedActive();
    const repairedProjectDirs = new Set<string>();
    const registerProjectDirectory = (
      projectDirectory: string | null | undefined,
      worktreePath?: string | null,
    ): string | null => {
      const normalized = this.normalizeProjectDirectory(projectDirectory, worktreePath);
      if (
        projectDirectory &&
        normalized &&
        normalized !== projectDirectory &&
        !repairedProjectDirs.has(projectDirectory)
      ) {
        this.db.reassignSpacesToProjectDirectory(normalized, projectDirectory);
        repairedProjectDirs.add(projectDirectory);
      }
      return normalized;
    };

    const activeProjects = new Set<string>();
    for (const row of activeRows) {
      const projectDirectory = registerProjectDirectory(
        row.original_directory ?? row.working_directory,
        row.worktree_path,
      );
      if (projectDirectory) {
        activeProjects.add(projectDirectory);
      }
    }
    for (const row of managedRows) {
      const projectDirectory = registerProjectDirectory(
        row.original_directory ?? row.working_directory,
        row.worktree_path,
      );
      if (projectDirectory) {
        activeProjects.add(projectDirectory);
      }
    }

    const existingSpaces = new Map<string, SpaceRow>();
    const defaultSpaces = new Set<string>();

    for (const project of this.db.getAllProjects()) {
      // Include archived rows: surviving chat metadata must never reopen them.
      const defaultSpace = this.db.getDefaultSpace(project.directory);
      const spaces = this.db.getSpacesByProjectAll(project.directory);
      if (defaultSpace) spaces.push(defaultSpace);
      for (const space of spaces) {
        existingSpaces.set(space.id, space);
        if (space.is_default === 1) {
          defaultSpaces.add(project.directory);
        }
      }
    }

    let recovered = 0;
    for (const projectDirectory of activeProjects) {
      if (!defaultSpaces.has(projectDirectory) && isGitRepo(projectDirectory)) {
        this.getOrCreateDefaultSpace(projectDirectory);
        defaultSpaces.add(projectDirectory);
        recovered++;
      }
    }

    const recoveredSpaces = new Map<
      string,
      {
        row: SpaceRow & { git_info_branch: string | null };
        sessionIds: string[];
        managedInstanceIds: string[];
      }
    >();

    const collect = (
      row: {
        session_id?: string;
        instance_id?: string;
        working_directory: string;
        original_directory: string | null;
        worktree_path: string | null;
        git_branch: string | null;
        git_info_branch: string | null;
        original_git_branch?: string | null;
        space_id: string | null;
        created_at: number;
        last_activity_at: number;
        archived: number;
      },
      kind: "session" | "managed",
    ) => {
      if (row.archived) return;
      const spaceBranch = row.git_branch ?? row.original_git_branch ?? null;
      if (!row.worktree_path && !spaceBranch?.startsWith("relay-space/")) return;

      const projectDirectory = this.normalizeProjectDirectory(
        row.original_directory ?? row.working_directory,
        row.worktree_path,
      );
      if (!projectDirectory) return;
      const id = this.deriveRecoveredSpaceId({
        ...row,
        git_branch: spaceBranch,
      });
      if (!id) return;

      const existing = recoveredSpaces.get(id);
      if (!existing) {
        recoveredSpaces.set(id, {
          row: {
            id,
            project_directory: projectDirectory,
            name: this.deriveRecoveredSpaceName({
              ...row,
              git_branch: spaceBranch,
            }),
            git_branch: spaceBranch,
            worktree_path: row.worktree_path,
            is_default: 0,
            status: "active",
            created_at: row.created_at,
            last_activity_at: row.last_activity_at,
            merge_commit: null,
            merge_method: null,
            merged_at: null,
            target_branch: null,
            remote_status: null,
            pr_url: null,
            git_info_branch: row.git_info_branch,
          },
          sessionIds: kind === "session" && row.session_id ? [row.session_id] : [],
          managedInstanceIds: kind === "managed" && row.instance_id ? [row.instance_id] : [],
        });
        return;
      }

      existing.row.created_at = Math.min(existing.row.created_at, row.created_at);
      existing.row.last_activity_at = Math.max(existing.row.last_activity_at, row.last_activity_at);
      existing.row.project_directory = projectDirectory;
      existing.row.git_branch = existing.row.git_branch ?? spaceBranch;
      existing.row.worktree_path = existing.row.worktree_path ?? row.worktree_path;
      existing.row.git_info_branch = existing.row.git_info_branch ?? row.git_info_branch;

      if (kind === "session" && row.session_id) {
        existing.sessionIds.push(row.session_id);
      }
      if (kind === "managed" && row.instance_id) {
        existing.managedInstanceIds.push(row.instance_id);
      }
    };

    for (const row of activeRows) {
      collect(row, "session");
    }
    for (const row of managedRows) {
      collect(row, "managed");
    }

    const needsGitCheck: string[] = [];
    for (const { row, sessionIds, managedInstanceIds } of recoveredSpaces.values()) {
      const matching =
        this.db.getSpace(row.id) ?? this.findMatchingSpaceRow(existingSpaces.values(), row);
      const linkedSpaceId = matching?.id ?? row.id;
      const { needsGitCheck: recoveredNeedsGit, ...recoveredMeta } =
        this.inferRecoveredSpaceStatus(row);
      if (!matching && recoveredNeedsGit) needsGitCheck.push(row.id);
      const upsertRow: SpaceRow = matching
        ? {
            ...matching,
            git_branch: matching.git_branch ?? row.git_branch,
            // Existing explicit space rows are authoritative; recovery metadata
            // should only fill gaps, not reinterpret an active space as merged.
            worktree_path: matching.worktree_path ?? recoveredMeta.worktree_path,
            status: matching.status,
            last_activity_at: Math.max(matching.last_activity_at, row.last_activity_at),
            merged_at:
              matching.status === "completed" || matching.status === "archived"
                ? (matching.merged_at ?? recoveredMeta.merged_at)
                : matching.merged_at,
            target_branch:
              matching.status === "completed" || matching.status === "archived"
                ? (matching.target_branch ?? recoveredMeta.target_branch)
                : matching.target_branch,
          }
        : {
            ...row,
            ...recoveredMeta,
          };

      this.db.upsertSpace(upsertRow);
      if (!matching) {
        existingSpaces.set(upsertRow.id, upsertRow);
        recovered++;
      }

      for (const sessionId of sessionIds) {
        this.db.updateSessionSpaceId(sessionId, linkedSpaceId);
      }
      for (const instanceId of managedInstanceIds) {
        this.db.updateManagedSpaceId(instanceId, linkedSpaceId);
      }
    }

    if (recovered > 0) {
      this.logger.info(`[SpaceManager] Recovered ${recovered} space row(s) from session metadata`);
    }
    if (needsGitCheck.length > 0) {
      void this.refineRecoveredSpaces(needsGitCheck);
    }

    return recovered;
  }

  /**
   * Get a space by ID.
   */
  getSpace(id: string): SpaceInfo | undefined {
    const row = this.db.getSpace(id);
    if (!row) return undefined;
    return this.toInfo(row);
  }

  /**
   * Get a space by its worktree path.
   */
  getSpaceByWorktreePath(worktreePath: string): SpaceInfo | undefined {
    let row = this.db.getSpaceByWorktreePath(worktreePath);
    if (!row) {
      // Git canonicalizes worktree paths (e.g. /tmp → /private/tmp on macOS),
      // so the stored path may differ from what the caller has. Try the
      // canonical form before giving up.
      try {
        const canonical = realpathSync(worktreePath);
        if (canonical !== worktreePath) {
          row = this.db.getSpaceByWorktreePath(canonical);
        }
      } catch {
        // path may not exist on disk
      }
    }
    if (!row) return undefined;
    return this.toInfo(row);
  }

  /**
   * Get the working directory for a space (worktree path if available, else project dir).
   * Returns undefined if the space is not found.
   */
  getSpaceWorkingDirectory(spaceId?: string): string | undefined {
    if (!spaceId) return undefined;
    const space = this.getSpace(spaceId);
    if (!space) return undefined;
    return space.worktreePath ?? space.projectDirectory;
  }

  renameSpace(id: string, name: string): SpaceInfo {
    const row = this.db.getSpace(id);
    if (!row) {
      throw new Error(`Space ${id} not found`);
    }
    if (row.is_default) {
      throw new Error("Cannot rename the default space");
    }

    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Space name cannot be empty");
    }

    const now = Date.now();
    this.db.updateSpaceName(id, trimmed, now);
    const updated = this.db.getSpace(id);
    if (!updated) {
      throw new Error(`Space ${id} not found after rename`);
    }
    const info = this.toInfo(updated);
    this.emit("space:updated", info);
    return info;
  }

  setSpacePinned(id: string, pinned: boolean): SpaceInfo {
    if (!this.db.setSpacePinned(id, pinned)) {
      throw new Error(`Space ${id} not found`);
    }
    const updated = this.db.getSpace(id);
    if (!updated) {
      throw new Error(`Space ${id} not found after pin update`);
    }
    const info = this.toInfo(updated);
    this.emit("space:updated", info);
    return info;
  }

  /**
   * Complete a space: stop its chats, auto-commit, merge the space branch
   * into its target branch (see `resolveTargetBranch`), archive the brief,
   * and remove the worktree (the local branch is kept for recoverability).
   *
   * The merge never depends on what the main checkout has checked out: if the
   * target is checked out there it is fast-forwarded (tracked changes block,
   * untracked files don't); otherwise only the branch ref moves. Conflicts and
   * other refusals throw `SpaceCompletionError` and leave everything as it was.
   */
  async completeSpace(
    id: string,
    opts?: { mergeMethod?: MergeMethod; squashMessage?: string },
  ): Promise<CompleteSpaceResult> {
    const row = this.db.getSpace(id);
    if (!row) throw new Error(`Space ${id} not found`);
    if (row.is_default) throw new Error("Cannot complete the default space");
    if (!row.git_branch || !row.worktree_path) {
      throw new Error("Space has no worktree to complete");
    }
    if (!existsSync(row.worktree_path) || !isGitRepo(row.worktree_path)) {
      throw new Error("Space has no worktree to complete");
    }
    const mergeMethod: MergeMethod = opts?.mergeMethod || "squash";
    if (mergeMethod !== "squash" && mergeMethod !== "merge-commit") {
      throw new Error(`Unsupported merge method: ${mergeMethod}`);
    }

    const repoRoot = getRepoRoot(row.project_directory);
    if (!repoRoot) throw new Error("Cannot determine git repository root");

    // Hold the repository lock for the whole check → commit → merge → cleanup
    // sequence so no other Relay git mutation interleaves (nested helpers
    // re-enter the same lock).
    const spaceRow = { ...row, git_branch: row.git_branch, worktree_path: row.worktree_path };
    return withRepoLock(repoRoot, () =>
      this.completeSpaceLocked(id, spaceRow, repoRoot, mergeMethod, opts?.squashMessage),
    );
  }

  private async completeSpaceLocked(
    id: string,
    row: SpaceRow & { git_branch: string; worktree_path: string },
    repoRoot: string,
    mergeMethod: "squash" | "merge-commit",
    squashMessage?: string,
  ): Promise<CompleteSpaceResult> {
    const targetBranch = await this.resolveTargetBranch(row, repoRoot);
    if (targetBranch === row.git_branch) {
      throw new SpaceCompletionError({
        code: "target_missing",
        message: `This space's branch (${targetBranch}) is also its merge target. Nothing to complete.`,
        targetBranch,
      });
    }

    // Cheap refusals first, so an obviously blocked Complete doesn't stop chats.
    const mainBranch = await getCurrentBranch(repoRoot).catch(() => null);
    if (mainBranch === targetBranch) {
      const status = await getStatusSummary(repoRoot);
      if (status.staged + status.unstaged + status.conflicted > 0) {
        throw new SpaceCompletionError({
          code: "target_dirty",
          message: `Your main workspace has uncommitted changes to tracked files on ${targetBranch}. Commit or stash them before completing this space. (Untracked files don't block completion.)`,
          targetBranch,
        });
      }
    }

    // Stop (never delete) the space's chats before touching the worktree.
    this.stopChatsInSpace(id);

    if (existsSync(row.worktree_path) && (await isWorktreeDirty(row.worktree_path))) {
      const commitResult = await commitAll(row.worktree_path, row.name || "Space work");
      if (!commitResult.success) {
        throw new Error(`Auto-commit failed: ${commitResult.error}`);
      }
    }

    let merge: Awaited<ReturnType<typeof mergeBranchIntoTarget>>;
    try {
      merge = await mergeBranchIntoTarget(repoRoot, {
        sourceBranch: row.git_branch,
        targetBranch,
        method: mergeMethod,
        message: mergeMethod === "squash" ? squashMessage || `Space: ${row.name}` : undefined,
      });
    } catch (err) {
      if (err instanceof MergeTargetError) {
        throw new SpaceCompletionError({
          code: err.code,
          message: err.message,
          targetBranch,
          worktreePath: row.worktree_path,
        });
      }
      throw err;
    }

    if (merge.status === "conflict") {
      const list = merge.conflicts.length
        ? `${merge.conflicts.map((f) => `  ${f}`).join("\n")}\n\n`
        : "";
      throw new SpaceCompletionError({
        code: "conflict",
        message:
          `Merge conflicts between this space and ${targetBranch}` +
          (merge.conflicts.length ? ` in ${merge.conflicts.length} file(s):\n${list}` : ".\n\n") +
          `Nothing was merged. Bring ${targetBranch} into the space and resolve the conflicts there ` +
          `(or ask a chat in this space to do it):\n  cd ${row.worktree_path}\n  git merge ${targetBranch}\n\n` +
          "Then complete the space again.",
        targetBranch,
        conflicts: merge.conflicts,
        worktreePath: row.worktree_path,
      });
    }

    const mergeCommit = merge.mergeCommit;
    this.logger.info(
      `[SpaceManager] Merged space "${row.name}" (${row.git_branch}) into ${targetBranch} via ${mergeMethod}` +
        (merge.status === "up_to_date" ? " (already up to date)" : "") +
        (merge.status === "merged" && !merge.updatedCheckout ? " (ref only; not checked out)" : ""),
    );

    if (existsSync(row.worktree_path)) {
      this.archiveSpaceContext(id, row.worktree_path);
    }
    const worktreeRemoval = await removeWorktree(repoRoot, row.worktree_path, row.git_branch, {
      keepBranch: true,
    });
    this.logWorktreeRemoval(id, row.worktree_path, worktreeRemoval);

    this.db.updateSpaceMergeMetadata(id, mergeCommit, mergeMethod, Date.now(), targetBranch);
    this.emit("space:completed", id, row.project_directory, targetBranch, mergeMethod, mergeCommit);
    this.invalidateRepoStatus(repoRoot, merge.updatedCheckout, row.project_directory);

    return {
      targetBranch,
      mergeCommit,
      mergeMethod,
      updatedCheckout: merge.updatedCheckout,
      alreadyMerged: merge.status === "up_to_date",
      worktreeRemoval,
    };
  }

  /**
   * Mark a space as merged without performing the actual git merge.
   * For cases where the merge was done manually outside of Relay.
   * Cleans up worktree and archives context, then updates status to "completed".
   */
  async markSpaceMerged(id: string): Promise<{ targetBranch: string }> {
    const row = this.db.getSpace(id);
    if (!row) throw new Error(`Space ${id} not found`);
    if (row.is_default) throw new Error("Cannot mark the default space as merged");
    if (row.status === "completed") throw new Error("Space is already marked as merged");

    const repoRoot = row.project_directory ? getRepoRoot(row.project_directory) : null;
    const targetBranch = repoRoot ? await this.resolveTargetBranch(row, repoRoot) : "main";

    this.stopChatsInSpace(id);

    // Auto-commit dirty worktree before cleanup so work isn't lost
    if (
      row.worktree_path &&
      existsSync(row.worktree_path) &&
      (await isWorktreeDirty(row.worktree_path))
    ) {
      const commitResult = await commitAll(row.worktree_path, row.name || "Space work");
      if (!commitResult.success) {
        throw new Error(`Auto-commit failed: ${commitResult.error}`);
      }
    }

    // Archive the shared space context before removing the worktree
    if (row.worktree_path && existsSync(row.worktree_path)) {
      this.archiveSpaceContext(id, row.worktree_path);
    }

    // Cleanup worktree if it exists (keep local branch for recoverability)
    if (row.git_branch && row.worktree_path && repoRoot && existsSync(row.worktree_path)) {
      const removal = await removeWorktree(repoRoot, row.worktree_path, row.git_branch, {
        keepBranch: true,
      });
      this.logWorktreeRemoval(id, row.worktree_path, removal);
    }

    this.db.updateSpaceMergeMetadata(id, undefined, "external", Date.now(), targetBranch);
    this.logger.info(
      `[SpaceManager] Marked space "${row.name}" (${id}) as externally merged into ${targetBranch}`,
    );
    this.emit("space:completed", id, row.project_directory, targetBranch, "external", undefined);
    this.invalidateRepoStatus(repoRoot, row.project_directory);

    return { targetBranch };
  }

  /**
   * Archive a space without merging. Stops its chats and removes the worktree.
   */
  async deleteSpace(id: string): Promise<void> {
    const row = this.db.getSpace(id);
    if (!row) throw new Error(`Space ${id} not found`);
    if (row.is_default) throw new Error("Cannot delete the default space");

    this.stopChatsInSpace(id);

    // Archive the shared space context before removing the worktree
    if (row.worktree_path && existsSync(row.worktree_path)) {
      this.archiveSpaceContext(id, row.worktree_path);
    }

    // Cleanup worktree if it exists
    if (row.git_branch && row.worktree_path) {
      const repoRoot = getRepoRoot(row.project_directory);
      if (repoRoot && existsSync(row.worktree_path)) {
        const removal = await removeWorktree(repoRoot, row.worktree_path, row.git_branch);
        this.logWorktreeRemoval(id, row.worktree_path, removal);
      }
    }

    this.db.updateSpaceStatus(id, "archived");
    this.logger.info(`[SpaceManager] Archived space "${row.name}" (${id})`);
    this.emit("space:removed", id, row.project_directory);
  }

  /**
   * Unified diff of a space's worktree (committed + uncommitted + untracked)
   * against its target branch. Null only when the space doesn't exist; ""
   * when it has no worktree any more. Git failures throw `GitCommandError`.
   */
  async getSpaceDiff(id: string): Promise<string | null> {
    const row = this.db.getSpace(id);
    if (!row) return null;
    if (!row.git_branch) {
      throw new Error("The default space has no branch diff");
    }

    const worktreePath = this.getExistingWorktreePath(row.worktree_path);
    if (!worktreePath) {
      return "";
    }

    const repoRoot = getRepoRoot(row.project_directory);
    if (!repoRoot) {
      throw new GitCommandError({
        kind: "not_a_repo",
        operation: "git diff",
        cwd: row.project_directory,
        message: "git diff failed: project is not a git repository",
      });
    }

    const targetBranch = await this.resolveTargetBranch(row, repoRoot);
    // Diff from inside the worktree so we capture both committed and
    // uncommitted changes vs the target branch.
    return (await getWorktreeDiff(worktreePath, targetBranch, { throwOnError: true })) ?? "";
  }

  /**
   * Push a space's branch to the remote. Optionally open a PR via gh: an
   * already-open PR for the branch is reused (`prAction: "opened_existing"`)
   * rather than duplicated. The PR base is the space's target branch.
   */
  async pushSpace(id: string, opts?: { createPR?: boolean }): Promise<PushSpaceResult> {
    const row = this.db.getSpace(id);
    if (!row) throw new Error(`Space ${id} not found`);
    if (row.is_default) throw new Error("Cannot push the default space");
    if (!row.git_branch || !row.worktree_path) {
      throw new Error("Space has no worktree to push");
    }
    const branch = row.git_branch;
    const worktreePath = row.worktree_path;

    // Auto-commit if dirty
    if (existsSync(worktreePath) && (await isWorktreeDirty(worktreePath))) {
      const commitResult = await commitAll(worktreePath, row.name || "Space work");
      if (!commitResult.success) {
        throw new Error(`Auto-commit failed: ${commitResult.error}`);
      }
    }

    // Push with upstream tracking
    const pushResult = await gitPush(worktreePath, branch, true);
    if (!pushResult.success) {
      return {
        pushed: false,
        error: pushResult.error || "Push failed",
        errorKind: pushResult.errorKind,
      };
    }
    if (pushResult.pushed === false && !opts?.createPR) {
      return { pushed: false, error: pushResult.message || "Nothing to push" };
    }

    this.logger.info(`[SpaceManager] Pushed space "${row.name}" branch ${branch}`);
    this.invalidateRepoStatus(worktreePath);

    // Keep a known PR state; otherwise record the push.
    if (!row.remote_status?.startsWith("pr-")) {
      this.db.updateSpaceRemoteStatus(id, "pushed");
      this.emit("space:updated", this.toInfo(this.db.getSpace(id)!));
    }
    this.prStatusReader.invalidate(id);

    if (!opts?.createPR) {
      this.refreshPrStatusInBackground(id);
      return { pushed: true };
    }

    const gh = await checkGhAvailability(worktreePath);
    if (!gh.ok) {
      return gh.reason === "not_installed"
        ? {
            pushed: true,
            error: "gh CLI not found — branch pushed but PR not created",
            ghNotFound: true,
          }
        : { pushed: true, error: "gh CLI is not authenticated", ghNotAuthenticated: true };
    }

    const recordPr = (prUrl: string, prAction: "created" | "opened_existing"): PushSpaceResult => {
      this.db.updateSpaceRemoteStatus(id, "pr-open", prUrl);
      this.emit("space:updated", this.toInfo(this.db.getSpace(id)!));
      this.refreshPrStatusInBackground(id);
      return { pushed: true, prUrl, prAction };
    };

    try {
      const existing = await findOpenPullRequest(worktreePath, branch);
      if (existing) return recordPr(existing.url, "opened_existing");

      const repoRoot = getRepoRoot(row.project_directory);
      const base = repoRoot ? await this.resolveTargetBranch(row, repoRoot) : "main";
      const title = row.name || `Space ${row.id.slice(0, 8)}`;
      const body = await this.buildPrBody(worktreePath, base, branch, row.name);
      let prUrl: string | null;
      try {
        prUrl = await createPullRequest(worktreePath, { head: branch, base, title, body });
      } catch (err) {
        // Lost a race with another creator — reuse theirs.
        const raced = await findOpenPullRequest(worktreePath, branch).catch(() => null);
        if (raced) return recordPr(raced.url, "opened_existing");
        throw err;
      }
      if (!prUrl) {
        const created = await findOpenPullRequest(worktreePath, branch).catch(() => null);
        prUrl = created?.url ?? null;
      }
      if (!prUrl) return { pushed: true, error: "PR created, but gh did not report its URL" };
      return recordPr(prUrl, "created");
    } catch (err) {
      if (isGitCommandError(err) && err.kind === "auth") {
        return { pushed: true, error: "gh CLI is not authenticated", ghNotAuthenticated: true };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        pushed: true,
        error: `PR creation failed: ${msg}`,
        errorKind: isGitCommandError(err) ? err.kind : undefined,
      };
    }
  }

  /** PR body: the space's commits relative to the base branch. */
  private async buildPrBody(
    cwd: string,
    base: string,
    branch: string,
    spaceName: string,
  ): Promise<string> {
    let commits: string[] = [];
    try {
      const { stdout } = await runGit(
        ["log", "--no-merges", "--format=%s", "-n", "50", `${base}..${branch}`],
        { cwd, readOnly: true, timeoutMs: GIT_TIMEOUTS.normal, operation: "git log" },
      );
      commits = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      // base may not exist locally; the body is best-effort
    }
    const lines = [`Changes from the Relay space "${spaceName}".`];
    if (commits.length > 0) {
      lines.push("", "## Commits", "", ...commits.map((c) => `- ${c}`));
    }
    return `${lines.join("\n")}\n`;
  }

  private refreshPrStatusInBackground(id: string): void {
    void this.getSpacePrStatus(id, { force: true }).catch((err) => {
      this.logger.debug(`[SpaceManager] PR status refresh failed for ${id}: ${String(err)}`);
    });
  }

  /**
   * Current PR status for a space. Reads `gh pr view` for the persisted PR
   * URL, or for the pushed branch when no URL is known (detects PRs opened
   * outside Relay). Cached 60s; failures back off exponentially and return
   * the last persisted snapshot with `stale: true`. A merged PR is reported,
   * never auto-completed. Null when the space doesn't exist.
   */
  async getSpacePrStatus(
    id: string,
    opts?: { force?: boolean },
  ): Promise<SpacePrStatusResponse | null> {
    const row = this.db.getSpace(id);
    if (!row) return null;
    const persisted = parsePrStatus(row.pr_status_json);
    const ref = row.pr_url || (row.remote_status && row.git_branch ? row.git_branch : null);
    if (row.is_default || !ref) return { pr: persisted };

    const cwd =
      this.getExistingWorktreePath(row.worktree_path) ??
      getRepoRoot(row.project_directory) ??
      row.project_directory;
    if (!existsSync(cwd)) return { pr: persisted, stale: persisted != null };

    const result = await this.prStatusReader.get(id, cwd, ref, opts);
    if (!result.ok) {
      return { pr: persisted, stale: true, error: result.error, errorKind: result.errorKind };
    }
    const pr = result.pr;
    if (!pr) return { pr: persisted, stale: persisted != null };
    if (!result.cached) this.persistPrStatus(row, persisted, pr);
    return { pr };
  }

  private persistPrStatus(row: SpaceRow, previous: SpacePrStatus | null, pr: SpacePrStatus): void {
    const strip = (s: SpacePrStatus | null) => (s ? JSON.stringify({ ...s, fetchedAt: 0 }) : "");
    const remoteStatus = remoteStatusForPr(pr);
    const changed =
      strip(previous) !== strip(pr) || row.remote_status !== remoteStatus || row.pr_url !== pr.url;
    this.db.setSpacePrStatus(row.id, JSON.stringify(pr), remoteStatus, pr.url);
    if (changed) {
      if (pr.state === "merged" && previous?.state !== "merged") {
        this.logger.info(
          `[SpaceManager] PR for space "${row.name}" (${row.id}) was merged; the space stays active until completed or marked merged`,
        );
      }
      const updated = this.db.getSpace(row.id);
      if (updated) this.emit("space:updated", this.toInfo(updated));
    }
  }

  /**
   * Maintenance sweep of `<worktreeBase>/space-*` directories. Removes only
   * directories whose `.git` file points at a gitdir that no longer exists
   * (the repository or its worktree admin dir is gone), unless an active
   * space still references them. Valid worktrees that no space row references
   * are logged, never removed. Never looks outside the worktree base.
   */
  async sweepOrphanedWorktrees(): Promise<OrphanWorktreeSweepResult> {
    const result: OrphanWorktreeSweepResult = { removed: [], unreferenced: [], keptReferenced: [] };
    const base = resolve(getWorktreeBase());
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      return result;
    }

    const referenced = new Map<string, SpaceRow>();
    for (const row of this.db.getAllSpaces()) {
      if (!row.worktree_path) continue;
      referenced.set(resolve(row.worktree_path), row);
      try {
        referenced.set(realpathSync(row.worktree_path), row);
      } catch {
        // missing on disk
      }
    }

    let processed = 0;
    for (const entry of entries) {
      // Dirent.isDirectory() is false for symlinks, so links out of the base are skipped.
      if (!entry.isDirectory() || !entry.name.startsWith("space-")) continue;
      const dir = join(base, entry.name);
      let canonical = dir;
      try {
        canonical = realpathSync(dir);
      } catch {
        continue;
      }
      const owner = referenced.get(dir) ?? referenced.get(canonical);
      const pointer = inspectWorktreeGitPointer(dir);
      if (pointer.state === "dangling") {
        if (owner && owner.status === "active") {
          result.keptReferenced.push(dir);
          continue;
        }
        try {
          await rm(dir, { recursive: true, force: true });
          result.removed.push(dir);
        } catch (err) {
          this.logger.warn(
            `[SpaceManager] Could not remove orphaned worktree ${dir}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else if (pointer.state === "valid" && !owner) {
        result.unreferenced.push(dir);
      }
      // Yield regularly so a large backlog never stalls the event loop.
      if (++processed % 25 === 0) await new Promise((r) => setImmediate(r));
    }

    if (result.removed.length > 0) {
      this.logger.info(
        `[SpaceManager] Removed ${result.removed.length} orphaned space worktree dir(s) with a dangling gitdir under ${base}`,
      );
    }
    if (result.keptReferenced.length > 0) {
      this.logger.warn(
        `[SpaceManager] ${result.keptReferenced.length} active space worktree(s) have a dangling gitdir and were kept: ${result.keptReferenced.join(", ")}`,
      );
    }
    if (result.unreferenced.length > 0) {
      this.logger.info(
        `[SpaceManager] ${result.unreferenced.length} valid worktree(s) under ${base} are not tracked as spaces (left in place): ${result.unreferenced.slice(0, 10).join(", ")}${result.unreferenced.length > 10 ? ", ..." : ""}`,
      );
    }
    return result;
  }

  /**
   * Update space last activity timestamp.
   */
  touchSpace(id: string): void {
    this.db.updateSpaceActivity(id, Date.now());
  }

  /**
   * Read the shared space context file for a space.
   * Returns null if the file doesn't exist or the space has no worktree.
   */
  readSpaceContext(id: string): string | null {
    const row = this.db.getSpace(id);
    if (!row) return null;

    // For active spaces, read from worktree
    if (row.worktree_path && existsSync(row.worktree_path)) {
      const contextPath = join(row.worktree_path, ".relay", "space-context.md");
      try {
        return readFileSync(contextPath, "utf-8");
      } catch {
        return null;
      }
    }

    // For completed/archived spaces, try the archive location
    const archivePath = join(this.getArchiveDir(id), "space-context.md");
    try {
      return readFileSync(archivePath, "utf-8");
    } catch {
      return null;
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────

  /**
   * Seed `.relay/space-context.md` in the worktree with a template and optional description.
   */
  private seedSpaceContext(worktreePath: string, spaceName: string, description?: string): void {
    const relayDir = join(worktreePath, ".relay");
    try {
      mkdirSync(relayDir, { recursive: true });

      const sections: string[] = [];
      sections.push(`# ${spaceName}\n`);

      if (description?.trim()) {
        sections.push(`## Goal\n\n${description.trim()}\n`);
      } else {
        sections.push(`## Goal\n\n<!-- Describe what this space is for -->\n`);
      }

      sections.push(`## Decisions\n\n<!-- Record key decisions and their rationale -->\n`);
      sections.push(`## Status\n\n<!-- Track current status of work streams -->\n`);
      sections.push(
        `## Interfaces\n\n<!-- Document APIs, contracts, or interfaces other chats depend on -->\n`,
      );

      writeFileSync(join(relayDir, "space-context.md"), sections.join("\n"), "utf-8");
    } catch (err) {
      this.logger.warn(
        `[SpaceManager] Failed to seed space context: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Ignore ephemeral Relay metadata in the worktree without hiding durable
   * repo-local files like `.relay/tasks/` from git.
   */
  private excludeRelayDir(worktreePath: string): void {
    try {
      // In a worktree, .git is a file pointing to the main repo's .git/worktrees/<name>
      const gitDir = resolveGitDirs(worktreePath)?.gitDir;
      if (!gitDir) throw new Error(`Not a git worktree: ${worktreePath}`);

      const infoDir = join(gitDir, "info");
      mkdirSync(infoDir, { recursive: true });

      const excludePath = join(infoDir, "exclude");
      let content = "";
      try {
        content = readFileSync(excludePath, "utf-8");
      } catch {
        /* no existing exclude file */
      }

      const patterns = [".relay/space-context.md"];
      const missing = patterns.filter((pattern) => !content.includes(pattern));
      if (missing.length > 0) {
        const newLine = content.endsWith("\n") || content === "" ? "" : "\n";
        writeFileSync(excludePath, `${content}${newLine}${missing.join("\n")}\n`, "utf-8");
      }
    } catch (err) {
      this.logger.warn(
        `[SpaceManager] Failed to exclude Relay metadata from git: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Archive the space context file to the Relay data directory before worktree removal.
   */
  private archiveSpaceContext(spaceId: string, worktreePath: string): void {
    const contextPath = join(worktreePath, ".relay", "space-context.md");
    if (!existsSync(contextPath)) return;

    try {
      const archiveDir = this.getArchiveDir(spaceId);
      mkdirSync(archiveDir, { recursive: true });
      copyFileSync(contextPath, join(archiveDir, "space-context.md"));
      this.logger.info(`[SpaceManager] Archived space context for ${spaceId}`);
    } catch (err) {
      this.logger.warn(
        `[SpaceManager] Failed to archive space context: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private getArchiveDir(spaceId: string): string {
    return join(relayDir, "spaces", spaceId);
  }
}
