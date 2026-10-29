import { getDisplaySessionStats } from "@/lib/utils";
import { isAttachedReviewInstance } from "@/lib/review-session";
import { isDelegatedChildInstance } from "@/lib/delegation";
import { getResolvedSpaceId } from "@/lib/space-membership";
import type { FileChange, InstanceInfo, SessionStats } from "@shared/types";

export function buildSpaceInstances(
  spaceId: string,
  chatSummaries: InstanceInfo[],
  liveInstances: InstanceInfo[],
  /** A delegated child is a tab only while the URL names it explicitly. */
  explicitChatId?: string,
): InstanceInfo[] {
  const spaceChatMap = new Map<string, InstanceInfo>();
  for (const chat of chatSummaries) {
    if (getResolvedSpaceId(chat) === spaceId) {
      spaceChatMap.set(chat.id, chat);
    }
  }
  for (const instance of liveInstances) {
    if (getResolvedSpaceId(instance) === spaceId) {
      spaceChatMap.set(instance.id, instance);
    }
  }
  return Array.from(spaceChatMap.values())
    .filter(
      (instance) =>
        !isAttachedReviewInstance(instance) &&
        (!isDelegatedChildInstance(instance) || instance.id === explicitChatId),
    )
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export function aggregateSpaceStats(instances: InstanceInfo[]): SessionStats | null {
  let hasAny = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;

  for (const instance of instances) {
    if (!instance.stats) {
      continue;
    }
    const display = getDisplaySessionStats(instance.provider, instance.stats);
    hasAny = true;
    inputTokens += display.inputTokens;
    outputTokens += display.outputTokens;
    cacheCreationTokens += display.cacheCreationTokens;
    cacheReadTokens += display.cacheReadTokens;
  }

  if (!hasAny) {
    return null;
  }

  return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens };
}

export function parseSpaceDiffFiles(spaceDiff: string | null): FileChange[] {
  if (!spaceDiff) {
    return [];
  }

  const files: FileChange[] = [];
  const chunks = spaceDiff.split(/^diff --git /m).filter(Boolean);
  for (const chunk of chunks) {
    const pathMatch = chunk.match(/^a\/(.+?) b\//);
    if (!pathMatch) {
      continue;
    }

    let additions = 0;
    let deletions = 0;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }

    files.push({
      path: pathMatch[1],
      editCount: 1,
      type: chunk.includes("new file mode") ? "added" : "edited",
      additions,
      deletions,
    });
  }

  return files;
}
