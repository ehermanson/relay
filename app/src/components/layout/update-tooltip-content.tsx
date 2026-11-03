import type { UpdateSnapshot } from "@shared/types";

/** Commit subjects shown in the tooltip before summarizing the rest. */
const TOOLTIP_COMMIT_LIMIT = 8;

/**
 * Tooltip body for the sidebar's Update button: what installing would pull in.
 * Desktop release updates carry no commit list, so they keep the plain label.
 */
export function UpdateTooltipContent({
  snapshot,
  installing,
  stageLabel,
}: {
  snapshot: UpdateSnapshot | null | undefined;
  installing: boolean;
  stageLabel: string | null | undefined;
}) {
  if (installing) return <>{stageLabel ?? "Installing update…"}</>;

  // Optional chaining: an older server (mid-update) doesn't send these fields.
  const commits = snapshot?.incomingCommits ?? [];
  if (commits.length === 0) return <>Install update and restart Relay</>;

  const total = Math.max(snapshot?.incomingCommitCount ?? 0, commits.length);
  const visible = commits.slice(0, TOOLTIP_COMMIT_LIMIT);
  const remaining = total - visible.length;

  return (
    <div className="flex flex-col gap-1.5 py-0.5">
      <div className="font-medium text-text-bright">
        {total === 1 ? "1 new commit" : `${total} new commits`}
      </div>
      <ul className="flex flex-col gap-0.5">
        {visible.map(({ commit, subject }) => (
          <li key={commit} className="flex min-w-0 gap-1.5">
            <span className="shrink-0 text-muted">•</span>
            <span className="min-w-0 truncate">{subject}</span>
          </li>
        ))}
      </ul>
      {remaining > 0 && <div className="text-muted">+{remaining} more</div>}
      <div className="border-t border-border/60 pt-1.5 text-muted">
        Click to install and restart Relay
      </div>
    </div>
  );
}
