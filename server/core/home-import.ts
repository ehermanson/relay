import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionDB } from "#core/db.js";
import type { Logger } from "#core/logger.js";

export interface HomeImportResult {
  projects: number;
  chats: number;
  /** The copy of the target database taken before anything was merged. */
  backupPath: string;
}

/**
 * Merge the Relay state of another home into a database: used when the desktop
 * app moves from its own separate data to the home the CLI uses. The caller
 * must hold the server state lock of both homes — neither may have a server
 * running. The source is left exactly as it was.
 *
 * The target is backed up first. Nothing already in it is overwritten (see
 * `SessionDB.importFromDatabase`). Pages agents rendered into the imported
 * chats are files next to the database, so they are copied too.
 */
export function importRelayHome(options: {
  fromDbPath: string;
  toDbPath: string;
  logger: Logger;
  now?: number;
}): HomeImportResult {
  const { fromDbPath, toDbPath, logger } = options;
  if (!existsSync(fromDbPath)) throw new Error("There is no data to import");
  const db = new SessionDB(toDbPath, logger);
  try {
    const backupPath = `${toDbPath}.pre-import.${options.now ?? Date.now()}`;
    db.backupTo(backupPath);
    const merged = db.importFromDatabase(fromDbPath);
    const fromRenders = join(dirname(fromDbPath), "html-renders");
    const toRenders = join(dirname(toDbPath), "html-renders");
    for (const id of merged.instanceIds) {
      const source = join(fromRenders, id);
      if (!existsSync(source)) continue;
      try {
        cpSync(source, join(toRenders, id), { recursive: true, force: false, errorOnExist: false });
      } catch (error) {
        logger.warn(
          `[HomeImport] Could not copy rendered pages of ${id}: ${(error as Error).message}`,
        );
      }
    }
    logger.info(`[HomeImport] Imported ${merged.projects} project(s) and ${merged.chats} chat(s)`);
    return { projects: merged.projects, chats: merged.chats, backupPath };
  } finally {
    db.close();
  }
}
