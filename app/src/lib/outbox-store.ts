/** A send is removed only after the server confirms receipt. IndexedDB is the
 * source of truth; React state is just a view of it. */
const DB_NAME = "relay-outbox";
const STORE = "messages";

/** randomUUID is unavailable on non-secure LAN origins, where Relay can run. */
export function newOutboxId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface OutboxAttachment {
  name: string;
  type: string;
  blob: Blob;
  kind: "image" | "file" | "video";
}

export interface OutboxMessage {
  id: string;
  instanceId: string;
  owner: string;
  text: string;
  attachments: OutboxAttachment[];
  createdAt: number;
  status: "queued" | "sending" | "uncertain" | "failed";
  error?: string;
  leaseOwner?: string;
  leaseUntil?: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;
function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise!;
}

async function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDB();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    let value: T;
    request.onsuccess = () => {
      value = request.result;
    };
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function listOutbox(): Promise<OutboxMessage[]> {
  return transact("readonly", (store) => store.getAll());
}

export function saveOutbox(message: OutboxMessage): Promise<IDBValidKey> {
  return transact("readwrite", (store) => store.put(message));
}

export function deleteOutbox(id: string): Promise<undefined> {
  return transact("readwrite", (store) => store.delete(id));
}

/** Delete a row unless a drain currently holds its lease. Returns whether it was removed. */
export async function discardOutbox(id: string): Promise<boolean> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const request = store.get(id);
    let removed = false;
    request.onsuccess = () => {
      const message = request.result as OutboxMessage | undefined;
      if (!message) {
        removed = true;
        return;
      }
      if ((message.leaseUntil ?? 0) > Date.now()) return;
      store.delete(id);
      removed = true;
    };
    tx.oncomplete = () => resolve(removed);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Write a claimed row only while `owner` still holds its lease, so a row
 * discarded after its lease expired is never resurrected by a late drain write. */
export async function saveLeasedOutbox(message: OutboxMessage, owner: string): Promise<boolean> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const request = store.get(message.id);
    let saved = false;
    request.onsuccess = () => {
      const current = request.result as OutboxMessage | undefined;
      if (current?.leaseOwner !== owner) return;
      store.put({ ...message, leaseOwner: owner, leaseUntil: current.leaseUntil });
      saved = true;
    };
    tx.oncomplete = () => resolve(saved);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function replaceOutbox(id: string, message: OutboxMessage): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    store.put(message);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function claimOutbox(id: string, owner: string): Promise<OutboxMessage | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const request = store.get(id);
    let claimed: OutboxMessage | null = null;
    request.onsuccess = () => {
      const message = request.result as OutboxMessage | undefined;
      if (!message || (message.leaseOwner !== owner && (message.leaseUntil ?? 0) > Date.now()))
        return;
      claimed = { ...message, leaseOwner: owner, leaseUntil: Date.now() + 120_000 };
      store.put(claimed);
    };
    tx.oncomplete = () => resolve(claimed);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function renewOutboxLease(id: string, owner: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const request = store.get(id);
    request.onsuccess = () => {
      const message = request.result as OutboxMessage | undefined;
      if (message?.leaseOwner === owner) {
        store.put({ ...message, leaseUntil: Date.now() + 120_000 });
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function releaseOutboxLease(id: string, owner: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const request = store.get(id);
    request.onsuccess = () => {
      const message = request.result as OutboxMessage | undefined;
      if (message?.leaseOwner === owner) {
        store.put({ ...message, leaseOwner: undefined, leaseUntil: undefined });
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
