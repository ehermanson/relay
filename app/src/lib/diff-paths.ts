/**
 * A chat's file path as it appears in that chat's diff. Paths may be absolute
 * or relative to the chat's working directory; diff paths are relative to the
 * repo root the diff ran in, which differs for a repo subdirectory or a worktree
 * the agent entered. `diffRoots` is that one root in each spelling the path may
 * use. A file outside it keeps its absolute path, so it matches nothing rather
 * than the wrong file.
 */
export function toDiffPath(
  path: string,
  workingDirectory: string,
  diffRoots?: readonly string[],
): string {
  const absolute = path.startsWith("/") ? path : `${workingDirectory.replace(/\/$/, "")}/${path}`;
  const roots = diffRoots?.length ? diffRoots : [workingDirectory];
  for (const candidate of roots) {
    const root = candidate.replace(/\/$/, "");
    if (absolute.startsWith(`${root}/`)) return absolute.slice(root.length + 1);
  }
  return absolute;
}
