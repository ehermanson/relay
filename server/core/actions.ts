/**
 * Suggestions — built-in definitions and resolution logic.
 *
 * Resolution order: built-in defaults -> global patches/customs -> project patches/customs.
 * Disabled at global level = hidden everywhere (project cannot re-enable).
 * Cap at 8 total resolved suggestions.
 *
 * Conditions:
 * - Client-evaluated: `has-changes`, `in-space` — sent in the response, filtered by the UI
 * - Server-evaluated: `has-tasks` — filtered during resolution, never sent to the client
 */

import type { BuiltInSuggestion, SuggestionsConfig, ResolvedSuggestion } from "#core/types.js";

/** Maximum number of resolved suggestions shown in the UI. */
export const MAX_SUGGESTIONS = 8;

/** Server-evaluated conditions that are filtered during resolution. */
type ServerCondition = "has-tasks";

/** Immutable set of built-in prompt suggestions. */
export const BUILT_IN_SUGGESTIONS: BuiltInSuggestion[] = [
  // ── Always visible (no conditions) ──────────────────────────────────
  {
    id: "explore-codebase",
    label: "Explore the Codebase",
    description: "Get oriented with the project structure, architecture, and tech stack.",
    icon: "Search",
    prompt:
      "Give me a tour of this project. Start with the README and manifest files (package.json, pyproject.toml, Cargo.toml, go.mod, etc.), then skim the top-level source directories to understand the layout. Cover: what the project does, its tech stack, how it's structured, how to build/run/test it, and any notable conventions, patterns, or gotchas. Keep the summary tight — a few paragraphs or short bullets, not an exhaustive file listing. Don't modify anything; this is a read-only pass.",
  },
  {
    id: "find-issues",
    label: "Find & Fix Issues",
    description: "Scan for potential bugs, code smells, or improvements.",
    icon: "Bug",
    prompt:
      "Scan the codebase for potential bugs, correctness issues, security concerns, and maintainability risks. Focus on high-leverage areas — entry points, shared utilities, and code that handles persistence, auth, or external input. Don't try to read every file. For each finding, include: severity (critical / high / medium / low), a file:line reference, what the issue is and why it matters, and a suggested fix in one or two sentences. Return a prioritized list, most important first. Don't make any edits — this is a read-only pass. Stop once you have a solid short list; exhaustiveness matters less than signal.",
  },

  // ── Requires a reviewable diff (uncommitted OR ahead of base) ───────
  {
    id: "review-changes",
    label: "Review Changes",
    description: "Check recent work for bugs, edge cases, and oversights.",
    icon: "Eye",
    prompt:
      "Review the changes on this branch. Read the full diff: both uncommitted edits (`git diff` and `git diff --staged`) and any commits not yet in the base branch (`git log <base>..HEAD` and `git diff <base>..HEAD`, where `<base>` is the branch this one was created from — typically `main` or `master`). Look for: correctness bugs, edge cases, regressions or unintended behavior changes, missing or inadequate tests, inconsistent naming, and anything that looks half-finished or left over from an earlier approach. Return a prioritized list of findings, each with a file:line reference, what's wrong, and a concrete suggestion. Don't make edits — review only.",
    conditions: ["has-reviewable-diff"],
  },
  {
    id: "write-tests",
    label: "Write Tests",
    description: "Generate tests for recent changes, matching project conventions.",
    icon: "FlaskConical",
    prompt:
      "Write tests for the recent changes on this branch. First, read the diff — both uncommitted edits and any commits not yet in the base branch — so you know what actually changed. Then find existing tests for similar code to learn the test framework, file layout, and assertion style used in this project. Focus on behavior that changed: new public surface, new branches and edge cases, and regression coverage for any bug fixes. Don't re-test unchanged code, and don't invent a new test style — match what's already here. When you're done, run the tests and fix any failures before handing off.",
    conditions: ["has-reviewable-diff"],
  },

  // ── Requires space with sibling chats ───────────────────────────────
  {
    id: "continue-work",
    label: "Continue Work",
    description: "Pick up where the last chat left off using the shared context.",
    icon: "Play",
    prompt:
      "Pick up the next piece of unfinished work in this space. Before starting, orient yourself: read `.relay/space-context.md` for decisions, interfaces, status, and blockers recorded by sibling chats; skim recent commits on this branch (`git log --oneline -20`); and check the current working-tree state (`git status`, `git diff`). Then identify what's in progress, what's obviously next, and what's blocked. Start on the next logical piece of work and tell me up front what you're doing and why. If the direction is genuinely ambiguous, ask before committing to an approach. When you finish significant work, record it in `.relay/space-context.md` so other chats in this space stay in sync.",
    conditions: ["in-space"],
  },
  {
    id: "summarize-progress",
    label: "Summarize Progress",
    description: "Recap what's been done so far based on the diff and shared context.",
    icon: "ScrollText",
    prompt:
      "Recap what has been accomplished in this space so far. Pull from three sources: commits on this branch that aren't in the base branch (`git log <base>..HEAD` plus the corresponding diff), uncommitted working-tree changes (`git status`, `git diff`, `git diff --staged`), and `.relay/space-context.md`. Structure the summary as: **Done** (what's landed or clearly working), **In progress** (partial or uncommitted work), and **Open questions / next steps** (anything known to be unresolved). Be concrete — reference specific files, features, or behaviors rather than talking in generalities. Keep it tight: bullets, not paragraphs.",
    conditions: ["in-space", "has-reviewable-diff"],
  },

  // ── Requires open tasks (server-filtered) ───────────────────────────
  {
    id: "pick-up-task",
    label: "Pick Up a Task",
    description: "Grab the highest-priority open task and start working on it.",
    icon: "ListChecks",
    prompt:
      "Run `relay tasks list --ready --json` from the current working directory and pick the first task (priority 0 is highest). Inspect it with `relay tasks show <id>`, including its description, parent, blockers, and referenced code. Mark it in progress with `relay tasks update <id> --status in_progress` before coding, do the work, then mark it done through the same CLI. If the requirements are unclear or the task spans more than the description implies, ask me before writing code.",
    conditions: ["has-tasks"],
  },
];

const EMPTY_CONFIG: SuggestionsConfig = { patches: {}, custom: [] };

/** Server-side context for pre-filtering suggestions the client can't evaluate. */
export interface SuggestionContext {
  hasOpenTasks?: boolean;
}

/** Map of server-evaluated conditions to their context predicates. */
const SERVER_CONDITIONS: Record<ServerCondition, (ctx: SuggestionContext) => boolean> = {
  "has-tasks": (ctx) => !!ctx.hasOpenTasks,
};

function isServerCondition(c: string): c is ServerCondition {
  return c in SERVER_CONDITIONS;
}

/**
 * Resolve the final suggestion list from layered config.
 *
 * 1. Start with built-in suggestions
 * 2. Apply global patches (disable / prompt override) and append global customs
 * 3. Apply project patches and append project customs
 * 4. Filter disabled + server conditions, cap at MAX_SUGGESTIONS
 */
export function resolveSuggestions(
  globalConfig?: SuggestionsConfig | null,
  projectConfig?: SuggestionsConfig | null,
  context?: SuggestionContext,
): ResolvedSuggestion[] {
  const global = globalConfig ?? EMPTY_CONFIG;
  const project = projectConfig ?? EMPTY_CONFIG;
  const ctx = context ?? {};

  // Track which IDs are globally disabled (cannot be re-enabled by project)
  const globalDisabled = new Set<string>();

  // --- Build resolved list from built-ins ---
  const byId = new Map<string, ResolvedSuggestion>();

  for (const suggestion of BUILT_IN_SUGGESTIONS) {
    const gp = global.patches[suggestion.id];
    const pp = project.patches[suggestion.id];

    // Global disable is absolute
    if (gp?.disabled) {
      globalDisabled.add(suggestion.id);
      continue;
    }

    // Project disable
    if (pp?.disabled) continue;

    // Server-evaluated conditions: filter here, don't send to client
    if (suggestion.conditions?.some((c) => isServerCondition(c) && !SERVER_CONDITIONS[c](ctx))) {
      continue;
    }

    // Client-evaluated conditions: pass through for the UI to filter
    const clientConditions = suggestion.conditions?.filter((c) => !isServerCondition(c));

    byId.set(suggestion.id, {
      id: suggestion.id,
      label: suggestion.label,
      description: suggestion.description,
      icon: suggestion.icon,
      // Phase 3: prompt override layering (project > global > built-in)
      prompt: pp?.prompt ?? gp?.prompt ?? suggestion.prompt,
      builtIn: true,
      conditions: clientConditions?.length ? clientConditions : undefined,
    });
  }

  // --- Append global custom suggestions ---
  for (const custom of global.custom) {
    if (custom.disabled) {
      globalDisabled.add(custom.id);
      continue;
    }
    // Project can patch/disable global customs
    const pp = project.patches[custom.id];
    if (pp?.disabled) continue;

    byId.set(custom.id, {
      id: custom.id,
      label: custom.label,
      description: custom.description,
      icon: custom.icon,
      prompt: pp?.prompt ?? custom.prompt,
      builtIn: false,
    });
  }

  // --- Append project custom suggestions ---
  for (const custom of project.custom) {
    if (custom.disabled) continue;
    if (globalDisabled.has(custom.id)) continue;
    byId.set(custom.id, {
      id: custom.id,
      label: custom.label,
      description: custom.description,
      icon: custom.icon,
      prompt: custom.prompt,
      builtIn: false,
    });
  }

  // Cap at MAX_SUGGESTIONS
  return Array.from(byId.values()).slice(0, MAX_SUGGESTIONS);
}
