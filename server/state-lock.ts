import { mkdirSync, realpathSync, openSync, closeSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Relay's persisted bindings require one server writer, even though its main SQLite DB supports sharing. */
export function acquireServerStateLock(dbPath: string): () => void {
  // SQLite memory databases are private to each connection and have no shared
  // state file to protect. Preserve library/test use without writing to CWD.
  if (dbPath === ":memory:") return () => {};
  const database = resolve(dbPath);
  mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  let canonical: string;
  try {
    canonical = realpathSync(database);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    canonical = join(realpathSync(dirname(database)), basename(database));
  }
  const file = `${canonical}.relay-lock.sqlite`;
  try {
    closeSync(openSync(file, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const lock = new DatabaseSync(file);
  try {
    // SQLite delegates ownership to the OS. A crash releases the lease without
    // PID reuse or stale-file reclamation races. Never unlink this stable inode.
    lock.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    if ((error as { errcode?: number }).errcode === 5) {
      throw new Error(
        "Another Relay server already owns this state directory. Attach to it or use a separate RELAY_HOME.",
      );
    }
    throw error;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off("exit", release);
    lock.close();
  };
  process.once("exit", release);
  return release;
}
