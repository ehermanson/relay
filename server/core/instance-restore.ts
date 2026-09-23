import { realpathSync } from "node:fs";
import { isRelayWorktreePath, resolveWorktreeOrigin } from "#core/git.js";
import type { SpaceInfo } from "#core/types.js";

export interface PersistenceOwnershipRow {
  space_id: string | null;
  worktree_path: string | null;
  git_branch: string | null;
  original_directory?: string | null;
  working_directory: string;
}

export interface RestorePaths {
  workingDirectory: string;
  worktreePath?: string;
  originalDirectory?: string;
  actualCwd?: string;
  gitBranch?: string;
  repairedStaleWorktree: boolean;
}

function normalizeProjectDirectory(directory: string): string {
  if (isRelayWorktreePath(directory)) {
    return resolveWorktreeOrigin(directory) ?? directory;
  }
  return directory;
}

function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function worktreePathsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return canonicalizePath(a) === canonicalizePath(b);
}

/** The space fields ownership inference reads; full `SpaceInfo` satisfies it. */
export type SpaceOwnershipCandidate = Pick<
  SpaceInfo,
  "id" | "projectDirectory" | "gitBranch" | "worktreePath" | "missingWorktreePath" | "isDefault"
>;

export function inferSpaceIdForPersistenceRow(
  row: PersistenceOwnershipRow,
  spaces: SpaceOwnershipCandidate[],
): string | undefined {
  if (row.space_id) return row.space_id;

  const worktreeMatch = row.worktree_path
    ? spaces.find(
        (space) =>
          worktreePathsMatch(space.worktreePath, row.worktree_path) ||
          worktreePathsMatch(space.missingWorktreePath, row.worktree_path),
      )
    : undefined;
  if (worktreeMatch) return worktreeMatch.id;

  const projectDirectory = normalizeProjectDirectory(
    row.original_directory ?? row.working_directory,
  );
  const branchMatch =
    row.git_branch && projectDirectory
      ? spaces.find(
          (space) =>
            space.projectDirectory === projectDirectory &&
            space.gitBranch === row.git_branch &&
            !space.isDefault,
        )
      : undefined;
  return branchMatch?.id;
}

export function explicitOrInferredSpaceIdForPersistenceRow(
  row: PersistenceOwnershipRow,
  spaces: SpaceOwnershipCandidate[],
): string | undefined {
  return row.space_id ?? inferSpaceIdForPersistenceRow(row, spaces);
}

export function resolveExternalRestorePaths(options: {
  row: PersistenceOwnershipRow;
  hasExplicitSpaceOwnership: boolean;
  usableStoredWorktreePath: boolean;
}): RestorePaths {
  const { row, hasExplicitSpaceOwnership, usableStoredWorktreePath } = options;
  const originalDirectory = row.original_directory ?? undefined;
  const gitBranch = row.git_branch ?? undefined;

  if (row.worktree_path && originalDirectory && !usableStoredWorktreePath) {
    if (hasExplicitSpaceOwnership) {
      return {
        workingDirectory: row.worktree_path,
        originalDirectory,
        gitBranch,
        repairedStaleWorktree: false,
      };
    }

    return {
      workingDirectory: originalDirectory,
      originalDirectory,
      gitBranch,
      repairedStaleWorktree: true,
    };
  }

  return {
    workingDirectory: row.working_directory,
    worktreePath: row.worktree_path ?? undefined,
    originalDirectory,
    actualCwd: row.worktree_path ?? undefined,
    gitBranch,
    repairedStaleWorktree: false,
  };
}

export function resolveManagedRestorePaths(options: {
  row: PersistenceOwnershipRow;
  hasExplicitSpaceOwnership: boolean;
  usableStoredWorktreePath: boolean;
}): RestorePaths {
  const { row, hasExplicitSpaceOwnership, usableStoredWorktreePath } = options;
  const originalDirectory = row.original_directory ?? undefined;
  const gitBranch = row.git_branch ?? undefined;

  if (row.worktree_path && originalDirectory) {
    if (usableStoredWorktreePath) {
      return {
        workingDirectory: row.worktree_path,
        worktreePath: row.worktree_path,
        originalDirectory,
        actualCwd: row.worktree_path,
        gitBranch,
        repairedStaleWorktree: false,
      };
    }

    if (hasExplicitSpaceOwnership) {
      return {
        workingDirectory: row.worktree_path,
        originalDirectory,
        gitBranch,
        repairedStaleWorktree: false,
      };
    }

    return {
      workingDirectory: originalDirectory,
      originalDirectory,
      gitBranch,
      repairedStaleWorktree: true,
    };
  }

  return {
    workingDirectory: row.working_directory,
    repairedStaleWorktree: false,
  };
}
