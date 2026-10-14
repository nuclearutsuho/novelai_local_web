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
  persistent.setItem(BATCH_TASK_PREFIX + 'expired', JSON.stringify({ request_id: 'expired', parameters: {}, phase: 'result_expired' }));
  const store = createStudioTaskStorage(persistent, () => 'user:1');
  store.setItem(BATCH_TASK_PREFIX + 'canvas', JSON.stringify({ request_id: 'canvas', workspace: true, parameters: {} }));
  const runner = new StudioTaskRunner({ storage: createStudioTaskStorage(persistent, () => 'user:1') });
  assert.deepEqual(runner.pendingAll().map(record => record.request_id), ['canvas']);
  assert.ok(persistent.getItem(PENDING_TASK_KEY));
  assert.equal(persistent.getItem(BATCH_TASK_PREFIX + 'expired'), null);
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

test('不存在的旧画布任务自动清理摘要和快照，刷新不复现且不影响其他任务', async () => {
  const persistent = storage();
  const scope = () => 'user:1';
  const store = createStudioTaskStorage(persistent, scope);
  for (const id of ['missing', 'other']) store.setItem(BATCH_TASK_PREFIX + id, JSON.stringify({
    request_id: id, separate: true, workspace: true, parameters: {}, phase: 'submitting',
  }));
  const calls = []; const removed = [];
  const runner = new StudioTaskRunner({ storage: store, scope,
    workspaceStore: { remove: async id => removed.push(id) },
    request: async (path, options) => {
      calls.push([path, options?.method || 'GET']);
      throw { status: 404, code: 'idlecloud_task_not_found' };
    },
  });
  assert.equal(await runner.inspect('missing'), null);
  assert.deepEqual(removed, ['missing']);
  const refreshed = new StudioTaskRunner({ storage: createStudioTaskStorage(persistent, scope) });
  assert.deepEqual(refreshed.pendingAll().map(record => record.request_id), ['other']);
  assert.deepEqual(calls, [['/studio/tasks/by-request/missing', 'GET']]);
});

test('恢复只清理明确失效任务，普通 404、权限错误、断网和迟到的旧账号 404 保留摘要', async () => {
  for (const error of [{ status: 404, code: 'HTTP_404' }, { status: 401 }, { status: 403 }, { code: 'NETWORK_ERROR' }]) {
    const persistent = storage();
    persistent.setItem(BATCH_TASK_PREFIX + 'keep', JSON.stringify({ request_id: 'keep', separate: true,
      workspace: true, id: 11, parameters: {}, phase: 'waiting' }));
    const runner = new StudioTaskRunner({ storage: persistent, sleep: async () => {}, request: async () => { throw error; } });
    await assert.rejects(runner.inspect('keep'));
    assert.ok(runner.pending('keep'));
  }
  let owner = 'one';
  const persistent = storage();
  persistent.setItem(BATCH_TASK_PREFIX + 'same', JSON.stringify({ request_id: 'same', separate: true,
    workspace: true, id: 11, parameters: {}, phase: 'waiting' }));
  const runner = new StudioTaskRunner({ storage: persistent, scope: () => owner, request: async () => {
    owner = 'two'; throw { status: 404, code: 'idlecloud_task_not_found' };
  } });
  await assert.rejects(runner.inspect('same'), { code: 'STUDIO_IDENTITY_CHANGED' });
  assert.ok(persistent.getItem(BATCH_TASK_PREFIX + 'same'));
});
