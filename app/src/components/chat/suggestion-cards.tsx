import { useState } from "react";
import { X, Sparkles, Settings } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import type { ResolvedSuggestion } from "@shared/types";
import { getSuggestionIcon } from "@/lib/suggestion-icons";

interface SuggestionCardsProps {
  suggestions: ResolvedSuggestion[];
  /** Called when a suggestion is selected — parent should pre-fill the composer. */
  onSelect: (prompt: string) => void;
  /** Optional link target for the settings gear icon. */
  onOpenSettings?: () => void;
  /** Visually dim the cards (e.g., when the user has started composing). */
  dimmed?: boolean;
}

export function SuggestionCards({
  suggestions,
  onSelect,
  onOpenSettings,
  dimmed,
}: SuggestionCardsProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || suggestions.length === 0) return null;

  return (
    <AnimatePresence>
      <motion.div
        className="flex w-full flex-col items-end gap-3 px-1"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: dimmed ? 0.45 : 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.25, ease: "easeOut" }}
      >
        <div className="flex items-center gap-2">
          <Sparkles size={11} className="text-muted/50" />
          <span className="text-[0.6875rem] text-muted/60">Suggestions</span>
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="ml-0.5 rounded p-0.5 text-muted/40 transition-colors hover:bg-surface-hover hover:text-muted"
              title="Suggestion settings"
            >
              <Settings size={11} />
            </button>
          )}
          <button
            onClick={() => setDismissed(true)}
            className="ml-0.5 rounded p-0.5 text-muted/40 transition-colors hover:bg-surface-hover hover:text-muted"
          >
            <X size={11} />
          </button>
        </div>

        <div className="grid w-full grid-cols-2 gap-1.5 mb-3">
          {suggestions.map((suggestion, i) => {
            const Icon = getSuggestionIcon(suggestion.icon);
            return (
              <motion.button
                key={suggestion.id}
                onClick={() => onSelect(suggestion.prompt)}
                className="group flex items-start gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-left transition-colors hover:border-border-hover hover:bg-surface-hover"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: i * 0.04 }}
              >
                <Icon
                  size={14}
                  strokeWidth={1.75}
                  className="mt-px shrink-0 text-muted/60 transition-colors group-hover:text-accent"
                />
                <div className="flex flex-col gap-px min-w-0">
                  <span className="text-[0.75rem] font-medium leading-snug text-text-bright">
                    {suggestion.label}
                  </span>
                  <span className="text-[0.6875rem] leading-snug text-muted">
                    {suggestion.description}
                  </span>
                </div>
              </motion.button>
            );
          })}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
