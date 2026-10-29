import { existsSync, realpathSync } from "fs";
import {
  isGitWorktree,
  isRelayWorktreePath,
  resolveAnyWorktreeOrigin,
  resolveWorktreeOrigin,
} from "#core/git.js";

export function normalizeProjectDirectory(directory: string): string {
  if (isRelayWorktreePath(directory)) {
    return resolveWorktreeOrigin(directory) ?? directory;
  }
  if (isGitWorktree(directory)) {
    return resolveAnyWorktreeOrigin(directory) ?? directory;
  }
  return directory;
}

export function getProjectDirectoryCandidates(directory: string | null | undefined): string[] {
  if (!directory) return [];

  const candidates = new Set<string>();
  const push = (value: string | null | undefined) => {
    if (!value) return;
    candidates.add(value);
    candidates.add(normalizeProjectDirectory(value));
    if (existsSync(value)) {
      try {
        candidates.add(realpathSync(value));
      } catch {
        // best-effort canonicalization only
      }
    }
  };

  push(directory);
  return [...candidates];
}

export function getPersistenceRowProjectDirectory(row: {
  original_directory?: string | null;
  working_directory: string;
}): string {
  return normalizeProjectDirectory(row.original_directory ?? row.working_directory);
}

export function buildPersistenceOwnershipReconciliation(options: {
  workingDirectory: string;
  originalDirectory?: string | null;
  infoOriginalDirectory?: string | null;
  infoProjectId?: string | null;
  projectId?: string | null;
}): {
  projectDirectory: string;
  nextInfoProjectId?: string;
} {
  const projectDirectory = getPersistenceRowProjectDirectory({
    original_directory: options.originalDirectory ?? options.infoOriginalDirectory,
    working_directory: options.workingDirectory,
  });
  if (options.projectId && options.infoProjectId !== options.projectId) {
    return { projectDirectory, nextInfoProjectId: options.projectId };
  }
  return { projectDirectory };
}
