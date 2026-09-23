// IndexedDB-backed store for draft attachments. Draft text lives in
// localStorage; Files live here so attached-but-unsent files survive reloads.

const DB_NAME = "relay-draft-attachments";
const DB_VERSION = 1;
const STORE = "attachments";

export interface StoredAttachment {
  name: string;
  type: string;
  blob: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;
const pendingWrites = new Map<string, Promise<void>>();

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // Single record per draftKey containing the full attachment list.
        db.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  // If opening failed, allow a future retry.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

export async function loadAttachments(key: string): Promise<StoredAttachment[]> {
  try {
    await pendingWrites.get(key);
    const db = await openDB();
    return await new Promise<StoredAttachment[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as StoredAttachment[] | undefined) ?? []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function saveAttachments(key: string, items: StoredAttachment[]): Promise<void> {
  const write = async () => {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      if (items.length === 0) {
        store.delete(key);
      } else {
        store.put(items, key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  const pending = (pendingWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(write);
  pendingWrites.set(key, pending);
  try {
    await pending;
  } finally {
    if (pendingWrites.get(key) === pending) pendingWrites.delete(key);
  }
}

export async function deleteAttachments(key: string): Promise<void> {
  await saveAttachments(key, []);
}
