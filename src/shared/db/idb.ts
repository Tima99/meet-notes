/**
 * Minimal promise helpers over raw IndexedDB (no runtime dependency).
 *
 * Awaiting a request inside a transaction is safe: the promise resolves from the
 * request's success callback and its continuation runs as a microtask before the
 * transaction can auto-commit.
 */
import { DB_NAME, DB_VERSION, upgradeSchema } from './schema';

export function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

export interface OpenOptions {
  readonly factory?: IDBFactory;
  readonly name?: string;
  readonly version?: number;
}

export function openDatabase(options: OpenOptions = {}): Promise<IDBDatabase> {
  const factory = options.factory ?? indexedDB;
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(options.name ?? DB_NAME, options.version ?? DB_VERSION);
    request.onupgradeneeded = (event) => upgradeSchema(request.result, event.oldVersion);
    request.onsuccess = () => {
      const db = request.result;
      // Another context upgraded the schema: close so the upgrade can proceed.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open MeetNotes database'));
    request.onblocked = () => reject(new Error('MeetNotes database upgrade is blocked by another open tab'));
  });
}

/**
 * Runs `work` in one transaction and resolves with its result once the
 * transaction has COMMITTED (so callers only see durable writes).
 */
export async function withTransaction<T>(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const tx = db.transaction(stores, mode);
  const done = transactionDone(tx);
  let result: T;
  try {
    result = await work(tx);
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // already finished
    }
    await done.catch(() => undefined);
    throw error;
  }
  await done;
  return result;
}
