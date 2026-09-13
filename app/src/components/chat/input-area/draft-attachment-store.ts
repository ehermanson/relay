// IndexedDB-backed store for draft attachments. Drafts (text) live in
// sessionStorage, but Files can't be serialized there — IDB lets us keep
// blobs around so attached-but-unsent files survive chat switches.

const DB_NAME = "relay-draft-attachments";
const DB_VERSION = 1;
const STORE = "attachments";

export interface StoredAttachment {
  name: string;
  type: string;
  blob: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;

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
  try {
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
  } catch {
    // Best-effort; persistence is a nice-to-have.
  }
}

export async function deleteAttachments(key: string): Promise<void> {
  await saveAttachments(key, []);
}
