/**
 * Rich content renderers for individual tool-call activities.
 * Extracted from activity-entry for cleaner separation.
 */

import type { ReactNode } from "react";
import { useState } from "react";
import { ActivityCodeBlock, PatchDiffView, langFromPath } from "@/components/chat/activity-code";
import { ImageThumbnail } from "@/components/chat/markdown-content";
import type { EditToolInput, UserInputAnswer } from "@shared/types";
import { toggleAnswerSelection } from "@/lib/utils";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "heic",
  "heif",
  "avif",
  "ico",
]);

function isImagePath(path: string | undefined): path is string {
  if (!path) return false;
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = path.slice(dot + 1).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function ImagePreview({ path }: { path: string }) {
  const src = `/api/file?path=${encodeURIComponent(path)}`;
  const alt = path.split("/").pop() || "Image";
  // The path text is rendered above by ActivityCodeBlock, so hide the thumbnail
  // entirely if the file is gone — no need for a redundant "failed to load" message.
  return (
    <div className="mt-1.5">
      <ImageThumbnail src={src} alt={alt} hideOnError />
    </div>
  );
}

// ── AskUserQuestion ──────────────────────────────────────────────────

interface AskUserQuestionContentProps {
  input: Record<string, unknown>;
  onSendMessage?: (text: string) => void;
  onAnswerUserInput?: (
    requestId: string,
    answers: Record<string, UserInputAnswer>,
    text?: string,
  ) => void;
  isInteractive?: boolean;
  resolution?: "approved" | "dismissed" | "feedback";
}

export function AskUserQuestionContent({
  input,
  onSendMessage,
  onAnswerUserInput,
  isInteractive,
}: AskUserQuestionContentProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string[]>>({});
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [replyMode, setReplyMode] = useState(false);
  const [replyText, setReplyText] = useState("");
  const requestId = typeof input.requestId === "string" ? input.requestId : null;
  const questions = input.questions as
    | Array<{
        id?: string;
        question?: string;
        header?: string;
        options?: Array<{ label?: string; description?: string }>;
        multiSelect?: boolean;
        isOther?: boolean;
      }>
    | undefined;

  if (!questions?.length) return null;

  const isManagedPrompt = !!requestId && !!onAnswerUserInput;
  const canClick = isInteractive && !!onSendMessage && !isManagedPrompt && selectedKey === null;
  const canRespond = isInteractive && isManagedPrompt && !submitted;

  const answerForQuestion = (questionId: string) => {
    const selected = selectedAnswers[questionId] ?? [];
    const result: string[] = [];
    for (const label of selected) {
      if (label === "__other__") {
        const other = otherAnswers[questionId]?.trim();
        if (other) result.push(other);
      } else {
        result.push(label);
      }
    }
    return result;
  };

  const canSubmit =
    canRespond &&
    questions.every((question, index) => {
      const questionId = question.id || `question-${index}`;
      // "Other" picked but left blank isn't a real answer — require the text so
      // the choice isn't silently dropped when submitting.
      if (
        (selectedAnswers[questionId] ?? []).includes("__other__") &&
        !otherAnswers[questionId]?.trim()
      ) {
        return false;
      }
      return answerForQuestion(questionId).length > 0;
    });

  return (
    <div className="mt-2 flex flex-col gap-2">
      {questions.map((q, qi) => {
        const questionId = q.id || `question-${qi}`;
        const selectedForQuestion = selectedAnswers[questionId] ?? [];
        const showOther = q.isOther && selectedForQuestion.includes("__other__");

        return (
          <div key={qi} className="overflow-hidden rounded-lg border border-border">
            <div className="border-b border-border bg-panel-header px-3 py-2 text-[0.8125rem] font-medium text-text">
              {q.header && (
                <span className="mr-2 rounded-md bg-claude-dim px-2 py-0.5 text-[0.6875rem] font-medium text-claude">
                  {q.header}
                </span>
              )}
              {q.question}
              {q.multiSelect && isManagedPrompt && (
                <p className="mt-1 text-[0.6875rem] font-normal text-muted">
                  Select all that apply
                </p>
              )}
            </div>
            {q.options && (
              <div className="flex flex-col">
                {q.options.map((opt, oi) => {
                  const key = `${qi}-${oi}`;
                  const optionLabel = opt.label;
                  const isSelected = isManagedPrompt
                    ? !!optionLabel && selectedForQuestion.includes(optionLabel)
                    : selectedKey === key;
                  const isDimmed = !isManagedPrompt && selectedKey !== null && !isSelected;
                  return (
                    <div
                      key={oi}
                      className={`flex items-baseline gap-2.5 border-b border-border px-3 py-2 transition-all last:border-b-0 ${
                        canClick || canRespond ? "cursor-pointer hover:bg-accent/5" : ""
                      } ${isDimmed ? "opacity-35" : ""} ${isSelected ? "bg-accent/5" : ""}`}
                      onClick={
                        optionLabel
                          ? () => {
                              if (canClick) {
                                setSelectedKey(key);
                                setSubmitted(true);
                                onSendMessage!(optionLabel);
                                return;
                              }
                              if (canRespond) {
                                setSelectedAnswers((prev) => ({
                                  ...prev,
                                  [questionId]: toggleAnswerSelection(
                                    prev[questionId],
                                    optionLabel,
                                    q.multiSelect,
                                  ),
                                }));
                              }
                            }
                          : undefined
                      }
                    >
                      <span className="text-[0.75rem] tabular-nums text-muted/60">{oi + 1}.</span>
                      <span
                        className={`text-[0.8125rem] font-medium ${isSelected ? "text-accent" : "text-text"}`}
                      >
                        {opt.label}
                      </span>
                      {opt.description && (
                        <span className="text-[0.75rem] text-muted">{opt.description}</span>
                      )}
                      {isSelected && !isManagedPrompt && (
                        <span className="ml-auto rounded-md bg-accent/15 px-2 py-0.5 text-[0.6875rem] font-medium text-accent">
                          sent
                        </span>
                      )}
                    </div>
                  );
                })}
                {q.isOther && (
                  <div className="border-b border-border px-3 py-2 last:border-b-0">
                    <button
                      type="button"
                      className={`rounded-md px-2 py-1 text-[0.75rem] font-medium transition-colors ${
                        selectedForQuestion.includes("__other__")
                          ? "bg-accent/10 text-accent"
                          : "text-muted hover:bg-accent/5 hover:text-text"
                      }`}
                      onClick={
                        canRespond
                          ? () =>
                              setSelectedAnswers((prev) => ({
                                ...prev,
                                [questionId]: toggleAnswerSelection(
                                  prev[questionId],
                                  "__other__",
                                  q.multiSelect,
                                ),
                              }))
                          : undefined
                      }
                    >
                      Other
                    </button>
                    {showOther && (
                      <input
                        type="text"
                        value={otherAnswers[questionId] ?? ""}
                        onChange={(e) =>
                          setOtherAnswers((prev) => ({
                            ...prev,
                            [questionId]: e.target.value,
                          }))
                        }
                        placeholder="Type your answer"
                        className="mt-2 w-full rounded-lg border border-border bg-bg px-3 py-2 text-[0.8125rem] text-text placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent-dim focus:outline-none"
                      />
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {isManagedPrompt &&
        (canRespond || submitted) &&
        (replyMode ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Write your reply to send back to the agent…"
              rows={2}
              autoFocus
              disabled={!canRespond}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[0.8125rem] text-text placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent-dim focus:outline-none disabled:opacity-50"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!canRespond || !replyText.trim()}
                onClick={() => {
                  if (!requestId || !onAnswerUserInput) return;
                  setSubmitted(true);
                  onAnswerUserInput(requestId, {}, replyText.trim());
                }}
                className="rounded-lg bg-accent/10 px-3.5 py-1.5 text-[0.8125rem] font-medium text-accent transition-colors hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-30"
              >
                Send
              </button>
              <button
                type="button"
                onClick={() => setReplyMode(false)}
                className="rounded-lg px-3.5 py-1.5 text-[0.8125rem] font-medium text-muted transition-colors hover:bg-surface-hover hover:text-text"
              >
                Back
              </button>
              {submitted && (
                <span className="rounded-md bg-accent/15 px-2 py-0.5 text-[0.6875rem] font-medium text-accent">
                  sent
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => {
                if (!requestId || !onAnswerUserInput) return;
                const answers = Object.fromEntries(
                  questions.map((question, index) => {
                    const questionId = question.id || `question-${index}`;
                    return [questionId, { answers: answerForQuestion(questionId) }];
                  }),
                ) as Record<string, UserInputAnswer>;
                setSubmitted(true);
                onAnswerUserInput(requestId, answers);
              }}
              className="rounded-lg bg-accent/10 px-3.5 py-1.5 text-[0.8125rem] font-medium text-accent transition-colors hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-30"
            >
              Submit
            </button>
            <button
              type="button"
              disabled={!canRespond}
              onClick={() => setReplyMode(true)}
              className="rounded-lg px-3.5 py-1.5 text-[0.8125rem] font-medium text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-30"
            >
              Dismiss
            </button>
            {submitted && (
              <span className="rounded-md bg-accent/15 px-2 py-0.5 text-[0.6875rem] font-medium text-accent">
                sent
              </span>
            )}
          </div>
        ))}
    </div>
  );
}

// ── PermissionDenied ─────────────────────────────────────────────────

interface PermissionDeniedContentProps {
  tool: string;
  onApproveTool?: (tool: string) => void;
  isInteractive?: boolean;
  approvedTools?: Set<string>;
}

export function PermissionDeniedContent({
  tool,
  onApproveTool,
  isInteractive,
  approvedTools,
}: PermissionDeniedContentProps) {
  const [approved, setApproved] = useState(false);
  const alreadyApproved = approvedTools?.has(tool) ?? false;
  const canClick = isInteractive && !!onApproveTool && !approved && !alreadyApproved;

  return (
    <div className="mt-2 flex items-center gap-2">
      {canClick ? (
        <button
          onClick={() => {
            setApproved(true);
            onApproveTool!(tool);
          }}
          className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-1.5 text-[0.8125rem] font-medium text-warning transition-colors hover:border-warning/40 hover:bg-warning/15"
        >
          Allow {tool}
        </button>
      ) : approved || alreadyApproved ? (
        <span className="rounded-md bg-accent/15 px-2 py-0.5 text-[0.75rem] font-medium text-accent">
          Allowed
        </span>
      ) : null}
    </div>
  );
}

// ── ToolContent (rich body for expanded tool entries) ─────────────────

interface ToolContentProps {
  tool: string;
  input: Record<string, unknown>;
  resultDetail?: string;
  onSendMessage?: (text: string) => void;
  onAnswerUserInput?: (
    requestId: string,
    answers: Record<string, UserInputAnswer>,
    text?: string,
  ) => void;
  isInteractive?: boolean;
  resolution?: "approved" | "dismissed" | "feedback";
}

/** Simple labeled section (non-collapsible) — matches Kanna's MetaCodeBlock label pattern. */
function LabeledSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className="text-[0.625rem] font-medium text-muted/60">{label}</span>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

export function ToolContent({
  tool,
  input,
  resultDetail,
  onSendMessage,
  onAnswerUserInput,
  isInteractive,
  resolution,
}: ToolContentProps) {
  // Tools with custom renderers for their input
  const inputContent = (() => {
    switch (tool) {
      case "Edit": {
        const edit = input as unknown as EditToolInput;
        if (edit.diff) {
          return <PatchDiffView diff={edit.diff} label={edit.file_path} />;
        }
        // Fallback: raw old_string/new_string (legacy persisted data or unexpected input shape)
        const oldStr = (input as Record<string, unknown>).old_string as string | undefined;
        const newStr = (input as Record<string, unknown>).new_string as string | undefined;
        if (typeof oldStr === "string" && typeof newStr === "string") {
          const filePath = (input.file_path as string) || undefined;
          // Build a minimal unified diff from old/new strings
          const oldLines = oldStr.split("\n");
          const newLines = newStr.split("\n");
          const diffLines = [
            `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
            ...oldLines.map((l) => `-${l}`),
            ...newLines.map((l) => `+${l}`),
          ];
          return <PatchDiffView diff={diffLines.join("\n")} label={filePath} />;
        }
        return null;
      }
      case "Write": {
        const content = input.content as string | undefined;
        const diff = input.diff as string | undefined;
        const filePath = (input.file_path as string) || undefined;
        if (content) {
          return (
            <ActivityCodeBlock content={content} label={filePath} lang={langFromPath(filePath)} />
          );
        }
        if (diff) {
          return <PatchDiffView diff={diff} label={filePath} />;
        }
        return null;
      }
      case "Bash": {
        const command = input.command as string | undefined;
        if (command) {
          return <ActivityCodeBlock content={command} lang="bash" />;
        }
        return null;
      }
      case "Read": {
        const filePath = (input.file_path as string) || undefined;
        if (filePath) {
          const parts = [];
          if (input.offset) parts.push(`offset: ${input.offset}`);
          if (input.limit) parts.push(`limit: ${input.limit}`);
          const extra = parts.length > 0 ? ` (${parts.join(", ")})` : "";
          return (
            <>
              <ActivityCodeBlock content={filePath + extra} />
              {isImagePath(filePath) && <ImagePreview path={filePath} />}
            </>
          );
        }
        return null;
      }
      case "ViewImage": {
        const filePath = (input.file_path as string) || (input.path as string) || undefined;
        if (filePath) {
          return (
            <>
              <ActivityCodeBlock content={filePath} />
              <ImagePreview path={filePath} />
            </>
          );
        }
        return null;
      }
      case "GenerateImage": {
        const filePath = (input.file_path as string) || (input.path as string) || undefined;
        if (filePath) {
          return <ImagePreview path={filePath} />;
        }
        return null;
      }
      case "Grep": {
        const pattern = input.pattern as string | undefined;
        if (pattern) {
          const parts = [`pattern: ${pattern}`];
          if (input.path) parts.push(`path: ${input.path}`);
          if (input.glob) parts.push(`glob: ${input.glob}`);
          return <ActivityCodeBlock content={parts.join("\n")} />;
        }
        return null;
      }
      case "Glob": {
        const pattern = input.pattern as string | undefined;
        if (pattern) {
          const parts = [`pattern: ${pattern}`];
          if (input.path) parts.push(`path: ${input.path}`);
          return <ActivityCodeBlock content={parts.join("\n")} />;
        }
        return null;
      }
      case "Agent":
      case "Task": {
        const prompt = input.prompt as string | undefined;
        if (prompt) {
          return <ActivityCodeBlock content={prompt} />;
        }
        return null;
      }
      case "ExitPlanMode":
        return (
          <div className="mt-1.5">
            {resolution === "approved" && (
              <span className="inline-block w-fit rounded-md bg-accent/15 px-2 py-0.5 text-[0.75rem] font-medium text-accent">
                Approved
              </span>
            )}
            {(resolution === "feedback" || resolution === "dismissed") && (
              <span className="inline-block w-fit rounded-md bg-warning/15 px-2 py-0.5 text-[0.75rem] font-medium text-warning">
                {resolution === "dismissed" ? "Dismissed" : "Changes requested"}
              </span>
            )}
          </div>
        );
      case "AskUserQuestion":
        return (
          <AskUserQuestionContent
            input={input}
            onSendMessage={onSendMessage}
            onAnswerUserInput={onAnswerUserInput}
            isInteractive={isInteractive}
          />
        );
      default: {
        // Generic: show input parameters as JSON
        const keys = Object.keys(input);
        if (keys.length === 0) return null;
        const formatted = JSON.stringify(input, null, 2);
        return <ActivityCodeBlock content={formatted} lang="json" />;
      }
    }
  })();

  // Tools that handle their own full layout (interactive tools)
  const isInteractiveTool = tool === "AskUserQuestion" || tool === "ExitPlanMode";
  if (isInteractiveTool) return inputContent;

  const hasResult = !!resultDetail;

  // Edit: just the diff. The result ("file updated successfully") is noise.
  if (tool === "Edit") return inputContent;

  // Write: show the created file content when available, otherwise fall back
  // to the patch diff for providers that only emit diff-style payloads.
  if (tool === "Write") return inputContent;

  // Bash: labeled Command + Result sections (like Kanna).
  if (tool === "Bash") {
    return (
      <div className="flex flex-col gap-2">
        {inputContent && <LabeledSection label="Command">{inputContent}</LabeledSection>}
        {hasResult ? (
          <LabeledSection label="Result">
            <ActivityCodeBlock content={resultDetail!} />
          </LabeledSection>
        ) : (
          <LabeledSection label="Result">
            <div className="text-[0.625rem] text-muted/50 italic">No output</div>
          </LabeledSection>
        )}
      </div>
    );
  }

  // Other tools with results: show result directly (input is captured by the header name).
  if (hasResult) {
    return <ActivityCodeBlock content={resultDetail!} />;
  }

  // No result yet — show the input content directly
  return inputContent;
}
