/**
 * Count Claude assistant usage once per API message.
 *
 * Claude Code writes one transcript record (and the SDK emits one assistant
 * frame) per content block, and every one of them carries the whole message's
 * `usage`. Summing records therefore multiplies a message's tokens by its block
 * count (thinking + text + two tool calls = 4×). Usage is attributed by
 * `message.id` instead: each record adds only what its message's usage grew by
 * since the last record for that id, so identical repeats add nothing and a
 * usage that grows across records still lands at its final value.
 */
import type { SessionStats } from "#core/types.js";

export interface MessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface CountedUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

/**
 * Records of one message are contiguous, so only recent ids need remembering;
 * the bound keeps a long-lived session's tracker small.
 */
const MAX_TRACKED_MESSAGES = 256;

export class MessageUsageTracker {
  private readonly counted = new Map<string, CountedUsage>();

  /**
   * Add this record's usage to `stats`, minus what earlier records of the same
   * message already added. Records without a message id count in full.
   */
  add(stats: SessionStats, messageId: string | undefined, usage: MessageUsage): void {
    const next: CountedUsage = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheCreation: usage.cache_creation_input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
    };
    const prev = messageId ? this.counted.get(messageId) : undefined;
    stats.inputTokens += Math.max(0, next.input - (prev?.input ?? 0));
    stats.outputTokens += Math.max(0, next.output - (prev?.output ?? 0));
    stats.cacheCreationTokens += Math.max(0, next.cacheCreation - (prev?.cacheCreation ?? 0));
    stats.cacheReadTokens += Math.max(0, next.cacheRead - (prev?.cacheRead ?? 0));
    if (!messageId) return;
    // Keep the larger value per field so a smaller later record never re-adds.
    const merged: CountedUsage = prev
      ? {
          input: Math.max(prev.input, next.input),
          output: Math.max(prev.output, next.output),
          cacheCreation: Math.max(prev.cacheCreation, next.cacheCreation),
          cacheRead: Math.max(prev.cacheRead, next.cacheRead),
        }
      : next;
    this.counted.delete(messageId);
    this.counted.set(messageId, merged);
    if (this.counted.size > MAX_TRACKED_MESSAGES) {
      const oldest = this.counted.keys().next().value;
      if (oldest !== undefined) this.counted.delete(oldest);
    }
  }
}

/**
 * Transcript parsing threads one `SessionStats` object through many
 * per-record helpers (full parse, incremental watcher). The tracker belongs to
 * that accumulator, so it is keyed by the object rather than added to every
 * parse-context type. A copied stats object starts a fresh tracker.
 */
const trackers = new WeakMap<SessionStats, MessageUsageTracker>();

export function addMessageUsage(
  stats: SessionStats,
  messageId: string | undefined,
  usage: MessageUsage,
): void {
  let tracker = trackers.get(stats);
  if (!tracker) {
    tracker = new MessageUsageTracker();
    trackers.set(stats, tracker);
  }
  tracker.add(stats, messageId, usage);
}
