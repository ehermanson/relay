import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import type { ComposerEditorHandle, ComposerEditorProps } from "./composer-editor";

/**
 * Native `<textarea>` drop-in for `ComposerEditor`, used on touch devices when
 * the "native mobile composer" experiment is on. Same props and handle, same
 * controlled-value contract: the parent owns `value`; a programmatic value
 * change (mention insert, draft restore, reset after send) is echoed back
 * through `onChange` exactly once, because `useComposerState` clears its
 * stale-echo guard only when the editor reports the value it was given.
 * Mentions and slash commands stay plain text here — no chips.
 */
export const ComposerTextarea = forwardRef<ComposerEditorHandle, ComposerEditorProps>(
  (
    {
      value,
      placeholder,
      disabled,
      className = "",
      onChange,
      onSelectionApplied,
      selectionOffset,
      onKeyDown,
      onPaste,
    },
    ref,
  ) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    // Last value we told the parent about; a `value` prop that differs came
    // from outside the textarea and must be echoed.
    const lastReportedRef = useRef(value);
    // Caret to apply once the textarea is focused. Setting a selection on an
    // unfocused textarea can focus it in WebKit, which raises the keyboard.
    const pendingCaretRef = useRef<number | null>(null);
    const onChangeRef = useRef(onChange);
    const onSelectionAppliedRef = useRef(onSelectionApplied);
    onChangeRef.current = onChange;
    onSelectionAppliedRef.current = onSelectionApplied;

    const applyCaret = useCallback((offset: number) => {
      const el = textareaRef.current;
      if (!el) return;
      if (document.activeElement === el) {
        const clamped = Math.min(offset, el.value.length);
        el.setSelectionRange(clamped, clamped);
        pendingCaretRef.current = null;
      } else {
        pendingCaretRef.current = offset;
      }
    }, []);

    useImperativeHandle(ref, () => ({
      focus: () => {
        textareaRef.current?.focus();
      },
    }));

    // Grow with content; the className's max-height caps it and overflow-y
    // scrolls past that.
    useLayoutEffect(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "0px";
      el.style.height = `${el.scrollHeight}px`;
    }, [value, className]);

    useEffect(() => {
      const caret = selectionOffset ?? null;
      if (caret != null) applyCaret(caret);
      if (value !== lastReportedRef.current) {
        lastReportedRef.current = value;
        onChangeRef.current(value, caret ?? value.length);
      }
      if (caret != null) onSelectionAppliedRef.current?.();
    }, [value, selectionOffset, applyCaret]);

    const report = (el: HTMLTextAreaElement) => {
      lastReportedRef.current = el.value;
      onChangeRef.current(el.value, el.selectionStart ?? el.value.length);
    };

    return (
      <textarea
        ref={textareaRef}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className={`block w-full resize-none ${className}`}
        spellCheck
        autoCorrect="on"
        autoCapitalize="sentences"
        enterKeyHint="send"
        onChange={(event) => report(event.currentTarget)}
        onSelect={(event) => {
          // Caret moves feed the mention/slash trigger detection.
          if (event.currentTarget.value === lastReportedRef.current) report(event.currentTarget);
        }}
        onFocus={(event) => {
          const pending = pendingCaretRef.current;
          if (pending != null) {
            pendingCaretRef.current = null;
            const clamped = Math.min(pending, event.currentTarget.value.length);
            event.currentTarget.setSelectionRange(clamped, clamped);
          }
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
    );
  },
);

ComposerTextarea.displayName = "ComposerTextarea";
