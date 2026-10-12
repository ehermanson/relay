import { getDesktop } from "@/lib/desktop";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { checkForUpdates, fetchUpdateStatus, installUpdate } from "@/lib/api";
import type { UpdateSnapshot, UpdateStage, UpdateStatus } from "@shared/types";

// Module-level interval so we only schedule one background check regardless of
// how many hook instances are mounted (mini-sidebar + sidebar + settings page).
let bgCheckInterval: ReturnType<typeof setInterval> | null = null;

const TOAST_ID = "system-update";
const QUERY_KEY = ["system-update"] as const;

// Mutation keys let us observe in-flight install/check mutations across *every*
// `useSystemUpdate()` instance via `useIsMutating`. Without a shared key, each
// mounted component has its own `useMutation` instance and its own
// `isPending` — so triggering install from the sidebar wouldn't flip the
// settings page into a loading state until the server's polled status caught
// up (~1s). With a shared key, every instance sees the pending state instantly.
const INSTALL_MUTATION_KEY = ["system-update", "install"] as const;
const CHECK_MUTATION_KEY = ["system-update", "check"] as const;

// Module-level post-install tracking. `pendingReload` and `preInstallCommit`
// need to survive the triggering component unmounting (e.g., the sidebar
// unmounts while the user navigates to the settings page mid-install) so the
// success toast still fires once the server reports the new commit.
let modulePendingReload = false;
let modulePreInstallCommit: string | null = null;
const reloadListeners = new Set<() => void>();

function setPendingReload(next: boolean): void {
  if (modulePendingReload === next) return;
  modulePendingReload = next;
  for (const listener of reloadListeners) listener();
}

function subscribeReload(listener: () => void): () => void {
  reloadListeners.add(listener);
  return () => {
    reloadListeners.delete(listener);
  };
}

function getPendingReload(): boolean {
  return modulePendingReload;
}

const BUSY_STATUSES: readonly UpdateStatus[] = ["checking", "updating", "restart_pending"];

const INSTALL_BUSY_STATUSES: readonly UpdateStatus[] = ["updating", "restart_pending"];

/**
 * Human label for the in-progress stage of a running upgrade.
 * Returned only while the upgrade is busy; callers show it in buttons,
 * tooltips, and toasts so the UI reflects the real server-side step.
 */
export function describeUpdateStage(
  status: UpdateStatus | undefined,
  stage: UpdateStage | null | undefined,
): string | null {
  if (stage === "waiting") return "Waiting for active chats to finish…";
  if (status === "checking") return "Checking for updates…";
  if (status === "restart_pending" || stage === "restarting") {
    return "Restarting Relay…";
  }
  if (status === "updating") {
    switch (stage) {
      case "downloading":
        return "Downloading Relay…";
      case "pulling":
        return "Pulling latest code…";
      case "installing":
        return "Installing dependencies…";
      case "building":
        return "Building Relay…";
      default:
        return "Installing update…";
    }
  }
  return null;
}

/** How stale the last check can be before we auto-re-check (5 min = server TTL). */
const STALE_THRESHOLD_MS = 5 * 60 * 1000;
/** How often we proactively recheck in the background. */
const BG_CHECK_INTERVAL_MS = 30 * 60 * 1000;

export interface UseSystemUpdateResult {
  snapshot: UpdateSnapshot | undefined;
  isLoading: boolean;
  /** True whenever an install/check is active server-side or client-side. */
  isBusy: boolean;
  /** True specifically during install (excludes plain update checks). */
  isInstalling: boolean;
  /** Human label for the active stage, or null when idle. */
  stageLabel: string | null;
  /** True when server reports an update is installable and we're idle. */
  canInstall: boolean;
  install: () => void;
  check: (force?: boolean) => void;
  installPending: boolean;
  checkPending: boolean;
}

function formatShortCommit(commit: string | null | undefined): string | null {
  return commit ? commit.slice(0, 7) : null;
}

/**
 * Shared hook for the Relay self-update flow.
 *
 * Consolidates the polling query, install/check mutations, and the persistent
 * "system-update" toast so every update entrypoint (mini-sidebar, expanded
 * sidebar, settings page) stays in sync and shows the same staged progress.
 *
 * Post-install: once the server has restarted on the new commit, we swap the
 * persistent toast for a success toast with a "Reload" action — the old JS in
 * the browser is still talking to a freshly-rebuilt server, so the user needs
 * to refresh to pick up matching client code. We don't auto-reload because it
 * could trash in-flight drafts in other tabs that didn't trigger the update.
 */
export function useSystemUpdate(): UseSystemUpdateResult {
  const queryClient = useQueryClient();

  const { data: snapshot, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchUpdateStatus,
    staleTime: 30_000,
    // During a restart the server is briefly unreachable; keep retrying so we
    // notice it come back up instead of surfacing a transient error.
    retry: (failureCount) => failureCount < 10,
    retryDelay: 1_000,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && BUSY_STATUSES.includes(status) ? 1_000 : false;
    },
  });

  const nativeRestart =
    !!getDesktop() && (snapshot?.distribution === "desktop" || snapshot?.distribution === "source");

  // Subscribe to module-level `pendingReload` so every mounted hook instance
  // re-renders together when install is triggered anywhere in the app.
  const pendingReload = useSyncExternalStore(subscribeReload, getPendingReload, getPendingReload);

  const installMutation = useMutation({
    mutationKey: INSTALL_MUTATION_KEY,
    mutationFn: installUpdate,
    onMutate: () => {
      modulePreInstallCommit = snapshot?.currentCommit ?? null;
      setPendingReload(!nativeRestart);
      toast.loading("Starting Relay update…", {
        id: TOAST_ID,
        description:
          snapshot?.distribution === "desktop"
            ? "Downloading the verified desktop release. Relay will restart when chats are idle."
            : "Pulling, installing, and building the new version.",
        duration: Infinity,
      });
    },
    onSuccess: () => {
      if (nativeRestart) {
        void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
        return;
      }
      toast.loading("Restarting Relay…", {
        id: TOAST_ID,
        description: "Reconnecting once the server comes back online.",
        duration: Infinity,
      });
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error) => {
      setPendingReload(false);
      modulePreInstallCommit = null;
      toast.error(error instanceof Error ? error.message : "Failed to install update", {
        id: TOAST_ID,
        description: undefined,
        duration: 8_000,
      });
    },
  });

  const checkMutation = useMutation({
    mutationKey: CHECK_MUTATION_KEY,
    mutationFn: (force?: boolean) => checkForUpdates(Boolean(force)),
    onSuccess: (nextSnapshot) => {
      queryClient.setQueryData(QUERY_KEY, nextSnapshot);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to check for updates");
    },
  });

  // Shared pending state — counts in-flight mutations globally by key, so every
  // hook instance (sidebar, mini-sidebar, settings page) sees the same value
  // regardless of which one triggered the mutation.
  const installingCount = useIsMutating({ mutationKey: INSTALL_MUTATION_KEY });
  const checkingCount = useIsMutating({ mutationKey: CHECK_MUTATION_KEY });
  const anyInstallPending = installingCount > 0;
  const anyCheckPending = checkingCount > 0;

  // Auto-check: fire once when the snapshot first becomes enabled + stale,
  // then keep a 30-min background interval. Multiple hook instances share a
  // single module-level interval; the server deduplicates via checkPromise.
  useEffect(() => {
    if (!snapshot?.enabled) return;
    const stale = !snapshot.checkedAt || Date.now() - snapshot.checkedAt > STALE_THRESHOLD_MS;
    if (stale && !anyInstallPending) {
      checkMutation.mutate(false);
    }
    if (!bgCheckInterval) {
      bgCheckInterval = setInterval(() => {
        checkMutation.mutate(false);
      }, BG_CHECK_INTERVAL_MS);
    }
    // Note: intentionally no cleanup — we want the interval to survive across
    // hook unmounts/remounts (e.g., navigating in and out of the settings page).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.enabled]);

  // Track the last stage key we rendered so we only update the persistent
  // "system-update" toast when the stage actually changes.
  const lastToastStageRef = useRef<string | null>(null);

  // Stage-tracking toast: fires while install is in-flight or the server-side
  // status is one of the install-busy states.
  useEffect(() => {
    const status = snapshot?.status;
    const installInProgress =
      anyInstallPending || (status != null && INSTALL_BUSY_STATUSES.includes(status));

    if (!installInProgress) {
      lastToastStageRef.current = null;
      return;
    }

    const label = describeUpdateStage(status, snapshot?.stage);
    if (!label) return;
    const percent = snapshot?.downloadPercent;
    const stageKey = `${status}:${snapshot?.stage ?? ""}:${percent == null ? "" : Math.floor(percent)}`;
    if (lastToastStageRef.current === stageKey) return;
    lastToastStageRef.current = stageKey;
    toast.loading(
      snapshot?.stage === "downloading" && percent != null
        ? `${label} ${Math.floor(percent)}%`
        : label,
      {
        id: TOAST_ID,
        duration: Infinity,
      },
    );
  }, [anyInstallPending, snapshot?.status, snapshot?.stage, snapshot?.downloadPercent]);

  useEffect(() => {
    if (nativeRestart && snapshot?.stage === "waiting" && snapshot.status === "available") {
      toast.info(snapshot.distribution === "desktop" ? "Update downloaded" : "Update ready", {
        id: TOAST_ID,
        description: snapshot.error ?? "Finish active chats, then choose Update and Restart.",
        duration: 8000,
      });
    }
  }, [nativeRestart, snapshot?.stage, snapshot?.status, snapshot?.error, snapshot?.distribution]);

  useEffect(() => {
    if (nativeRestart && snapshot?.status === "error") {
      toast.error(snapshot.error ?? "Relay update failed", { id: TOAST_ID, duration: 8000 });
    }
  }, [nativeRestart, snapshot?.status, snapshot?.error]);

  // Post-restart toast: once we've cleared the busy states AND we see a commit
  // that differs from the one we captured before install, show the final
  // success toast with a Reload action. The user's browser is still running
  // the old JS bundle, so refreshing is the last step.
  useEffect(() => {
    if (!pendingReload) return;
    if (anyInstallPending) return;
    const status = snapshot?.status;
    if (status == null) return;

    if (status === "error") {
      setPendingReload(false);
      modulePreInstallCommit = null;
      toast.error(snapshot?.error ?? "Relay update failed", {
        id: TOAST_ID,
        duration: 8_000,
      });
      return;
    }

    if (INSTALL_BUSY_STATUSES.includes(status)) return;

    const before = modulePreInstallCommit;
    const after = snapshot?.currentCommit ?? null;
    const commitChanged = !!after && !!before && after !== before;

    if (!commitChanged) return;

    setPendingReload(false);
    modulePreInstallCommit = null;

    const shortCommit = formatShortCommit(after);
    toast.success(shortCommit ? `Relay updated to ${shortCommit}` : "Relay updated", {
      id: TOAST_ID,
      description: "Reload the page to finish switching to the new version.",
      duration: Infinity,
      action: {
        label: "Reload",
        onClick: () => {
          if (typeof window !== "undefined") window.location.reload();
        },
      },
    });
  }, [
    pendingReload,
    anyInstallPending,
    snapshot?.status,
    snapshot?.currentCommit,
    snapshot?.error,
  ]);

  const status = snapshot?.status;
  const isBusy =
    anyInstallPending || anyCheckPending || (status != null && BUSY_STATUSES.includes(status));
  const isInstalling = anyInstallPending || status === "updating" || status === "restart_pending";
  const stageLabel = isInstalling
    ? (describeUpdateStage(status, snapshot?.stage) ?? "Installing update…")
    : status === "checking"
      ? "Checking for updates…"
      : null;
  const canInstall = Boolean(snapshot?.enabled && snapshot?.updateAvailable && !isBusy);

  const install = useCallback(() => {
    if (anyInstallPending) return;
    installMutation.mutate();
  }, [installMutation, anyInstallPending]);

  const check = useCallback(
    (force = false) => {
      checkMutation.mutate(force);
    },
    [checkMutation],
  );

  return {
    snapshot,
    isLoading,
    isBusy,
    isInstalling,
    stageLabel,
    canInstall,
    install,
    check,
    installPending: anyInstallPending,
    checkPending: anyCheckPending,
  };
}
