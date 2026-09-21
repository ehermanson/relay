import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export interface SidecarTabDef {
  key: string;
  label: string;
  count?: number;
}

interface SidecarShellProps {
  tabs: SidecarTabDef[];
  activeTab: string;
  onActiveTabChange: (key: string) => void;
  renderTabContent: (key: string) => ReactNode;
  isMobileOverlay?: boolean;
  onClose?: () => void;
}

/**
 * Shared chrome for the chat sidecar and space sidebar: outer container,
 * tab header, tab switching, and content slot. Callers build the tab list
 * and render content per active tab key.
 */
export function SidecarShell({
  tabs,
  activeTab,
  onActiveTabChange,
  renderTabContent,
  isMobileOverlay,
  onClose,
}: SidecarShellProps) {
  const effectiveTab = tabs.find((t) => t.key === activeTab)?.key ?? tabs[0]?.key ?? "";

  return (
    <div
      className={
        isMobileOverlay
          ? "@container/sidecar animate-slide-in-right flex min-h-0 flex-1 w-[85vw] max-w-sm flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
          : "@container/sidecar flex h-full w-full flex-col overflow-hidden bg-transparent"
      }
    >
      <div className="flex shrink-0 items-center border-b border-border/60">
        <div className="flex min-w-0 flex-1 items-stretch">
          {tabs.map((tab) => {
            const isActive = tab.key === effectiveTab;
            const isSingle = tabs.length === 1;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => !isSingle && onActiveTabChange(tab.key)}
                className={`relative flex min-w-0 items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
                  isSingle
                    ? "cursor-default border-transparent text-text-bright"
                    : isActive
                      ? "flex-1 justify-center border-accent text-text-bright"
                      : "flex-1 justify-center border-transparent text-muted hover:text-text"
                }`}
              >
                <span className="truncate">{tab.label}</span>
                {tab.count !== undefined && tab.count > 0 && (
                  <span
                    className={`shrink-0 text-[0.6875rem] tabular-nums ${
                      isActive || isSingle ? "text-muted" : "text-muted/60"
                    }`}
                  >
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {onClose && (
          <Button variant="icon" size="icon-sm" onClick={onClose} className="mr-2 shrink-0">
            <X size={14} />
          </Button>
        )}
      </div>

      {renderTabContent(effectiveTab) ?? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner size={16} />
        </div>
      )}
    </div>
  );
}
