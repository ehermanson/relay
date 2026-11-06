import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getEditor,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  BLUR_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  type EditorConfig,
  FOCUS_COMMAND,
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  KEY_BACKSPACE_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  mergeRegister,
  ParagraphNode,
  RootNode,
  type SerializedParagraphNode,
  type Spread,
  type TextNode,
} from "lexical";
import { useEffect, useRef } from "react";
import {
  applyComposerFormat,
  composerFormatFromKey,
  type ComposerMarkdownSpan,
  type ComposerTextEdit,
  continueComposerList,
  MARK_BOLD,
  MARK_BULLET,
  MARK_CODE,
  MARK_CODE_BLOCK,
  MARK_HIDDEN,
  MARK_ITALIC,
  MARK_LIST_NUMBER,
  MARK_QUOTE,
  MARK_QUOTE_MARKER,
  MARK_STRIKETHROUGH,
  MARK_SYNTAX,
  parseComposerMarkdown,
  removeComposerLinePrefix,
} from "@/lib/composer-markdown";

export const COMPOSER_TEXT_THEME = {
  bold: "font-semibold",
  italic: "italic",
  strikethrough: "line-through",
  code: "rounded bg-surface-hover px-1 py-px font-mono text-[0.9em]",
};

type SerializedComposerLineNode = Spread<{ line: string }, SerializedParagraphNode>;

/**
 * One line of the prompt. Each line is its own block so that CSS can give it what
 * only a block can have: a hanging indent, spacing, one bar down a whole quote.
 * `data-composer-line` carries its kind and position (see index.css).
 */
export class ComposerLineNode extends ParagraphNode {
  __line = "";

  static override getType(): string {
    return "composer-line";
  }

  static override clone(node: ComposerLineNode): ComposerLineNode {
    return new ComposerLineNode(node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerLineNode): ComposerLineNode {
    return new ComposerLineNode().updateFromJSON(serializedNode);
  }

  override afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__line = prevNode.__line;
  }

  override exportJSON(): SerializedComposerLineNode {
    return { ...super.exportJSON(), line: this.__line, type: "composer-line" };
  }

  override createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.dataset.composerLine = this.__line;
    return dom;
  }

  override updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    if (prevNode.__line !== this.__line) dom.dataset.composerLine = this.__line;
    return super.updateDOM(prevNode, dom, config);
  }

  setLine(line: string): void {
    if (this.__line !== line) this.getWritable().__line = line;
  }
}

/** All paragraphs are lines, including the ones Lexical creates itself. */
export const COMPOSER_LINE_NODES = [
  ComposerLineNode,
  {
    replace: ParagraphNode,
    with: () => new ComposerLineNode(),
    withKlass: ComposerLineNode,
  },
];

/** The composer's value: lines are blocks, which `getTextContent()` would double-space. */
export function $readComposerValue(): string {
  return $getRoot()
    .getChildren()
    .map((block) => block.getTextContent())
    .join("\n");
}

function textFormatFor(marks: number): number {
  let format = 0;
  if (marks & MARK_BOLD) format |= IS_BOLD;
  if (marks & MARK_ITALIC) format |= IS_ITALIC;
  if (marks & MARK_STRIKETHROUGH) format |= IS_STRIKETHROUGH;
  if (marks & MARK_CODE) format |= IS_CODE;
  return format;
}

const HIDDEN_MARKS = MARK_BULLET | MARK_QUOTE_MARKER | MARK_HIDDEN;
const HIDDEN_STYLE = "color: transparent;";

function textStyleFor(marks: number, length: number): string {
  // Stays in the text, so the caret and the value are untouched, but takes up no
  // room: a monospace `ch` is exactly one character, and pulling back by that
  // much lands what follows where the markup began. (font-size: 0 would be
  // simpler, but the caret takes its height from the text it sits in, and would
  // vanish right after a closing backtick or a new bullet.)
  // Pulled back like that it lies over the text before it, so clicks pass through.
  if (marks & HIDDEN_MARKS) {
    return `${HIDDEN_STYLE} caret-color: var(--color-text); font-family: var(--font-mono); margin-left: -${length}ch; pointer-events: none;`;
  }
  // Right-aligned into the line's indent, like a native list number.
  if (marks & MARK_LIST_NUMBER) {
    return "display: inline-flex; justify-content: flex-end; width: 1.5em; margin-left: -1.5em; white-space: pre; color: var(--color-muted);";
  }
  if (marks & MARK_SYNTAX) return "opacity: 0.45;";
  if (marks & MARK_CODE_BLOCK) return "font-family: var(--font-mono); font-size: 0.9em;";
  if (marks & MARK_QUOTE) return "opacity: 0.75;";
  return "";
}

function $styleTextNode(node: TextNode, start: number, spans: ComposerMarkdownSpan[]): void {
  const end = start + node.getTextContentSize();
  const overlapping = spans.filter((span) => span.start < end && span.end > start);

  const cuts = new Set<number>();
  for (const span of overlapping) {
    if (span.start > start) cuts.add(span.start - start);
    if (span.end < end) cuts.add(span.end - start);
  }
  const parts = cuts.size
    ? node.splitText(...[...cuts].sort((a, b) => a - b))
    : ([node] as TextNode[]);

  let partStart = start;
  for (const part of parts) {
    const length = part.getTextContentSize();
    const partEnd = partStart + length;
    const marks = overlapping.find((item) => item.start <= partStart && item.end >= partEnd)?.marks;
    const format = textFormatFor(marks ?? 0);
    const style = textStyleFor(marks ?? 0, length);
    if (part.getFormat() !== format) part.setFormat(format);
    if (part.getStyle() !== style) part.setStyle(style);
    partStart = partEnd;
  }
}

function lineKindOf(start: number, end: number, spans: ComposerMarkdownSpan[]): string {
  const prefix = spans.find((span) => span.start >= start && span.end <= end);
  if (!prefix) return "";
  if (prefix.marks & MARK_BULLET) return "bullet";
  if (prefix.marks & MARK_LIST_NUMBER) return "number";
  if (prefix.marks & MARK_QUOTE_MARKER) return "quote";
  return "";
}

/** What CSS needs to know about a line: its kind, and where it sits in its block. */
function lineAttribute(kinds: string[], lengths: number[], index: number): string {
  const kind = kinds[index];
  if (!kind) return "";
  const tokens = [kind];
  const before = index - 1;
  const after = index + 1;
  if (kinds[before] !== kind) tokens.push("first");
  if (kinds[after] !== kind) tokens.push("last");
  // A blank line already separates the block, so only text needs the margin.
  if (kinds[before] !== kind && (lengths[before] ?? 0) > 0) tokens.push("gap-above");
  if (kinds[after] !== kind && (lengths[after] ?? 0) > 0) tokens.push("gap-below");
  return tokens.join(" ");
}

function hasLineBreak(block: LexicalNode): boolean {
  return $isElementNode(block) && block.getChildren().some($isLineBreakNode);
}

/**
 * Runs after every change. It only sets formats and line attributes, so the
 * composer's value is never affected. It must stay idempotent: every write
 * dirties the tree and re-runs it.
 */
function $decorateComposer(root: RootNode): void {
  const spans = parseComposerMarkdown($readComposerValue());
  const blocks = root.getChildren();
  const lengths = blocks.map((block) => block.getTextContentSize());

  const starts: number[] = [];
  let offset = 0;
  for (const length of lengths) {
    starts.push(offset);
    offset += length + 1;
  }
  const kinds = lengths.map((length, index) => {
    const start = starts[index] ?? 0;
    return lineKindOf(start, start + length, spans);
  });

  blocks.forEach((block, index) => {
    if (!$isElementNode(block)) return;
    if (block instanceof ComposerLineNode) block.setLine(lineAttribute(kinds, lengths, index));
    let childStart = starts[index] ?? 0;
    for (const child of block.getChildren()) {
      if ($isTextNode(child) && child.isSimpleText()) $styleTextNode(child, childStart, spans);
      childStart += child.getTextContentSize();
    }
  });
}

function editorHasFocus(editor: LexicalEditor): boolean {
  const root = editor.getRootElement();
  return !!root && root.contains(document.activeElement);
}

/**
 * Show the markers around the caret. A reveal changes how they look and nothing
 * else, so it's an attribute on the DOM, set after each commit, not editor state:
 * state would mean an update on every caret move, which undo, onChange and an
 * unfocused editor all have to be protected from (it crashed undo when tried).
 */
function $revealMarkers(editor: LexicalEditor, $readEdit: () => ComposerTextEdit | null): void {
  const selection = editorHasFocus(editor) ? $readEdit() : null;
  const spans = parseComposerMarkdown($readComposerValue(), selection);
  let offset = 0;
  for (const block of $getRoot().getChildren()) {
    if ($isElementNode(block)) {
      for (const child of block.getChildren()) {
        if ($isTextNode(child) && child.getStyle().startsWith(HIDDEN_STYLE)) {
          const start = offset;
          const marks = spans.find((span) => span.start <= start && span.end > start)?.marks ?? 0;
          const dom = editor.getElementByKey(child.getKey());
          dom?.toggleAttribute("data-composer-reveal", !!(marks & MARK_SYNTAX));
        }
        offset += child.getTextContentSize();
      }
    }
    offset += 1;
  }
}

export function ComposerMarkdownPlugin({
  $readEdit,
  $writeEdit,
  enterContinuesBlocks,
}: {
  $readEdit: () => ComposerTextEdit | null;
  $writeEdit: (edit: ComposerTextEdit) => void;
  enterContinuesBlocks: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  const enterContinuesBlocksRef = useRef(enterContinuesBlocks);
  enterContinuesBlocksRef.current = enterContinuesBlocks;

  useEffect(() => {
    let pointerHeld = false;
    const reveal = () => {
      if (!pointerHeld) $revealMarkers(editor, $readEdit);
    };
    const holdReveal = () => {
      pointerHeld = true;
    };
    const releaseReveal = () => {
      pointerHeld = false;
      editor.getEditorState().read(reveal);
    };
    document.addEventListener("pointerup", releaseReveal);
    document.addEventListener("pointercancel", releaseReveal);

    return mergeRegister(
      editor.registerNodeTransform(RootNode, (root) => {
        // Replacing nodes under an active IME composition would cancel it;
        // composition end dirties the text, which runs this again.
        if ($getEditor().isComposing()) return;
        // Enter and paste insert line breaks, which become lines here.
        if (root.getChildren().some(hasLineBreak)) {
          const edit = $readEdit();
          if (edit) $writeEdit(edit);
        }
        $decorateComposer(root);
      }),
      editor.registerUpdateListener(({ editorState }) => {
        editorState.read(reveal);
      }),
      editor.registerCommand(
        FOCUS_COMMAND,
        () => {
          reveal();
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        BLUR_COMMAND,
        () => {
          reveal();
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      // Markers appearing under a press move the text out from under a drag, which
      // lost or skewed the selection. They wait for the release.
      editor.registerRootListener((root, prevRoot) => {
        prevRoot?.removeEventListener("pointerdown", holdReveal);
        root?.addEventListener("pointerdown", holdReveal);
      }),
      () => {
        document.removeEventListener("pointerup", releaseReveal);
        document.removeEventListener("pointercancel", releaseReveal);
      },
      editor.registerCommand(
        KEY_DOWN_COMMAND,
        (event) => {
          const format = composerFormatFromKey(event);
          if (!format || !editor.isEditable()) return false;
          const edit = $readEdit();
          if (!edit) return false;
          event.preventDefault();
          $writeEdit(applyComposerFormat(edit, format));
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      // Everywhere else Enter sends, and ⌘/Ctrl+Enter sends even inside a list or quote.
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (!event || event.metaKey || event.ctrlKey || event.altKey) return false;
          const plainEnter = !event.shiftKey;
          if (plainEnter && !enterContinuesBlocksRef.current) return false;
          const edit = $readEdit();
          if (!edit || edit.start !== edit.end) return false;
          const next = continueComposerList(edit.value, edit.start);
          if (!next) return false;
          event.preventDefault();
          // This runs on the editor root, ahead of the composer's React handler,
          // which would otherwise send the message as well.
          event.stopPropagation();
          $writeEdit(next);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_BACKSPACE_COMMAND,
        (event) => {
          const edit = $readEdit();
          if (!edit || edit.start !== edit.end) return false;
          const next = removeComposerLinePrefix(edit.value, edit.start);
          if (!next) return false;
          event.preventDefault();
          $writeEdit(next);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    );
  }, [editor, $readEdit, $writeEdit]);

  return null;
}
