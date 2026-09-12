import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('./vibeDB.js', import.meta.url), 'utf8'))
  .replace("'@/utils/userStorage.mjs'", JSON.stringify(new URL('../../../utils/userStorage.mjs', import.meta.url).href));
const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// 控制 IndexedDB 事件顺序，专门复现 request 成功后 transaction 回滚的窗口。
function databaseBoundary(t) {
  const previous = { window: globalThis.window, indexedDB: globalThis.indexedDB };
  const state = { owner: '1', closed: false, request: { result: undefined }, transaction: null };
  const store = {
    put(value) { state.value = value; return state.request; },
    get() { return state.request; }, getAll() { return state.request; }, delete() { return state.request; }
  };
  const db = { close() { state.closed = true; }, transaction() {
    state.transaction = { objectStore: () => store, abort() { this.onabort?.(); } };
    return state.transaction;
  } };
  globalThis.indexedDB = { open(name) {
    state.name = name;
    const request = {};
    queueMicrotask(() => request.onsuccess({ target: { result: db } }));
    return request;
  } };
  globalThis.window = { indexedDB: globalThis.indexedDB,
    sessionStorage: { getItem: key => key === 'idlecloud.connection' ? 'studio' : state.owner } };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  return state;
}

test('缓存请求成功后仍等待事务提交，提交后才可确认领取', async t => {
  const state = databaseBoundary(t);
  let confirmed = false;
  const saving = module.addVibeToCache({ image: 'raw', encodings: { v4full: 'encoded' } }, 'hash', 'model', 0.7)
    .then(() => { confirmed = true; });
  await new Promise(setImmediate);
  state.request.onsuccess?.();
  await new Promise(setImmediate);
  assert.equal(confirmed, false);
  assert.equal(state.closed, false);
  state.transaction.oncomplete();
  await saving;
  assert.equal(confirmed, true);
  assert.equal(state.closed, true);
  assert.equal(state.name, 'studio:1:AIPaintingVibeDB');
  assert.equal(state.value.cacheKey, 'hash-model-0.7');
});

test('请求成功后事务回滚时拒绝保存并关闭连接', async t => {
  const state = databaseBoundary(t);
  const saving = module.saveVibePanelState([{ hash: 'not-committed' }]);
  const rejected = assert.rejects(saving, /quota/);
  await new Promise(setImmediate);
  state.request.onsuccess?.();
  state.transaction.error = new Error('quota');
  state.transaction.onabort();
  await rejected;
  assert.equal(state.closed, true);
});

test('读取提交时切换身份不返回前一用户的缓存', async t => {
  const state = databaseBoundary(t);
  const reading = module.getAllVibesFromCache();
  const rejected = assert.rejects(reading, /STUDIO_IDENTITY_CHANGED/);
  await new Promise(setImmediate);
  state.request.result = [{ image: 'private' }];
  state.owner = '2';
  state.transaction.oncomplete();
  await rejected;
  assert.equal(state.closed, true);
});
