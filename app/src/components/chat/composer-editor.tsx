import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { EditorRefPlugin } from "@lexical/react/LexicalEditorRefPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $applyNodeReplacement,
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  SKIP_DOM_SELECTION_TAG,
  type EditorConfig,
  type EditorState,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type PointType,
  type SerializedTextNode,
  type Spread,
  TextNode,
} from "lexical";
import {
  forwardRef,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { splitPromptIntoComposerSegments } from "@/lib/composer-mentions";
import { basenameOfPath, getFileIconUrl } from "@/lib/file-icons";

export interface ComposerEditorHandle {
  focus: () => void;
}

interface ComposerEditorProps {
  value: string;
  placeholder: string;
  placeholderClassName?: string;
  disabled?: boolean;
  className?: string;
  onChange: (value: string, selectionOffset: number) => void;
  onSelectionApplied?: () => void;
  selectionOffset?: number | null;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
}

type SerializedComposerMentionNode = Spread<
  {
    path: string;
    type: "composer-mention";
    version: 1;
  },
  SerializedTextNode
>;

class ComposerMentionNode extends TextNode {
  __path: string;

  static override getType(): string {
    return "composer-mention";
  }

  static override clone(node: ComposerMentionNode): ComposerMentionNode {
    return new ComposerMentionNode(node.__path, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerMentionNode): ComposerMentionNode {
    return $createComposerMentionNode(serializedNode.path);
  }

  constructor(path: string, key?: NodeKey) {
    const normalizedPath = path.startsWith("@") ? path.slice(1) : path;
    super(`@${normalizedPath}`, key);
    this.__path = normalizedPath;
  }

  override exportJSON(): SerializedComposerMentionNode {
    return {
      ...super.exportJSON(),
      path: this.__path,
      type: "composer-mention",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement("span");
    dom.className =
      "inline-flex select-none items-center gap-1 rounded-md border border-border/80 bg-accent/10 px-1.5 py-px align-middle text-[0.75rem] font-medium leading-[1.1] text-text";
    dom.contentEditable = "false";
    renderMentionChip(dom, this.__path);

    if (isTaskMention(this.__path)) {
      const { taskId } = parseTaskToken(this.__path);
      dom.dataset.taskId = taskId;
      dom.style.cursor = "pointer";
      dom.addEventListener("click", (e) => {
        e.stopPropagation();
        dom.dispatchEvent(
          new CustomEvent("task-chip-click", {
            detail: { taskId: dom.dataset.taskId, anchor: dom },
            bubbles: true,
          }),
        );
      });
    }

    return dom;
  }

  override updateDOM(prevNode: ComposerMentionNode, dom: HTMLElement): boolean {
    dom.contentEditable = "false";
    if (prevNode.__path !== this.__path || prevNode.__text !== this.__text) {
      renderMentionChip(dom, this.__path);
    }
    return false;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): false {
    return false;
  }

  override isTextEntity(): true {
    return true;
  }

  override isToken(): true {
    return true;
  }
}

function $createComposerMentionNode(path: string): ComposerMentionNode {
  return $applyNodeReplacement(new ComposerMentionNode(path));
}

// ── Slash-command node ───────────────────────────────────────────────

type SerializedComposerSlashNode = Spread<
  {
    command: string;
    type: "composer-slash";
    version: 1;
  },
  SerializedTextNode
>;

class ComposerSlashNode extends TextNode {
  __command: string;

  static override getType(): string {
    return "composer-slash";
  }

  static override clone(node: ComposerSlashNode): ComposerSlashNode {
    return new ComposerSlashNode(node.__command, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerSlashNode): ComposerSlashNode {
    return $createComposerSlashNode(serializedNode.command);
  }

  constructor(command: string, key?: NodeKey) {
    super(command, key);
    this.__command = command;
  }

  override exportJSON(): SerializedComposerSlashNode {
    return {
      ...super.exportJSON(),
      command: this.__command,
      type: "composer-slash",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement("span");
    dom.className =
      "inline-flex select-none items-center gap-1 rounded-md border border-border/60 bg-surface-hover/80 px-1.5 py-px align-middle text-[0.75rem] font-medium leading-[1.1] text-text";
    dom.contentEditable = "false";
    renderSlashChip(dom, this.__command);
    return dom;
  }

  override updateDOM(prevNode: ComposerSlashNode, dom: HTMLElement): boolean {
    dom.contentEditable = "false";
    if (prevNode.__command !== this.__command) {
      renderSlashChip(dom, this.__command);
    }
    return false;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): false {
    return false;
  }

  override isTextEntity(): true {
    return true;
  }

  override isToken(): true {
    return true;
  }
}

function $createComposerSlashNode(command: string): ComposerSlashNode {
  return $applyNodeReplacement(new ComposerSlashNode(command));
}

/** Slash icon SVG (lucide Slash). */
const SLASH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 2 22"/></svg>`;

function renderSlashChip(container: HTMLElement, command: string): void {
  container.textContent = "";

  const icon = document.createElement("span");
  icon.className = "inline-flex h-3 w-3 shrink-0 items-center justify-center text-muted";
  icon.innerHTML = SLASH_ICON_SVG;

  const label = document.createElement("span");
  label.textContent = command.replace(/^[/$]/, "");

  container.append(icon, label);
}

function resolveTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

function inferEntryKind(pathValue: string): "file" | "directory" {
  const base = basenameOfPath(pathValue);
  if (base.startsWith(".") && !base.slice(1).includes(".")) return "directory";
  if (base.includes(".")) return "file";
  return "directory";
}

function isTaskMention(pathValue: string): boolean {
  return pathValue.startsWith("task:");
}

/** Parse `task:ID:EncodedTitle` → { taskId, title }. Falls back to raw ID if no title. */
function parseTaskToken(pathValue: string): { taskId: string; title: string } {
  const rest = pathValue.slice(5); // strip "task:"
  const colonIdx = rest.indexOf(":");
  if (colonIdx === -1) return { taskId: rest, title: rest };
  const taskId = rest.slice(0, colonIdx);
  try {
    return { taskId, title: decodeURIComponent(rest.slice(colonIdx + 1)) };
  } catch {
    return { taskId, title: rest.slice(colonIdx + 1) };
  }
}

// SVG path for a simple checkbox/task icon (lucide ListChecks)
const TASK_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>`;

function renderMentionChip(container: HTMLElement, pathValue: string): void {
  container.textContent = "";

  if (isTaskMention(pathValue)) {
    const { title } = parseTaskToken(pathValue);

    const icon = document.createElement("span");
    icon.className = "inline-flex h-3 w-3 shrink-0 items-center justify-center text-muted";
    icon.innerHTML = TASK_ICON_SVG;

    const prefix = document.createElement("span");
    prefix.className = "text-muted";
    prefix.textContent = "task:";

    const label = document.createElement("span");
    label.className = "truncate";
    label.textContent = title;

    container.append(icon, prefix, label);
    return;
  }

  const icon = document.createElement("img");
  icon.alt = "";
  icon.ariaHidden = "true";
  icon.loading = "lazy";
  icon.className = "h-3 w-3 shrink-0 opacity-75";
  icon.src = getFileIconUrl(pathValue, inferEntryKind(pathValue), resolveTheme());

  const label = document.createElement("span");
  label.className = "truncate";
  label.textContent = basenameOfPath(pathValue);

  container.append(icon, label);
}

function appendTextWithBreaks(paragraph: LexicalNode, text: string): void {
  if (!$isElementNode(paragraph)) return;
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (line) {
      paragraph.append($createTextNode(line));
    }
    if (index < lines.length - 1) {
      paragraph.append($createLineBreakNode());
    }
  });
}

function $setComposerText(value: string): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  for (const segment of splitPromptIntoComposerSegments(value)) {
    if (segment.kind === "slash") {
      paragraph.append($createComposerSlashNode(segment.command));
      continue;
    }
    if (segment.kind === "mention") {
      paragraph.append($createComposerMentionNode(segment.path));
      continue;
    }
    appendTextWithBreaks(paragraph, segment.text);
  }
  root.append(paragraph);
  if (root.getChildrenSize() === 0) {
    root.append($createParagraphNode());
  }
}

function getNodeTextLength(node: LexicalNode): number {
  if ($isTextNode(node)) return node.getTextContentSize();
  if ($isLineBreakNode(node)) return 1;
  if ($isElementNode(node)) {
    return node.getChildren().reduce((total, child) => total + getNodeTextLength(child), 0);
  }
  return 0;
}

function getSelectionOffsetFromPoint(point: PointType): number {
  const node = point.getNode();
  let offset = 0;
  let current: LexicalNode | null = node;

  while (current) {
    const parent: LexicalNode | null = current.getParent();
    if (!parent || !$isElementNode(parent)) break;
    const siblings = parent.getChildren();
    const index = current.getIndexWithinParent();
    for (let i = 0; i < index; i += 1) {
      const sibling = siblings[i];
      if (sibling) offset += getNodeTextLength(sibling);
    }
    current = parent;
  }

  if ($isTextNode(node)) {
    return offset + Math.min(point.offset, node.getTextContentSize());
  }
  if ($isLineBreakNode(node)) {
    return offset + Math.min(point.offset, 1);
  }
  if ($isElementNode(node)) {
    const children = node.getChildren();
    for (let i = 0; i < point.offset; i += 1) {
      const child = children[i];
      if (child) offset += getNodeTextLength(child);
    }
  }
  return offset;
}

function findPointAtOffset(
  node: LexicalNode,
  remaining: { value: number },
): { key: string; offset: number; type: "text" | "element" } | null {
  if ($isTextNode(node)) {
    const length = node.getTextContentSize();
    if (remaining.value <= length) {
      return { key: node.getKey(), offset: remaining.value, type: "text" };
    }
    remaining.value -= length;
    return null;
  }

  if ($isLineBreakNode(node)) {
    const parent = node.getParent();
    if (!parent || !$isElementNode(parent)) return null;
    const index = node.getIndexWithinParent();
    if (remaining.value === 0) {
      return { key: parent.getKey(), offset: index, type: "element" };
    }
    if (remaining.value === 1) {
      return { key: parent.getKey(), offset: index + 1, type: "element" };
    }
    remaining.value -= 1;
    return null;
  }

  if ($isElementNode(node)) {
    const children = node.getChildren();
    for (const child of children) {
      const point = findPointAtOffset(child, remaining);
      if (point) return point;
    }
    if (remaining.value === 0) {
      return {
        key: node.getKey(),
        offset: children.length,
        type: "element",
      };
    }
  }

  return null;
}

function $setSelectionAtOffset(offset: number): void {
  const root = $getRoot();
  const point = findPointAtOffset(root, { value: offset });
  if (!point) {
    root.selectEnd();
    return;
  }
  const selection = $createRangeSelection();
  selection.anchor.set(point.key, point.offset, point.type);
  selection.focus.set(point.key, point.offset, point.type);
  $setSelection(selection);
}

function ComposerSyncPlugin({
  editorRef,
  value,
  selectionOffset,
  onSelectionApplied,
}: {
  editorRef: RefObject<LexicalEditor | null>;
  value: string;
  selectionOffset?: number | null;
  onSelectionApplied?: () => void;
}) {
  return (
    <SyncEffect
      editorRef={editorRef}
      value={value}
      selectionOffset={selectionOffset}
      onSelectionApplied={onSelectionApplied}
    />
  );
}

function SyncEffect({
  editorRef,
  value,
  selectionOffset,
  onSelectionApplied,
}: {
  editorRef: RefObject<LexicalEditor | null>;
  value: string;
  selectionOffset?: number | null;
  onSelectionApplied?: () => void;
}) {
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    editor.update(() => {
      const currentValue = $getRoot().getTextContent();
      if (currentValue !== value) {
        $setComposerText(value);
      }
    });
  }, [editorRef, value]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || selectionOffset == null) return;

    // Writing a DOM range into an unfocused contenteditable focuses it (and on
    // iOS raises the keyboard), so only sync the editor-state selection while the
    // editor is blurred; a later editor.focus() re-applies it to the DOM.
    const rootElement = editor.getRootElement();
    const editorHasFocus =
      !!rootElement &&
      document.activeElement !== null &&
      rootElement.contains(document.activeElement);
    editor.update(
      () => {
        $setSelectionAtOffset(selectionOffset);
      },
      editorHasFocus ? undefined : { tag: SKIP_DOM_SELECTION_TAG },
    );
    onSelectionApplied?.();
  }, [editorRef, onSelectionApplied, selectionOffset]);

  return null;
}

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(
  (
    {
      value,
      placeholder,
      placeholderClassName = "",
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
    const editorRef = useRef<LexicalEditor | null>(null);

    useImperativeHandle(ref, () => ({
      focus: () => {
        editorRef.current?.focus();
      },
    }));

    const initialConfig = useMemo<InitialConfigType>(
      () => ({
        namespace: "relay-composer",
        onError: (error) => {
          throw error;
        },
        nodes: [ComposerMentionNode, ComposerSlashNode],
      }),
      [],
    );

    const handleChange = (editorState: EditorState) => {
      editorState.read(() => {
        const nextValue = $getRoot().getTextContent();
        const selection = $getSelection();
        const offset = $isRangeSelection(selection)
          ? getSelectionOffsetFromPoint(selection.anchor)
          : nextValue.length;
        onChange(nextValue, offset);
      });
    };

    return (
      <LexicalComposer initialConfig={initialConfig}>
        <EditorRefPlugin editorRef={editorRef} />
        <ComposerSyncPlugin
          editorRef={editorRef}
          value={value}
          selectionOffset={selectionOffset}
          onSelectionApplied={onSelectionApplied}
        />
        <div className="relative">
          <PlainTextPlugin
            contentEditable={
              <ContentEditable
                aria-placeholder={placeholder}
                placeholder={() => null}
                className={className}
                spellCheck
                autoCorrect="on"
                autoCapitalize="sentences"
                inputMode="text"
                enterKeyHint="send"
                onKeyDown={onKeyDown}
                onPaste={onPaste}
              />
            }
            placeholder={
              <div
                className={`pointer-events-none absolute inset-0 select-none text-muted ${placeholderClassName}`}
              >
                {placeholder}
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <OnChangePlugin onChange={handleChange} ignoreHistoryMergeTagChange />
        <HistoryPlugin />
        {disabled ? <DisabledStatePlugin /> : null}
      </LexicalComposer>
    );
  },
);

ComposerEditor.displayName = "ComposerEditor";

function DisabledStatePlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.setEditable(false);
    return () => {
      editor.setEditable(true);
    };
  }, [editor]);

  return null;
}
