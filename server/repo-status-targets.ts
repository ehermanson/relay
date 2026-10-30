/**
 * Resolve a repo-status subscription target (instance / project) to
 * the worktree directory the status service should watch.
 */
import type { InstanceManager } from "#core/instance-manager.js";
import type { RepoStatusTarget } from "#core/types.js";

export function repoStatusTargetKey(target: RepoStatusTarget): string {
  switch (target.kind) {
    case "instance":
      return `instance:${target.instanceId}`;
    case "project":
      return `project:${target.projectId}`;
  }
}

export function isRepoStatusTarget(value: unknown): value is RepoStatusTarget {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return (
    (t.kind === "instance" && typeof t.instanceId === "string" && !!t.instanceId) ||
    (t.kind === "project" && typeof t.projectId === "string" && !!t.projectId)
  );
}

/** Worktree directory for a target, or null when it no longer exists. */
export function resolveRepoStatusDir(
  instanceManager: InstanceManager,
  target: RepoStatusTarget,
): string | null {
  switch (target.kind) {
    case "instance":
      // Follows the worktree the chat's agent moved into, like its branch label.
      return instanceManager.getGitDirectory(target.instanceId);
    case "project": {
      const project = instanceManager.projectManager.getProject(target.projectId);
      return project ? project.repoRoot || project.directory : null;
    }
  }
}
