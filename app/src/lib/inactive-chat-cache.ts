/** Estimate retained transcript payload without allocating a serialized copy.
 * Objects shared between replay and rendered state are counted once. Strings
 * use UTF-16 upper-bound storage, so the budget remains conservative for V8's
 * one-byte strings. This is a cache policy estimate, not a heap measurement. */
export function estimateRetainedBytes(values: unknown[], maxBytes = Infinity): number {
  const seen = new WeakSet<object>();
  // Iterator frames visit children lazily: an oversized transcript stops at
  // the threshold without copying its arrays or walking the remaining graph.
  const pending: Iterator<unknown>[] = [values.values()];
  let bytes = 0;
  while (pending.length) {
    const next = pending[pending.length - 1].next();
    if (next.done) {
      pending.pop();
      continue;
    }
    const value = next.value;
    if (typeof value === "string") bytes += value.length * 2;
    else if (typeof value === "number") bytes += 8;
    else if (typeof value === "boolean") bytes += 4;
    else if (value && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      bytes += 32;
      if (bytes > maxBytes) return bytes;
      pending.push(retainedChildren(value));
    }
    if (bytes > maxBytes) return bytes;
  }
  return bytes;
}

function* retainedChildren(value: object): Generator<unknown> {
  if (value instanceof Map) {
    for (const [key, child] of value) {
      yield key;
      yield child;
    }
  } else if (value instanceof Set || Array.isArray(value)) {
    yield* value.values();
  } else {
    for (const key in value) {
      if (Object.hasOwn(value, key)) yield (value as Record<string, unknown>)[key];
    }
  }
}

/** Inactive snapshots only. Taking an entry transfers ownership to its view. */
export class InactiveChatCache<T> {
  private entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;
  constructor(
    private maxEntries: number,
    private maxBytes: number,
    private onEvict: (id: string) => void,
  ) {}
  get size() {
    return this.entries.size;
  }
  get estimatedBytes() {
    return this.bytes;
  }
  peek(id: string): T | undefined {
    return this.entries.get(id)?.value;
  }
  take(id: string): T | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    this.bytes -= entry.bytes;
    return entry.value;
  }
  set(id: string, value: T, bytes: number) {
    this.take(id);
    if (bytes > this.maxBytes) {
      this.onEvict(id);
      return;
    }
    this.entries.set(id, { value, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value!;
      this.take(oldest);
      this.onEvict(oldest);
    }
  }
}
