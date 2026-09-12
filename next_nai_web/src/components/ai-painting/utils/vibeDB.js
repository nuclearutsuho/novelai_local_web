import { currentStorageScope } from '@/utils/userStorage.mjs';
// utils/vibeDB.js

const DB_NAME = 'AIPaintingVibeDB';
const STORE_NAME = 'vibeCache';
const PANEL_STATE_STORE_NAME = 'vibePanelState';
const PANEL_STATE_KEY = 'current-vibe-images';
const DB_VERSION = 2;
export const VIBE_DB_ERROR_CODES = Object.freeze({
  UNSUPPORTED: 'VIBE_DB_UNSUPPORTED',
  OPEN_FAILED: 'VIBE_DB_OPEN_FAILED',
});

/**
 * 打开或创建 IndexedDB 数据库。
 * @returns {Promise<IDBDatabase>} 返回一个数据库实例的 Promise。
 */
function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      const error = new Error(VIBE_DB_ERROR_CODES.UNSUPPORTED);
      error.code = VIBE_DB_ERROR_CODES.UNSUPPORTED;
      reject(error);
      return;
    }
    const request = indexedDB.open(currentStorageScope() + DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // 创建一个对象存储空间，使用 cacheKey 作为主键
        db.createObjectStore(STORE_NAME, { keyPath: 'cacheKey' });
      }
      if (!db.objectStoreNames.contains(PANEL_STATE_STORE_NAME)) {
        db.createObjectStore(PANEL_STATE_STORE_NAME, { keyPath: 'key' });
      }
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onerror = (event) => {
      console.error("数据库错误:", event.target.errorCode);
      const error = new Error(VIBE_DB_ERROR_CODES.OPEN_FAILED);
      error.code = VIBE_DB_ERROR_CODES.OPEN_FAILED;
      reject(error);
    };
  });
}

/**
 * 根据哈希值、模型和信息提取值生成一个唯一的缓存键。
 * @param {string} hash - 图像哈希值。
 * @param {string} model - 模型名称。
 * @param {number} information_extracted - 信息提取值。
 * @returns {string} 唯一的缓存键。
 */
const getCacheKey = (hash, model, information_extracted) => {
    // 将 information_extracted 格式化为一位小数
    return `${hash}-${model}-${information_extracted.toFixed(1)}`;
}

async function runVibeTransaction(storeName, mode, operation, selectResult = value => value) {
  const owner = currentStorageScope();
  const db = await openDatabase();
  try {
    if (currentStorageScope() !== owner) throw new Error('STUDIO_IDENTITY_CHANGED');
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], mode);
      let request;
      // 单个请求成功不等于事务提交；只有 complete 才允许确认领取或更新界面。
      transaction.oncomplete = () => {
        if (currentStorageScope() !== owner) reject(new Error('STUDIO_IDENTITY_CHANGED'));
        else resolve(selectResult(request.result));
      };
      transaction.onabort = () => reject(transaction.error || request?.error || new Error('VIBE_DB_TRANSACTION_ABORTED'));
      transaction.onerror = () => reject(transaction.error || request?.error || new Error('VIBE_DB_TRANSACTION_FAILED'));
      try { request = operation(transaction.objectStore(storeName)); }
      catch (error) { transaction.abort(); reject(error); }
    });
  } finally {
    db.close();
  }
}

/**
 * 将 Vibe 数据添加到缓存中。
 * @param {object} vibeData - 要缓存的完整 Vibe JSON 对象。
 * @param {string} hash - 图像哈希值。
 * @param {string} model - 模型名称。
 * @param {number} information_extracted - 信息提取值。
 * @returns {Promise<void>} 操作完成时解析的 Promise。
 */
export const addVibeToCache = async (vibeData, hash, model, information_extracted) => {
    return runVibeTransaction(STORE_NAME, 'readwrite', store => store.put({
        ...vibeData, cacheKey: getCacheKey(hash, model, information_extracted),
    }), () => undefined);
};

/**
 * 从缓存中检索 Vibe 数据。
 * @param {string} hash - 图像哈希值。
 * @param {string} model - 模型名称。
 * @param {number} information_extracted - 信息提取值。
 * @returns {Promise<object|undefined>} 返回找到的 Vibe 数据对象，如果未找到则返回 undefined。
 */
export const getVibeFromCache = async (hash, model, information_extracted) => {
    return runVibeTransaction(STORE_NAME, 'readonly', store => store.get(getCacheKey(hash, model, information_extracted)));
};

/**
 * [新增] 从缓存中检索所有 Vibe 数据。
 * @returns {Promise<Array<object>>} 返回包含所有 Vibe 数据对象的数组。
 */
export const getAllVibesFromCache = async () => {
    return runVibeTransaction(STORE_NAME, 'readonly', store => store.getAll(), result => result || []);
};

export const saveVibePanelState = async (vibeImages) => {
  return runVibeTransaction(PANEL_STATE_STORE_NAME, 'readwrite', store => store.put({
      key: PANEL_STATE_KEY,
      vibeImages,
      updatedAt: Date.now(),
    }), () => undefined);
};

export const getVibePanelState = async () => {
  return runVibeTransaction(PANEL_STATE_STORE_NAME, 'readonly', store => store.get(PANEL_STATE_KEY), result => result?.vibeImages || []);
};

export const clearVibePanelState = async () => {
  return runVibeTransaction(PANEL_STATE_STORE_NAME, 'readwrite', store => store.delete(PANEL_STATE_KEY), () => undefined);
};
