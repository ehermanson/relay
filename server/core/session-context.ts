import type {
  ProviderContextBlock,
  ReviewSessionInfo,
  ProviderSessionBootstrap,
  ProviderSessionContext,
} from "#core/types.js";

export const TASK_CONTEXT_BLOCK_KIND = "task_guidance";
export const CUSTOM_INSTRUCTIONS_BLOCK_KIND = "custom_instructions";
export const SPACE_CONTEXT_BLOCK_KIND = "space_context";
export const RUNTIME_CONTEXT_PREFIX = "Runtime context for this turn:";

/** Kept for recognizing bootstrap prompts recorded before task files moved to Markdown. */
export const LEGACY_TASK_CONTEXT_MSG =
  "This project tracks tasks in .relay/tasks.json (Relay-managed snapshot JSON). " +
  "Do not create a task for every request. Create a task only when explicitly asked, pick up an existing task when explicitly asked or when the request clearly matches one, and otherwise just do the work without creating a new task. Ask if unsure whether a request should map to a task. " +
  "Fields: id (8-char hex), title, description (markdown), status (open|in_progress|done), " +
  "priority (0-4), type (epic|task|bug), tags (string[]), parent (nullable task ID), " +
  "blockedBy (task ID[]), createdAt, updatedAt (ISO timestamps). " +
  "Blocked status is auto-derived from unresolved blockedBy refs. " +
  "When asked to pick up a task (e.g. 'pick up task a1b2c3d4'), read .relay/tasks.json to find it.";

export const TASK_CONTEXT_MSG =
  "This project tracks tasks as Markdown files under .relay/tasks/. " +
  "Do not create a task for every request. Create a task only when explicitly asked, pick up an existing task when explicitly asked or when the request clearly matches one, and otherwise just do the work without creating a new task. Ask if unsure whether a request should map to a task. " +
  "Use `relay tasks` commands from the current working directory to list, inspect, create, update, comment on, validate, and archive tasks so edits follow the shared validation and concurrency rules. " +
  "Task IDs may be legacy IDs or UUIDs. Stored statuses are open, in_progress, done, and cancelled; blocked is derived from unresolved blockers. " +
  "When asked to pick up work, use `relay tasks list --ready --json`, choose priority 0 before higher numbers, inspect it with `relay tasks show <id>`, and update it through the CLI.";

const TASK_CONTEXT_FOLLOWUP =
  "Do not mention, restate, or acknowledge the task-tracking guidance unless the user directly asks about tasks.";

function renderBlocks(
  title: string,
  blocks: ProviderContextBlock[],
  preface?: string,
): string | undefined {
  if (blocks.length === 0) return undefined;
  const sections = blocks.map((block) => {
    const header = block.source ? `## ${block.title} (${block.source})` : `## ${block.title}`;
    return `${header}\n${block.text.trim()}`;
  });
  return [title, preface, ...sections].filter(Boolean).join("\n\n");
}

export function buildSessionBootstrapContext(options: {
  customInstructionBlocks?: ProviderContextBlock[];
  relayInstructionBlocks?: ProviderContextBlock[];
  includeTaskContext?: boolean;
}): ProviderSessionBootstrap | undefined {
  const customInstructionBlocks = options.customInstructionBlocks ?? [];
  const relayInstructionBlocks = options.relayInstructionBlocks ?? [];
  const taskBlocks: ProviderContextBlock[] = options.includeTaskContext
    ? [
        {
          key: "task-files-guidance",
          kind: TASK_CONTEXT_BLOCK_KIND,
          title: "Task tracking guidance",
          source: ".relay/tasks/",
          text: `${TASK_CONTEXT_MSG}\n\n${TASK_CONTEXT_FOLLOWUP}`,
        },
      ]
    : [];

  const relayBlocks = [...relayInstructionBlocks, ...taskBlocks];
  const blocks = [...customInstructionBlocks, ...relayBlocks];
  if (blocks.length === 0) return undefined;

  return {
    blocks,
    baseInstructions: renderBlocks(
      "Follow the project and user instructions below. These override Relay defaults when they conflict.",
      customInstructionBlocks,
    ),
    developerInstructions: renderBlocks("Relay-specific session guidance:", relayBlocks),
  };
}

/**
 * Decide whether a space brief (`.relay/space-context.md`) has meaningful,
 * authored content worth injecting into a chat's bootstrap context.
 *
 * A freshly seeded brief contains only markdown headers and HTML-comment
 * placeholders — injecting that is noise. We strip headers and comments to
 * test for real content, but return the FULL trimmed text (headers included)
 * when content exists, so the injected brief keeps its structure.
 *
 * @returns the trimmed brief to inject, or null when effectively empty.
 */
export function extractSpaceContextForInjection(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const meaningful = trimmed
    .replace(/<!--[\s\S]*?-->/g, "") // drop HTML-comment placeholders
    .split("\n")
    .filter((line) => !/^\s*#{1,6}\s/.test(line)) // drop markdown headers
    .join("")
    .trim();

  return meaningful ? trimmed : null;
}

export function getSessionContextFromRuntimePayload(
  runtimePayload: Record<string, unknown> | undefined,
): ProviderSessionContext | undefined {
  const value = runtimePayload?.sessionContext;
  if (!value || typeof value !== "object") return undefined;
  return value as ProviderSessionContext;
}

export function getReviewSessionFromRuntimePayload(
  runtimePayload: Record<string, unknown> | undefined,
): ReviewSessionInfo | undefined {
  const value = runtimePayload?.review;
  if (!value || typeof value !== "object") return undefined;
  const review = value as ReviewSessionInfo;
  if (!review.sourceName || (review.scope !== "session-files" && review.scope !== "branch")) {
    return undefined;
  }
  return {
    ...review,
    filePaths: Array.isArray(review.filePaths)
      ? review.filePaths.filter((path): path is string => typeof path === "string")
      : undefined,
  };
}

export function getReviewInstanceIdFromRuntimePayload(
  runtimePayload: Record<string, unknown> | undefined,
): string | undefined {
  const value = runtimePayload?.reviewInstanceId;
  return typeof value === "string" && value ? value : undefined;
}

export function hasSessionBootstrapBlock(
  context: ProviderSessionContext | undefined,
  kind: string,
): boolean {
  return !!context?.bootstrap?.blocks.some((block) => block.kind === kind);
}
