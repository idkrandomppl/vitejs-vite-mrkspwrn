const DB = 'localchat';
let opening: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return opening;
}

function run<T>(name: 'chats' | 'kv', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction(name, mode).objectStore(name));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const putChat = (value: unknown) => run<IDBValidKey>('chats', 'readwrite', (s) => s.put(value));
export const getChats = () => run<unknown[]>('chats', 'readonly', (s) => s.getAll());
export const dropChat = (id: string) => run<void>('chats', 'readwrite', (s) => s.delete(id));
export const clearChats = () => run<void>('chats', 'readwrite', (s) => s.clear());

export const setKV = (key: string, value: unknown) => run<IDBValidKey>('kv', 'readwrite', (s) => s.put(value, key));
export const getKV = (key: string) => run<unknown>('kv', 'readonly', (s) => s.get(key));
export const clearKV = () => run<void>('kv', 'readwrite', (s) => s.clear());
