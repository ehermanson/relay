import { isInternalInjectedUserText, stripInjectedWrapper } from "#core/internal-user-messages.js";
import type { ActivityMessage, HistoryEntry, OutputMessage, UserMessage } from "#core/types.js";

/**
 * A chat's conversation as an agent reads it through `chat_read`: bounded,
 * provider-neutral, and paged by cursor. A cursor is `<timestamp>.<n>` (the
 * entry's timestamp plus how many earlier entries share that timestamp),
 * not a history index: Relay keeps only the most recent history entries in
 * memory, so indexes shift as old ones are dropped while cursors don't.
 */

export type ChatViewMode = "messages" | "activity";

export interface ChatViewItem {
  cursor: string;
  /** `agent` = an agent-authored note in this chat (not a human turn). */
  role: "user" | "assistant" | "agent" | "tool";
  text: string;
  truncated?: boolean;
  timestamp: number;
  /** Sender name for `agent` items. */
  author?: string;
}

export interface ChatView {
  items: ChatViewItem[];
  /** Pass as `after` to read what comes after this page. */
  nextCursor: string | null;
  /** More items exist before the first returned one. */
  hasEarlier: boolean;
  /** More items exist after the last returned one (only with `after`). */
  hasMore: boolean;
}

export const CHAT_VIEW_DEFAULT_LIMIT = 40;
export const CHAT_VIEW_MAX_LIMIT = 200;
export const CHAT_VIEW_ITEM_MAX_CHARS = 4_000;
/** Total text budget for one page, so a single read can't flood the caller's context. */
export const CHAT_VIEW_PAGE_MAX_CHARS = 60_000;

export interface ChatViewOptions {
  view?: ChatViewMode;
  /** Exclusive: return items strictly after this cursor, oldest first. */
  after?: string;
  /** Without `after`, the most recent `limit` items are returned. */
  limit?: number;
}

export function buildChatView(history: HistoryEntry[], options: ChatViewOptions = {}): ChatView {
  const view = options.view ?? "messages";
  const limit = clampLimit(options.limit);
  const all: Array<ChatViewItem & { key: CursorKey }> = [];
  const seen = new Map<number, number>();
  for (const entry of history) {
    const ordinal = seen.get(entry.timestamp) ?? 0;
    seen.set(entry.timestamp, ordinal + 1);
    const key: CursorKey = [entry.timestamp, ordinal];
    const item = toViewItem(entry, `${key[0]}.${key[1]}`, view);
    if (item) all.push({ ...item, key });
  }

  const forward = options.after !== undefined;
  let start: number;
  let end: number;
  if (forward) {
    const after = parseChatCursor(options.after!);
    if (!after) throw new InvalidChatCursorError(options.after!);
    // Resume right after the cursor's item; if it has since been trimmed
    // from memory, fall back to the first item ordered after it.
    const exact = all.findIndex((item) => item.cursor === `${after[0]}.${after[1]}`);
    start = exact !== -1 ? exact + 1 : all.findIndex((item) => compareKeys(item.key, after) > 0);
    if (start === -1) start = all.length;
    end = Math.min(all.length, start + limit);
  } else {
    end = all.length;
    start = Math.max(0, end - limit);
  }

  // Enforce the page budget: newest-first pages drop from the front, forward
  // reads drop from the back, so the caller can always continue.
  let page = all.slice(start, end);
  let total = page.reduce((sum, item) => sum + item.text.length, 0);
  while (page.length > 1 && total > CHAT_VIEW_PAGE_MAX_CHARS) {
    const dropped = forward ? page.pop()! : page.shift()!;
    if (forward) end -= 1;
    else start += 1;
    total -= dropped.text.length;
  }

  const last = page.at(-1);
  return {
    items: page.map(({ key: _key, ...item }) => item),
    nextCursor: last ? last.cursor : (options.after ?? null),
    hasEarlier: start > 0,
    hasMore: end < all.length,
  };
}

type CursorKey = [timestamp: number, ordinal: number];

export class InvalidChatCursorError extends Error {
  constructor(cursor: string) {
    super(`Invalid chat cursor: ${cursor}`);
    this.name = "InvalidChatCursorError";
  }
}

function parseChatCursor(cursor: string): CursorKey | null {
  const match = /^(-?\d+)\.(\d+)$/.exec(cursor.trim());
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function compareKeys(a: CursorKey, b: CursorKey): number {
  return a[0] - b[0] || a[1] - b[1];
}

function toViewItem(entry: HistoryEntry, cursor: string, view: ChatViewMode): ChatViewItem | null {
  const message = entry.message;
  switch (message.type) {
    case "user": {
      const user = message as UserMessage;
      // Child-agent transcript lines, hidden injections, and not-yet-sent
      // queue placeholders aren't part of this chat's conversation.
      if (user.agentId || user.internal || user.queued) return null;
      let text = user.text ?? "";
      if (isInternalInjectedUserText(text)) {
        const stripped = stripInjectedWrapper(text);
        if (stripped === text) return null;
        text = stripped;
      }
      if (!text.trim()) return null;
      const isAgent = user.author?.kind === "agent";
      return withText(
        {
          cursor,
          role: isAgent ? "agent" : "user",
          timestamp: entry.timestamp,
          ...(isAgent && user.author?.name ? { author: user.author.name } : {}),
        },
        text,
      );
    }
    case "output": {
      const output = message as OutputMessage;
      if (output.agentId || !output.text?.trim()) return null;
      return withText({ cursor, role: "assistant", timestamp: entry.timestamp }, output.text);
    }
    case "activity": {
      if (view !== "activity") return null;
      const activity = message as ActivityMessage;
      if (activity.agentId || activity.activity !== "tool_use") return null;
      const label = activity.inputDescription || activity.description;
      const text = [activity.tool, label].filter(Boolean).join(": ");
      if (!text) return null;
      return withText({ cursor, role: "tool", timestamp: entry.timestamp }, text);
    }
    default:
      return null;
  }
}

function withText(base: Omit<ChatViewItem, "text" | "truncated">, text: string): ChatViewItem {
  if (text.length <= CHAT_VIEW_ITEM_MAX_CHARS) return { ...base, text };
  return { ...base, text: `${text.slice(0, CHAT_VIEW_ITEM_MAX_CHARS)}…`, truncated: true };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return CHAT_VIEW_DEFAULT_LIMIT;
  return Math.max(1, Math.min(CHAT_VIEW_MAX_LIMIT, Math.floor(limit)));
}
