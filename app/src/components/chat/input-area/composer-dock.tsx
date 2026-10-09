import { createContext, useContext, type ReactNode } from "react";

const DockStackContext = createContext(false);

/** True inside a `ComposerDockStack`, where docks render as sections. */
export function useInComposerDockStack(): boolean {
  return useContext(DockStackContext);
}

const DOCK_SHAPE = "rounded-t-xl border border-b-0 border-border/60 bg-surface pb-3";

function dockInset(isMobile: boolean): string {
  return isMobile ? "mx-2" : "mx-4";
}

/**
 * Inset tab docked above the composer box: rounded top, no bottom edge, and
 * tucked 12px behind the composer so the two read as one unit. Shared by
 * everything that pops out of the composer (queued messages, plan review,
 * agent questions, status notices) so they look like one family. Pass
 * `tucked={false}` when a clipping wrapper (e.g. a height animation) applies
 * the negative margin instead.
 *
 * Inside a `ComposerDockStack` the stack owns the shape and the tuck, and each
 * dock renders as a plain section of it.
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
  const inStack = useInComposerDockStack();
  if (inStack) return <div className="relative">{children}</div>;
  return (
    <div
      className={`relative overflow-hidden ${DOCK_SHAPE} ${tucked ? "-mb-3" : ""} ${dockInset(isMobile)}`}
    >
      {children}
    </div>
  );
}

/**
 * One dock for several items at once: a single rounded tab tucked behind the
 * composer, with hairlines between its sections, instead of a pile of tabs
 * each tucked behind the next. Children are the dock items themselves (each
 * may render nothing); the stack hides itself when all of them are empty.
 * Sections divide on direct children, so an item's own enter/exit wrapper
 * must be its outermost element.
 */
export function ComposerDockStack({
  isMobile,
  children,
}: {
  isMobile: boolean;
  children: ReactNode;
}) {
  return (
    <DockStackContext.Provider value={true}>
      <div
        className={`relative -mb-3 divide-y divide-border/40 overflow-hidden empty:hidden ${DOCK_SHAPE} ${dockInset(isMobile)}`}
      >
        {children}
      </div>
    </DockStackContext.Provider>
  );
}
