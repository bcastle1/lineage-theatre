import type { AppState } from "../types";
import { ADMIN_EMAIL } from "./runtime";
import { createSeedState } from "./seed";

const STATE_KEY = "lineage-theatre-state-v1";
const DB_NAME = "lineage-theatre-assets";
const STORE_NAME = "source-files";

interface StoredSourceFile {
  id: string;
  projectId: string;
  file: Blob;
  name: string;
  type: string;
  updatedAt: string;
}

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return createSeedState();
    const parsed = JSON.parse(raw) as AppState;
    if (parsed.version !== 1 || !Array.isArray(parsed.projects)) return createSeedState();
    return migrateState(parsed);
  } catch {
    return createSeedState();
  }
}

function migrateState(state: AppState): AppState {
  return {
    ...state,
    customers: state.customers.map((customer) =>
      customer.email === "family@example.com" ? { ...customer, email: ADMIN_EMAIL } : customer
    ),
  };
}

export function saveState(state: AppState) {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

export function resetState() {
  const seed = createSeedState();
  saveState(seed);
  return seed;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
  });
}

export async function saveSourceFile(id: string, projectId: string, file: File) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const payload: StoredSourceFile = {
      id,
      projectId,
      file,
      name: file.name,
      type: file.type,
      updatedAt: new Date().toISOString(),
    };
    store.put(payload);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function getSourceObjectUrl(id: string): Promise<string | null> {
  const db = await openDb();
  const stored = await new Promise<StoredSourceFile | undefined>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result as StoredSourceFile | undefined);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return stored ? URL.createObjectURL(stored.file) : null;
}

export async function deleteSourceFile(id: string) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}
