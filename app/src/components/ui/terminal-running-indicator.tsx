import { Terminal } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { useTerminalStore, scopeKey } from "@/stores/terminal-store";
import type { TerminalScope } from "@shared/types";

/**
 * Sidebar badge that flags a chat with live (running) terminals.
 *
 * Reads the global per-scope live-terminal count maintained by the
 * `terminal_scopes` broadcast, so it lights up even for scopes the user
 * hasn't opened yet — useful for finding where a dev server was spun up.
 * Renders nothing when the scope has no live terminals.
 */
export function TerminalRunningIndicator({
  scope,
  active = false,
}: {
  scope: TerminalScope;
  active?: boolean;
}) {
  const count = useTerminalStore((s) => s.activeScopeCounts[scopeKey(scope)] ?? 0);
  if (count <= 0) return null;

  const label = count === 1 ? "1 terminal running" : `${count} terminals running`;

  return (
    <Tooltip content={label} side="top">
      <span
        className={`flex shrink-0 items-center gap-0.5 ${active ? "text-accent" : "text-muted"}`}
      >
        <Terminal size={11} strokeWidth={2.5} />
        {count > 1 && <span className="text-[0.625rem] font-semibold leading-none">{count}</span>}
      </span>
    </Tooltip>
  );
}
