import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioTaskRunner, BATCH_TASK_PREFIX } from './StudioTaskRunner.mjs';
import { runStudioBatch } from './StudioBatchFlow.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const storage = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null,
  setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k), keys: () => [...data.keys()] }; };

test('一批只创建一个计划，逐任务乱序领取且失败项不覆盖成功结果', async () => {
  const store = storage(); const started = deferred(); const ready = new Set(); const waiters = [];
  const finish = id => { ready.add(id); waiters.splice(0).forEach(resolve => resolve()); };
  let serial = 0; let posts = 0; const received = [];
  const runner = new StudioTaskRunner({ storage: store, createId: () => `batch-request-${++serial}`, sleep: async () => {},
    request: async (path, options) => {
      if (options?.method === 'POST') {
        posts++; assert.equal(options.body.task_count, 3); started.resolve();
        return { id: 9, tasks: [1, 2, 3].map(id => ({ id })) };
      }
      if (path.includes('/results/')) return { images: [{ image: 'png', seed: Number(path.split('/').at(-1)) + 1 }] };
      await new Promise(resolve => waiters.push(resolve));
      return { status: 'running', tasks: [1, 2, 3].map(id => ({ id, index: id - 1, status: ready.has(id) ? id === 2 ? 'failed' : 'success' : 'queued' })) };
    } });
  const done = runStudioBatch({ runner, batchId: 'batch', count: 3, paramsFor: i => ({ seed: i }),
    generate: params => runner.start(params), receive: result => { received.push(result.images[0].seed); runner.acknowledge(result.studio_request_id); } });
  await started.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posts, 1); assert.equal(runner.pendingAll().length, 3);
  assert.equal(new Set(runner.pendingAll().map(item => item.submission_request_id)).size, 1);
  finish(3); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, [3]); assert.equal(runner.pendingAll().length, 2);
  finish(1); finish(2);
  const status = await done;
  assert.equal(status.completed, 2); assert.equal(status.failed, 1);
  assert.equal(posts, 1); assert.equal(runner.busy, false);
  assert.equal(runner.pendingAll()[0].phase, 'failed');
});

test('创建响应未返回时取消，收到创建结果后仍取消该任务，取消不触发额外生成', async () => {
  const created = deferred(); let posts = 0; let cancels = 0;
  const runner = new StudioTaskRunner({ storage: storage(), createId: () => 'cancel-pending-request',
    request: async (path, options) => {
      if (path === '/studio/tasks') { posts++; await created.promise; return { id: 9, tasks: [{ id: 90 }] }; }
      if (path.includes('by-request')) throw { status: 404 };
      if (path.endsWith('/cancel')) { cancels++; return { status: 'canceled' }; }
      return { status: 'canceled', tasks: [{ id: 90, status: 'canceled' }] };
    } });
  runner.beginBatch('cancel-batch');
  const task = runner.start({ batch_id: 'cancel-batch' });
  await assert.rejects(runner.cancel(null, 'cancel-batch'));
  await assert.rejects(runner.start({ batch_id: 'cancel-batch' }), { code: 'STUDIO_TASK_PENDING' });
  created.resolve();
  await assert.rejects(task, { code: 'STUDIO_TASK_CANCELED' });
  assert.equal(posts, 1); assert.equal(cancels, 1);
  assert.equal(runner.pending().phase, 'canceled');
  runner.endBatch('cancel-batch');
});

test('刷新后指定请求恢复只查已有结果，领取一项保留另一项与工作区快照', async () => {
  const store = storage();
  for (const id of ['first', 'second']) store.setItem(BATCH_TASK_PREFIX + id, JSON.stringify({ request_id: id,
    parameters: { width: 512 }, concurrent: true, submission_request_id: 'parent-batch', index: id === 'first' ? 0 : 1, phase: 'submitting', workspace: id === 'second' }));
  const calls = [];
  const runner = new StudioTaskRunner({ storage: store, request: async (path, options) => {
    assert.notEqual(options?.method, 'POST'); calls.push(path);
    if (path.includes('by-request')) return { id: 8, tasks: [{ id: 80 }, { id: 81 }] };
    if (path.includes('/results/')) return { images: [{ image: 'png' }] };
    return { status: 'success', tasks: [{ id: 80, status: 'success' }, { id: 81, status: 'success' }] };
  } });
  const result = await runner.resume(undefined, 'first');
  assert.equal(result.studio_request_id, 'first');
  assert.ok(calls[0].endsWith('/parent-batch'));
  assert.ok(calls.some(path => path.endsWith('/results/80')));
  runner.acknowledge('first');
  assert.deepEqual(runner.pendingAll().map(record => record.request_id), ['second']);
  assert.equal(runner.pending().workspace, true);
});

test('批量最多 64 项；换号或关页后的结果不回填并释放图片资源', async () => {
  const gate = deferred(); let current = true; let posts = 0; const released = []; const received = [];
  const runner = { beginBatch() {}, endBatch() {} };
  const done = runStudioBatch({ runner, batchId: 'eight', count: 80, paramsFor: index => ({ index }),
    isCurrent: () => current,
    generate: async params => { posts++; await gate.promise; return { index: params.index }; },
    receive: item => received.push(item), release: item => released.push(item) });
  assert.equal(posts, 64);
  current = false; gate.resolve(); await done;
  assert.deepEqual(received, []);
  assert.equal(released.length, 64);
});


test('整批记录未写完时存储失败，不提交半批也不让其他任务永久等待', async () => {
  const store = storage(); const write = store.setItem; let serial = 0; let posts = 0;
  store.setItem = (key, value) => { if (key.endsWith('local-3')) throw new Error('storage full'); write(key, value); };
  const runner = new StudioTaskRunner({ storage: store, createId: () => `local-${++serial}`, request: async () => { posts++; } });
  const status = await runStudioBatch({ runner, batchId: 'storage-batch', count: 2, paramsFor: () => ({}),
    generate: params => runner.start(params), receive: () => {} });
  assert.equal(status.failed, 2);
  assert.equal(posts, 0);
  assert.equal(runner.busy, false);
  assert.equal(runner.pending(), null);
});

test('计划响应丢失后按序号恢复；未派发项暂停时不自动继续收费', async () => {
  const store = storage(); const calls = [];
  store.setItem(BATCH_TASK_PREFIX + 'recover', JSON.stringify({ request_id: 'recover',
    parameters: { width: 512 }, concurrent: true, plan: true,
    submission_request_id: 'plan-parent-request', index: 17, phase: 'submitting' }));
  let paused = true;
  const runner = new StudioTaskRunner({ storage: store, request: async (path, options) => {
    calls.push([path, options?.method]);
    if (path.endsWith('/resume')) { paused = false; return {}; }
    if (path.includes('/results/')) return { images: [{ image: 'png', seed: 59 }] };
    return { id: 7, kind: 'plan', status: paused ? 'paused' : 'success',
      tasks: Array.from({ length: 64 }, (_, index) => ({ index, id: null, status: paused ? 'planned' : 'success' })) };
  } });
  await assert.rejects(runner.resume(), { code: 'STUDIO_PLAN_PAUSED' });
  assert.equal(runner.pending().phase, 'paused');
  assert.ok(calls.every(([,method]) => method !== 'POST'));
  await runner.resumePlan('recover');
  const result = await runner.resume();
  assert.equal(result.images[0].seed, 59);
  assert.equal(calls.filter(([,method]) => method === 'POST').length, 1);
  assert.ok(calls.some(([path]) => path === '/studio/plans/7/results/17'));
});

test('取消计划仍保留运行中图片的恢复记录', async () => {
  const store = storage();
  store.setItem(BATCH_TASK_PREFIX + 'running', JSON.stringify({ request_id: 'running',
    parameters: {}, id: 9, concurrent: true, plan: true, index: 0, phase: 'waiting' }));
  const runner = new StudioTaskRunner({ storage: store, request: async () => ({ status: 'canceled',
    tasks: [{ index: 0, status: 'running' }, { index: 1, status: 'canceled' }] }) });
  await runner.cancel('running');
  assert.equal(runner.pending().phase, 'waiting');
});
