import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { ProviderKind } from "#core/types.js";

const MAX_BYTES = 1024 * 1024;
const cache = new Map<string, { mtimeMs: number; size: number; model?: string }>();

/** Read only the transcript head for a model; never parse a child's full conversation. */
export function readAgentModelFromTranscript(
  path: string,
  provider: ProviderKind,
): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    const key = `${provider}\0${path}`;
    const cached = cache.get(key);
    if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.model;
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, length);
    const lines = text.split("\n");
    if (length < stat.size) lines.pop(); // Never parse a truncated last line.
    let model: string | undefined;
    for (const line of lines) {
      if (!line.includes('"model"')) continue;
      try {
        const entry = JSON.parse(line);
        const candidate =
          provider === "codex"
            ? entry.type === "turn_context" || entry.type === "session_meta"
              ? entry.payload?.model
              : undefined
            : entry.type === "assistant"
              ? entry.message?.model
              : undefined;
        if (typeof candidate === "string" && candidate.trim() && candidate !== "<synthetic>") {
          model = candidate;
          break;
        }
      } catch {
        /* Partial or malformed JSONL entries supply no metadata. */
      }
    }
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, model });
    return model;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
