import type { EditorPage } from './model';

const DATABASE_NAME = 'pdf-editor-local';
const STORE_NAME = 'recovery';
const SNAPSHOT_KEY = 'active-document';

export type RecoverySnapshot = {
  fileName: string;
  bytes: ArrayBuffer;
  pages: EditorPage[];
  documentInfo: { title: string; author: string; subject: string };
  updatedAt: number;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Não foi possível abrir o armazenamento local.'));
  });
}

export async function saveRecoverySnapshot(snapshot: RecoverySnapshot) {
  if (typeof indexedDB === 'undefined') return;
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(snapshot, SNAPSHOT_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Não foi possível salvar a recuperação local.'));
  });
  database.close();
}

export async function loadRecoverySnapshot(): Promise<RecoverySnapshot | null> {
  if (typeof indexedDB === 'undefined') return null;
  const database = await openDatabase();
  const snapshot = await new Promise<RecoverySnapshot | null>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
    request.onsuccess = () => resolve((request.result as RecoverySnapshot | undefined) || null);
    request.onerror = () => reject(request.error || new Error('Não foi possível ler a recuperação local.'));
  });
  database.close();
  return snapshot;
}

export async function clearRecoverySnapshot() {
  if (typeof indexedDB === 'undefined') return;
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(SNAPSHOT_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Não foi possível limpar a recuperação local.'));
  });
  database.close();
}
