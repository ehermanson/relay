import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $applyNodeReplacement,
  $createTextNode,
  $getEditor,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  type EditorConfig,
  type ElementNode,
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  KEY_BACKSPACE_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  mergeRegister,
  RootNode,
  type SerializedTextNode,
  type Spread,
  TextNode,
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

type SerializedComposerBlockMarkerNode = Spread<
  { marker: string; type: "composer-block-marker"; version: 1 },
  SerializedTextNode
>;

// The prefix text stays in place but invisible, with the glyph drawn over it. It
// has to be real, editable text: a contentEditable=false token at the end of a
// line leaves the caret in front of it, so typing after a fresh bullet landed
// before the marker.
const HIDDEN_MARKER_CLASS = "relative text-transparent [caret-color:var(--color-text)]";
const BULLET_MARKER_CLASS =
  "before:absolute before:left-0 before:text-text/70 before:content-['•']";
const QUOTE_MARKER_CLASS =
  "before:absolute before:inset-y-[0.1em] before:left-[0.1em] before:w-[3px] before:rounded-full before:bg-muted/50 before:content-['']";

/**
 * A bullet (`- `) or quote (`> `) prefix drawn as a glyph. Its text is still the
 * literal prefix, so the composer's value doesn't change.
 */
export class ComposerBlockMarkerNode extends TextNode {
  static override getType(): string {
    return "composer-block-marker";
  }

  static override clone(node: ComposerBlockMarkerNode): ComposerBlockMarkerNode {
    return new ComposerBlockMarkerNode(node.__text, node.__key);
  }

  static override importJSON(
    serializedNode: SerializedComposerBlockMarkerNode,
  ): ComposerBlockMarkerNode {
    return new ComposerBlockMarkerNode(serializedNode.marker);
  }

  override exportJSON(): SerializedComposerBlockMarkerNode {
    return {
      ...super.exportJSON(),
      marker: this.__text,
      type: "composer-block-marker",
      version: 1,
    };
  }

  override createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    const glyph = this.__text.startsWith(">") ? QUOTE_MARKER_CLASS : BULLET_MARKER_CLASS;
    dom.className = `${HIDDEN_MARKER_CLASS} ${glyph}`;
    return dom;
  }

  // Keeps typed text out of the marker, in a plain node beside it.
  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): false {
    return false;
  }
}

function $isComposerBlockMarkerNode(node: unknown): node is ComposerBlockMarkerNode {
  return node instanceof ComposerBlockMarkerNode;
}

/** `node.replace` moves the caret to the end of the new node; keep it where it was. */
function $swapTextNode(node: TextNode, next: TextNode): void {
  const selection = $getSelection();
  const key = node.getKey();
  const points = $isRangeSelection(selection)
    ? [selection.anchor, selection.focus].filter((point) => point.key === key)
    : [];
  const offsets = points.map((point) => point.offset);
  node.replace(next);
  points.forEach((point, index) => {
    point.set(next.getKey(), offsets[index] ?? 0, "text");
  });
}

function textFormatFor(marks: number): number {
  let format = 0;
  if (marks & MARK_BOLD) format |= IS_BOLD;
  if (marks & MARK_ITALIC) format |= IS_ITALIC;
  if (marks & MARK_STRIKETHROUGH) format |= IS_STRIKETHROUGH;
  if (marks & MARK_CODE) format |= IS_CODE;
  return format;
}

function textStyleFor(marks: number): string {
  if (marks & MARK_SYNTAX) return "opacity: 0.45;";
  if (marks & MARK_CODE_BLOCK) return "font-family: var(--font-mono); font-size: 0.9em;";
  if (marks & MARK_LIST_NUMBER) return "color: var(--color-muted);";
  if (marks & MARK_QUOTE) return "opacity: 0.75;";
  return "";
}

const BLOCK_MARKER_MARKS = MARK_BULLET | MARK_QUOTE_MARKER;

function isWholeBlockMarker(
  span: ComposerMarkdownSpan | undefined,
  start: number,
  end: number,
): boolean {
  return !!span && !!(span.marks & BLOCK_MARKER_MARKS) && span.start === start && span.end === end;
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
    const partEnd = partStart + part.getTextContentSize();
    const span = overlapping.find((item) => item.start <= partStart && item.end >= partEnd);
    if (isWholeBlockMarker(span, partStart, partEnd)) {
      $swapTextNode(
        part,
        $applyNodeReplacement(new ComposerBlockMarkerNode(part.getTextContent())),
      );
    } else {
      // A block marker split across nodes styles as plain text; the nodes merge
      // and the next pass picks it up whole.
      const marks = span && !(span.marks & BLOCK_MARKER_MARKS) ? span.marks : 0;
      const format = textFormatFor(marks);
      const style = textStyleFor(marks);
      if (part.getFormat() !== format) part.setFormat(format);
      if (part.getStyle() !== style) part.setStyle(style);
    }
    partStart = partEnd;
  }
}

function $decorateBlock(block: ElementNode): void {
  const spans = parseComposerMarkdown(block.getTextContent());
  let offset = 0;
  for (const child of block.getChildren()) {
    const start = offset;
    offset += child.getTextContentSize();
    if ($isComposerBlockMarkerNode(child)) {
      const span = spans.find((item) => item.start === start);
      if (!isWholeBlockMarker(span, start, offset)) {
        $swapTextNode(child, $createTextNode(child.getTextContent()));
      }
    } else if ($isTextNode(child) && child.isSimpleText()) {
      $styleTextNode(child, start, spans);
    }
  }
}

/**
 * Runs after every change. It only sets formats and swaps prefixes for tokens of
 * the same text, so `getTextContent()`, which is the composer's value, is never
 * affected. It must stay idempotent: every write dirties the tree and re-runs it.
 */
function $decorateComposer(root: RootNode): void {
  // Replacing nodes under an active IME composition would cancel it; composition
  // end dirties the text, which runs this again.
  if ($getEditor().isComposing()) return;
  for (const child of root.getChildren()) {
    if ($isElementNode(child)) $decorateBlock(child);
  }
}

export function ComposerMarkdownPlugin({
  $readEdit,
  $writeEdit,
  enterContinuesLists,
}: {
  $readEdit: () => ComposerTextEdit | null;
  $writeEdit: (edit: ComposerTextEdit) => void;
  enterContinuesLists: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  const enterContinuesListsRef = useRef(enterContinuesLists);
  enterContinuesListsRef.current = enterContinuesLists;

  useEffect(() => {
    return mergeRegister(
      editor.registerNodeTransform(RootNode, $decorateComposer),
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
      // Everywhere else Enter sends, and ⌘/Ctrl+Enter sends even inside a list.
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (!event || event.metaKey || event.ctrlKey || event.altKey) return false;
          const plainEnter = !event.shiftKey;
          if (plainEnter && !enterContinuesListsRef.current) return false;
          const edit = $readEdit();
          if (!edit || edit.start !== edit.end) return false;
          const next = continueComposerList(edit.value, edit.start, { listsOnly: plainEnter });
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
