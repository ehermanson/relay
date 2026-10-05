import { useEffect, useState } from "react";
import { Check, FilePenLine, GitBranch } from "lucide-react";
import type {
  ProviderKind,
  ProviderModelOptions,
  ProviderRuntimeMode,
  ReasoningEffort,
  ReviewSessionInfo,
} from "@shared/types";
import { getProviderDisplayName } from "@shared/provider-catalog";
import { Button } from "@/components/ui/button";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { useAvailableProviders } from "@/hooks/use-available-providers";
import { useProviderModels } from "@/hooks/use-provider-models";

function OptionTag({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[0.6875rem] font-medium transition-colors ${
        selected
          ? "border-accent bg-accent/10 text-accent"
          : "border-border bg-bg text-text hover:border-border-hover hover:bg-surface-hover/60"
      }`}
    >
      {selected && <Check size={10} strokeWidth={2.5} className="shrink-0" />}
      {label}
    </button>
  );
}

interface ReviewSetupPanelProps {
  initialProvider: ProviderKind;
  initialModel?: string;
  initialModelOptions?: ProviderModelOptions;
  initialRuntimeMode?: ProviderRuntimeMode;
  sourceFileCount: number;
  onStartReview: (selection: {
    scope: ReviewSessionInfo["scope"];
    provider: ProviderKind;
    model?: string;
    modelOptions?: ProviderModelOptions;
    runtimeMode?: ProviderRuntimeMode;
    instructions?: string;
  }) => void | Promise<void>;
  isSubmitting?: boolean;
  onCancel?: () => void;
}

export function ReviewSetupPanel({
  initialProvider,
  initialModel,
  initialModelOptions,
  initialRuntimeMode,
  sourceFileCount,
  onStartReview,
  isSubmitting,
  onCancel,
}: ReviewSetupPanelProps) {
  const { providers } = useAvailableProviders();
  const [scope, setScope] = useState<ReviewSessionInfo["scope"]>(
    sourceFileCount > 0 ? "session-files" : "branch",
  );
  const [provider, setProvider] = useState<ProviderKind>(initialProvider);
  const [model, setModel] = useState<string | undefined>(initialModel);
  const [modelOptions, setModelOptions] = useState<ProviderModelOptions | undefined>(
    initialModelOptions,
  );
  const [runtimeMode] = useState<ProviderRuntimeMode | undefined>(initialRuntimeMode);
  const [instructions, setInstructions] = useState("");
  const {
    availableProviderModels: visibleModels,
    capabilities,
    defaultModel,
  } = useProviderModels(provider);
  const defaultModelId = defaultModel?.id;
  const effortLevels = capabilities.reasoningEffortLevels ?? [];
  const sessionFilesUnavailable = sourceFileCount === 0;

  useEffect(() => {
    setScope(sourceFileCount > 0 ? "session-files" : "branch");
  }, [sourceFileCount]);

  const handleProviderChange = (nextProvider: ProviderKind) => {
    setProvider(nextProvider);
    setModel(undefined);
    setModelOptions(undefined);
  };

  const multipleProviders = providers.length > 1;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="grid gap-4">
          {/* ── Scope ──────────────────────────────────── */}
          <section className="grid gap-2">
            <div className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-muted">
              Scope
            </div>
            <div className="grid gap-1.5">
              <button
                type="button"
                onClick={() => !sessionFilesUnavailable && setScope("session-files")}
                disabled={sessionFilesUnavailable}
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors ${
                  sessionFilesUnavailable
                    ? "cursor-not-allowed border-border/60 opacity-50"
                    : scope === "session-files"
                      ? "border-accent bg-accent/5"
                      : "border-border hover:border-border-hover hover:bg-surface-hover/40"
                }`}
              >
                <FilePenLine size={13} strokeWidth={1.75} className="shrink-0 text-muted" />
                <span className="flex-1 font-medium text-text">Session files</span>
                {sessionFilesUnavailable && (
                  <span className="text-[0.625rem] text-muted">
                    No files attributed to this chat yet
                  </span>
                )}
                {sourceFileCount > 0 && (
                  <span
                    className={`rounded-md px-1.5 py-px text-[0.625rem] tabular-nums ${
                      scope === "session-files"
                        ? "bg-accent/15 text-accent"
                        : "bg-surface-hover text-muted"
                    }`}
                  >
                    {sourceFileCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setScope("branch")}
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors ${
                  scope === "branch"
                    ? "border-accent bg-accent/5"
                    : "border-border hover:border-border-hover hover:bg-surface-hover/40"
                }`}
              >
                <GitBranch size={13} strokeWidth={1.75} className="shrink-0 text-muted" />
                <span className="flex-1 font-medium text-text">Whole branch</span>
              </button>
            </div>
          </section>

          {/* ── Additional instructions (optional) ────── */}
          <section className="grid gap-2">
            <div className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-muted">
              Additional Instructions
            </div>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="What to focus on, things to look out for, extra context…"
              rows={3}
              className="w-full resize-y rounded-lg border border-border bg-bg px-2.5 py-2 text-xs text-text placeholder:text-muted/70 focus:border-accent focus:outline-none"
            />
          </section>

          {/* ── Reviewer ──────────────────────────────── */}
          <section className="grid gap-2">
            <div className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-muted">
              Reviewer
            </div>
            <div className="grid gap-2.5">
              {multipleProviders && (
                <div className="flex flex-wrap gap-1.5">
                  {providers.map((p) => (
                    <button
                      key={p.provider}
                      type="button"
                      onClick={() => handleProviderChange(p.provider)}
                      className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                        provider === p.provider
                          ? "border-accent bg-accent/5 text-text"
                          : "border-border hover:border-border-hover hover:bg-surface-hover/40 text-muted"
                      }`}
                    >
                      <ProviderLogo provider={p.provider} className="h-3.5 w-3.5 shrink-0" />
                      {p.provider === "claude" ? "Claude" : getProviderDisplayName(p.provider)}
                    </button>
                  ))}
                </div>
              )}

              <div className="grid gap-1">
                <div className="flex items-center gap-1.5 text-[0.6875rem] text-muted">
                  {!multipleProviders && <ProviderLogo provider={provider} className="h-3 w-3" />}
                  Model
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {visibleModels.map((m) => {
                    const isSelected = model ? model === m.id : m.id === defaultModelId;
                    return (
                      <OptionTag
                        key={m.id}
                        label={m.label}
                        selected={isSelected}
                        onClick={() => setModel(m.id === defaultModelId ? undefined : m.id)}
                      />
                    );
                  })}
                </div>
              </div>

              {effortLevels.length > 0 && (
                <div className="grid gap-1">
                  <div className="text-[0.6875rem] text-muted">Reasoning</div>
                  <div className="flex flex-wrap gap-1.5">
                    {effortLevels.map((level) => {
                      const isSelected = modelOptions?.reasoningEffort
                        ? modelOptions.reasoningEffort === level.effort
                        : !!level.isDefault;
                      return (
                        <OptionTag
                          key={level.effort}
                          label={level.label}
                          selected={isSelected}
                          onClick={() =>
                            setModelOptions((prev) => ({
                              ...prev,
                              reasoningEffort: level.isDefault
                                ? undefined
                                : (level.effort as ReasoningEffort),
                            }))
                          }
                        />
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      {/* ── Footer ───────────────────────────────────── */}
      <div className="shrink-0 border-t border-border/60 px-3 py-2.5">
        <div className={`flex gap-2 ${onCancel ? "" : "flex-col"}`}>
          {onCancel ? (
            <Button variant="ghost" onClick={onCancel} disabled={isSubmitting} className="flex-1">
              Cancel
            </Button>
          ) : null}
          <Button
            variant="primary"
            className="flex-1"
            disabled={!!isSubmitting || (scope === "session-files" && sessionFilesUnavailable)}
            onClick={() =>
              onStartReview({
                scope,
                provider,
                model,
                modelOptions,
                runtimeMode,
                instructions: instructions.trim() || undefined,
              })
            }
          >
            {isSubmitting ? "Starting…" : "Start review"}
          </Button>
        </div>
      </div>
    </div>
  );
}
