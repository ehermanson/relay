import { mkdir, readFile, writeFile, rename, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** EPERM means the recorded PID was reused by another user's process: the
 * signal probe cannot reach it, but it exists, so the lock reads as held. */
export function lockOwnerAlive(pid, signal = (value) => process.kill(value, 0)) {
  try {
    signal(pid);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

/** One desktop backend may write a home, even across Electron profiles. */
export async function acquireStateLock(home) {
  const directory = join(await realpath(home), "desktop-backend.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, "owner.json"), JSON.stringify({ pid: process.pid, token }), {
        mode: 0o600,
        flag: "wx",
      });
      return async () => {
        try {
          const owner = JSON.parse(await readFile(join(directory, "owner.json"), "utf8"));
          if (owner.token === token) await rm(directory, { recursive: true, force: true });
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(await readFile(join(directory, "owner.json"), "utf8"));
      } catch {
        throw new Error("Another Relay backend is initializing this desktop home");
      }
      if (!Number.isInteger(owner.pid) || owner.pid < 1)
        throw new Error("Desktop state lock is invalid; inspect its owner file");
      if (lockOwnerAlive(owner.pid))
        throw new Error("Another Relay backend is already using this desktop home");
      const stale = `${directory}.stale-${token}`;
      try {
        await rename(directory, stale);
      } catch (renameError) {
        if (renameError.code === "ENOENT") continue;
        throw renameError;
      }
      await rm(stale, { recursive: true, force: true });
    }
  }
  throw new Error("Desktop state ownership changed during startup; retry launching Relay");
}
