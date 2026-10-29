/**
 * `relay://chat/<id>` — how agents refer to chats (Relay's orchestration tools
 * return these). Chat markdown renders them as chips with the chat's live
 * title and provider logo.
 */

const CHAT_LINK_PREFIX = "relay://chat/";

/** A bare chat link inside prose. Ids are UUIDs, so stop at anything else. */
const CHAT_LINK_RE = /relay:\/\/chat\/([A-Za-z0-9-]+)/g;

/** The chat id a link points at, or null for any other href. */
export function parseChatLinkHref(href: string): string | null {
  if (!href.startsWith(CHAT_LINK_PREFIX)) return null;
  const match = /^([A-Za-z0-9-]+)\/?$/.exec(href.slice(CHAT_LINK_PREFIX.length));
  return match ? match[1]! : null;
}

export type ChatLinkSegment = { kind: "text"; text: string } | { kind: "chat"; href: string };

/** Split prose into text and bare chat links, in order. */
export function splitChatLinks(text: string): ChatLinkSegment[] {
  const segments: ChatLinkSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(CHAT_LINK_RE)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ kind: "text", text: text.slice(last, start) });
    segments.push({ kind: "chat", href: match[0] });
    last = start + match[0].length;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}
