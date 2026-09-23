import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { uploadAttachment } from "@/lib/api";
import {
  claimOutbox,
  deleteOutbox,
  discardOutbox,
  listOutbox,
  newOutboxId,
  releaseOutboxLease,
  renewOutboxLease,
  replaceOutbox,
  saveLeasedOutbox,
  saveOutbox,
  type OutboxAttachment,
  type OutboxMessage,
} from "@/lib/outbox-store";
import { useWSState } from "@/context/websocket-context";
import { useWSMethods } from "@/context/websocket-context";

interface OutboxContextValue {
  messages: OutboxMessage[];
  enqueue: (instanceId: string, text: string, attachments: OutboxAttachment[]) => Promise<void>;
  retry: (id: string) => Promise<void>;
  /** Resolves false when the message is mid-send and can no longer be withdrawn. */
  discard: (id: string) => Promise<boolean>;
}

const Context = createContext<OutboxContextValue | null>(null);
const OWNER_KEY = "relay:outbox-owner";
const WORKER_ID = newOutboxId();

class SendError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function responseJson(
  url: string,
  init?: RequestInit,
): Promise<{ state?: string; identity?: string; error?: string }> {
  const response = await fetch(url, init);
  if (response.status === 401) throw new Error("Authentication required");
  const data = await response.json();
  if (!response.ok && response.status !== 409)
    throw new SendError(data.error || "Connection failed", response.status);
  return data;
}

export function OutboxProvider({ children }: { children: ReactNode }) {
  const { isConnected, connectionId, instances } = useWSState();
  const { markUserAwaitingReply } = useWSMethods();
  const [messages, setMessages] = useState<OutboxMessage[]>([]);
  const [kick, setKick] = useState(0);
  const draining = useRef(false);
  const drainAgain = useRef(false);
  const ownerRef = useRef<string | null>(window.localStorage.getItem(OWNER_KEY));
  const instancesRef = useRef(instances);
  instancesRef.current = instances;

  // The drain only cares whether chats with queued sends can accept a turn.
  // Keying on that (not the whole instance list, which churns while any chat
  // streams) keeps the drain from restarting on unrelated updates.
  const readyKey = useMemo(() => {
    const queued = new Set(messages.map((entry) => entry.instanceId));
    return instances
      .filter((instance) => queued.has(instance.id))
      .map(
        (instance) =>
          `${instance.id}:${
            instance.status !== "processing" &&
            !instance.pendingPermission &&
            !instance.pendingTool &&
            !instance.pendingPlan
          }`,
      )
      .sort()
      .join(",");
  }, [instances, messages]);

  const refresh = useCallback(async () => {
    setMessages((await listOutbox()).sort((a, b) => a.createdAt - b.createdAt));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => setKick((n) => n + 1), 15_000);
    const wake = () => setKick((n) => n + 1);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);

  const enqueue = useCallback(
    async (instanceId: string, text: string, attachments: OutboxAttachment[]) => {
      let owner = ownerRef.current;
      if (!owner && navigator.onLine) {
        const data = await responseJson("/api/outbox/identity");
        owner = data.identity ?? null;
        if (owner) {
          ownerRef.current = owner;
          window.localStorage.setItem(OWNER_KEY, owner);
        }
      }
      const message: OutboxMessage = {
        id: newOutboxId(),
        instanceId,
        owner: owner ?? "unknown",
        text,
        attachments,
        createdAt: Date.now(),
        status: "queued",
      };
      await saveOutbox(message);
      await refresh();
      setKick((n) => n + 1);
    },
    [refresh],
  );

  const retry = useCallback(
    async (id: string) => {
      const message = (await listOutbox()).find((entry) => entry.id === id);
      if (!message) return;
      // An uncertain receipt can represent a turn already delivered. Retrying is
      // an explicit user action with a new ID, never an automatic replay.
      const identity = (await responseJson("/api/outbox/identity")).identity;
      if (!identity) throw new Error("Reconnect before sending again");
      await replaceOutbox(id, {
        ...message,
        id: newOutboxId(),
        owner: identity,
        status: "queued",
        error: undefined,
        leaseOwner: undefined,
        leaseUntil: undefined,
      });
      await refresh();
      setKick((n) => n + 1);
    },
    [refresh],
  );

  const discard = useCallback(
    async (id: string) => {
      const removed = await discardOutbox(id);
      await refresh();
      return removed;
    },
    [refresh],
  );

  useEffect(() => {
    if (!isConnected) return;
    if (draining.current) {
      drainAgain.current = true;
      return;
    }
    let cancelled = false;
    draining.current = true;
    void (async () => {
      try {
        const rows = await listOutbox();
        if (rows.length === 0 || cancelled) return;
        const identity = (await responseJson("/api/outbox/identity")).identity;
        if (!identity || cancelled) return;
        ownerRef.current = identity;
        window.localStorage.setItem(OWNER_KEY, identity);
        const blockedChats = new Set<string>();
        for (const row of rows.sort((a, b) => a.createdAt - b.createdAt)) {
          if (cancelled || !navigator.onLine) break;
          if (blockedChats.has(row.instanceId)) continue;
          if (row.status === "uncertain" || row.status === "failed") {
            blockedChats.add(row.instanceId);
            continue;
          }
          const message = await claimOutbox(row.id, WORKER_ID);
          if (!message) {
            blockedChats.add(row.instanceId);
            continue;
          }
          // Every write below goes through the lease: if the row was discarded
          // (possible only after an expired lease) it must stay gone.
          const persist = (next: OutboxMessage) => saveLeasedOutbox(next, WORKER_ID);
          const leaseTimer = setInterval(() => {
            void renewOutboxLease(message.id, WORKER_ID);
          }, 30_000);
          try {
            if (message.owner !== identity) {
              await persist({
                ...message,
                status: "uncertain",
                error: "Saved under a different login. Check before sending again.",
              });
              blockedChats.add(message.instanceId);
              continue;
            }
            if (message.status === "sending") {
              const receipt = await responseJson(`/api/outbox/${message.id}`);
              if (receipt.state === "accepted") {
                await deleteOutbox(message.id);
                continue;
              }
              if (receipt.state !== "missing") {
                await persist({
                  ...message,
                  status: "uncertain",
                  error: "Delivery may have completed. Check the chat before retrying.",
                });
                blockedChats.add(message.instanceId);
                continue;
              }
            }
            const instance = instancesRef.current.find((entry) => entry.id === message.instanceId);
            if (
              !instance ||
              instance.status === "processing" ||
              instance.pendingPermission ||
              instance.pendingTool ||
              instance.pendingPlan
            ) {
              blockedChats.add(message.instanceId);
              continue;
            }
            const sending = { ...message, status: "sending" as const, error: undefined };
            if (!(await persist(sending))) continue;
            void refresh();
            let uploaded: { path: string; kind: OutboxAttachment["kind"] }[];
            try {
              uploaded = await Promise.all(
                message.attachments.map(async (entry) => ({
                  path: await uploadAttachment(
                    new File([entry.blob], entry.name, { type: entry.type }),
                  ),
                  kind: entry.kind,
                })),
              );
            } catch (error) {
              const description =
                error instanceof Error ? error.message : "Attachment upload failed";
              const permanent =
                description.startsWith("File too large") ||
                description.includes("Unsupported file type");
              await persist({
                ...message,
                status: permanent ? "failed" : "queued",
                error: description,
              });
              blockedChats.add(message.instanceId);
              if (!permanent) break;
              continue;
            }
            try {
              const result = await responseJson(`/api/outbox/${message.id}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  instanceId: message.instanceId,
                  text: message.text,
                  images: uploaded
                    .filter((entry) => entry.kind === "image")
                    .map((entry) => entry.path),
                  attachments: uploaded
                    .filter((entry) => entry.kind !== "image")
                    .map((entry) => entry.path),
                }),
              });
              if (result.state === "accepted") {
                markUserAwaitingReply(message.instanceId);
                await deleteOutbox(message.id);
              } else if (result.state === "busy") await persist({ ...message, status: "queued" });
              else
                await persist({
                  ...message,
                  status: "uncertain",
                  error:
                    result.error ?? "Delivery may have completed. Check the chat before retrying.",
                });
              blockedChats.add(message.instanceId);
            } catch (error) {
              if (error instanceof SendError && error.status >= 400 && error.status < 500) {
                await persist({ ...message, status: "failed", error: error.message });
              }
              // A failed upload/POST may or may not have reached the server.
              // Keep `sending`; the next connection checks the server receipt.
              break;
            }
          } finally {
            clearInterval(leaseTimer);
            await releaseOutboxLease(message.id, WORKER_ID);
          }
        }
      } catch {
        // Preserve the local queue when Relay or auth is unavailable.
      } finally {
        draining.current = false;
        if (!cancelled) void refresh();
        if (drainAgain.current) {
          drainAgain.current = false;
          setKick((n) => n + 1);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isConnected, connectionId, readyKey, kick, refresh, markUserAwaitingReply]);

  return (
    <Context.Provider value={{ messages, enqueue, retry, discard }}>{children}</Context.Provider>
  );
}

export function useOutbox() {
  const value = useContext(Context);
  if (!value) throw new Error("useOutbox must be used within OutboxProvider");
  return value;
}
