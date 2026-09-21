import { BATCH_TASK_PREFIX, PENDING_TASK_KEY } from './StudioTaskRunner.mjs';

// 已完成普通图片只属于本页；未确认终态的任务保留摘要供刷新后查询/取消，不自动下载。
const needsTracking = record => record?.workspace === true ||
  ['submitting', 'waiting', 'waiting_timeout', 'waiting_connection', 'paused'].includes(record?.phase);
export function createStudioTaskStorage(persistent, scope) {
  const records = new Map();
  let owner = scope();
  const checkScope = () => {
    if (owner !== scope()) { records.clear(); owner = scope(); }
  };
  const persistedTracking = key => {
    const value = persistent.getItem(key);
    if (!value) return null;
    try { return needsTracking(JSON.parse(value)) ? value : null; }
    catch { return null; } // 旧普通记录损坏也不能阻塞新的生成。
  };
  return {
    getItem(key) {
      checkScope();
      return records.get(key) ?? persistedTracking(key);
    },
    setItem(key, value) {
      checkScope();
      if (needsTracking(JSON.parse(value))) {
        persistent.setItem(key, value);
        records.delete(key);
      } else {
        // 观察到终态后不再跨刷新保留；本页仍能手动领取未下载的图片。
        persistent.removeItem(key);
        records.set(key, value);
      }
    },
    removeItem(key) {
      checkScope();
      records.delete(key);
      if (persistedTracking(key)) persistent.removeItem(key);
    },
    keys() {
      checkScope();
      // 兼容旧未结束摘要；普通终态记录不作为历史图片入口。
      const saved = (persistent.keys?.() || []).filter(key =>
        (key === PENDING_TASK_KEY || key.startsWith(BATCH_TASK_PREFIX)) && persistedTracking(key));
      return [...new Set([...records.keys(), ...saved])];
    },
  };
}
