import {
  LEGACY_TASK_CONTEXT_MSG,
  RUNTIME_CONTEXT_PREFIX,
  TASK_CONTEXT_MSG,
} from "#core/session-context.js";

export const AUTO_CONTINUE_MSG =
  "The relay server restarted while you were mid-turn. Please continue from where you left off.";

export function buildPermissionGrantedRetryMessage(toolLabel: string): string {
  return `Permission granted for ${toolLabel}. Please continue.`;
}

export function buildFirstTurnTaskContextPrompt(userMessage: string): string {
  return (
    `${TASK_CONTEXT_MSG}\n\n` +
    "Do not mention, restate, or acknowledge the task-tracking guidance unless the user directly asks about tasks. " +
    "Focus only on the user's request below.\n\n" +
    `User request:\n${userMessage}`
  );
}

const CUSTOM_INSTRUCTIONS_PREFIX = "Codebase and user instructions are shown below.";

export function buildCustomInstructionsPrompt(userMessage: string, instructions: string): string {
  return (
    `${CUSTOM_INSTRUCTIONS_PREFIX} Be sure to adhere to these instructions. ` +
    `IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n` +
    `${instructions}\n\n` +
    `      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n\n` +
    `User request:\n${userMessage}`
  );
}

const SPACE_CONTEXT_PREFIX = "<space-context>";

export function isInternalInjectedUserText(text: string): boolean {
  return (
    text === AUTO_CONTINUE_MSG ||
    text.startsWith(TASK_CONTEXT_MSG) ||
    text.startsWith(LEGACY_TASK_CONTEXT_MSG) ||
    text.startsWith(CUSTOM_INSTRUCTIONS_PREFIX) ||
    text.startsWith(SPACE_CONTEXT_PREFIX) ||
    text.startsWith(RUNTIME_CONTEXT_PREFIX) ||
    /^Permission granted for .+\. Please continue\.$/.test(text)
  );
}

const USER_REQUEST_MARKER = "User request:\n";

/**
 * If `text` is a wrapped internal message (task context / custom instructions),
 * extract and return the real user request embedded inside it.
 * Returns the original text unchanged if no wrapper is detected.
 */
export function stripInjectedWrapper(text: string): string {
  if (
    text.startsWith(TASK_CONTEXT_MSG) ||
    text.startsWith(LEGACY_TASK_CONTEXT_MSG) ||
    text.startsWith(CUSTOM_INSTRUCTIONS_PREFIX) ||
    text.startsWith(SPACE_CONTEXT_PREFIX) ||
    text.startsWith(RUNTIME_CONTEXT_PREFIX)
  ) {
    const idx = text.lastIndexOf(USER_REQUEST_MARKER);
    if (idx !== -1) {
      const inner = text.slice(idx + USER_REQUEST_MARKER.length);
      if (inner) return inner;
    }
  }
  return text;
}
