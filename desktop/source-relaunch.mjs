import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
/** Resolve the newly installed Electron binary after a source upgrade. */
export async function sourceRelaunchExecutable(root) {
  const base = resolve(root, "node_modules/electron/dist");
  const installed = (await readFile(join(root, "node_modules/electron/path.txt"), "utf8")).trim();
  const executable = resolve(base, installed);
  if (!executable.startsWith(base + sep) || !(await stat(executable)).isFile())
    throw new Error("Updated Electron executable is unavailable");
  return executable;
}
