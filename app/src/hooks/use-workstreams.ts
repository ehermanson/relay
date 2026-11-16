/**
 * The active account's Workstreams and which chat belongs to which.
 *
 * One query shared by every surface (sidebar folders, row chips, the chat
 * header, the chat menu), so a change shows everywhere at once. Membership
 * lives beside the chat list rather than on `InstanceInfo`: it is Relay-level
 * grouping, not chat state, and keeping it out of the instance contract means
 * no session path can clobber it.
 */

import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Workstream, WorkstreamStatus, WorkstreamsSnapshot } from "@shared/types";
import { useActiveAccount } from "@/hooks/use-active-account";
import {
  createWorkstream,
  deleteWorkstream,
  fetchWorkstreams,
  setChatWorkstream,
  updateWorkstream,
} from "@/lib/api";

const EMPTY: WorkstreamsSnapshot = { workstreams: [], members: {} };

export function workstreamsQueryKey(accountId: string | undefined) {
  return ["workstreams", accountId ?? "default"] as const;
}

export function useWorkstreams() {
  const { accountIdParam } = useActiveAccount();
  const queryKey = workstreamsQueryKey(accountIdParam);
  const { data } = useQuery({
    queryKey,
    queryFn: () => fetchWorkstreams(accountIdParam),
    staleTime: 30_000,
  });
  const snapshot = data ?? EMPTY;

  const byId = useMemo(() => {
    const map = new Map<string, Workstream>();
    for (const workstream of snapshot.workstreams) map.set(workstream.id, workstream);
    return map;
  }, [snapshot.workstreams]);

  /** The Workstream a chat belongs to, if any. */
  const workstreamFor = useCallback(
    (instanceId: string | undefined): Workstream | undefined => {
      const id = instanceId ? snapshot.members[instanceId] : undefined;
      return id ? byId.get(id) : undefined;
    },
    [snapshot.members, byId],
  );

  return { workstreams: snapshot.workstreams, members: snapshot.members, byId, workstreamFor };
}

export function useWorkstreamActions() {
  const queryClient = useQueryClient();
  const { accountIdParam } = useActiveAccount();
  const queryKey = useMemo(() => workstreamsQueryKey(accountIdParam), [accountIdParam]);

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["workstreams"] }),
    [queryClient],
  );

  const patchSnapshot = useCallback(
    (update: (snapshot: WorkstreamsSnapshot) => WorkstreamsSnapshot) => {
      queryClient.setQueryData<WorkstreamsSnapshot>(queryKey, (current) =>
        update(current ?? EMPTY),
      );
    },
    [queryClient, queryKey],
  );

  const fail = useCallback(
    (err: unknown, fallback: string) => {
      toast.error(err instanceof Error ? err.message : fallback);
      void refresh();
    },
    [refresh],
  );

  /** Move a chat into a Workstream, or out of every one with `null`. Optimistic. */
  const assign = useCallback(
    async (instanceId: string, workstreamId: string | null) => {
      patchSnapshot((snapshot) => {
        const members = { ...snapshot.members };
        if (workstreamId) members[instanceId] = workstreamId;
        else delete members[instanceId];
        return { ...snapshot, members };
      });
      try {
        await setChatWorkstream(instanceId, workstreamId);
      } catch (err) {
        fail(err, "Failed to update workstream");
      }
    },
    [patchSnapshot, fail],
  );

  /** Create a Workstream, optionally putting a chat straight into it. */
  const create = useCallback(
    async (name: string, instanceId?: string): Promise<Workstream | undefined> => {
      try {
        const workstream = await createWorkstream(name, accountIdParam);
        patchSnapshot((snapshot) => ({
          ...snapshot,
          workstreams: [...snapshot.workstreams, workstream],
        }));
        if (instanceId) await assign(instanceId, workstream.id);
        return workstream;
      } catch (err) {
        fail(err, "Failed to create workstream");
        return undefined;
      }
    },
    [accountIdParam, patchSnapshot, assign, fail],
  );

  const update = useCallback(
    async (id: string, patch: { name?: string; status?: WorkstreamStatus }) => {
      patchSnapshot((snapshot) => ({
        ...snapshot,
        workstreams: snapshot.workstreams.map((workstream) =>
          workstream.id === id ? { ...workstream, ...patch } : workstream,
        ),
      }));
      try {
        await updateWorkstream(id, patch);
      } catch (err) {
        fail(err, "Failed to update workstream");
      }
    },
    [patchSnapshot, fail],
  );

  const remove = useCallback(
    async (id: string) => {
      patchSnapshot((snapshot) => ({
        workstreams: snapshot.workstreams.filter((workstream) => workstream.id !== id),
        members: Object.fromEntries(
          Object.entries(snapshot.members).filter(([, workstreamId]) => workstreamId !== id),
        ),
      }));
      try {
        await deleteWorkstream(id);
      } catch (err) {
        fail(err, "Failed to delete workstream");
      }
    },
    [patchSnapshot, fail],
  );

  /**
   * Link the directory at `path`, or unlink with `null`. Not optimistic: the
   * server decides whether the path is a real folder, and its message is
   * returned so the dialog can show it beside the input.
   */
  const setFolder = useCallback(
    async (id: string, path: string | null): Promise<string | undefined> => {
      try {
        const updated = await updateWorkstream(id, { folderPath: path });
        patchSnapshot((snapshot) => ({
          ...snapshot,
          workstreams: snapshot.workstreams.map((workstream) =>
            workstream.id === id ? updated : workstream,
          ),
        }));
        return undefined;
      } catch (err) {
        return err instanceof Error ? err.message : "Failed to link folder";
      }
    },
    [patchSnapshot],
  );

  return { assign, create, update, remove, setFolder, refresh };
}
