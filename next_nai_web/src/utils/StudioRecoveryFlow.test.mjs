import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverStudioResult } from './StudioRecoveryFlow.mjs';

function fixture() {
  let owner = 'studio:1:';
  const calls = [];
  const result = { studio_workspace: true, studio_request_id: 'original' };
  const checkOwner = () => {
    if (owner !== 'studio:1:') throw Object.assign(new Error('用户已切换'), { code: 'STUDIO_IDENTITY_CHANGED' });
  };
  const options = {
    checkOwner,
    runner: {
      resume: async (_progress, _id, receive) => receive(result),
      workspaceStore: { load: async () => ({ mask: '原蒙版' }) },
      acknowledge: id => calls.push(['ack', id]),
    },
    createItem: () => { calls.push(['create']); return { src: 'blob:old-user' }; },
    applyItem: async (item, workspace, guard) => { guard(); calls.push(['apply', workspace.mask]); },
    releaseItem: item => calls.push(['release', item.src]),
  };
  return { options, calls, switchUser: () => { owner = 'studio:2:'; } };
}

test('恢复结果和工作区读取完成前换号，不创建图片或确认任务', async () => {
  for (const phase of ['result', 'workspace']) {
    const f = fixture();
    if (phase === 'result') f.options.runner.resume = async (_progress, _id, receive) => {
      f.switchUser(); return receive({ studio_workspace: true, studio_request_id: 'original' });
    };
    else f.options.runner.workspaceStore.load = async () => { f.switchUser(); return { mask: '旧用户' }; };
    await assert.rejects(recoverStudioResult(f.options), { code: 'STUDIO_IDENTITY_CHANGED' });
    assert.deepEqual(f.calls, []);
  }
});

test('图片处理期间换号，写入前守卫中止恢复并释放临时 URL', async () => {
  const f = fixture();
  f.options.applyItem = async (item, workspace, guard) => {
    await Promise.resolve();
    f.switchUser();
    guard();
    f.calls.push(['private-write']);
  };
  await assert.rejects(recoverStudioResult(f.options), { code: 'STUDIO_IDENTITY_CHANGED' });
  assert.deepEqual(f.calls, [['create'], ['release', 'blob:old-user']]);
});

test('恢复回调结束时换号也不确认新账号命名空间中的同名任务', async () => {
  const f = fixture();
  f.options.applyItem = async () => { f.switchUser(); };
  await assert.rejects(recoverStudioResult(f.options), { code: 'STUDIO_IDENTITY_CHANGED' });
  assert.deepEqual(f.calls, [['create'], ['release', 'blob:old-user']]);
});

test('恢复成功后才确认；工作区缺失或应用失败均保留恢复记录', async () => {
  const good = fixture();
  await recoverStudioResult(good.options);
  assert.deepEqual(good.calls, [['create'], ['apply', '原蒙版'], ['ack', 'original']]);
  const missing = fixture();
  missing.options.runner.workspaceStore.load = async () => null;
  await assert.rejects(recoverStudioResult(missing.options), { code: 'STUDIO_WORKSPACE_MISSING' });
  assert.deepEqual(missing.calls, []);
  const failed = fixture();
  failed.options.applyItem = async () => { throw new Error('图片损坏'); };
  await assert.rejects(recoverStudioResult(failed.options), /图片损坏/);
  assert.deepEqual(failed.calls, [['create'], ['release', 'blob:old-user']]);
});


test('画布恢复在快照加载和补丁安装结束前阻止新生成，成功/失败都释放互斥', async () => {
  const { StudioTaskRunner, PENDING_TASK_KEY } = await import('./StudioTaskRunner.mjs');
  for (const fail of [false, true]) {
    let releaseLoad, releaseApply, loading, applying;
    const loadStarted = new Promise(resolve => { loading = resolve; });
    const applyStarted = new Promise(resolve => { applying = resolve; });
    const loadGate = new Promise(resolve => { releaseLoad = resolve; });
    const applyGate = new Promise(resolve => { releaseApply = resolve; });
    const data = new Map([[PENDING_TASK_KEY, JSON.stringify({ request_id: 'canvas', workspace: true, id: 7, parameters: {} })]]);
    const runner = new StudioTaskRunner({ storage: { getItem: key => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), keys: () => [...data.keys()] },
      workspaceStore: { load: async () => { loading(); await loadGate; return {}; }, remove: async () => {} },
      request: async path => path.endsWith('/result') ? { images: [] } : { status: 'success' } });
    const recovery = recoverStudioResult({ runner, requestId: 'canvas', checkOwner: () => {},
      createItem: () => ({}), releaseItem: () => {}, applyItem: async () => {
        applying(); await applyGate; if (fail) throw new Error('安装失败');
      } });
    const outcome = recovery.then(() => null, error => error);
    await loadStarted;
    await assert.rejects(runner.start({}), { code: 'STUDIO_TASK_PENDING' });
    assert.throws(() => runner.beginBatch('new', 2), { code: 'STUDIO_TASK_PENDING' });
    releaseLoad(); await applyStarted;
    await assert.rejects(runner.start({}), { code: 'STUDIO_TASK_PENDING' });
    releaseApply();
    assert.equal(Boolean(await outcome), fail);
    assert.equal(runner.busy, false);
    assert.equal(Boolean(runner.pending()), fail);
  }
});
