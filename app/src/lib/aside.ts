import type { InstanceInfo } from "@shared/types";

/** The asides forked from `source`, newest first. */
export function getAttachedAsides(source: InstanceInfo, instances: InstanceInfo[]): InstanceInfo[] {
  return instances
    .filter((candidate) => candidate.aside?.sourceInstanceId === source.id)
    .sort((a, b) => b.createdAt - a.createdAt || b.lastActivityAt - a.lastActivityAt);
}

/**
 * Which aside the panel shows: the selected one, else the newest. An id that
 * isn't listed yet stays selected only while it is the one just created (the
 * instance list can lag the create response).
 */
export function resolveAsideSelection(
  asides: InstanceInfo[],
  selection: string | undefined,
  pendingId?: string | null,
): string | null {
  if (selection && (selection === pendingId || asides.some((aside) => aside.id === selection))) {
    return selection;
  }
  return asides[0]?.id ?? null;
}

/** Quote an aside reply as a Markdown blockquote for the source chat's composer. */
export function buildAsideDraftQuote(text: string): string {
  const body = text
    .trim()
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  return `From an aside:\n${body}\n\n`;
}

/** The question in a `/btw <question>` composer message, or null. */
export function parseBtw(text: string): string | null {
  const match = /^\/btw\s+([\s\S]*\S[\s\S]*)$/i.exec(text.trim());
  return match ? match[1]!.trim() : null;
}
