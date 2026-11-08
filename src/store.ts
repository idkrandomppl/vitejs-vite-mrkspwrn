const DB_NAME = 'localchat';
const VERSION = 1;

type Stores = 'chats' | 'kv';

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('chats')) db.createObjectStore('chats', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx<T>(store: Stores, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const put = <T>(store: Stores, value: T, key?: string) =>
  key === undefined ? tx(store, 'readwrite', (s) => s.put(value)) : tx(store, 'readwrite', (s) => s.put(value, key));

export const get = <T>(store: Stores, key: string) => tx<T | undefined>(store, 'readonly', (s) => s.get(key));
export const del = (store: Stores, key: string) => tx(store, 'readwrite', (s) => s.delete(key));
export const all = <T>(store: Stores) => tx<T[]>(store, 'readonly', (s) => s.getAll());
export const clearStore = (store: Stores) => tx(store, 'readwrite', (s) => s.clear());
