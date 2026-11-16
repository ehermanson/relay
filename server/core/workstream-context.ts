/**
 * What a chat in a directory-linked Workstream is told at session start: where
 * the effort's folder is, and the two files that say what the effort is and
 * where it stands. See `plans/workstreams.md`.
 *
 * The folder belongs to the user. Relay reads it and never writes to it; how
 * progress is recorded there is whatever the folder's own README says.
 */

import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProviderContextBlock, Workstream } from "#core/types.js";

export const WORKSTREAM_BLOCK_KIND = "relay_workstream";

/** Inline caps. Past them the agent gets the head of the file and its path. */
const README_LIMIT = 12_000;
const STATUS_LIMIT = 6_000;

/** True when `path` is a directory that exists right now. */
export function isUsableWorkstreamFolder(path: string | undefined): path is string {
  if (!path) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Find `README.md` / `readme` / `Status.md`… whatever case the folder uses. */
function findFile(names: string[], stem: string): string | undefined {
  const wanted = [`${stem}.md`, stem, `${stem}.markdown`, `${stem}.txt`];
  for (const candidate of wanted) {
    const match = names.find((name) => name.toLowerCase() === candidate);
    if (match) return match;
  }
  return undefined;
}

function readHead(path: string, limit: number): { text: string; truncated: boolean } | undefined {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    fd = openSync(path, "r");
    // A few spare bytes so a cut never lands inside a multi-byte character.
    const buffer = Buffer.alloc(Math.min(size, limit + 4));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    const truncated = size > limit;
    return { text: truncated ? text.slice(0, limit) : text, truncated };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function section(folder: string, file: string | undefined, limit: number): string | undefined {
  if (!file) return undefined;
  const path = join(folder, file);
  const head = readHead(path, limit);
  if (!head || !head.text.trim()) return undefined;
  const note = head.truncated ? `\n\n[Cut off here. The rest is in ${path}]` : "";
  return `### ${file}\n\n${head.text.trim()}${note}`;
}

/**
 * The bootstrap block for a chat in `workstream`, or undefined when it has no
 * usable folder. Read fresh at every session start, so a resumed chat sees the
 * current STATUS rather than the one from when it began.
 */
export function buildWorkstreamContextBlock(
  workstream: Workstream,
): ProviderContextBlock | undefined {
  const folder = workstream.folderPath;
  if (!isUsableWorkstreamFolder(folder)) return undefined;

  let names: string[] = [];
  try {
    names = readdirSync(folder);
  } catch {
    // Unreadable folder: the agent still learns where it is.
  }
  const readme = section(folder, findFile(names, "readme"), README_LIMIT);
  const status = section(folder, findFile(names, "status"), STATUS_LIMIT);

  const intro = [
    `This chat is part of the workstream "${workstream.name}", a long-running effort that spans many chats.`,
    `Its working folder is ${folder}. You can read and write files there; it is outside this chat's project directory and is not part of the repository.`,
    "The folder is the effort's shared memory. Read what you need from it before starting, and follow its README for how it is organised and how progress is recorded.",
    "Update its files when the state of the work changes in a way a later chat would need to know (a decision, a finished milestone, a changed plan) or when the user asks. Do not update them after every turn.",
    readme || status
      ? "Its README and STATUS as of the start of this session follow."
      : "It has no README or STATUS file yet.",
  ].join("\n");

  return {
    key: "relay-workstream",
    kind: WORKSTREAM_BLOCK_KIND,
    title: `Workstream: ${workstream.name}`,
    source: folder,
    text: [intro, readme, status].filter(Boolean).join("\n\n"),
  };
}
