import test from 'node:test';
import assert from 'node:assert/strict';
import { applyVibeEncodingResult, createVibeInformationUpdater } from './vibeInformationUpdater.mjs';

function fixture() {
  let items = [{ id: 'a', hash: 'a', isV4Vibe: true, informationExtracted: 0.7, encoding: 'old', status: 'converted' }];
  let model = 'v4', owner = true;
  const pending = [];
  const updater = createVibeInformationUpdater({
    readCache: (hash, requestedModel, value) => new Promise((resolve, reject) => pending.push({ resolve, reject, value })),
    modelType: value => value, getModel: () => model, isOwner: () => owner,
    updateItems: change => { items = change(items); },
  });
  const respond = index => pending[index].resolve({ name: 'synthetic', encodings: { v4: {
    selected: { encoding: `encoding-${pending[index].value}`, params: { information_extracted: pending[index].value } },
  } } });
  return { updater, pending, respond, items: () => items, replace: value => { items = value; },
    switchModel: () => { model = 'v45'; }, switchOwner: () => { owner = false; } };
}

test('快速连续调整以最后一次为准，等待期间不能使用旧编码', async () => {
  const f = fixture();
  const first = f.updater.change(f.items()[0], 'v4', 0.3);
  assert.equal(f.items()[0].encoding, null);
  assert.equal(f.items()[0].informationExtracted, 0.3);
  const second = f.updater.change(f.items()[0], 'v4', 0.5);
  f.respond(1); await second;
  f.respond(0); await first;
  assert.equal(f.items()[0].informationExtracted, 0.5);
  assert.equal(f.items()[0].encoding, 'encoding-0.5');
});

test('查询期间删除、添加或修改其他条目，不复活旧数组也不覆盖其他修改', async () => {
  const f = fixture();
  const lookup = f.updater.change(f.items()[0], 'v4', 0.3);
  f.updater.forget('a');
  f.replace([{ id: 'b', informationExtracted: 0.9, referenceStrength: 0 }]);
  f.respond(0); await lookup;
  assert.deepEqual(f.items(), [{ id: 'b', informationExtracted: 0.9, referenceStrength: 0 }]);
});

test('模型或身份切换使迟到的成功和失败均失效', async () => {
  for (const change of ['switchModel', 'switchOwner']) {
    for (const failure of [false, true]) {
      const f = fixture();
      const lookup = f.updater.change(f.items()[0], 'v4', 0.3);
      f[change]();
      f.replace([{ id: 'a', encoding: 'new-context' }]);
      if (failure) f.pending[0].reject(new Error('旧查询失败'));
      else f.respond(0);
      await lookup;
      assert.deepEqual(f.items(), [{ id: 'a', encoding: 'new-context' }]);
    }
  }
});

test('当前查询失败可报告，但保留新提取值且禁用不匹配旧编码', async () => {
  const f = fixture();
  const lookup = f.updater.change(f.items()[0], 'v4', 0.3);
  f.pending[0].reject(new Error('数据库不可用'));
  await assert.rejects(lookup, /数据库不可用/);
  assert.equal(f.items()[0].encoding, null);
  assert.equal(f.items()[0].status, 'unconverted');
  assert.equal(f.items()[0].informationExtracted, 0.3);
});

test('编码结果按条目及提取值回填，删除或修改后不污染其他条目', () => {
  const request = { id: 'a', informationExtracted: 0.7 };
  const b = { id: 'b', informationExtracted: 0.7, encoding: 'b-encoding' };
  const changed = { id: 'a', informationExtracted: 0.3, encoding: 'new-choice' };
  const result = { status: 'converted', encoding: 'a-07' };
  assert.deepEqual(applyVibeEncodingResult([b, changed], request, result), [b, changed]);
  assert.deepEqual(applyVibeEncodingResult([b], request, result), [b]);
  assert.deepEqual(applyVibeEncodingResult([b, request], request, result), [b, { ...request, ...result }]);
});
