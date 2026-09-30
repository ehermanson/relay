import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useInstalledProviders } from "@/hooks/use-available-providers";
import { useDismissedProviderAdvisories } from "@/hooks/use-dismissed-provider-advisories";
import {
  buildToastDescription,
  buildToastTitle,
  collectUpdateCandidates,
  providerAdvisoryNotificationKey,
} from "@/components/provider-update-notification.logic";

const TOAST_ID = "provider-update-advisory";

/**
 * Mounts at the app root. Watches `useInstalledProviders()` for any providers
 * whose installed CLI is behind the latest published version, and fires a
 * single sonner toast per (provider, latestVersion) tuple.
 *
 * Layout: only one action button ("Open settings") is rendered inline; the
 * close X (via sonner's `closeButton: true`) handles permanent dismissal.
 * This keeps the toast's text column wide enough for the title and
 * description to fit on a reasonable number of lines — the previous version
 * had two side-by-side buttons that squeezed the text into a 3-line wrap.
 *
 * Persistence rules: dismissal is persisted ONLY when the user explicitly
 * acknowledges the toast — clicking "Open settings" or the close X.
 * Programmatic dismissals (advisory set shrank, server cache temporarily
 * empty) never write to localStorage, so a transient empty advisory window
 * can't lock the user out of a real advisory when the probe repopulates.
 */
export function ProviderUpdateNotification() {
  const navigate = useNavigate();
  // Every installed provider: an update matters whichever account is active.
  const { providers } = useInstalledProviders();
  const { dismissed, dismiss } = useDismissedProviderAdvisories();

  // Track which keys we've already fired during this session so we don't
  // re-fire the same toast if the providers list refetches without changes.
  const firedRef = useRef<Set<string>>(new Set());
  // Track the currently-visible toast key so we can dismiss it when the set
  // of outdated providers shrinks (e.g. user updated one of them).
  const activeKeyRef = useRef<string | null>(null);
  // Set right before any `toast.dismiss(TOAST_ID)` we issue ourselves, so the
  // shared `onDismiss` handler can tell programmatic dismissals (don't
  // persist) from user-driven ones (close X → persist).
  const programmaticDismissRef = useRef(false);

  const candidates = useMemo(() => collectUpdateCandidates(providers), [providers]);
  const notificationKey = useMemo(() => providerAdvisoryNotificationKey(candidates), [candidates]);

  useEffect(() => {
    // No outdated providers (or advisories not yet probed): close any
    // lingering toast and bail. Marked programmatic so we don't persist.
    if (!notificationKey) {
      if (activeKeyRef.current) {
        programmaticDismissRef.current = true;
        toast.dismiss(TOAST_ID);
        activeKeyRef.current = null;
      }
      return;
    }

    // The outdated-provider set changed — close the previous toast before
    // showing the new one. Marked programmatic so we don't persist the
    // outgoing key as user-dismissed.
    if (activeKeyRef.current && activeKeyRef.current !== notificationKey) {
      programmaticDismissRef.current = true;
      toast.dismiss(TOAST_ID);
      activeKeyRef.current = null;
    }

    // Already shown this session, or persistently dismissed across reloads.
    if (firedRef.current.has(notificationKey)) return;
    if (dismissed.has(notificationKey)) return;

    firedRef.current.add(notificationKey);
    activeKeyRef.current = notificationKey;

    toast.warning(buildToastTitle(candidates), {
      id: TOAST_ID,
      description: buildToastDescription(candidates),
      duration: Infinity,
      // Sonner default toast width is fairly narrow on the right edge; giving
      // this toast a touch more room prevents the title from wrapping to
      // three lines when there are 2+ outdated providers.
      style: { width: "min(420px, calc(100vw - 24px))" },
      closeButton: true,
      action: {
        label: "Open settings",
        onClick: () => {
          // User acknowledged the advisory — persist so we don't badger
          // them on every reload. (We also tag this as programmatic so the
          // onDismiss handler doesn't double-persist.)
          dismiss(notificationKey);
          programmaticDismissRef.current = true;
          if (activeKeyRef.current === notificationKey) {
            activeKeyRef.current = null;
          }
          void navigate({ to: "/settings/providers" });
        },
      },
      onDismiss: () => {
        // Sonner fires onDismiss for both programmatic `toast.dismiss()` and
        // user-driven close. The ref lets us persist only the user-driven
        // case (close X).
        if (programmaticDismissRef.current) {
          programmaticDismissRef.current = false;
          return;
        }
        dismiss(notificationKey);
        if (activeKeyRef.current === notificationKey) {
          activeKeyRef.current = null;
        }
      },
    });
  }, [candidates, dismiss, dismissed, navigate, notificationKey]);

  return null;
}
