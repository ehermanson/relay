export interface PersistenceOwnershipRow {
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
}

// A recorded worktree is restored as recorded even when it is missing on
// disk: never moved into the main checkout (another branch), and never
// dropped, so the next save keeps the metadata and a remounted volume brings
// the chat back intact. Existence is checked at use time — a chat whose
// directory is gone is read-only (`ChatReadOnlyError`).

export function resolveExternalRestorePaths(row: PersistenceOwnershipRow): RestorePaths {
  return {
    workingDirectory: row.working_directory,
    worktreePath: row.worktree_path ?? undefined,
    originalDirectory: row.original_directory ?? undefined,
    actualCwd: row.worktree_path ?? undefined,
    gitBranch: row.git_branch ?? undefined,
  };
}

export function resolveManagedRestorePaths(row: PersistenceOwnershipRow): RestorePaths {
  if (row.worktree_path && row.original_directory) {
    return {
      workingDirectory: row.worktree_path,
      worktreePath: row.worktree_path,
      originalDirectory: row.original_directory,
      actualCwd: row.worktree_path,
      gitBranch: row.git_branch ?? undefined,
    };
  }
  return { workingDirectory: row.working_directory };
}
