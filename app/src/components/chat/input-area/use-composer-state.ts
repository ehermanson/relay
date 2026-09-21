import { useCallback, useEffect, useReducer, type RefObject, type SetStateAction } from "react";
import type { MentionEntry } from "./shared";
import type { ComposerEditorHandle } from "../composer-editor";
import { shouldAutoFocusComposer } from "@/lib/composer-focus";

const DRAFT_PREFIX = "relay:draft:";

function getDraftKey(key: string): string {
  return `${DRAFT_PREFIX}${key}`;
}

function loadDraft(key: string): string {
  try {
    return sessionStorage.getItem(getDraftKey(key)) || "";
  } catch {
    return "";
  }
}

function saveDraft(key: string, value: string): void {
  try {
    if (value) {
      sessionStorage.setItem(getDraftKey(key), value);
    } else {
      sessionStorage.removeItem(getDraftKey(key));
    }
  } catch {
    // sessionStorage full or unavailable — silently ignore
  }
}

function deleteDraft(key: string): void {
  try {
    sessionStorage.removeItem(getDraftKey(key));
  } catch {
    // ignore
  }
}

interface ComposerState {
  draftText: string;
  composerSelectionOffset: number;
  pendingSelectionOffset: number | null;
  mentionEntries: MentionEntry[];
  selectedMentionKey: string | null;
  mentionMenuDismissed: boolean;
  selectedSlashKey: string | null;
  slashMenuDismissed: boolean;
  /** Set by set_composer_value to guard against stale update_draft dispatches. */
  _pendingProgrammaticValue: string | null;
}

type ComposerAction =
  | { type: "restore"; value: string }
  | { type: "update_draft"; value: string }
  | { type: "set_composer_value"; value: string; selectionOffset: number }
  | { type: "set_selection_offset"; value: number }
  | { type: "clear_pending_selection" }
  | { type: "set_mention_entries"; entries: MentionEntry[] }
  | {
      type: "set_selected_mention_key";
      value: string | null | ((current: string | null) => string | null);
    }
  | { type: "dismiss_mentions" }
  | { type: "reset_mentions" }
  | {
      type: "set_selected_slash_key";
      value: string | null | ((current: string | null) => string | null);
    }
  | { type: "dismiss_slash" }
  | { type: "reset_slash" }
  | { type: "reset_after_send" };

const INITIAL_STATE: ComposerState = {
  draftText: "",
  composerSelectionOffset: 0,
  pendingSelectionOffset: null,
  mentionEntries: [],
  selectedMentionKey: null,
  mentionMenuDismissed: false,
  selectedSlashKey: null,
  slashMenuDismissed: false,
  _pendingProgrammaticValue: null,
};

function reducer(state: ComposerState, action: ComposerAction): ComposerState {
  switch (action.type) {
    case "restore":
      return {
        ...INITIAL_STATE,
        draftText: action.value,
        composerSelectionOffset: action.value.length,
        pendingSelectionOffset: action.value.length,
      };
    case "update_draft":
      // Guard against stale Lexical onChange dispatches that arrive after a
      // programmatic set_composer_value. If a programmatic set is pending and
      // the incoming value doesn't match, this is a stale echo — skip it.
      // Once the editor syncs and sends the matching value, clear the guard.
      if (state._pendingProgrammaticValue !== null) {
        if (action.value === state._pendingProgrammaticValue) {
          // Editor synced — clear guard, accept the value (no-op since it matches)
          return { ...state, _pendingProgrammaticValue: null };
        }
        // Stale echo — skip
        return state;
      }
      return {
        ...state,
        draftText: action.value,
        mentionMenuDismissed: false,
        slashMenuDismissed: false,
      };
    case "set_composer_value":
      return {
        ...state,
        draftText: action.value,
        composerSelectionOffset: action.selectionOffset,
        pendingSelectionOffset: action.selectionOffset,
        mentionMenuDismissed: false,
        slashMenuDismissed: false,
        _pendingProgrammaticValue: action.value,
      };
    case "set_selection_offset":
      return {
        ...state,
        composerSelectionOffset: action.value,
      };
    case "clear_pending_selection":
      return {
        ...state,
        pendingSelectionOffset: null,
      };
    case "set_mention_entries":
      return {
        ...state,
        mentionEntries: action.entries,
      };
    case "set_selected_mention_key": {
      const next =
        typeof action.value === "function" ? action.value(state.selectedMentionKey) : action.value;
      if (next === state.selectedMentionKey) return state;
      return { ...state, selectedMentionKey: next };
    }
    case "dismiss_mentions":
      return {
        ...state,
        mentionEntries: [],
        selectedMentionKey: null,
        mentionMenuDismissed: true,
      };
    case "reset_mentions":
      return {
        ...state,
        mentionEntries: [],
        selectedMentionKey: null,
        mentionMenuDismissed: false,
      };
    case "set_selected_slash_key": {
      const next =
        typeof action.value === "function" ? action.value(state.selectedSlashKey) : action.value;
      if (next === state.selectedSlashKey) return state;
      return { ...state, selectedSlashKey: next };
    }
    case "dismiss_slash":
      return {
        ...state,
        selectedSlashKey: null,
        slashMenuDismissed: true,
      };
    case "reset_slash":
      return {
        ...state,
        selectedSlashKey: null,
        slashMenuDismissed: false,
      };
    case "reset_after_send":
      return {
        ...INITIAL_STATE,
      };
    default:
      return state;
  }
}

export function useComposerState(
  draftKey: string | undefined,
  composerRef: RefObject<ComposerEditorHandle | null>,
) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  useEffect(() => {
    if (!draftKey) return;
    dispatch({ type: "restore", value: loadDraft(draftKey) });
    if (shouldAutoFocusComposer()) composerRef.current?.focus();
  }, [composerRef, draftKey]);

  const persistDraft = useCallback(
    (value: string) => {
      if (!draftKey) return;
      saveDraft(draftKey, value);
    },
    [draftKey],
  );

  const updateDraft = useCallback(
    (value: string) => {
      persistDraft(value);
      dispatch({ type: "update_draft", value });
    },
    [persistDraft],
  );

  const setComposerValue = useCallback(
    (value: string, selectionOffset = value.length) => {
      persistDraft(value);
      dispatch({ type: "set_composer_value", value, selectionOffset });
      // Defer focus — calling focus() synchronously triggers Lexical's onChange
      // which reads the still-empty editor and dispatches updateDraft(""),
      // clobbering the value we just set.
      requestAnimationFrame(() => composerRef.current?.focus());
    },
    [composerRef, persistDraft],
  );

  const resetAfterSend = useCallback(() => {
    if (draftKey) deleteDraft(draftKey);
    dispatch({ type: "reset_after_send" });
  }, [draftKey]);

  return {
    ...state,
    updateDraft,
    setComposerValue,
    setComposerSelectionOffset: useCallback(
      (value: number) => dispatch({ type: "set_selection_offset", value }),
      [],
    ),
    clearPendingSelectionOffset: useCallback(
      () => dispatch({ type: "clear_pending_selection" }),
      [],
    ),
    setMentionEntries: useCallback(
      (entries: MentionEntry[]) => dispatch({ type: "set_mention_entries", entries }),
      [],
    ),
    setSelectedMentionKey: useCallback(
      (value: SetStateAction<string | null>) =>
        dispatch({
          type: "set_selected_mention_key",
          value,
        }),
      [],
    ),
    dismissMentionMenu: useCallback(() => dispatch({ type: "dismiss_mentions" }), []),
    resetMentionMenu: useCallback(() => dispatch({ type: "reset_mentions" }), []),
    setSelectedSlashKey: useCallback(
      (value: SetStateAction<string | null>) =>
        dispatch({
          type: "set_selected_slash_key",
          value,
        }),
      [],
    ),
    dismissSlashMenu: useCallback(() => dispatch({ type: "dismiss_slash" }), []),
    resetSlashMenu: useCallback(() => dispatch({ type: "reset_slash" }), []),
    resetAfterSend,
  };
}
