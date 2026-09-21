import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioTaskRunner, PENDING_TASK_KEY, BATCH_TASK_PREFIX } from './StudioTaskRunner.mjs';
import { createStudioTaskStorage } from './StudioTaskStorage.mjs';

const storage = () => {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key), keys: () => [...data.keys()] };
};

test('当前页下载失败可以重试或新生成；刷新和新标签没有普通历史，也不发送自动请求', async () => {
  const persistent = storage(); let count = 0; let broken = true; const calls = [];
  const request = async (path, options) => {
    calls.push([path, options?.method || 'GET']);
    if (options?.method === 'POST') return { id: ++count };
    if (path.endsWith('/result')) {
      if (broken) throw { code: 'NETWORK_ERROR' };
      return { images: [{ blob: new Blob(['png']) }] };
    }
    return { status: 'success' };
  };
  let serial = 0;
  const runner = new StudioTaskRunner({ storage: createStudioTaskStorage(persistent, () => 'user:1'),
    request, createId: () => `request-${++serial}` });
  await assert.rejects(runner.start({}), { code: 'STUDIO_RESULT_DOWNLOAD_FAILED' });
  await assert.rejects(runner.start({}), { code: 'STUDIO_RESULT_DOWNLOAD_FAILED' });
  assert.equal(runner.pendingAll().length, 2);
  assert.deepEqual(persistent.keys(), []);
  const before = calls.length;
  const refreshed = new StudioTaskRunner({ storage: createStudioTaskStorage(persistent, () => 'user:1'), request });
  assert.deepEqual(refreshed.pendingAll(), []);
  await assert.rejects(refreshed.resume(), { code: 'STUDIO_NO_PENDING_TASK' });
  assert.equal(calls.length, before);
  // 另一页面初始化不会删除原页面的记录。
  broken = false;
  const result = await runner.resume(undefined, 'request-1');
  runner.acknowledge(result.studio_request_id);
  assert.equal(count, 2);
  assert.deepEqual(runner.pendingAll().map(record => record.request_id), ['request-2']);
});

test('旧普通记录和损坏记录不回显；画布快照记录仍可跨刷新手动恢复', () => {
  const persistent = storage();
  persistent.setItem(PENDING_TASK_KEY, JSON.stringify({ request_id: 'old', parameters: {} }));
  persistent.setItem(BATCH_TASK_PREFIX + 'bad', '{');
  const store = createStudioTaskStorage(persistent, () => 'user:1');
  store.setItem(BATCH_TASK_PREFIX + 'canvas', JSON.stringify({ request_id: 'canvas', workspace: true, parameters: {} }));
  const runner = new StudioTaskRunner({ storage: createStudioTaskStorage(persistent, () => 'user:1') });
  assert.deepEqual(runner.pendingAll().map(record => record.request_id), ['canvas']);
  assert.ok(persistent.getItem(PENDING_TASK_KEY));
});

test('切换用户会清空本页普通记录，不显示上个身份的数据', () => {
  let owner = 'user:1';
  const store = createStudioTaskStorage(storage(), () => owner);
  store.setItem(PENDING_TASK_KEY, JSON.stringify({ request_id: 'private', parameters: {} }));
  owner = 'user:2';
  assert.equal(store.getItem(PENDING_TASK_KEY), null);
  owner = 'user:1';
  assert.equal(store.getItem(PENDING_TASK_KEY), null);
});


test('批次响应丢失后刷新可取消整批，终态不跨刷新保留且不重新生成', async () => {
  const persistent = storage(); let serial = 0; let posts = 0; let cancels = 0;
  const request = async (path, options) => {
    if (path.endsWith('/cancel')) {
      cancels++;
      return { status: 'canceled', tasks: [{ index: 0, status: 'canceled' }, { index: 1, status: 'canceled' }] };
    }
    if (options?.method === 'POST') { posts++; throw { code: 'NETWORK_ERROR' }; }
    if (path.includes('by-request')) return { id: 9, tasks: [{ index: 0 }, { index: 1 }] };
    throw new Error('不应自动查询或下载');
  };
  const create = () => new StudioTaskRunner({ storage: createStudioTaskStorage(persistent, () => 'user:1'),
    request, createId: () => `batch-${++serial}` });
  const first = create();
  first.beginBatch('batch', 2, { plan: true });
  await Promise.allSettled([first.start({ batch_id: 'batch', index: 0 }), first.start({ batch_id: 'batch', index: 1 })]);
  first.endBatch('batch');
  const refreshed = create();
  assert.equal(refreshed.pendingAll().length, 2);
  assert.equal(refreshed.busy, false);
  await refreshed.cancel(refreshed.pending().request_id);
  assert.equal(cancels, 1);
  assert.equal(posts, 1);
  assert.deepEqual(refreshed.pendingAll().map(record => record.phase), ['canceled', 'canceled']);
  assert.deepEqual(create().pendingAll(), []);
});

test('未结束任务跨刷新保留最少摘要，终态后只在当前页领取；画布继续保留', () => {
  const persistent = storage();
  const store = createStudioTaskStorage(persistent, () => 'user:1');
  for (const phase of ['submitting', 'waiting', 'waiting_timeout', 'waiting_connection', 'paused']) {
    const key = BATCH_TASK_PREFIX + phase;
    store.setItem(key, JSON.stringify({ request_id: phase, parameters: {}, phase }));
  }
  const refreshed = createStudioTaskStorage(persistent, () => 'user:1');
  assert.equal(refreshed.keys().length, 5);
  for (const key of refreshed.keys()) {
    const record = JSON.parse(refreshed.getItem(key));
    refreshed.setItem(key, JSON.stringify({ ...record, phase: 'result_pending' }));
  }
  assert.equal(refreshed.keys().length, 5);
  assert.equal(createStudioTaskStorage(persistent, () => 'user:1').keys().length, 0);
});
