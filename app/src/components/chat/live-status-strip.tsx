import { useState, useEffect, useRef } from "react";
import { AlertTriangle, Clock, Cog } from "lucide-react";
import type { LiveActivity } from "@/lib/chat-types";
import { formatElapsed } from "@/lib/utils";

interface LiveStatusStripProps {
  activity: LiveActivity | null;
  processingStartedAt: number | null;
  isProcessing: boolean;
  instanceStatus?: string;
  isCompacting?: boolean;
}

export function LiveStatusStrip({
  activity,
  processingStartedAt,
  isProcessing,
  instanceStatus,
  isCompacting,
}: LiveStatusStripProps) {
  const showStrip = isProcessing || instanceStatus === "processing";
  const [now, setNow] = useState(Date.now);
  const lastEventRef = useRef(Date.now());

  // Tick every second while visible
  useEffect(() => {
    if (!showStrip) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [showStrip]);

  // Track when we last received an activity update (for stale detection)
  useEffect(() => {
    if (activity) {
      lastEventRef.current = Date.now();
    }
  }, [activity?.description, activity?.tool]);

  if (!showStrip) return null;

  const silenceMs = now - lastEventRef.current;
  const isStale = silenceMs > 15_000;
  const isVeryStale = silenceMs > 60_000;

  // Elapsed since the turn started (not per-activity)
  const elapsedMs = processingStartedAt ? now - processingStartedAt : 0;

  // Description text
  let description: string;
  if (isCompacting && isVeryStale) {
    description = "No compaction activity for " + formatElapsed(silenceMs);
  } else if (isCompacting && isStale) {
    description = "Still compacting context...";
  } else if (isCompacting) {
    description = "Compacting context...";
  } else if (isVeryStale) {
    description = "Still working...";
  } else if (isStale) {
    description = "Still working...";
  } else if (activity?.phase === "thinking" || activity?.phase === "starting") {
    description = "Thinking...";
  } else {
    description = "Working...";
  }

  return (
    <div className="flex items-center gap-2.5 px-1 py-2">
      {/* Icon */}
      <div className="flex items-center justify-center">
        {isVeryStale ? (
          <AlertTriangle size={14} className="shrink-0 text-warning" />
        ) : isStale ? (
          <Clock size={14} className="shrink-0 animate-pulse text-muted" />
        ) : (
          <Cog size={14} className="shrink-0 animate-spin text-muted [animation-duration:3s]" />
        )}
      </div>

      {/* Description */}
      <span
        className={`min-w-0 truncate text-[0.8125rem] ${
          isVeryStale ? "text-warning" : "text-muted"
        }`}
      >
        {description}
      </span>

      {/* Elapsed timer — hidden on mobile to save space */}
      {elapsedMs >= 1000 && (
        <span className="hidden shrink-0 tabular-nums text-[0.75rem] text-muted/50 sm:inline">
          {formatElapsed(elapsedMs)}
        </span>
      )}
    </div>
  );
}
