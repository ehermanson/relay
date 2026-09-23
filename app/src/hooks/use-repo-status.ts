/**
 * Push-based repository status (`repo_status` over the WebSocket).
 *
 * Components never poll git endpoints. Instead they subscribe to a target
 * (chat / space / project); the server publishes a snapshot on subscribe and
 * again whenever the repo's fingerprint changes (agent turn end, Relay git
 * mutations, background fetch). Components invalidate their git queries when
 * the fingerprint changes.
 *
 * Several components usually watch the same target (header badge, diff
 * drawer, suggestions), so subscriptions are ref-counted per target here and
 * the wire only carries one subscription per target per connection.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useWSMethods, useWSState } from "@/context/websocket-context";
import type { ClientMessage, RepoStatusSnapshot, RepoStatusTarget } from "@shared/types";

export function repoStatusTargetKey(target: RepoStatusTarget): string {
  switch (target.kind) {
    case "instance":
      return `instance:${target.instanceId}`;
    case "space":
      return `space:${target.spaceId}`;
    case "project":
      return `project:${target.projectId}`;
  }
}

interface TargetState {
  refCount: number;
  /** Connection the server-side subscription was made on. */
  connectionId: number;
  snapshot: RepoStatusSnapshot | null;
  listeners: Set<() => void>;
}

const targets = new Map<string, TargetState>();

function getTarget(key: string): TargetState {
  let state = targets.get(key);
  if (!state) {
    state = { refCount: 0, connectionId: 0, snapshot: null, listeners: new Set() };
    targets.set(key, state);
  }
  return state;
}

/** Apply a `repo_status` message to the store. Exported for tests. */
export function applyRepoStatusMessage(
  target: RepoStatusTarget,
  snapshot: RepoStatusSnapshot | null,
) {
  const state = targets.get(repoStatusTargetKey(target));
  if (!state || state.refCount === 0) return;
  state.snapshot = snapshot;
  for (const listener of state.listeners) listener();
}

/** Acquire a ref-counted server subscription. Returns the release function. */
export function acquireRepoStatus(
  target: RepoStatusTarget,
  connectionId: number,
  send: (message: ClientMessage) => boolean,
): () => void {
  const key = repoStatusTargetKey(target);
  const state = getTarget(key);
  state.refCount++;
  if (state.refCount === 1 || state.connectionId !== connectionId) {
    state.connectionId = connectionId;
    send({ type: "repo_status_subscribe", target });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.refCount = Math.max(0, state.refCount - 1);
    if (state.refCount === 0) {
      send({ type: "repo_status_unsubscribe", target });
      state.snapshot = null;
      state.connectionId = 0;
      if (state.listeners.size === 0) targets.delete(key);
    }
  };
}

/** Test helper. */
export function resetRepoStatusStore(): void {
  targets.clear();
}

function subscribeStore(key: string, listener: () => void): () => void {
  const state = getTarget(key);
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
    if (state.refCount === 0 && state.listeners.size === 0) targets.delete(key);
  };
}

/**
 * Subscribe to repo status for `target` (null = disabled). Returns the latest
 * snapshot. When the fingerprint changes after the first snapshot, every
 * query in `invalidate` is invalidated (react-query dedups in-flight fetches).
 */
export function useRepoStatus(
  target: RepoStatusTarget | null,
  options?: { invalidate?: QueryKey[] },
): RepoStatusSnapshot | null {
  const { send, addMessageHandler } = useWSMethods();
  const { connectionId } = useWSState();
  const queryClient = useQueryClient();
  const key = target ? repoStatusTargetKey(target) : null;
  const targetRef = useRef(target);
  targetRef.current = target;

  // One global message listener per mounted hook is cheap; it only touches
  // the store for matching targets.
  useEffect(() => {
    if (!key) return;
    return addMessageHandler((message) => {
      if (message.type !== "repo_status") return;
      if (repoStatusTargetKey(message.target) !== key) return;
      applyRepoStatusMessage(message.target, message.status);
    });
  }, [addMessageHandler, key]);

  useEffect(() => {
    const current = targetRef.current;
    if (!key || !current || connectionId === 0) return;
    return acquireRepoStatus(current, connectionId, send);
  }, [key, connectionId, send]);

  const snapshot = useSyncExternalStore(
    (listener) => (key ? subscribeStore(key, listener) : () => {}),
    () => (key ? (targets.get(key)?.snapshot ?? null) : null),
  );

  const fingerprint = snapshot?.fingerprint ?? null;
  const lastFingerprintRef = useRef<{ key: string | null; value: string | null }>({
    key: null,
    value: null,
  });
  const invalidateRef = useRef(options?.invalidate);
  invalidateRef.current = options?.invalidate;
  useEffect(() => {
    if (!fingerprint) return;
    const previous = lastFingerprintRef.current;
    lastFingerprintRef.current = { key, value: fingerprint };
    // The first snapshot for a target only establishes the baseline; queries
    // already fetched on mount.
    if (previous.key !== key || previous.value === null || previous.value === fingerprint) return;
    for (const queryKey of invalidateRef.current ?? []) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [fingerprint, key, queryClient]);

  return snapshot;
}
