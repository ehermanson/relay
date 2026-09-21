import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, Brain, ShieldAlert, CircleX, CircleCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { EditToolInput, UserInputAnswer } from "@shared/types";
import type { ActivityKind, Resolution, ResultStatus } from "@/lib/chat-types";
import { getToolIcon } from "@/lib/tool-icons";
import { FileIcon } from "@/components/ui/file-icon";
import { ToolContent } from "@/components/chat/tool-content";
import { PermissionDeniedContent } from "@/components/chat/tool-content";

interface ActivityEntryProps {
  activity: ActivityKind;
  description: string;
  tool?: string;
  detail?: string;
  input?: Record<string, unknown>;
  inputDescription?: string;
  collapsed?: boolean;
  onSendMessage?: (text: string) => void;
  onAnswerUserInput?: (
    requestId: string,
    answers: Record<string, UserInputAnswer>,
    text?: string,
  ) => void;
  isInteractive?: boolean;
  permissionDenied?: string;
  onApproveTool?: (tool: string) => void;
  approvedTools?: Set<string>;
  isExternalPending?: boolean;
  resolution?: Resolution;
  /** Merged result status from the paired tool_result. */
  resultStatus?: ResultStatus;
  /** Merged result detail from the paired tool_result. */
  resultDetail?: string;
  /** SDK-reported reason a tool was not executed (denied, interrupted, cancelled). */
  toolResultMeta?: { nonExecutionKind?: string; userFeedback?: string };
}

/** Tools where we show a file-type icon instead of the generic tool icon. */
const FILE_TOOLS = new Set(["Edit", "Write", "Read", "ViewImage"]);

function ActivityIcon({
  activity,
  tool,
  resultStatus,
  isPermDenied,
  filePath,
}: {
  activity: ActivityKind;
  tool?: string;
  resultStatus?: ResultStatus;
  isPermDenied?: boolean;
  /** When set and the tool is a file tool, renders the file-type icon (grayscale). */
  filePath?: string;
}) {
  // For file tools with a known path, show the file-type icon instead of a Lucide icon.
  if (filePath && tool && FILE_TOOLS.has(tool) && !isPermDenied && activity !== "tool_result") {
    return (
      <FileIcon
        path={filePath}
        size={12}
        className="mt-[3px] shrink-0 !opacity-100 ![filter:grayscale(1)]"
      />
    );
  }

  let Icon: LucideIcon;
  let colorClass: string;

  if (isPermDenied) {
    Icon = ShieldAlert;
    colorClass = "text-warning/50";
  } else if (activity === "tool_result") {
    Icon = resultStatus === "error" ? CircleX : CircleCheck;
    colorClass = resultStatus === "error" ? "text-error/50" : "text-accent/40";
  } else if (activity === "thinking") {
    Icon = Brain;
    colorClass = "text-claude/40";
  } else if (resultStatus === "error") {
    Icon = getToolIcon(tool);
    colorClass = "text-error/50";
  } else if (resultStatus === "success") {
    Icon = getToolIcon(tool);
    colorClass = "text-accent/40";
  } else {
    Icon = getToolIcon(tool);
    colorClass = "text-muted/35";
  }

  return <Icon size={12} className={`mt-[3px] shrink-0 ${colorClass}`} />;
}

/**
 * Compute a single clean display name for a tool call, following Kanna's pattern:
 * one descriptive string that communicates what happened, no secondary detail.
 */
function computeDisplayName(
  tool: string | undefined,
  description: string,
  detail: string | undefined,
  inputDescription: string | undefined,
): string {
  if (!tool || !detail) return description;
  switch (tool) {
    case "Bash":
      // Human description first, fall back to truncated command
      if (inputDescription) return inputDescription;
      return detail.length > 60 ? detail.slice(0, 60) + "\u2026" : detail;
    case "Edit":
      if (inputDescription) return `Edit ${inputDescription}`;
      return `Edit ${detail.split("/").pop() || detail}`;
    case "Write":
    case "Read": {
      if (inputDescription) {
        const verb = tool === "Write" ? "Write" : "Read";
        return `${verb} ${inputDescription}`;
      }
      const fileName = detail.split("/").pop() || detail;
      const verb = tool === "Write" ? "Write" : "Read";
      return `${verb} ${fileName}`;
    }
    case "ViewImage": {
      if (inputDescription) return `View ${inputDescription}`;
      const fileName = detail.split("/").pop() || detail;
      return `View ${fileName}`;
    }
    case "Grep":
      return `Find \`${detail}\` in files`;
    case "Glob":
      return `Search files matching ${detail}`;
    case "Agent":
    case "Task":
      if (inputDescription) return inputDescription;
      if (detail) return detail;
      return description;
    default:
      return description;
  }
}

export function ActivityEntry({
  activity,
  description,
  tool,
  detail,
  input,
  inputDescription,
  collapsed,
  onSendMessage,
  onAnswerUserInput,
  isInteractive,
  permissionDenied,
  onApproveTool,
  approvedTools,
  isExternalPending,
  resolution,
  resultStatus,
  resultDetail,
  toolResultMeta,
}: ActivityEntryProps) {
  const hasRichContent = !!tool && (!!input || !!detail || !!resultDetail);
  const isPermDenied = !!permissionDenied;
  const defaultExpanded =
    isPermDenied || (hasRichContent && (tool === "AskUserQuestion" || tool === "GenerateImage"));
  const [expanded, setExpanded] = useState(defaultExpanded);
  // Lazy-mount: only render content once it's been expanded at least once,
  // so collapsed-by-default items don't pay the render cost.
  const hasBeenExpanded = useRef(defaultExpanded);
  if (expanded) hasBeenExpanded.current = true;

  const isError = description === "Tool error";
  const displayName = computeDisplayName(tool, description, detail, inputDescription);
  const edit = tool === "Edit" && input ? (input as unknown as EditToolInput) : null;
  const hasEditCounts =
    edit != null && (typeof edit.additions === "number" || typeof edit.deletions === "number");

  // Extract file path for file-tool icon rendering
  const filePath =
    tool && FILE_TOOLS.has(tool) && input
      ? (((input as Record<string, unknown>).file_path as string | undefined) ?? detail)
      : undefined;

  // Any tool call with input is expandable — the generic JSON fallback in
  // ToolContent handles tools without a custom renderer.
  const isExpandable = isPermDenied || hasRichContent;

  return (
    <div className={`flex flex-col ${collapsed ? "hidden" : ""}`}>
      <div
        className={`group/entry flex items-start gap-2.5 rounded-md py-1 text-[0.6875rem] leading-relaxed text-muted max-[768px]:py-2 ${
          isError ? "bg-error-dim" : ""
        } ${isExpandable ? "cursor-pointer" : ""}`}
        onClick={isExpandable ? () => setExpanded(!expanded) : undefined}
      >
        <ActivityIcon
          activity={activity}
          tool={tool}
          resultStatus={resultStatus}
          isPermDenied={isPermDenied}
          filePath={filePath}
        />
        <span
          className={`min-w-0 truncate text-[0.6875rem] ${
            isError
              ? "font-medium text-error"
              : isExpandable
                ? "transition-colors duration-150 group-hover/entry:text-text-bright"
                : ""
          }`}
        >
          {displayName}
        </span>
        {hasEditCounts ? (
          <span className="shrink-0 text-[0.6875rem] font-medium tabular-nums">
            <span className="text-green-400">+{edit!.additions ?? 0}</span>
            <span className="text-muted/40"> / </span>
            <span className="text-red-400">-{edit!.deletions ?? 0}</span>
          </span>
        ) : null}
        {isExternalPending && (
          <span className="shrink-0 whitespace-nowrap rounded-md bg-claude-dim px-1.5 py-0.5 text-[0.625rem] font-medium text-claude">
            Pending in terminal
          </span>
        )}
        {toolResultMeta?.nonExecutionKind && (
          <span className="shrink-0 whitespace-nowrap rounded-md bg-muted/10 px-1.5 py-0.5 text-[10px] font-medium text-muted/70">
            {toolResultMeta.nonExecutionKind.replace(/_/g, " ")}
          </span>
        )}
        {isExpandable && (
          <ChevronRight
            size={10}
            className={`mt-[5px] shrink-0 text-muted/40 transition-all duration-200 ${
              expanded ? "rotate-90 opacity-100" : "opacity-0 group-hover/entry:opacity-100"
            }`}
          />
        )}
      </div>
      {/* Expanded content — smooth animated open/close */}
      <AnimatePresence initial={false}>
        {expanded && hasRichContent && hasBeenExpanded.current && (
          <motion.div
            key="tool-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] },
              opacity: { duration: 0.15 },
            }}
            className="overflow-hidden"
          >
            <div className="pl-[18px] pr-2 pb-1.5">
              <ToolContent
                tool={tool!}
                input={input ?? (detail ? { input: detail } : {})}
                resultDetail={resultDetail}
                resultStatus={resultStatus}
                onSendMessage={onSendMessage}
                onAnswerUserInput={onAnswerUserInput}
                isInteractive={isInteractive}
                resolution={resolution}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {expanded && isPermDenied && (
          <motion.div
            key="perm-denied"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] },
              opacity: { duration: 0.15 },
            }}
            className="overflow-hidden"
          >
            <div className="pl-[18px] pr-2 pb-1.5">
              <PermissionDeniedContent
                tool={permissionDenied!}
                onApproveTool={onApproveTool}
                isInteractive={isInteractive}
                approvedTools={approvedTools}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
