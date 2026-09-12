import test from 'node:test';
import assert from 'node:assert/strict';
import { queryStudioStatus } from './StudioStatusQuery.mjs';
import { StudioTaskRunner, PENDING_TASK_KEY } from './StudioTaskRunner.mjs';

function fixture(request) {
  const data = new Map([[PENDING_TASK_KEY, JSON.stringify({ request_id: 'original', id: 7, parameters: {}, phase: 'waiting' })]]);
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const runner = new StudioTaskRunner({ storage, request, sleep: async () => {} });
  return { runner, storage };
}

test('临时查询错误有限退避，权限错误不重试，等待期间换号停止请求', async () => {
  let calls = 0; const delays = [];
  assert.equal(await queryStudioStatus(async () => {
    if (++calls < 3) throw { status: 503 };
    return 'queued';
  }, () => {}, async ms => delays.push(ms)), 'queued');
  assert.deepEqual(delays, [1000, 2000]);
  calls = 0;
  await assert.rejects(queryStudioStatus(async () => { calls++; throw { status: 401 }; }, () => {}, async () => {}), { status: 401 });
  assert.equal(calls, 1);
  let changed = false; calls = 0;
  await assert.rejects(queryStudioStatus(async () => { calls++; throw { code: 'NETWORK_ERROR' }; },
    () => { if (changed) throw new Error('identity'); }, async () => { changed = true; }), /identity/);
  assert.equal(calls, 1);
});

test('查询重试耗尽后保留原任务，继续恢复不发 POST', async () => {
  let offline = true; let calls = 0;
  const { runner } = fixture(async (path, options) => {
    assert.notEqual(options?.method, 'POST');
    calls++;
    if (offline) throw { code: 'NETWORK_ERROR' };
    return path.endsWith('/result') ? { images: [{ blob: new Blob(['image']) }] } : { status: 'success' };
  });
  await assert.rejects(runner.resume(), { code: 'STUDIO_STATUS_UNAVAILABLE' });
  assert.equal(calls, 4);
  assert.equal(runner.pending().phase, 'waiting_connection');
  offline = false;
  assert.equal((await runner.resume()).studio_request_id, 'original');
  assert.ok(runner.pending());
});

test('等待上限只暂停查询，原任务成功后可继续领取', async () => {
  let complete = false;
  const { runner } = fixture(async path => path.endsWith('/result')
    ? { images: [{ image: 'png' }] } : { status: complete ? 'success' : 'queued' });
  await assert.rejects(runner.resume(), { code: 'STUDIO_WAIT_TIMEOUT' });
  assert.equal(runner.pending().phase, 'waiting_timeout');
  complete = true;
  assert.equal((await runner.resume()).studio_request_id, 'original');
});

test('过期结果显式清理必须再次确认，断网和记录变化不能误删', async () => {
  let mode = 'expired';
  const { runner, storage } = fixture(async (path, options) => {
    assert.notEqual(options?.method, 'POST');
    if (!path.endsWith('/result')) return { status: 'success' };
    if (mode === 'offline') throw { code: 'NETWORK_ERROR' };
    if (mode === 'available') return { images: [] };
    if (mode === 'changed') storage.setItem(PENDING_TASK_KEY, JSON.stringify({ ...runner.pending(), phase: 'ready' }));
    throw { status: 410, code: 'idlecloud_result_expired' };
  });
  await assert.rejects(runner.resume(), { code: 'idlecloud_result_expired' });
  assert.equal(runner.pending().phase, 'result_expired');
  mode = 'offline';
  await assert.rejects(runner.forgetExpired('original'), { code: 'NETWORK_ERROR' });
  assert.ok(runner.pending());
  mode = 'available';
  await assert.rejects(runner.forgetExpired('original'), { code: 'STUDIO_RESULT_AVAILABLE' });
  assert.ok(runner.pending());
  mode = 'changed';
  await assert.rejects(runner.forgetExpired('original'), { code: 'STUDIO_RECORD_CHANGED' });
  assert.equal(runner.pending().phase, 'ready');
  mode = 'expired';
  await assert.rejects(runner.resume(), { code: 'idlecloud_result_expired' });
  await runner.forgetExpired('original');
  assert.equal(runner.pending(), null);
});
