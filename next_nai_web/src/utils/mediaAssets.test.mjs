import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadUrlToFile } from './mediaAssets.js';

test('自动下载开始前或读取图片期间失效，均不触发浏览器下载', async t => {
  let current = false, requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    return { ok: true, blob: async () => { current = false; return new Blob(['private']); } };
  });
  assert.equal(await downloadUrlToFile('https://fixture.invalid/image', 'image.png', { isCurrent: () => current }), false);
  assert.equal(requests, 0);
  current = true;
  assert.equal(await downloadUrlToFile('https://fixture.invalid/image', 'image.png', { isCurrent: () => current }), false);
  assert.equal(requests, 1);
});

test('未指定自动保存守卫时保留原手动下载行为', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const downloads = [];
  globalThis.document = {
    createElement: () => ({ click() { downloads.push([this.href, this.download]); } }),
    body: { appendChild() {}, removeChild() {} },
  };
  try {
    await downloadUrlToFile('data:image/png;base64,dGVzdA==', 'manual.png');
    assert.deepEqual(downloads, [['data:image/png;base64,dGVzdA==', 'manual.png']]);
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else delete globalThis.document;
  }
});
