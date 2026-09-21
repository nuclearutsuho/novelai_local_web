import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioTaskRunner, PENDING_TASK_KEY } from './StudioTaskRunner.mjs';
import { createScopedStorage } from './userStorage.mjs';

const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k), keys: () => [...data.keys()] }; };

test('恢复二进制结果保持 Blob，画廊确认前仍保留恢复记录', async () => {
  const store = storage();
  store.setItem(PENDING_TASK_KEY, JSON.stringify({ request_id: 'binary', id: 7, parameters: {}, phase: 'waiting' }));
  const blob = new Blob(['png-fixture'], { type: 'image/png' });
  const runner = new StudioTaskRunner({ storage: store, request: async (path, options) => {
    if (path.endsWith('/result')) {
      assert.equal(options.headers.Accept, 'image/*');
      return { images: [{ blob, seed: 0 }] };
    }
    return { id: 7, status: 'success' };
  } });
  const result = await runner.resume();
  assert.equal(result.images[0].blob, blob);
  assert.equal(result.images[0].seed, 0);
  assert.ok(store.getItem(PENDING_TASK_KEY));
  runner.acknowledge(result.studio_request_id);
  assert.equal(store.getItem(PENDING_TASK_KEY), null);
});

test('切换账号后迟到的提交成功或拒绝都不能覆盖新用户记录', async () => {
  for (const reject of [false, true]) {
    let owner = 'studio:1:';
    const base = storage();
    const other = JSON.stringify({ request_id: 'same-id', parameters: { prompt: 'other-user' } });
    base.setItem('studio:2:' + PENDING_TASK_KEY, other);
    const scoped = { getItem: (k) => base.getItem(owner + k), setItem: (k, v) => base.setItem(owner + k, v), removeItem: (k) => base.removeItem(owner + k), keys: () => base.keys().filter(k => k.startsWith(owner)).map(k => k.slice(owner.length)) };
    const runner = new StudioTaskRunner({ scope: () => owner, storage: scoped, createId: () => 'same-id',
      request: async () => { owner = 'studio:2:'; if (reject) throw { status: 400 }; return { id: 7 }; } });
    await assert.rejects(runner.start({ prompt: 'private' }), { code: 'STUDIO_IDENTITY_CHANGED' });
    assert.equal(base.getItem('studio:2:' + PENDING_TASK_KEY), other);
    assert.equal(JSON.parse(base.getItem('studio:1:idlecloud.batch-task:same-id')).phase, 'submitting');
  }
});

test('恢复结果途中切换账号不会返回旧用户图片或写入新记录', async () => {
  let owner = 'studio:1:';
  const base = storage();
  const original = JSON.stringify({ request_id: 'old', id: 7, parameters: {}, phase: 'waiting' });
  base.setItem(owner + PENDING_TASK_KEY, original);
  const scoped = { getItem: (k) => base.getItem(owner + k), setItem: (k, v) => base.setItem(owner + k, v) };
  const runner = new StudioTaskRunner({ storage: scoped, scope: () => owner,
    request: async (path) => {
      if (path.endsWith('/result')) { owner = 'studio:2:'; return { images: [{ image: 'private-image' }] }; }
      return { status: 'success' };
    } });
  await assert.rejects(runner.resume(), { code: 'STUDIO_IDENTITY_CHANGED' });
  assert.equal(JSON.parse(base.getItem('studio:1:' + PENDING_TASK_KEY)).phase, 'result_pending');
  assert.equal(base.getItem('studio:2:' + PENDING_TASK_KEY), null);
});

test('取消查询期间切换账号不会再发送取消请求', async () => {
  let owner = 'studio:1:';
  const store = storage();
  store.setItem(PENDING_TASK_KEY, JSON.stringify({ request_id: 'old', parameters: {} }));
  const calls = [];
  const runner = new StudioTaskRunner({ storage: store, scope: () => owner,
    request: async (path, options) => { calls.push(options?.method || 'GET'); owner = 'studio:2:'; return { id: 7 }; } });
  await assert.rejects(runner.cancel(), { code: 'STUDIO_IDENTITY_CHANGED' });
  assert.deepEqual(calls, ['GET']);
});

test('响应丢失后恢复只查询已有任务，不重发 POST', async () => {
  const store = storage(); const calls = [];
  const request = async (path, options) => {
    calls.push([path, options?.method || 'GET']);
    if (options?.method === 'POST') throw Object.assign(new Error('network'), { code: 'NETWORK_ERROR' });
    if (path.includes('by-request')) return { id: 7 };
    if (path.endsWith('/result')) return { images: [{ image: 'png-fixture', seed: 42 }] };
    return { id: 7, status: 'success' };
  };
  const runner = new StudioTaskRunner({ request, storage: store, createId: () => 'request-0000000001', sleep: async () => {} });
  await assert.rejects(runner.start({ width: 512, height: 512, seed: 42 }));
  assert.ok(runner.pending());
  const resumed = new StudioTaskRunner({ request, storage: store });
  const result = await resumed.resume();
  assert.equal(result.images[0].seed, 42);
  assert.equal(calls.filter(([, method]) => method === 'POST').length, 1);
  assert.ok(resumed.pending());
  resumed.acknowledge(result.studio_request_id);
  assert.equal(resumed.pending(), null);
});

test('明确参数拒绝可重新编辑，不确定失败仍保留任务', async () => {
  const runner = new StudioTaskRunner({ request: async () => { throw { status: 400 }; }, storage: storage(), createId: () => 'request-0000000001' });
  await assert.rejects(runner.start({ prompt: 'test' }));
  assert.equal(runner.pending(), null);
});

test('已有旧版未领取记录不阻止新生成，新旧记录均可保留', async () => {
  const store = storage(); store.setItem(PENDING_TASK_KEY, JSON.stringify({ request_id: 'old', parameters: {} }));
  let sent = false;
  const runner = new StudioTaskRunner({ request: async () => { sent = true; throw { code: 'NETWORK_ERROR' }; }, storage: store, createId: () => 'new' });
  await assert.rejects(runner.start({}), { code: 'NETWORK_ERROR' });
  assert.equal(sent, true);
  assert.deepEqual(runner.pendingAll().map(r => r.request_id), ['old', 'new']);
});

test('用户草稿分区不读取其他用户或独立模式的数据', () => {
  const base = storage(); base.setItem('prompt', 'original');
  const a = createScopedStorage(base, 'studio:1:'); const b = createScopedStorage(base, 'studio:2:');
  assert.equal(a.getItem('prompt'), null);
  a.setItem('prompt', 'private');
  assert.equal(b.getItem('prompt'), null);
  assert.equal(base.getItem('prompt'), 'original');
  b.removeItem('prompt'); assert.equal(a.getItem('prompt'), 'private');
});

test('大图原文只发送给服务端，断线恢复记录不占用图片大小的 localStorage', async () => {
  const store = storage();
  const originalSet = store.setItem;
  store.setItem = (key, value) => {
    assert.ok(value.length < 2048, '恢复记录不应包含大图或参考编码');
    originalSet(key, value);
  };
  const image = 'A'.repeat(6 * 1024 * 1024);
  const parameters = { positivePrompt: '原版提示词', model: 'nai-diffusion-4-5-full', width: 512, height: 512,
    image, mask: image, director_reference_images_cached: [{ data: image }], reference_image_multiple: [image] };
  let submitted;
  const runner = new StudioTaskRunner({ storage: store, createId: () => 'image-request-0001',
    request: async (_path, options) => { submitted = options.body; throw new Error('response lost'); } });
  await assert.rejects(runner.start(parameters));
  assert.equal(submitted.parameters.image, image);
  assert.equal(submitted.parameters.mask, image);
  assert.equal(runner.pending().parameters.positivePrompt, '原版提示词');
  assert.equal(runner.pending().parameters.image, undefined);
  const recovered = new StudioTaskRunner({ storage: store, request: async (path, options) => {
    assert.notEqual(options?.method, 'POST');
    if (path.includes('by-request')) return { id: 9 };
    if (path.endsWith('/result')) return { images: [{ image: 'png-fixture', seed: 42 }] };
    return { status: 'success' };
  } });
  const result = await recovered.resume();
  assert.equal(result.studio_parameters.positivePrompt, '原版提示词');
  assert.equal(result.images[0].width, 512);
});

test('画布快照提交事务后才发送生成，恢复记录关联同一任务', async () => {
  const events = [];
  const snapshots = new Map();
  const workspace = { version: 1, content: '底图', mask: '蒙版', bounds: { x: -32, y: 64 } };
  const runner = new StudioTaskRunner({ storage: storage(), createId: () => 'workspace-task-01',
    workspaceStore: {
      save: async (id, value) => { await Promise.resolve(); snapshots.set(id, value); events.push('saved'); },
      remove: async (id) => { snapshots.delete(id); },
    },
    request: async () => { events.push('sent'); throw new Error('connection lost'); } });
  await assert.rejects(runner.start({ width: 512 }, undefined, workspace));
  assert.deepEqual(events, ['saved', 'sent']);
  assert.equal(runner.pending().workspace, true);
  assert.deepEqual(snapshots.get(runner.pending().request_id), workspace);
  runner.acknowledge('workspace-task-01');
  assert.equal(snapshots.size, 0);
});

test('画布快照保存失败时不发生成请求', async () => {
  let sent = false;
  const runner = new StudioTaskRunner({ storage: storage(), createId: () => 'workspace-task-02',
    workspaceStore: { save: async () => { throw new Error('quota'); }, remove: async () => {} },
    request: async () => { sent = true; } });
  await assert.rejects(runner.start({}, undefined, { version: 1 }), /quota/);
  assert.equal(sent, false);
  assert.equal(runner.pending(), null);
  assert.equal(runner.busy, false);
});

test('下载中断后可生成新图，取消已成功任务不能丢结果，恢复不重复 POST', async () => {
  const store = storage(); let serial = 0; let offline = true; const posts = [];
  const runner = new StudioTaskRunner({ storage: store, createId: () => `task-${++serial}`,
    request: async (path, options) => {
      if (path.endsWith('/cancel')) return { status: 'success' };
      if (options?.method === 'POST') { posts.push(options.body.request_id); return { id: posts.length }; }
      if (path.endsWith('/result')) {
        if (offline) throw { code: 'NETWORK_ERROR' };
        return { images: [{ image: 'png' }] };
      }
      return { status: 'success' };
    } });
  await assert.rejects(runner.start({}), { code: 'STUDIO_RESULT_DOWNLOAD_FAILED' });
  await runner.cancel('task-1');
  assert.equal(runner.pending('task-1').phase, 'result_pending');
  await assert.rejects(runner.start({}), { code: 'STUDIO_RESULT_DOWNLOAD_FAILED' });
  assert.equal(runner.pendingAll().length, 2);
  offline = false;
  for (const id of ['task-1', 'task-2']) {
    const result = await runner.resume(undefined, id);
    runner.acknowledge(result.studio_request_id);
  }
  assert.deepEqual(posts, ['task-1', 'task-2']);
  assert.equal(runner.pendingAll().length, 0);
});

test('旧结果正在下载时新生成可提交，同一恢复请求不能同时领取两次', async () => {
  const store = storage(); let release; const gate = new Promise(resolve => { release = resolve; });
  store.setItem(PENDING_TASK_KEY, JSON.stringify({ request_id: 'old', id: 7, parameters: {}, phase: 'result_pending' }));
  let submitted = 0;
  const runner = new StudioTaskRunner({ storage: store, createId: () => 'new', request: async (path, options) => {
    if (options?.method === 'POST') { submitted++; throw { status: 400 }; }
    if (path.endsWith('/result')) { await gate; return { images: [{ image: 'png' }] }; }
    return { status: 'success' };
  } });
  const recovery = runner.resume(undefined, 'old');
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(runner.resume(undefined, 'old'), { code: 'STUDIO_TASK_PENDING' });
  await assert.rejects(runner.start({}), { status: 400 });
  assert.equal(submitted, 1); release(); await recovery;
  assert.ok(runner.pending('old'));
});
