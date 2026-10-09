import type { ReactNode } from "react";

/**
 * Inset tab docked above the composer box: rounded top, no bottom edge, and
 * tucked 12px behind the composer so the two read as one unit. Shared by
 * everything that pops out of the composer (queued messages, plan review,
 * agent questions) so they look like one family. Pass `tucked={false}` when a
 * clipping wrapper (e.g. a height animation) applies the negative margin instead.
 */
export function ComposerDock({
  isMobile,
  tucked = true,
  children,
}: {
  isMobile: boolean;
  tucked?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-t-xl border border-b-0 border-border/60 bg-surface pb-3 ${
        tucked ? "-mb-3" : ""
      } ${isMobile ? "mx-2" : "mx-4"}`}
    >
      {children}
    </div>
  );
}
