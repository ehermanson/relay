import { useEffect } from "react";

/**
 * While a chat/space view is mounted, hand the top safe-area inset to that
 * view's pinned in-view header instead of <body>.
 *
 * iOS 26+ standalone PWAs paint a scroll-edge blur at the top of the web
 * content and only replace it with a solid fill when a `position: sticky`/
 * `fixed` element sits at the viewport's *true* top edge (`top: 0`) AND owns
 * `env(safe-area-inset-top)` (extends up under the status bar). Relay's global
 * `body { padding-top: env(safe-area-inset-top) }` pushes the header below that
 * edge, so the header can never satisfy the rule and the header band stays
 * blurred. Toggling `body.immersive-top-inset` drops the body padding for these
 * views; the header (see `view-header.tsx`) then reaches `top: 0` and owns the
 * inset. See WebKit bug 301756.
 *
 * Ref-counted so overlapping mounts (a space view plus its compact child chat
 * views, or a route transition that mounts the next screen before unmounting
 * the previous one) don't drop the class prematurely.
 */
let mountCount = 0;

export function useImmersiveTopInset(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    mountCount += 1;
    document.body.classList.add("immersive-top-inset");
    return () => {
      mountCount -= 1;
      if (mountCount <= 0) {
        mountCount = 0;
        document.body.classList.remove("immersive-top-inset");
      }
    };
  }, [enabled]);
}
