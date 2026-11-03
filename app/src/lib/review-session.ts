import type { FileChange, InstanceInfo, ReviewSessionInfo } from "@shared/types";

function looksLikeReviewTitle(name: string): boolean {
  return /^Review the recent changes from "/.test(name);
}

export function isAttachedReviewInstance(instance: InstanceInfo): boolean {
  if (instance.aside) return false;
  return Boolean(
    instance.review?.sourceInstanceId ||
    instance.review?.sourceSessionId ||
    (instance.parentSessionId && looksLikeReviewTitle(instance.name)),
  );
}

/** An aside ("btw") chat: a read-only fork shown only in its source chat's sidecar. */
export function isAsideInstance(instance: InstanceInfo): boolean {
  return !!instance.aside?.sourceInstanceId;
}

/**
 * A chat that lives inside another chat (an attached review or an aside) and
 * so never appears in navigation, lists, Home, or the stale-chat sweep.
 */
export function isAttachedChatInstance(instance: InstanceInfo): boolean {
  return isAsideInstance(instance) || isAttachedReviewInstance(instance);
}

export function getReviewSourceInstance(
  instance: InstanceInfo,
  instances: InstanceInfo[],
): InstanceInfo | null {
  const sourceInstanceId = instance.review?.sourceInstanceId;
  if (sourceInstanceId) {
    const byId = instances.find((candidate) => candidate.id === sourceInstanceId);
    if (byId) return byId;
  }
  const parentSessionId = instance.review?.sourceSessionId ?? instance.parentSessionId;
  if (!parentSessionId) return null;
  return (
    instances.find(
      (candidate) =>
        candidate.sessionId === parentSessionId &&
        candidate.workingDirectory === instance.workingDirectory,
    ) ?? null
  );
}

export function getAttachedReviewInstance(
  instance: InstanceInfo,
  instances: InstanceInfo[],
): InstanceInfo | null {
  const attached = getAttachedReviewInstances(instance, instances);
  if (attached.length === 0) return null;
  if (instance.reviewInstanceId) {
    const active = attached.find((candidate) => candidate.id === instance.reviewInstanceId);
    if (active) return active;
  }
  return attached[0] ?? null;
}

export function getAttachedReviewInstances(
  instance: InstanceInfo,
  instances: InstanceInfo[],
): InstanceInfo[] {
  return instances
    .filter((candidate) => {
      if (!isAttachedReviewInstance(candidate)) return false;
      if (candidate.review?.sourceInstanceId === instance.id) return true;
      if (
        !!candidate.review?.sourceSessionId &&
        !!instance.sessionId &&
        candidate.review.sourceSessionId === instance.sessionId &&
        candidate.workingDirectory === instance.workingDirectory
      ) {
        return true;
      }
      return (
        !!candidate.parentSessionId &&
        !!instance.sessionId &&
        candidate.parentSessionId === instance.sessionId &&
        candidate.workingDirectory === instance.workingDirectory
      );
    })
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
      return b.lastActivityAt - a.lastActivityAt;
    });
}

export function buildReviewDraft(options: {
  sourceName: string;
  review: ReviewSessionInfo;
  touchedFiles?: FileChange[] | null;
  instructions?: string;
}): string {
  const { sourceName, review, touchedFiles } = options;
  const instructions = options.instructions?.trim();
  const lines: string[] = [
    `Review the recent changes from "${sourceName}". This is a review-only pass; do not make edits.`,
  ];

  if (review.scope === "session-files") {
    const filePaths = review.filePaths?.length
      ? review.filePaths
      : (touchedFiles ?? []).map((file) => file.path);
    if (filePaths.length > 0) {
      lines.push("", "<source_files>", ...filePaths, "</source_files>");
    }
    lines.push(
      "",
      "Focus on correctness bugs, regressions, edge cases, missing tests, and anything half-finished or inconsistent. Return a prioritized list of findings with file:line references and concrete suggestions.",
    );
  } else {
    lines.push(
      "",
      "Read the full reviewable diff for this branch/worktree: uncommitted edits and any commits ahead of the base branch. Look for correctness bugs, regressions, edge cases, missing tests, naming inconsistencies, and unfinished work. Return a prioritized list of findings with file:line references and concrete suggestions.",
    );
  }

  if (instructions) {
    lines.push("", "Additional instructions for this review:", instructions);
  }
  return lines.join("\n");
}

export function buildReviewSendBackMessage(options: {
  reviewName: string;
  sourceName: string;
  message: string;
}): string {
  const { reviewName, sourceName, message } = options;
  return [`[Review from: ${reviewName}]`, "", `For source chat "${sourceName}":`, "", message].join(
    "\n",
  );
}
