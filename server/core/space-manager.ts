/**
 * SpaceManager — Space lifecycle management for Relay
 *
 * A Space groups multiple concurrent agent chats within a shared git worktree/branch.
 * Every project has an implicit "main" space (no worktree, default branch).
 * Additional spaces create dedicated worktrees for isolation.
 */

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, realpathSync } from "fs";
import { execSync, execFileSync } from "child_process";
import { basename, join } from "path";
import { EventEmitter } from "events";

import type { SessionDB } from "#core/db.js";
import { relayDir } from "#core/config.js";
import type { SpaceRow } from "#core/db.js";
import type { Logger } from "#core/logger.js";
import type { SpaceInfo, SpaceStatus, MergeMethod } from "#core/types.js";
import type { SpaceOwnershipCandidate } from "#core/instance-restore.js";
import {
  isGitRepo,
  getRepoRoot,
  getDefaultBranch,
  getCurrentBranch,
  removeWorktree,
  isWorktreeDirty,
  commitAll,
  mergeWorktreeBranch,
  squashMergeBranch,
  getWorktreeDiff,
  gitPush,
  getWorktreeBase,
  resolveWorktreeOrigin,
  listWorktrees,
  type WorktreeEntry,
} from "#core/git.js";

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

  constructor(db: SessionDB, logger: Logger) {
    super();
    this.db = db;
    this.logger = logger;
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

  private inferRecoveredSpaceStatus(row: {
    project_directory: string;
    git_branch: string | null;
    worktree_path: string | null;
    git_info_branch: string | null;
    last_activity_at: number;
  }): Pick<SpaceRow, "status" | "worktree_path" | "merged_at" | "target_branch"> {
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
    if (!repoRoot || !row.git_branch) {
      return {
        status: "active",
        worktree_path: null,
        merged_at: null,
        target_branch: null,
      };
    }

    const targetBranch = getDefaultBranch(repoRoot) || getCurrentBranch(repoRoot);
    if (!targetBranch || targetBranch === row.git_branch) {
      return {
        status: "active",
        worktree_path: null,
        merged_at: null,
        target_branch: null,
      };
    }

    try {
      execFileSync("git", ["merge-base", "--is-ancestor", row.git_branch, targetBranch], {
        cwd: repoRoot,
        stdio: "pipe",
        timeout: 5000,
      });
      return {
        status: "completed",
        worktree_path: null,
        merged_at: row.last_activity_at,
        target_branch: targetBranch,
      };
    } catch {
      return {
        status: "active",
        worktree_path: null,
        merged_at: null,
        target_branch: null,
      };
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
  createSpace(
    projectDirectory: string,
    opts?: { name?: string; baseBranch?: string; description?: string },
  ): SpaceInfo {
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

    try {
      const baseBranch =
        opts?.baseBranch || getDefaultBranch(repoRoot) || getCurrentBranch(repoRoot) || "HEAD";
      execFileSync("git", ["worktree", "add", "-b", branchName, worktreePath, baseBranch], {
        cwd: repoRoot,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
      });
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
    };

    try {
      // Seed the shared space context file
      this.seedSpaceContext(worktreePath, spaceName, opts?.description);

      // Exclude .relay/ from git in the worktree
      this.excludeRelayDir(worktreePath);

      this.db.upsertSpace(row);
    } catch (err) {
      try {
        removeWorktree(repoRoot, worktreePath, branchName);
      } catch (cleanupErr) {
        this.logger.warn(
          `[SpaceManager] Failed to clean up worktree after createSpace error: ${
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          }`,
        );
      }
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
  listConvertibleWorktrees(projectDirectory: string): WorktreeEntry[] {
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

    return listWorktrees(repoRoot).filter((w) => {
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
  convertWorktreeToSpace(
    projectDirectory: string,
    worktreePath: string,
    opts?: { name?: string; description?: string },
  ): SpaceInfo {
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
    const worktrees = listWorktrees(repoRoot);
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

    for (const { row, sessionIds, managedInstanceIds } of recoveredSpaces.values()) {
      const matching =
        this.db.getSpace(row.id) ?? this.findMatchingSpaceRow(existingSpaces.values(), row);
      const linkedSpaceId = matching?.id ?? row.id;
      const recoveredMeta = this.inferRecoveredSpaceStatus(row);
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
   * Complete a space: auto-commit, merge branch into default, archive, cleanup worktree.
   */
  completeSpace(
    id: string,
    opts?: { mergeMethod?: MergeMethod; squashMessage?: string },
  ): { targetBranch: string; mergeCommit?: string; mergeMethod: MergeMethod } {
    const row = this.db.getSpace(id);
    if (!row) throw new Error(`Space ${id} not found`);
    if (row.is_default) throw new Error("Cannot complete the default space");
    if (!row.git_branch || !row.worktree_path) {
      throw new Error("Space has no worktree to complete");
    }
    if (!existsSync(row.worktree_path) || !isGitRepo(row.worktree_path)) {
      throw new Error("Space has no worktree to complete");
    }

    const repoRoot = getRepoRoot(row.project_directory);
    if (!repoRoot) throw new Error("Cannot determine git repository root");

    // Pre-check: refuse to merge if the main worktree has uncommitted changes
    if (isWorktreeDirty(repoRoot)) {
      throw new Error(
        "Your main workspace has uncommitted changes. Commit or stash them before completing this space.",
      );
    }

    // Auto-commit if dirty
    if (existsSync(row.worktree_path) && isWorktreeDirty(row.worktree_path)) {
      const commitResult = commitAll(row.worktree_path, row.name || "Space work");
      if (!commitResult.success) {
        throw new Error(`Auto-commit failed: ${commitResult.error}`);
      }
    }

    const mergeMethod: MergeMethod = opts?.mergeMethod || "squash";
    if (mergeMethod !== "squash" && mergeMethod !== "merge-commit") {
      throw new Error(`Unsupported merge method: ${mergeMethod}`);
    }

    // Record the actual branch that will receive the merge — this is the
    // branch currently checked out in the main worktree, not the heuristic
    // "default branch". The merge helpers operate on the checked-out branch,
    // so this must match what we persist and display.
    const currentBranch = getCurrentBranch(repoRoot);
    const targetBranch = currentBranch || getDefaultBranch(repoRoot) || "main";

    // Execute the merge using the selected strategy
    let mergeResult: { success: true } | { success: false; error: string };

    switch (mergeMethod) {
      case "squash": {
        const message = opts?.squashMessage || `Space: ${row.name}`;
        mergeResult = squashMergeBranch(repoRoot, row.git_branch, message);
        break;
      }
      case "merge-commit":
        mergeResult = mergeWorktreeBranch(repoRoot, row.git_branch);
        break;
    }

    if (!mergeResult.success) {
      if (mergeResult.error === "CONFLICT") {
        const methodHint =
          mergeMethod === "squash"
            ? `Squash merge has conflicts — the space and main workspace have overlapping changes.\n\nTo resolve, run:\n  cd ${row.worktree_path}\n  git rebase ${targetBranch}\n\nFix any conflicts, then try completing the space again.`
            : `Merge conflicts — the space and main workspace have overlapping changes.\n\nTo resolve, run:\n  cd ${row.worktree_path}\n  git rebase ${targetBranch}\n\nFix any conflicts, then try completing the space again.`;
        throw new Error(methodHint);
      }
      throw new Error(`Merge failed: ${mergeResult.error}`);
    }

    // Capture the merge commit hash
    let mergeCommit: string | undefined;
    try {
      mergeCommit = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
    } catch {
      // non-critical
    }

    this.logger.info(
      `[SpaceManager] Merged space "${row.name}" (${row.git_branch}) into ${targetBranch} via ${mergeMethod}`,
    );

    // Archive the shared space context before removing the worktree
    if (existsSync(row.worktree_path)) {
      this.archiveSpaceContext(id, row.worktree_path);
    }

    // Cleanup worktree (keep local branch for recoverability)
    if (existsSync(row.worktree_path)) {
      removeWorktree(repoRoot, row.worktree_path, row.git_branch, { keepBranch: true });
    }

    // Store merge metadata
    this.db.updateSpaceMergeMetadata(id, mergeCommit, mergeMethod, Date.now(), targetBranch);
    this.emit("space:completed", id, row.project_directory, targetBranch, mergeMethod, mergeCommit);

    return { targetBranch, mergeCommit, mergeMethod };
  }

  /**
   * Mark a space as merged without performing the actual git merge.
   * For cases where the merge was done manually outside of Relay.
   * Cleans up worktree and archives context, then updates status to "completed".
   */
  markSpaceMerged(id: string): { targetBranch: string } {
    const row = this.db.getSpace(id);
    if (!row) throw new Error(`Space ${id} not found`);
    if (row.is_default) throw new Error("Cannot mark the default space as merged");
    if (row.status === "completed") throw new Error("Space is already marked as merged");

    const repoRoot = row.project_directory ? getRepoRoot(row.project_directory) : null;
    const targetBranch =
      (repoRoot ? getCurrentBranch(repoRoot) : null) ||
      (repoRoot ? getDefaultBranch(repoRoot) : null) ||
      "main";

    // Auto-commit dirty worktree before cleanup so work isn't lost
    if (row.worktree_path && existsSync(row.worktree_path) && isWorktreeDirty(row.worktree_path)) {
      const commitResult = commitAll(row.worktree_path, row.name || "Space work");
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
      removeWorktree(repoRoot, row.worktree_path, row.git_branch, { keepBranch: true });
    }

    this.db.updateSpaceMergeMetadata(id, undefined, "external", Date.now(), targetBranch);
    this.logger.info(
      `[SpaceManager] Marked space "${row.name}" (${id}) as externally merged into ${targetBranch}`,
    );
    this.emit("space:completed", id, row.project_directory, targetBranch, "external", undefined);

    return { targetBranch };
  }

  /**
   * Delete/archive a space without merging. Cleans up the worktree.
   */
  deleteSpace(id: string): void {
    const row = this.db.getSpace(id);
    if (!row) throw new Error(`Space ${id} not found`);
    if (row.is_default) throw new Error("Cannot delete the default space");

    // Archive the shared space context before removing the worktree
    if (row.worktree_path && existsSync(row.worktree_path)) {
      this.archiveSpaceContext(id, row.worktree_path);
    }

    // Cleanup worktree if it exists
    if (row.git_branch && row.worktree_path) {
      const repoRoot = getRepoRoot(row.project_directory);
      if (repoRoot && existsSync(row.worktree_path)) {
        removeWorktree(repoRoot, row.worktree_path, row.git_branch);
      }
    }

    this.db.updateSpaceStatus(id, "archived");
    this.logger.info(`[SpaceManager] Archived space "${row.name}" (${id})`);
    this.emit("space:removed", id, row.project_directory);
  }

  /**
   * Get the unified diff for a space's branch vs the repo default branch.
   */
  getSpaceDiff(id: string): string | null {
    const row = this.db.getSpace(id);
    if (!row || !row.git_branch) return null;

    const worktreePath = this.getExistingWorktreePath(row.worktree_path);
    if (!worktreePath) {
      return "";
    }

    const repoRoot = getRepoRoot(row.project_directory);
    if (!repoRoot) return null;

    const defaultBranch = getDefaultBranch(repoRoot) || getCurrentBranch(repoRoot) || "main";

    // Diff from inside the worktree so we capture both committed and
    // uncommitted changes vs the base branch.
    return getWorktreeDiff(worktreePath, defaultBranch);
  }

  /**
   * Push a space's branch to the remote. Optionally create a PR via gh CLI.
   */
  async pushSpace(
    id: string,
    opts?: { createPR?: boolean },
  ): Promise<{
    pushed: boolean;
    prUrl?: string;
    error?: string;
    ghNotFound?: boolean;
    ghNotAuthenticated?: boolean;
  }> {
    const row = this.db.getSpace(id);
    if (!row) throw new Error(`Space ${id} not found`);
    if (row.is_default) throw new Error("Cannot push the default space");
    if (!row.git_branch || !row.worktree_path) {
      throw new Error("Space has no worktree to push");
    }

    // Auto-commit if dirty
    if (existsSync(row.worktree_path) && isWorktreeDirty(row.worktree_path)) {
      const commitResult = commitAll(row.worktree_path, row.name || "Space work");
      if (!commitResult.success) {
        throw new Error(`Auto-commit failed: ${commitResult.error}`);
      }
    }

    // Push with upstream tracking
    const pushResult = await gitPush(row.worktree_path, row.git_branch, true);
    if (!pushResult.success) {
      return { pushed: false, error: pushResult.error || "Push failed" };
    }
    if (pushResult.pushed === false && !opts?.createPR) {
      return { pushed: false, error: pushResult.message || "Nothing to push" };
    }

    this.logger.info(`[SpaceManager] Pushed space "${row.name}" branch ${row.git_branch}`);

    // Persist remote status
    this.db.updateSpaceRemoteStatus(id, "pushed");
    this.emit("space:updated", this.toInfo(this.db.getSpace(id)!));

    // Optionally create PR via gh CLI
    if (opts?.createPR) {
      // Check if gh is available
      try {
        execFileSync("which", ["gh"], { stdio: "pipe", timeout: 3000 });
      } catch {
        return {
          pushed: true,
          error: "gh CLI not found — branch pushed but PR not created",
          ghNotFound: true,
        };
      }

      try {
        const repoRoot = getRepoRoot(row.project_directory);
        const defaultBranch = (repoRoot ? getDefaultBranch(repoRoot) : null) || "main";
        const title = row.name || `Space ${row.id.slice(0, 8)}`;

        const prOutput = execFileSync(
          "gh",
          [
            "pr",
            "create",
            "--head",
            row.git_branch,
            "--base",
            defaultBranch,
            "--title",
            title,
            "--fill",
          ],
          {
            cwd: row.worktree_path,
            encoding: "utf8",
            timeout: 30000,
            stdio: ["pipe", "pipe", "pipe"],
          },
        ).trim();

        // gh pr create outputs the PR URL on success
        const prUrl = prOutput.match(/https?:\/\/\S+/)?.[0];
        this.db.updateSpaceRemoteStatus(id, "pr-open", prUrl);
        this.emit("space:updated", this.toInfo(this.db.getSpace(id)!));
        return { pushed: true, prUrl };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("gh auth login") || msg.includes("GH_TOKEN")) {
          return { pushed: true, error: "gh CLI is not authenticated", ghNotAuthenticated: true };
        }
        return { pushed: true, error: `PR creation failed: ${msg}` };
      }
    }

    return { pushed: true };
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
      // Use git rev-parse to find the actual git dir
      const gitDir = execSync("git rev-parse --git-dir", {
        cwd: worktreePath,
        encoding: "utf8",
        timeout: 5000,
      }).trim();

      const infoDir = join(worktreePath, gitDir, "info");
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
