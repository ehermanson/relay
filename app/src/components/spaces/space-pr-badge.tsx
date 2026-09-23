/**
 * PR state for a Space: the header badge (refreshes on view through
 * `GET /api/spaces/:id/pr`, cached server-side for 60s) and a compact chip
 * for space list rows (persisted snapshot only — list rows never call gh).
 */
import { useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleDashed, CircleX, ExternalLink } from "lucide-react";
import type { SpaceInfo, SpacePrStatus } from "@shared/types";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { fetchSpacePrStatus } from "@/lib/api";

type BadgeVariant = "default" | "accent" | "warning" | "error" | "success";

export function getPrPresentation(pr: SpacePrStatus): {
  label: string;
  variant: BadgeVariant;
  detail: string[];
} {
  const label =
    pr.state === "merged"
      ? `PR #${pr.number} merged`
      : pr.state === "closed"
        ? `PR #${pr.number} closed`
        : pr.state === "draft"
          ? `PR #${pr.number} draft`
          : `PR #${pr.number} open`;
  const variant: BadgeVariant =
    pr.state === "merged"
      ? "success"
      : pr.state === "closed"
        ? "default"
        : pr.checks.state === "failing" || pr.mergeable === "conflicting"
          ? "error"
          : "accent";
  const detail: string[] = [];
  if (pr.title) detail.push(pr.title);
  const { checks } = pr;
  if (checks.total > 0) {
    const parts = [
      checks.passing ? `${checks.passing} passing` : "",
      checks.failing ? `${checks.failing} failing` : "",
      checks.pending ? `${checks.pending} pending` : "",
      checks.skipped ? `${checks.skipped} skipped` : "",
    ].filter(Boolean);
    detail.push(`Checks: ${parts.join(", ")}`);
  } else {
    detail.push("No checks reported");
  }
  if (pr.reviewDecision === "approved") detail.push("Review: approved");
  else if (pr.reviewDecision === "changes_requested") detail.push("Review: changes requested");
  else if (pr.reviewDecision === "review_required") detail.push("Review: required");
  if (pr.state !== "merged" && pr.mergeable === "conflicting") {
    detail.push("Conflicts with the base branch");
  }
  if (pr.state === "merged") {
    detail.push("Merged on the remote. Complete or mark this space as merged to close it.");
  }
  return { label, variant, detail };
}

function ChecksIcon({ pr }: { pr: SpacePrStatus }) {
  if (pr.state === "merged" || pr.state === "closed" || pr.checks.state === "none") return null;
  if (pr.checks.state === "failing") return <CircleX size={10} aria-label="Checks failing" />;
  if (pr.checks.state === "pending") {
    return <CircleDashed size={10} aria-label="Checks pending" />;
  }
  return <CircleCheck size={10} aria-label="Checks passing" />;
}

function PrBadge({ pr, stale, size }: { pr: SpacePrStatus; stale?: boolean; size: "sm" | "xs" }) {
  const { label, variant, detail } = getPrPresentation(pr);
  const tooltip = (
    <span className="flex max-w-72 flex-col gap-0.5 text-left">
      {detail.map((line) => (
        <span key={line}>{line}</span>
      ))}
      {stale && <span className="text-muted">Status may be out of date</span>}
    </span>
  );
  return (
    <Tooltip content={tooltip}>
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => event.stopPropagation()}
        className="inline-flex"
      >
        <Badge variant={variant} size={size} className="cursor-pointer">
          <ChecksIcon pr={pr} />
          {label}
          {size === "sm" && <ExternalLink size={10} />}
        </Badge>
      </a>
    </Tooltip>
  );
}

/** Header badge: live PR state + checks, falling back to push state. */
export function SpacePrBadge({ space }: { space: SpaceInfo }) {
  const hasRemote = Boolean(space.prUrl || space.remoteStatus);
  const { data } = useQuery({
    queryKey: ["space-pr", space.id],
    queryFn: () => fetchSpacePrStatus(space.id),
    enabled: hasRemote && !space.isDefault,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  // The persisted snapshot (pushed via space_list after a refresh/push) can be
  // newer than this query's cached response — show whichever was read last.
  const live = data?.pr ?? null;
  const persisted = space.prStatus ?? null;
  const pr =
    live && persisted
      ? persisted.fetchedAt > live.fetchedAt
        ? persisted
        : live
      : (live ?? persisted);

  if (pr) return <PrBadge pr={pr} stale={data?.stale} size="sm" />;
  if (space.remoteStatus === "pr-open" && space.prUrl) {
    return (
      <a href={space.prUrl} target="_blank" rel="noopener noreferrer" className="inline-flex">
        <Badge variant="accent" size="sm" className="cursor-pointer">
          PR open
          <ExternalLink size={10} />
        </Badge>
      </a>
    );
  }
  if (space.remoteStatus) {
    return (
      <Badge variant="accent" size="sm">
        Pushed
      </Badge>
    );
  }
  return (
    <Badge variant="default" size="sm">
      Local only
    </Badge>
  );
}

/** Compact chip for list rows, from the persisted snapshot only. */
export function SpacePrStateChip({ space }: { space: SpaceInfo }) {
  const pr = space.prStatus;
  if (!pr || (space.status !== "active" && space.status !== "broken")) return null;
  return <PrBadge pr={pr} size="xs" />;
}
