/**
 * Side drawer with native-feel touch gestures, built on motion's drag.
 *
 * - Finger-tracked swipe-to-dismiss: drag the open panel toward its edge;
 *   release decides by offset + velocity (motion supplies both).
 * - Optional edge-swipe-to-open (`edgeSwipeOpen`): document-level touch
 *   tracking from the screen edge drives the panel 1:1 under the finger.
 *   Listeners never preventDefault on touchstart and only claim the gesture
 *   after clear horizontal intent, so taps on content under the edge zone
 *   (e.g. the hamburger) are never swallowed. Caveat: at the outermost bezel
 *   the OS back-gesture (iOS standalone / Android gesture nav) may win —
 *   the tap affordance stays as the reliable fallback.
 * - The backdrop's opacity follows drag progress, not open/closed state.
 *
 * The panel mounts only while open or mid-gesture, and stays mounted through
 * the exit animation (`onExitComplete` fires after), so parents may
 * conditionally render the whole drawer and still get a clean slide-out.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { animate, motion, useMotionValue, useTransform, type PanInfo } from "motion/react";

const SPRING = { type: "spring", stiffness: 480, damping: 44 } as const;
/** How far from the screen edge a touch can start the open gesture. */
const EDGE_PX = 24;
/** Movement (px) before we commit to the gesture (or rule it out). */
const SLOP_PX = 10;
/** px/s — faster than this and the release direction wins over position. */
const FLING_VELOCITY = 400;

interface SwipeableDrawerProps {
  side: "left" | "right";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires after the exit animation finishes (panel just unmounted). */
  onExitComplete?: () => void;
  /** Enable swipe-to-open from the screen edge (touch only). */
  edgeSwipeOpen?: boolean;
  /** Classes for the fixed full-screen container (padding etc.). */
  containerClassName?: string;
  /**
   * Classes for the draggable panel wrapper (width). The panel is a flex
   * column that stretches to the container's height — don't give it a
   * percentage height: WebKit won't reliably resolve one through a row-flex
   * item, and a collapsed panel means the content never overflows, so touches
   * scroll the page instead of the drawer. Fill it with `flex-1 min-h-0`.
   */
  panelClassName?: string;
  children: ReactNode;
}

export function SwipeableDrawer({
  side,
  open,
  onOpenChange,
  onExitComplete,
  edgeSwipeOpen = false,
  containerClassName = "",
  panelClassName = "",
  children,
}: SwipeableDrawerProps) {
  const [mounted, setMounted] = useState(open);
  const [width, setWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(0);
  const gestureActiveRef = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const onExitCompleteRef = useRef(onExitComplete);
  onExitCompleteRef.current = onExitComplete;

  const x = useMotionValue(0);
  const hiddenX = (w: number) => (side === "left" ? -w : w);
  // 0 = fully hidden, 1 = fully open — drives the backdrop.
  const backdropOpacity = useTransform(x, (v) =>
    widthRef.current ? 1 - Math.abs(v) / widthRef.current : 0,
  );

  // Mount → measure and position offscreen before paint. The open effect
  // below (declared after, so it runs after) animates in from there.
  useLayoutEffect(() => {
    if (!mounted) return;
    const w = panelRef.current?.offsetWidth ?? 0;
    widthRef.current = w;
    setWidth(w);
    x.set(hiddenX(w));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  // Open/close animation — always from x's current position, so a release
  // mid-gesture continues from under the finger instead of jumping.
  useLayoutEffect(() => {
    if (!mounted) return;
    if (open) {
      const controls = animate(x, 0, SPRING);
      return () => controls.stop();
    }
    // Closed while mounted: animate out, then unmount — unless a finger
    // currently owns x (edge gesture on a not-yet-open panel).
    if (gestureActiveRef.current) return;
    const controls = animate(x, hiddenX(widthRef.current), SPRING);
    controls.then(() => {
      if (!openRef.current && !gestureActiveRef.current) {
        setMounted(false);
        onExitCompleteRef.current?.();
      }
    });
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted]);

  // ── Edge-swipe-to-open ──────────────────────────────────────────────
  useEffect(() => {
    if (!edgeSwipeOpen) return;

    let touchId: number | null = null;
    let startX = 0;
    let startY = 0;
    let active = false;
    let lastX = 0;
    let lastT = 0;
    let vx = 0; // px/s, signed in screen coords

    const findTouch = (e: TouchEvent) =>
      Array.from(e.touches).find((t) => t.identifier === touchId);

    const onTouchStart = (e: TouchEvent) => {
      if (openRef.current || gestureActiveRef.current || e.touches.length !== 1) return;
      const t = e.touches[0];
      const fromEdge =
        side === "left" ? t.clientX <= EDGE_PX : window.innerWidth - t.clientX <= EDGE_PX;
      if (!fromEdge) return;
      touchId = t.identifier;
      startX = t.clientX;
      startY = t.clientY;
      active = false;
      vx = 0;
      lastT = 0;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (touchId === null) return;
      const t = findTouch(e);
      if (!t) return;
      const rawDx = t.clientX - startX;
      const inward = side === "left" ? rawDx : -rawDx;
      const dy = Math.abs(t.clientY - startY);

      if (!active) {
        if (inward > SLOP_PX && inward > dy) {
          active = true;
          gestureActiveRef.current = true;
          setMounted(true); // layout effect measures + parks x offscreen
        } else if (dy > SLOP_PX || inward < -SLOP_PX) {
          touchId = null; // vertical scroll or wrong direction — bail
          return;
        } else {
          return;
        }
      }

      e.preventDefault(); // claim the gesture from scrolling
      const w = widthRef.current;
      if (!w) return; // first move can land before measurement — skip
      const next =
        side === "left"
          ? Math.min(0, Math.max(-w, -w + rawDx))
          : Math.max(0, Math.min(w, w + rawDx));
      const now = performance.now();
      if (lastT) vx = ((next - lastX) / (now - lastT)) * 1000;
      lastX = next;
      lastT = now;
      x.stop();
      x.set(next);
    };

    const onTouchEnd = () => {
      if (touchId === null) return;
      touchId = null;
      if (!active) return;
      active = false;
      const w = widthRef.current || 1;
      const towardOpen = side === "left" ? vx > 0 : vx < 0;
      const openEnough = 1 - Math.abs(x.get()) / w > 0.5;
      const shouldOpen = Math.abs(vx) > FLING_VELOCITY ? towardOpen : openEnough;
      gestureActiveRef.current = false;
      if (shouldOpen) {
        onOpenChangeRef.current(true); // open effect animates the rest
      } else {
        const controls = animate(x, hiddenX(w), SPRING);
        controls.then(() => {
          if (!openRef.current && !gestureActiveRef.current) setMounted(false);
        });
      }
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd);
    document.addEventListener("touchcancel", onTouchEnd);
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeSwipeOpen, side]);

  // ── Drag-to-dismiss (open panel) ────────────────────────────────────
  const onDragEnd = (_: unknown, info: PanInfo) => {
    const towardClose = side === "left" ? info.velocity.x < 0 : info.velocity.x > 0;
    const closedEnough = Math.abs(x.get()) > widthRef.current / 2;
    const shouldClose = Math.abs(info.velocity.x) > FLING_VELOCITY ? towardClose : closedEnough;
    if (shouldClose) {
      onOpenChange(false); // close effect animates from current x
    } else {
      animate(x, 0, SPRING);
    }
  };

  // ── Scroll lock ─────────────────────────────────────────────────────
  // While the drawer is up, a touch drag anywhere that can't be consumed by
  // an inner scroller (backdrop, container padding, panel chrome) would
  // otherwise scroll the page behind it.
  //
  // iOS commits to native scrolling on the FIRST touchmove of a gesture and
  // ignores later preventDefault calls, so every decision here must be made
  // on that first event: never let one through "to see where it goes".
  // The only decision is "is this touch inside an overflowing scroller?" —
  // if so we never touch the event; if not we cancel it. Cancelling during a
  // horizontal swipe is harmless (motion drives dismiss via pointer events and
  // touch-action: pan-y already forbids native horizontal panning). Capture
  // phase so no descendant's stopPropagation can hide the event from us.
  useEffect(() => {
    if (!mounted) return;
    const container = containerRef.current;
    if (!container) return;
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;

      let el = e.target as HTMLElement | null;
      while (el && el !== container) {
        if (el.scrollHeight > el.clientHeight) {
          const overflowY = getComputedStyle(el).overflowY;
          if (overflowY === "auto" || overflowY === "scroll") {
            // A real, overflowing scroller: hands off entirely. Never cancel
            // here, even at its edges — cancelling the first touchmove kills
            // the whole gesture on iOS, and a 1px jitter at scrollTop 0 would
            // do exactly that. Edge bounce is contained natively by the
            // [data-swipeable-drawer] overscroll-behavior rule instead.
            return;
          }
        }
        el = el.parentElement;
      }
      e.preventDefault(); // nothing here can scroll — don't leak to the page
    };

    container.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
    return () => {
      container.removeEventListener("touchmove", onTouchMove, { capture: true });
    };
  }, [mounted]);

  if (!mounted) return null;

  return (
    <div
      ref={containerRef}
      data-swipeable-drawer=""
      className={`fixed inset-0 z-50 flex ${side === "right" ? "justify-end" : ""} ${containerClassName}`}
    >
      <motion.div
        className="absolute inset-0 bg-black/50"
        style={{ opacity: backdropOpacity }}
        onClick={() => onOpenChange(false)}
      />
      <motion.div
        ref={panelRef}
        className={`relative z-10 flex flex-col ${panelClassName}`}
        style={{ x, touchAction: "pan-y" }}
        drag={open ? "x" : false}
        dragDirectionLock
        dragConstraints={side === "left" ? { left: -width, right: 0 } : { left: 0, right: width }}
        dragElastic={0.03}
        dragMomentum={false}
        onDragEnd={onDragEnd}
      >
        {children}
      </motion.div>
    </div>
  );
}
