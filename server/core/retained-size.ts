/** Conservative JS retention estimate, without a temporary serialized copy.
 * Counts UTF-16 strings and object/reference overhead; this is a cache budget,
 * not an exact heap measurement (engines share strings and object shapes). */
export function estimateRetainedBytes(value: unknown, stopAfter = Infinity): number {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  let bytes = 0;
  while (pending.length && bytes <= stopAfter) {
    const item = pending.pop();
    if (typeof item === "string") {
      bytes += 24 + item.length * 2;
    } else if (typeof item === "number" || typeof item === "bigint") {
      bytes += 8;
    } else if (typeof item === "boolean") {
      bytes += 4;
    } else if (item && typeof item === "object" && !seen.has(item)) {
      seen.add(item);
      if (item instanceof Map) {
        bytes += 64 + item.size * 32;
        for (const [key, entry] of item) pending.push(key, entry);
      } else if (item instanceof Set) {
        bytes += 64 + item.size * 24;
        for (const entry of item) pending.push(entry);
      } else if (Array.isArray(item)) {
        bytes += 24 + item.length * 8;
        for (const entry of item) pending.push(entry);
      } else if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) {
        bytes += 64 + item.byteLength;
      } else {
        bytes += 64;
        for (const key of Object.keys(item)) {
          bytes += 16 + key.length * 2;
          pending.push((item as Record<string, unknown>)[key]);
        }
      }
    }
  }
  return bytes;
}
