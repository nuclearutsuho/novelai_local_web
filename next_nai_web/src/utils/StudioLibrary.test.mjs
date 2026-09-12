import test from 'node:test';
import assert from 'node:assert/strict';
import { saveStudioImage } from './StudioLibrary.mjs';

const memory = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
};

test('删除后换用确定性后继键，丢失响应后重试不再换键', async () => {
  const storage = memory();
  const keys = [];
  const blob = new Blob(['deleted-image']);
  const request = async (_path, options) => {
    keys.push(options.headers['Idempotency-Key']);
    if (keys.length === 1) throw Object.assign(new Error('gone'), { code: 'idempotent_target_gone', status: 410 });
    if (keys.length === 2) throw new Error('NETWORK_ERROR');
    return { media_id: 18, status: 'ready' };
  };
  await assert.rejects(saveStudioImage({ blob, storage, request, scope: () => 'studio:1:' }), /NETWORK_ERROR/);
  await saveStudioImage({ blob, storage, request, scope: () => 'studio:1:' });
  assert.notEqual(keys[0], keys[1]);
  assert.equal(keys[1], keys[2]);
});

test('两个标签同时恢复删除图片时使用同一个新键', async () => {
  const keys = [];
  const run = async () => {
    let first = true;
    await saveStudioImage({ blob: new Blob(['same-image']), storage: memory(), scope: () => 'studio:1:',
      request: async (_path, options) => {
        if (first) { first = false; throw Object.assign(new Error('gone'), { code: 'idempotent_target_gone', status: 410 }); }
        keys.push(options.headers['Idempotency-Key']);
        return { media_id: 18, status: 'ready' };
      } });
  };
  await Promise.all([run(), run()]);
  assert.equal(keys[0], keys[1]);
});

test('容量失败或未知的 410 不切换保存键', async () => {
  for (const error of [{ code: 'storage_limit_exceeded', status: 403 }, { code: 'other_expired', status: 410 }]) {
    let calls = 0;
    const storage = memory();
    storage.setItem = () => { throw new Error('不得更换保存键'); };
    await assert.rejects(saveStudioImage({ blob: new Blob(['image']), scope: () => 'studio:1:', storage,
      request: async () => { calls++; throw error; } }), (caught) => caught === error);
    assert.equal(calls, 1);
  }
});

test('追溯多次删除记录有上限，下一次点击从已记录的新键继续', async () => {
  const storage = memory();
  let calls = 0;
  const options = { blob: new Blob(['old-image']), storage, scope: () => 'studio:1:',
    request: async () => {
      calls++;
      if (calls <= 4) throw Object.assign(new Error('gone'), { code: 'idempotent_target_gone', status: 410 });
      return { media_id: 21, status: 'ready' };
    } };
  await assert.rejects(saveStudioImage(options), /STUDIO_MEDIA_RETRY/);
  assert.equal(calls, 4);
  assert.equal((await saveStudioImage(options)).media_id, 21);
  assert.equal(calls, 5);
});

test('原始图片不转换，重复保存复用内容键，只有 ready 才成功', async () => {
  const blob = new Blob(['final-pixels'], { type: 'image/png' });
  const keys = [];
  const statuses = [];
  const request = async (path, options) => {
    if (options) {
      assert.equal(options.body, blob);
      keys.push(options.headers['Idempotency-Key']);
      return { media_id: 17, status: 'processing' };
    }
    assert.equal(path, '/studio/media/17');
    return { media_id: 17, status: 'ready' };
  };
  for (let i = 0; i < 2; i++) await saveStudioImage({ blob, request, scope: () => 'studio:1:',
    sleep: async () => {}, onStatus: (state) => statuses.push(state) });
  assert.equal(keys[0], keys[1]);
  assert.deepEqual(statuses, ['uploading', 'processing', 'ready', 'uploading', 'processing', 'ready']);
});

test('保存期间切换用户后不继续查询或报告成功', async () => {
  let owner = 'studio:1:';
  let calls = 0;
  await assert.rejects(saveStudioImage({ blob: new Blob(['image']), scope: () => owner,
    request: async () => { calls++; owner = 'studio:2:'; return { media_id: 17, status: 'ready' }; }
  }), /STUDIO_IDENTITY_CHANGED/);
  assert.equal(calls, 1);
});

test('处理失败和长时间处理中不能误报保存成功', async () => {
  for (const [status, error] of [['failed', 'STUDIO_MEDIA_FAILED'], ['processing', 'STUDIO_MEDIA_PENDING']]) {
    await assert.rejects(saveStudioImage({ blob: new Blob(['image']), scope: () => 'studio:1:',
      request: async () => ({ media_id: 17, status }), sleep: async () => {},
      onStatus: (state) => assert.notEqual(state, 'ready') }), new RegExp(error));
  }
});
