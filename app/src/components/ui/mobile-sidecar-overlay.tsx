/**
 * Floating-card overlay used to host the mobile sidecar/sidebar on small
 * screens. Owns the backdrop, positioning, and dismissal (backdrop tap or
 * swipe-right) so instance and space views share the same presentation.
 *
 * Parents conditionally mount this on open, so the drawer manages its own
 * enter/exit animation internally: it mounts closed, opens on the next
 * effect tick, and calls `onClose` only after the slide-out completes.
 */

import { useEffect, useState, type ReactNode } from "react";
import { SwipeableDrawer } from "./swipeable-drawer";

interface MobileSidecarOverlayProps {
  onClose: () => void;
  children: ReactNode;
}

export function MobileSidecarOverlay({ onClose, children }: MobileSidecarOverlayProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(true);
  }, []);

  return (
    <SwipeableDrawer
      side="right"
      open={open}
      onOpenChange={setOpen}
      onExitComplete={onClose}
      containerClassName="p-2 pt-[calc(var(--app-top-inset)+0.5rem)]"
      panelClassName="min-h-0"
    >
      {children}
    </SwipeableDrawer>
  );
}
