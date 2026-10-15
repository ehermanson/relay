import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const READ_CHUNK_BYTES = 64 * 1024;

/** A stable file descriptor/length for one replay, including multi-pass Claude replay. */
export class TranscriptReader {
  private fd: number | undefined;
  private readonly size: number;

  constructor(path: string) {
    this.fd = openSync(path, "r");
    try {
      this.size = fstatSync(this.fd).size;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /**
   * Decode at most one chunk plus the current record, never the complete file.
   * StringDecoder preserves UTF-8 code points crossing a chunk boundary. Records
   * can exceed the chunk size; a final record need not end in a newline.
   */
  *lines(): Generator<string> {
    if (this.fd === undefined) throw new Error("Transcript reader is closed");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    let position = 0;
    let fragments: string[] = [];
    while (position < this.size) {
      const count = readSync(
        this.fd,
        buffer,
        0,
        Math.min(buffer.length, this.size - position),
        position,
      );
      if (count === 0) break;
      position += count;
      const chunk = decoder.write(buffer.subarray(0, count));
      let start = 0;
      for (let end = chunk.indexOf("\n"); end !== -1; end = chunk.indexOf("\n", start)) {
        const line = chunk.slice(start, end);
        if (fragments.length) {
          fragments.push(line);
          yield fragments.join("");
          fragments = [];
        } else yield line;
        start = end + 1;
      }
      if (start < chunk.length) fragments.push(chunk.slice(start));
    }
    const final = decoder.end();
    if (final) fragments.push(final);
    if (fragments.length) yield fragments.join("");
  }

  close(): void {
    if (this.fd === undefined) return;
    const fd = this.fd;
    this.fd = undefined;
    closeSync(fd);
  }
}

/** Single-pass convenience wrapper; early iterator return also closes the descriptor. */
export function* readTranscriptLines(path: string): Generator<string> {
  const reader = new TranscriptReader(path);
  try {
    yield* reader.lines();
  } finally {
    reader.close();
  }
}

/** Read metadata without loading the rest of a potentially large rollout. */
export function readTranscriptFirstLine(path: string): string | undefined {
  for (const line of readTranscriptLines(path)) return line;
  return undefined;
}

/** Retain the existing replay tail while still folding state from every record. */
export class TranscriptHistory<T> {
  private readonly entries: T[] = [];
  private next = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid history capacity");
    this.capacity = capacity;
  }

  append(entries: readonly T[]): void {
    for (const entry of entries) {
      if (this.entries.length < this.capacity) this.entries.push(entry);
      else {
        this.entries[this.next] = entry;
        this.next = (this.next + 1) % this.capacity;
      }
    }
  }

  toArray(): T[] {
    return this.next === 0
      ? this.entries.slice()
      : this.entries.slice(this.next).concat(this.entries.slice(0, this.next));
  }
}
