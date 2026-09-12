import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { cacheImportedVibe, downloadVibeZip, selectVibeEncoding } from './vibeTransferOperations.mjs';

const data = {
  id: 'synthetic-vibe', name: '同名文件', image: null, importInfo: { strength: 0 },
  encodings: {
    v4: { original: { encoding: 'first-encoding', params: { information_extracted: 0.7 } } },
    v45: { original: { encoding: 'second-encoding', params: { information_extracted: 0.5 } } },
  },
};
const guardFixture = () => {
  let active = true;
  return {
    invalidate: () => { active = false; },
    checkOwner: () => { if (!active) throw Object.assign(new Error('用户切换或页面卸载'), { code: 'STUDIO_IDENTITY_CHANGED' }); },
  };
};
const cacheOptions = {
  data, hash: data.id, models: [{ value: 'v4' }, { value: 'v45' }], modelType: model => model,
};

test('同模型多个信息提取值都建立缓存索引，不能只保存第一份编码', async () => {
  const multi = { ...data, encodings: { v4: {
    lower: { encoding: 'encoding-03', params: { information_extracted: 0.3 } },
    higher: { encoding: 'encoding-07', params: { information_extracted: 0.7 } },
  } } };
  const writes = [];
  await cacheImportedVibe({ ...cacheOptions, data: multi, checkOwner: guardFixture().checkOwner,
    write: async (...args) => { writes.push(args); },
  });
  assert.deepEqual(writes.map(args => args[3]), [0.3, 0.7]);
  assert.ok(writes.every(args => args[0] === multi));
});

test('按提取值和模型选择编码，缺失值不冒充已转换；初次导入优先文件选择值', () => {
  const multi = { importInfo: { information_extracted: 0.7 }, encodings: {
    v4: { lower: { encoding: '03', params: { information_extracted: 0.3 } },
      higher: { encoding: '07', params: { information_extracted: 0.7 } } },
    v45: { higher: { encoding: 'v45-07', params: { information_extracted: 0.7 } } },
  } };
  assert.equal(selectVibeEncoding(multi, 'v4').encoding, '07');
  assert.equal(selectVibeEncoding(multi, 'v4', 0.3).encoding, '03');
  assert.equal(selectVibeEncoding(multi, 'v4', 0.7).encoding, '07');
  assert.equal(selectVibeEncoding(multi, 'v45', 0.7).encoding, 'v45-07');
  assert.equal(selectVibeEncoding(multi, 'v4', 0.5), null);
  assert.equal(selectVibeEncoding(undefined, 'v4', 0.7), null);
  assert.equal(selectVibeEncoding({ encodings: { v4: { old: { encoding: 'legacy' } } } }, 'v4', 0.7).encoding, 'legacy');
});

test('多模型导入在换号后停止余下写入，开始前失效则零写入', async () => {
  for (const beforeStart of [true, false]) {
    const guard = guardFixture();
    const writes = [];
    if (beforeStart) guard.invalidate();
    await assert.rejects(cacheImportedVibe({ ...cacheOptions, checkOwner: guard.checkOwner,
      write: async (...args) => { writes.push(args); guard.invalidate(); },
    }), { code: 'STUDIO_IDENTITY_CHANGED' });
    assert.equal(writes.length, beforeStart ? 0 : 1);
  }
});

test('有效账号导入保留完整模型编码、零强度和各模型信息提取值', async () => {
  const writes = [];
  await cacheImportedVibe({ ...cacheOptions, checkOwner: guardFixture().checkOwner,
    write: async (...args) => { writes.push(args); },
  });
  assert.deepEqual(writes, [[data, data.id, 'v4', 0.7], [data, data.id, 'v45', 0.5]]);
});

test('ZIP 在读取或压缩期间失效均不触发下载', async () => {
  for (const stage of ['read', 'compress']) {
    const guard = guardFixture();
    let saved = 0;
    await assert.rejects(downloadVibeZip({ checkOwner: guard.checkOwner,
      readAll: async () => { if (stage === 'read') guard.invalidate(); return [data]; },
      createZip: () => ({ file() {}, async generateAsync() { guard.invalidate(); return new Blob(['private']); } }),
      save: () => { saved += 1; },
    }), { code: 'STUDIO_IDENTITY_CHANGED' });
    assert.equal(saved, 0);
  }
});

test('真实 ZIP 压缩的多文件导出完整，空缓存不下载', async () => {
  const vibes = [data, { ...data, id: 'second-id' }];
  let saved;
  assert.equal(await downloadVibeZip({ checkOwner: guardFixture().checkOwner,
    readAll: async () => vibes, createZip: () => new JSZip(), save: (blob, name) => { saved = { blob, name }; },
  }), true);
  assert.equal(saved.name, 'vibes_database.zip');
  const zip = await JSZip.loadAsync(await saved.blob.arrayBuffer());
  const files = Object.values(zip.files);
  assert.equal(files.length, 2);
  for (const [index, file] of files.entries()) assert.deepEqual(JSON.parse(await file.async('string')), vibes[index]);
  assert.equal(await downloadVibeZip({ checkOwner: guardFixture().checkOwner, readAll: async () => [],
    createZip: () => { throw new Error('空数据不能启动压缩'); }, save: () => assert.fail('空数据不能下载'),
  }), false);
});
