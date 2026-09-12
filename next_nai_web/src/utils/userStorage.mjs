// Studio 用户与独立模式使用不同命名空间，不迁移或覆盖原浏览器数据。
export const CONNECTION_KEY = 'idlecloud.connection';
export const STUDIO_USER_KEY = 'idlecloud.studio-user';
export const IDENTITY_EVENT_KEY = 'idlecloud.identity-change';

export function currentStorageScope() {
  if (typeof window === 'undefined') return '';
  if (window.sessionStorage.getItem(CONNECTION_KEY) !== 'studio') return '';
  const id = window.sessionStorage.getItem(STUDIO_USER_KEY);
  return `studio:${/^[1-9][0-9]*$/.test(id || '') ? id : 'pending'}:`;
}

export function createScopedStorage(storage, scope) {
  return {
    getItem: (key) => storage?.getItem(scope + key) ?? null,
    setItem: (key, value) => storage?.setItem(scope + key, value),
    removeItem: (key) => storage?.removeItem(scope + key),
    keys: () => Array.from({ length: storage?.length || 0 }, (_, index) => storage.key(index))
      .filter(key => typeof key === 'string' && (scope ? key.startsWith(scope) : !key.startsWith('studio:')))
      .map(key => key.slice(scope.length)),
  };
}

export const userStorage = {
  getItem(key) { return typeof window === 'undefined' ? null : createScopedStorage(window.localStorage, currentStorageScope()).getItem(key); },
  setItem(key, value) { if (typeof window !== 'undefined') createScopedStorage(window.localStorage, currentStorageScope()).setItem(key, value); },
  removeItem(key) { if (typeof window !== 'undefined') createScopedStorage(window.localStorage, currentStorageScope()).removeItem(key); },
  keys() { return typeof window === 'undefined' ? [] : createScopedStorage(window.localStorage, currentStorageScope()).keys(); },
};

export function chooseConnection(mode, userId = '') {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(CONNECTION_KEY, mode === 'studio' ? 'studio' : 'direct');
  window.sessionStorage.setItem(STUDIO_USER_KEY, String(userId));
  // 其他标签不再继续展示旧账号内存；当前页随后完整导航重新挂载。
  window.localStorage.setItem(IDENTITY_EVENT_KEY, JSON.stringify({ mode, userId, nonce: Date.now() }));
}
