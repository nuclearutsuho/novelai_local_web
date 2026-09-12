import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOwnedPreview, loadOwnedImageSource, publishGeneratedItem } from './imageOperationLifecycle.mjs';

test('原图下载、Blob 读取或编码期间换号，不能返回可提交的新请求内容', async () => {
  for (const phase of ['download', 'blob', 'encode']) {
    let current = true;
    let encodes = 0;
    await assert.rejects(loadOwnedImageSource({ source: 'blob:old-user',
      checkOwner: () => { if (!current) throw new Error('identity changed'); },
      fetchSource: async () => {
        if (phase === 'download') current = false;
        return { ok: true, blob: async () => { if (phase === 'blob') current = false; return new Blob(['old-image']); } };
      },
      encodeBlob: async () => { encodes += 1; if (phase === 'encode') current = false; return 'old-image'; },
    }), /identity changed/);
    assert.equal(encodes, phase === 'encode' ? 1 : 0);
  }
});

test('正常读取返回图像；下载失败不能继续处理', async () => {
  const options = { source: 'blob:image', checkOwner() {}, fetchSource: async () => ({ ok: true, blob: async () => 'bytes' }), encodeBlob: async value => 'encoded-' + value };
  assert.equal(await loadOwnedImageSource(options), 'encoded-bytes');
  await assert.rejects(loadOwnedImageSource({ ...options, fetchSource: async () => ({ ok: false, status: 404 }) }), { code: 'MEDIA_ASSET_DOWNLOAD_FAILED', statusCode: 404 });
});

test('画廊接收后才确认，失效或写入失败保留恢复摘要并释放 URL', () => {
  for (const state of ['active', 'changed', 'failed']) {
    const calls = [], item = { studioRequestId: 'original', src: 'blob:image' };
    const publish = () => publishGeneratedItem({ item, isCurrent: () => state !== 'changed',
      release: () => calls.push('release'),
      append: () => { calls.push('append'); if (state === 'failed') throw new Error('gallery failed'); },
      acknowledge: () => calls.push('ack'),
    });
    if (state === 'failed') assert.throws(publish, /gallery failed/);
    else assert.equal(publish(), state === 'active' ? item : null);
    assert.deepEqual(calls, state === 'active' ? ['append', 'ack'] : state === 'changed' ? ['release'] : ['append', 'release']);
  }
});

test('预览加载期间失效、拒收或异常都不确认；所有路径释放图片 URL', async () => {
  for (const mode of ['success', 'changed', 'rejected', 'error']) {
    let current = true;
    const calls = [];
    const promise = applyOwnedPreview({ item: { src: 'blob:preview' },
      checkOwner: () => { if (!current) throw new Error('changed'); },
      apply: async (item, checkOwner) => {
        assert.equal(item.src, 'blob:preview');
        await Promise.resolve();
        if (mode === 'changed') current = false;
        checkOwner();
        if (mode === 'error') throw new Error('decode failed');
        return mode !== 'rejected';
      },
      acknowledge: () => calls.push('ack'), release: () => calls.push('release'),
    });
    if (mode === 'success') await promise;
    else await assert.rejects(promise);
    assert.deepEqual(calls, mode === 'success' ? ['ack', 'release'] : ['release']);
  }
});
