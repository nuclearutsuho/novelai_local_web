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
      resume: async () => result,
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
    if (phase === 'result') f.options.runner.resume = async () => {
      f.switchUser(); return { studio_workspace: true, studio_request_id: 'original' };
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
