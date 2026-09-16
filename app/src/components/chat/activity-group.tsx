import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronRight } from "lucide-react";
import { ActivityEntry } from "./activity-entry";
import type { MergedActivity } from "@/lib/chat-types";
import { INTERACTIVE_TOOLS } from "@shared/tools";

const VISIBLE_COUNT = 3;

interface ActivityGroupProps {
  activities: MergedActivity[];
  onSendMessage?: (text: string) => void;
  onAnswerUserInput?: (
    requestId: string,
    answers: Record<string, import("@shared/types").UserInputAnswer>,
    text?: string,
  ) => void;
  isInteractive?: boolean;
  onApproveTool?: (tool: string) => void;
  approvedTools?: Set<string>;
  isExternal?: boolean;
  /** Resolution from a tool_result in the next activity group (cross-group). */
  trailingResolution?: "approved" | "dismissed" | "feedback";
  /** Hide the leading tool_result (consumed by the previous group's resolution). */
  skipLeadingResult?: boolean;
  planChildId?: string;
  planChildName?: string;
}

export function ActivityGroup({
  activities,
  onSendMessage,
  onAnswerUserInput,
  isInteractive,
  onApproveTool,
  approvedTools,
  isExternal,
  trailingResolution,
  skipLeadingResult,
  planChildId,
  planChildName,
}: ActivityGroupProps) {
  const [expanded, setExpanded] = useState(false);

  // Only show Allow button on the last denial per tool in this group
  const lastDenialIndex = new Map<string, number>();
  activities.forEach((act, i) => {
    if (act.permissionDenied) lastDenialIndex.set(act.permissionDenied, i);
  });

  // Hide earlier denied attempts when the same tool was retried within this group.
  const superseded = new Set<number>();
  for (const [tool, lastIdx] of lastDenialIndex) {
    activities.forEach((act, i) => {
      if (i >= lastIdx) return;
      if (act.permissionDenied === tool) {
        superseded.add(i);
        if (i > 0 && activities[i - 1].activity === "tool_use" && activities[i - 1].tool === tool) {
          superseded.add(i - 1);
        }
      }
    });
  }

  // Detect interactive tool_uses resolved from the terminal.
  const resolvedInteractive = new Map<number, "approved" | "dismissed" | "feedback">();
  const hiddenResults = new Set<number>();
  let lastInteractiveIdx = -1;
  for (let i = 0; i < activities.length; i++) {
    const act = activities[i];
    if (act.activity === "tool_use" && INTERACTIVE_TOOLS.has(act.tool || "")) {
      lastInteractiveIdx = i;
    } else if (act.activity === "tool_result" && lastInteractiveIdx >= 0) {
      resolvedInteractive.set(lastInteractiveIdx, act.resolution || "approved");
      hiddenResults.add(i);
      lastInteractiveIdx = -1;
    }
  }

  // Cross-group resolution: the tool_result landed in the NEXT activity group.
  if (lastInteractiveIdx >= 0 && trailingResolution) {
    resolvedInteractive.set(lastInteractiveIdx, trailingResolution);
  }

  // Hide a leading tool_result that was consumed by the previous group's resolution.
  if (skipLeadingResult && activities[0]?.activity === "tool_result") {
    hiddenResults.add(0);
  }

  // Hide any remaining standalone tool_result entries that weren't merged at the
  // data level (permission denied results are kept, interactive results handled above).
  for (let i = 0; i < activities.length; i++) {
    const act = activities[i];
    if (act.activity !== "tool_result") continue;
    if (hiddenResults.has(i) || superseded.has(i)) continue;
    if (act.permissionDenied) continue;
    // This result wasn't merged at the data level — hide it
    hiddenResults.add(i);
  }

  // Hide known progress-update entries (emitted by the server
  // for long-running Bash commands as "Running... Ns"). Once the real result is
  // merged into the original tool_use (which has `input`), these are stale noise.
  for (let i = 0; i < activities.length; i++) {
    const act = activities[i];
    if (act.activity !== "tool_use" || act.input || !act.description.startsWith("Running... "))
      continue;
    // Missing input alone does not imply progress: custom tools may lack arguments.
    hiddenResults.add(i);
  }

  // Build visible list preserving original indices for key stability
  const visible = activities
    .map((act, i) => ({ act, origIndex: i }))
    .filter(({ origIndex }) => !superseded.has(origIndex) && !hiddenResults.has(origIndex));

  const hiddenCount = visible.length - VISIBLE_COUNT;
  const rendered = hiddenCount > 0 && !expanded ? visible.slice(hiddenCount) : visible;

  return (
    <div className="flex flex-col gap-px">
      <AnimatePresence initial={false}>
        {hiddenCount > 0 && (
          <motion.div
            key="expand-btn"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1.5 border-none bg-transparent py-0.5 text-[0.625rem] uppercase tracking-[0.12em] text-muted/55 transition-colors duration-150 hover:text-muted/80 max-[768px]:py-1.5"
            >
              <ChevronRight
                size={8}
                strokeWidth={2.5}
                className={`transition-transform ${expanded ? "rotate-90" : ""}`}
              />
              {expanded ? "Show less" : `${hiddenCount} more`}
            </button>
          </motion.div>
        )}
        {rendered.map(({ act, origIndex }, vi) => {
          const isLastDenialForTool =
            act.permissionDenied && lastDenialIndex.get(act.permissionDenied) === origIndex;

          const isPendingInTerminal =
            isExternal &&
            act.activity === "tool_use" &&
            vi === rendered.length - 1 &&
            INTERACTIVE_TOOLS.has(act.tool || "") &&
            act.tool !== "EnterPlanMode" &&
            act.tool !== "ExitPlanMode";
          return (
            <motion.div
              key={`activity-${origIndex}`}
              initial={{ opacity: 0, height: 0, scale: 0.95 }}
              animate={{ opacity: 1, height: "auto", scale: 1 }}
              exit={{ opacity: 0, height: 0, scale: 0.95 }}
              transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              style={{ transformOrigin: "top center" }}
              className="overflow-hidden"
            >
              <ActivityEntry
                activity={act.activity}
                description={act.description}
                tool={act.tool}
                detail={act.detail}
                input={act.input}
                inputDescription={act.inputDescription}
                isExternalPending={isPendingInTerminal}
                resultStatus={act.mergedResultStatus}
                resultDetail={act.mergedResultDetail}
                toolResultMeta={act.toolResultMeta}
                {...(act.tool === "AskUserQuestion" || act.tool === "ExitPlanMode"
                  ? {
                      onSendMessage,
                      onAnswerUserInput,
                      isInteractive: resolvedInteractive.has(origIndex) ? false : isInteractive,
                      resolution: resolvedInteractive.get(origIndex),
                      ...(act.tool === "ExitPlanMode" ? { planChildId, planChildName } : {}),
                    }
                  : {})}
                {...(act.permissionDenied
                  ? {
                      permissionDenied: act.permissionDenied,
                      isInteractive,
                      approvedTools,
                      onApproveTool: isLastDenialForTool ? onApproveTool : undefined,
                    }
                  : {})}
              />
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
