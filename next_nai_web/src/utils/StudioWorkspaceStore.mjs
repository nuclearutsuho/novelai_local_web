import { currentStorageScope } from './userStorage.mjs';

// 画布快照使用用户独立的 IndexedDB，避免 Base64 占满同步存储。
async function operation(mode, action) {
  const scope = currentStorageScope();
  if (!/^studio:[1-9][0-9]*:$/.test(scope)) throw new Error('STUDIO_WORKSPACE_IDENTITY_REQUIRED');
  const db = await new Promise((resolve, reject) => {
    const opening = indexedDB.open(`${scope}idlecloud-recovery`, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('workspaces');
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
  try {
    if (currentStorageScope() !== scope) throw new Error('STUDIO_WORKSPACE_IDENTITY_CHANGED');
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('workspaces', mode);
      const request = action(transaction.objectStore('workspaces'));
      transaction.oncomplete = () => currentStorageScope() === scope
        ? resolve(request.result) : reject(new Error('STUDIO_WORKSPACE_IDENTITY_CHANGED'));
      transaction.onabort = () => reject(transaction.error || new Error('STUDIO_WORKSPACE_STORAGE_FAILED'));
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

export const studioWorkspaceStore = {
  save: (id, snapshot) => operation('readwrite', (store) => store.put(snapshot, id)),
  load: (id) => operation('readonly', (store) => store.get(id)),
  remove: (id) => operation('readwrite', (store) => store.delete(id)),
};
