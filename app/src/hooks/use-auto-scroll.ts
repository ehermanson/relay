import { useRef, useEffect, useCallback, useState } from "react";

const NEAR_BOTTOM_PX = 64;
const SHOW_SCROLL_TO_BOTTOM_PX = 500;
const FORCE_SCROLL_MAX_FRAMES = 48;
const FORCE_SCROLL_STABLE_FRAMES = 3;
/** After a programmatic jump, ignore "near bottom" for this long (see detachFromBottom). */
const NAVIGATION_HOLD_MS = 600;

export function useAutoScroll<T extends HTMLElement>(options?: { onUserScroll?: () => void }) {
  const ref = useRef<T>(null);
  // Keep the latest callback without re-subscribing the scroll listeners.
  const onUserScrollRef = useRef(options?.onUserScroll);
  onUserScrollRef.current = options?.onUserScroll;
  const stickToBottom = useRef(true);
  const forceScrollRunId = useRef(0);
  const forceScrollUntil = useRef(0);
  const navigationHoldUntil = useRef(0);
  // "Framed" = we've parked a specific turn near the top of the viewport and
  // want the answer to stream into the space below WITHOUT auto-following the
  // live edge. Stays on until the reader actually interacts (wheel/touch/etc).
  const framed = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const showScrollToBottomRef = useRef(false);

  // Track real user interaction so we can distinguish user scroll-up from
  // programmatic scroll shifts (virtualizer remeasuring, layout reflow, etc.)
  const userInteracting = useRef(false);
  const userInteractingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const setShowScrollToBottomIfChanged = useCallback((next: boolean) => {
    if (showScrollToBottomRef.current === next) return;
    showScrollToBottomRef.current = next;
    setShowScrollToBottom(next);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const cancelForcedScroll = useCallback(() => {
    forceScrollRunId.current += 1;
    forceScrollUntil.current = 0;
  }, []);

  // Force scroll to bottom — session switch / initial load / user click
  const forceStickToBottom = useCallback(
    (smooth?: boolean) => {
      stickToBottom.current = true;
      framed.current = false;
      setShowScrollToBottomIfChanged(false);

      // Smooth scroll for user-initiated clicks — let the browser animate
      if (smooth) {
        const el = ref.current;
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        return;
      }

      const runId = forceScrollRunId.current + 1;
      forceScrollRunId.current = runId;
      forceScrollUntil.current = performance.now() + 1000;

      let lastScrollHeight = -1;
      let stableFrames = 0;
      let frames = 0;

      const settleToBottom = () => {
        if (forceScrollRunId.current !== runId) return;

        const el = ref.current;
        if (!el) return;

        scrollToBottom();

        const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
        const heightStable = Math.abs(el.scrollHeight - lastScrollHeight) <= 1;
        stableFrames = remaining <= 1 && heightStable ? stableFrames + 1 : 0;
        lastScrollHeight = el.scrollHeight;
        frames += 1;

        if (stableFrames >= FORCE_SCROLL_STABLE_FRAMES || frames >= FORCE_SCROLL_MAX_FRAMES) {
          if (forceScrollRunId.current === runId) {
            forceScrollUntil.current = 0;
          }
          return;
        }

        requestAnimationFrame(settleToBottom);
      };

      settleToBottom();
    },
    [scrollToBottom, setShowScrollToBottomIfChanged],
  );

  // Conditionally scroll — content changes while user is at bottom
  const onContentChange = useCallback(() => {
    if (stickToBottom.current) scrollToBottom();
  }, [scrollToBottom]);

  // Track user scroll intent
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let lastScrollTop = el.scrollTop;

    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const remainingDistance = scrollHeight - scrollTop - clientHeight;
      const nearBottom = remainingDistance <= NEAR_BOTTOM_PX;
      const forcingBottom = performance.now() < forceScrollUntil.current;

      if (nearBottom && !framed.current && performance.now() >= navigationHoldUntil.current) {
        stickToBottom.current = true;
      } else if (!forcingBottom && userInteracting.current && scrollTop < lastScrollTop - 1) {
        // Only detach when the user actually scrolled (wheel / touch / pointer).
        // Programmatic scroll-position shifts (virtualizer remeasuring, layout
        // reflow, ResizeObserver adjustments) also decrease scrollTop but should
        // NOT flip stickToBottom off.
        stickToBottom.current = false;
      }

      setShowScrollToBottomIfChanged(
        !forcingBottom && remainingDistance > SHOW_SCROLL_TO_BOTTOM_PX,
      );

      lastScrollTop = scrollTop;
    };

    const onUserIntent = () => {
      cancelForcedScroll();
      navigationHoldUntil.current = 0;
      // Real interaction ends framing — normal stick-to-bottom logic resumes,
      // so scrolling back to the live edge re-engages following.
      if (framed.current) {
        framed.current = false;
        onUserScrollRef.current?.();
      }
      userInteracting.current = true;
      clearTimeout(userInteractingTimer.current);
      userInteractingTimer.current = setTimeout(() => {
        userInteracting.current = false;
      }, 200);
    };

    // pointerdown only counts as scroll intent when clicking the scrollbar
    // track (x > clientWidth) — not when clicking content like tool rows.
    const onPointerDown = (e: PointerEvent) => {
      if (e.offsetX > el.clientWidth) onUserIntent();
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onUserIntent, { passive: true });
    el.addEventListener("touchstart", onUserIntent, { passive: true });
    el.addEventListener("pointerdown", onPointerDown, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onUserIntent);
      el.removeEventListener("touchstart", onUserIntent);
      el.removeEventListener("pointerdown", onPointerDown);
      clearTimeout(userInteractingTimer.current);
    };
  }, [cancelForcedScroll, setShowScrollToBottomIfChanged]);

  // Auto-scroll when content/container size changes
  // (virtualizer measuring, images loading, panel resizing, etc.)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) scrollToBottom();
    });

    if (el.firstElementChild) ro.observe(el.firstElementChild);
    ro.observe(el);

    return () => ro.disconnect();
  }, [scrollToBottom]);

  // Let programmatic navigation (timeline scrub, TOC jump) detach from
  // auto-scroll without faking a user interaction.  The user can re-engage
  // by scrolling near the bottom or clicking "Jump to latest".
  // A jump that starts at the live edge fires its first scroll events inside
  // the near-bottom zone; without the hold those re-engage following and the
  // next virtualizer remeasure yanks the reader straight back down.
  const detachFromBottom = useCallback(() => {
    stickToBottom.current = false;
    navigationHoldUntil.current = performance.now() + NAVIGATION_HOLD_MS;
    cancelForcedScroll();
  }, [cancelForcedScroll]);

  // Park a turn near the top of the viewport: stop following the live edge and
  // suppress the near-bottom re-engage so the streamed answer can grow into the
  // space below without yanking the reader down. Cleared on user interaction.
  const beginFramed = useCallback(() => {
    framed.current = true;
    stickToBottom.current = false;
    cancelForcedScroll();
  }, [cancelForcedScroll]);

  return {
    ref,
    scrollToBottom,
    forceStickToBottom,
    onContentChange,
    showScrollToBottom,
    detachFromBottom,
    beginFramed,
  };
}
