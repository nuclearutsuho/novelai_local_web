import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioVibeRunner } from './StudioVibeRunner.mjs';
import { createScopedStorage } from './userStorage.mjs';

const payload = { image: 'large-original-image', information_extracted: 0.5, model: 'nai-diffusion-4-5-full' };
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k), setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k), keys: () => [...data.keys()], data }; };
const setup = (store, request, scope = () => 'studio:1:') => new StudioVibeRunner({ storage: store, request, scope,
  createId: () => 'encoding-request-001', digest: async () => 'hash', sleep: async () => {} });

test('工具查询断线后继续已有操作，重试不会再次提交编码', async () => {
  let posts = 0, reads = 0;
  const runner = setup(storage(), async (path, options) => {
    if (options?.method === 'POST') { posts++; return { id: 7 }; }
    if (path.endsWith('/result')) return { encoding: 'original' };
    if (++reads === 1) throw { status: 502 };
    return { status: 'succeeded' };
  });
  assert.equal((await runner.encode(payload)).encoding, 'original');
  assert.equal(posts, 1);
  assert.equal(reads, 2);
});

test('显式恢复缺失摘要不发请求；已有摘要只查询原任务和结果', async () => {
  const store = storage(), calls = [];
  const runner = setup(store, async (path, options) => {
    calls.push([path, options?.method || 'GET']);
    return path.endsWith('/result') ? { encoding: 'original-result' } : { id: 7, status: 'succeeded' };
  });
  await assert.rejects(runner.encode(payload, { resumeOnly: true }), { code: 'STUDIO_TOOL_RECORD_MISSING' });
  assert.deepEqual(calls, []);
  store.setItem('idlecloud.vibe.hash', JSON.stringify({ request_id: 'original' }));
  assert.equal((await runner.encode(payload, { resumeOnly: true })).encoding, 'original-result');
  assert.deepEqual(calls, [['/studio/tools/by-request/original', 'GET'], ['/studio/tools/7', 'GET'], ['/studio/tools/7/result', 'GET']]);
  assert.equal(JSON.parse(store.getItem('idlecloud.vibe.hash')).request_id, 'original');
});

test('跨页面发现只查询所属工具，坏记录不挡住后面的终态', async () => {
  const store = storage(); const receipts = [], calls = [];
  store.setItem('idlecloud.vibe.bad', '{');
  store.setItem('idlecloud.vibe.lost', JSON.stringify({ request_id: 'old-request' }));
  store.setItem('idlecloud.upscale.other', JSON.stringify({ request_id: 'other', id: 8 }));
  const runner = setup(store, async (path, options) => {
    assert.notEqual(options?.method, 'POST'); calls.push(path);
    return { id: 7, status: 'failed_unknown' };
  });
  runner.onTerminal = receipt => receipts.push(receipt);
  await assert.rejects(runner.refreshTerminals());
  assert.deepEqual(calls, ['/studio/tools/by-request/old-request']);
  assert.equal(receipts[0].id, 7);
  assert.equal(JSON.parse(store.getItem('idlecloud.vibe.lost')).id, 7);
  assert.equal(store.getItem('idlecloud.vibe.bad'), '{');
});

test('跨页面查询不能复活已删除记录或返回旧账号结果', async () => {
  for (const change of ['delete', 'identity']) {
    const store = storage(); let owner = 'studio:1:';
    store.setItem('idlecloud.vibe.hash', JSON.stringify({ request_id: 'old', id: 7 }));
    const runner = setup(store, async () => {
      if (change === 'delete') store.removeItem('idlecloud.vibe.hash'); else owner = 'studio:2:';
      return { id: 7, status: 'failed' };
    }, () => owner);
    runner.onTerminal = () => assert.fail('不得显示迟到结果');
    if (change === 'delete') {
      await runner.refreshTerminals();
      assert.equal(store.data.size, 0);
    } else await assert.rejects(runner.refreshTerminals(), /STUDIO_IDENTITY_CHANGED/);
  }
});

test('枚举存储键保持 Studio 用户和独立模式隔离', () => {
  const values = ['studio:1:idlecloud.vibe.a', 'studio:2:idlecloud.vibe.b', 'idlecloud.vibe.direct'];
  const native = { length: values.length, key: index => values[index] };
  assert.deepEqual(createScopedStorage(native, 'studio:1:').keys(), ['idlecloud.vibe.a']);
  assert.deepEqual(createScopedStorage(native, '').keys(), ['idlecloud.vibe.direct']);
});

test('成功结果过期必须再次确认才清除，清除不重新编码', async () => {
  for (const code of ['idlecloud_tool_result_expired', 'idlecloud_tool_result_corrupt']) {
    const store = storage(); let receipt, posts = 0, reads = 0;
    const runner = setup(store, async (path, options) => {
      if (options?.method === 'POST') { posts++; return { id: 7 }; }
      if (path.endsWith('/result')) { reads++; throw { status: 410, code }; }
      return { status: 'succeeded' };
    });
    runner.onTerminal = value => { receipt = value; };
    await assert.rejects(runner.encode(payload), error => error.code === code);
    assert.equal(receipt.status, 'result_unavailable');
    assert.equal(store.data.size, 1);
    await runner.forgetTerminal(receipt);
    assert.equal(reads, 2);
    assert.equal(posts, 1);
    assert.equal(store.data.size, 0);
  }
});

test('过期清除复核时网络中断或结果恢复都保留本地记录', async () => {
  for (const response of ['network', 'available']) {
    const store = storage(); let receipt, checking = false;
    const runner = setup(store, async (path, options) => {
      if (options?.method === 'POST') return { id: 7 };
      if (!path.endsWith('/result')) return { status: 'succeeded' };
      if (!checking) throw { status: 410, code: 'idlecloud_tool_result_expired' };
      if (response === 'network') throw new Error('network');
      return { encoding: 'available' };
    });
    runner.onTerminal = value => { receipt = value; };
    await assert.rejects(runner.encode(payload));
    checking = true;
    await assert.rejects(runner.forgetTerminal(receipt));
    assert.equal(store.data.size, 1);
  }
});

test('三种工具的未知终态只能显式清除，清除不产生新的上游任务', async () => {
  for (const tool of ['vibe-encode', 'upscale', 'director']) {
    const store = storage(); let receipt, posts = 0;
    const runner = new StudioVibeRunner({ storage: store, scope: () => 'studio:1:', tool,
      digest: async () => 'hash', createId: () => `request-${posts}`, sleep: async () => {},
      onTerminal: value => { receipt = value; },
      request: async (_path, options) => {
        if (options?.method === 'POST') return { id: ++posts };
        return { status: 'failed_unknown' };
      } });
    await assert.rejects(runner.encode(payload));
    assert.equal(receipt.status, 'failed_unknown');
    assert.equal(receipt.tool, tool);
    await runner.forgetTerminal(receipt);
    assert.equal(posts, 1);
    assert.equal(store.data.size, 0);
    await assert.rejects(runner.encode(payload));
    assert.equal(posts, 2);
  }
});

test('运行中、成功和无法确认的任务不能被当作失败记录清除', async () => {
  for (const state of ['running', 'succeeded', 'network']) {
    const store = storage(); let receipt, checking = false;
    const runner = setup(store, async (_path, options) => {
      if (options?.method === 'POST') return { id: 7 };
      if (checking && state === 'network') throw new Error('network');
      return { status: checking ? state : 'canceled' };
    });
    runner.onTerminal = value => { receipt = value; };
    await assert.rejects(runner.encode(payload));
    checking = true;
    await assert.rejects(runner.forgetTerminal(receipt));
    assert.equal(store.data.size, 1);
  }
});

test('清除终态查询期间切换用户不能删除记录', async () => {
  const store = storage(); let owner = 'studio:1:', receipt, checking = false;
  const runner = setup(store, async (_path, options) => {
    if (options?.method === 'POST') return { id: 7 };
    if (checking) owner = 'studio:2:';
    return { status: 'failed' };
  }, () => owner);
  runner.onTerminal = value => { receipt = value; };
  await assert.rejects(runner.encode(payload));
  checking = true;
  await assert.rejects(runner.forgetTerminal(receipt), /STUDIO_IDENTITY_CHANGED/);
  assert.equal(store.data.size, 1);
});

test('编码 POST 响应丢失后只查询原操作，缓存确认前保留记录', async () => {
  const store = storage();
  await assert.rejects(setup(store, async () => { throw new Error('network'); }).encode(payload));
  assert.ok(![...store.data.values()][0].includes(payload.image));
  const paths = [];
  const runner = setup(store, async (path, options) => {
    assert.notEqual(options?.method, 'POST'); paths.push(path);
    return path.includes('by-request') ? { id: 7 } : path.endsWith('/result') ? { encoding: 'encoded' } : { status: 'succeeded' };
  });
  const result = await runner.encode(payload);
  assert.equal(result.encoding, 'encoded');
  assert.ok(paths[0].includes('by-request'));
  assert.equal(store.data.size, 1);
  runner.acknowledge(result.studio_vibe_receipt);
  assert.equal(store.data.size, 0);
});

test('重复点击合并同一次编码，结果未知不会重发 POST', async () => {
  const store = storage(); let posts = 0;
  const runner = setup(store, async (path, options) => {
    if (options?.method === 'POST') { posts++; return { id: 7 }; }
    return { status: 'failed_unknown', error_code: 'idlecloud_execution_unknown' };
  });
  const results = await Promise.allSettled([runner.encode(payload), runner.encode(payload)]);
  assert.ok(results.every((result) => result.status === 'rejected'));
  await assert.rejects(runner.encode(payload), /idlecloud_execution_unknown/);
  assert.equal(posts, 1);
});

test('切换身份后拒绝返回旧用户编码或改写新用户记录', async () => {
  const store = storage(); let owner = 'studio:1:';
  const runner = setup(store, async () => { owner = 'studio:2:'; return { id: 7 }; }, () => owner);
  await assert.rejects(runner.encode(payload), /STUDIO_IDENTITY_CHANGED/);
  assert.ok(![...store.data.values()][0].includes('"id":7'));
});

test('放大请求与 Vibe 分区，模糊参数不混用，领取后才确认', async () => {
  const store = storage(); let posts = 0;
  const runner = new StudioVibeRunner({ storage: store, scope: () => 'studio:1:', tool: 'upscale',
    digest: async (value) => value, createId: () => `upscale-request-${posts}`, sleep: async () => {},
    request: async (path, options) => {
      if (options?.method === 'POST') { assert.equal(path, '/studio/tools/upscale'); posts++; return { id: posts }; }
      return path.endsWith('/result') ? { images: [{ data: 'result', width: 1024, height: 1024 }] } : { status: 'succeeded' };
    } });
  const body = { model: payload.model, image: payload.image };
  const first = await runner.encode(body);
  assert.equal(first.images[0].width, 1024);
  assert.ok(first.studio_upscale_receipt.key.startsWith('idlecloud.upscale.'));
  await runner.encode(body);
  assert.equal(posts, 1);
  await runner.encode({ ...body, declared_blur_sigma: 0 });
  assert.equal(posts, 2);
  runner.acknowledge(first.studio_upscale_receipt);
  assert.equal(store.data.size, 1);
});

test('Director 断线后只恢复原请求，提示词和强度变化不会复用旧操作', async () => {
  const store = storage(); let posts = 0, loseResponse = true;
  const options = { storage: store, scope: () => 'studio:1:', tool: 'director',
    digest: async (value) => value, createId: () => `director-request-${posts}`, sleep: async () => {},
    request: async (path, request) => {
      if (request?.method === 'POST') { posts++; assert.equal(path, '/studio/tools/director');
        if (loseResponse) throw new Error('network'); return { id: posts }; }
      return path.includes('by-request') ? { id: 1 } : path.endsWith('/result') ? { images: [{ data: 'result' }] } : { status: 'succeeded' };
    } };
  const body = { req_type: 'emotion', width: 512, height: 512, image: 'source', prompt: 'happy;; blue hair', defry: 0 };
  await assert.rejects(new StudioVibeRunner(options).encode(body));
  loseResponse = false;
  const runner = new StudioVibeRunner(options);
  const result = await runner.encode(body);
  assert.equal(posts, 1);
  assert.ok(result.studio_director_receipt);
  await runner.encode({ ...body, defry: 5 });
  await runner.encode({ ...body, prompt: 'sad' });
  assert.equal(posts, 3);
});
