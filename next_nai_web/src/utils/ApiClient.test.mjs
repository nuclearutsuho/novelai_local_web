import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./ApiClient.js', import.meta.url), 'utf8');
const testableSource = source.replace(
  /^import .*modelUtils';\r?\n/,
  "const isPaintingModelAllowed = (model) => model === 'nai-diffusion-4-5-full';\n",
).replace("'./userStorage.mjs'", JSON.stringify(new URL('./userStorage.mjs', import.meta.url).href))
  .replace("'./StudioTaskRunner.mjs'", JSON.stringify(new URL('./StudioTaskRunner.mjs', import.meta.url).href))
  .replace("'./StudioVibeRunner.mjs'", JSON.stringify(new URL('./StudioVibeRunner.mjs', import.meta.url).href));
const apiModule = await import(`data:text/javascript;base64,${Buffer.from(testableSource).toString('base64')}`);
const { ApiClient } = apiModule;

test('二进制图片保留原始字节与零种子，过期结果仍抛出结构化错误', async (t) => {
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
  let expired = false;
  t.mock.method(globalThis, 'fetch', async () => expired
    ? new Response(JSON.stringify({ code: 'idlecloud_result_expired' }), {
      status: 410, headers: { 'Content-Type': 'application/json' },
    })
    : new Response(bytes, { headers: { 'Content-Type': 'image/png', 'X-Image-Seed': '0' } }));
  const client = new ApiClient();
  const options = { responseType: 'image', headers: { Accept: 'image/*' } };
  const { images: [image] } = await client.request('/studio/tasks/1/result', options);
  assert.deepEqual(new Uint8Array(await image.blob.arrayBuffer()), bytes);
  assert.equal(image.seed, 0);
  assert.equal(image.width, undefined);
  assert.equal(image.image, undefined);
  expired = true;
  await assert.rejects(client.request('/studio/tasks/1/result', options), {
    code: 'idlecloud_result_expired', status: 410,
  });
});

test('笔记批量导入在页面失效后停止后续写入，导出拒绝过期结果', async (t) => {
  const client = new ApiClient();
  let active = true;
  const written = [];
  t.mock.method(client, 'request', async (_path, options) => {
    if (options) written.push(options.body.note);
    active = false;
    return { notes: [{ title: '旧用户笔记' }] };
  });
  await assert.rejects(client.importTexts([{ title: '第一条' }, { title: '第二条' }],
    { isCurrent: () => active }), { code: 'LOCAL_OPERATION_INTERRUPTED' });
  assert.deepEqual(written, [{ title: '第一条' }]);
  active = true;
  await assert.rejects(client.exportTexts({ isCurrent: () => active }),
    { code: 'LOCAL_OPERATION_INTERRUPTED' });
});

test('笔记正常导入导出保留完整字段与原接口', async (t) => {
  const client = new ApiClient();
  const notes = [{ title: '角色', text_content1: '1girl', character_tabs: [{ prompt: 'blue hair' }] }];
  const stored = [];
  t.mock.method(client, 'request', async (path, options) => {
    assert.equal(path, '/local/notes');
    if (options) stored.push(options.body.note);
    return { notes: stored };
  });
  assert.deepEqual(await client.importTexts(notes), { imported: true });
  assert.deepEqual((await client.exportTexts()).texts, notes);
});

test('Studio Director 从原版生成参数分流，保留强度零与表情提示词', async (t) => {
  const client = new ApiClient();
  t.mock.method(client, 'isStudio', () => true);
  const received = [];
  t.mock.method(client.studioDirectors, 'encode', async (body) => { received.push(body); return { images: [] }; });
  t.mock.method(client.studioTasks, 'start', () => { throw new Error('不得发送普通生成'); });
  for (const tool of ['lineart', 'sketch', 'declutter', 'emotion', 'colorize']) {
    await client.generateImage({ req_type: tool, image: 'source', width: 768, height: 512,
      defry: 0, prompt: 'happy;; red hair', model: 'nai-diffusion-4-5-full', steps: 28, scale: 5 });
    const expected = { req_type: tool, image: 'source', width: 768, height: 512 };
    if (['emotion', 'colorize'].includes(tool)) Object.assign(expected, { defry: 0, prompt: 'happy;; red hair' });
    assert.deepEqual(received.at(-1), expected);
  }
  assert.deepEqual(apiModule.buildStudioDirectorRequest({ req_type: 'emotion', image: 'source' }),
    { req_type: 'emotion', image: 'source', width: 512, height: 512, defry: 1, prompt: '' });
});

test('官方直连的 Director 生成路径保持原样', async (t) => {
  const client = new ApiClient();
  t.mock.method(client, 'isStudio', () => false);
  const body = { req_type: 'lineart', model: 'nai-diffusion-3', image: 'source', width: 512, height: 512 };
  t.mock.method(client, 'request', async (path, options) => {
    assert.equal(path, '/images/generate'); assert.deepEqual(options.body, body); return { images: [] };
  });
  await client.generateImage(body);
});

test('标签请求使用 prompt 并只附加白名单模型', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ tags: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const client = new ApiClient();

  await client.getPrompt('1 girl', 'nai-diffusion-4-5-full');
  await client.getPrompt('landscape', 'unsupported-model');

  assert.equal(
    requests[0].url,
    '/api/images/tags?prompt=1+girl&model=nai-diffusion-4-5-full',
  );
  assert.equal(requests[1].url, '/api/images/tags?prompt=landscape');
});

test('Studio 标签补全使用联动接口并返回实际建议', async (t) => {
  const client = new ApiClient();
  t.mock.method(client, 'isStudio', () => true);
  t.mock.method(client, 'request', async (path) => {
    assert.equal(path, '/studio/tags?prompt=blue+hair&model=nai-diffusion-4-5-full');
    return { tags: [{ tag: 'blue hair' }] };
  });
  assert.deepEqual(await client.getPrompt(' blue hair ', 'nai-diffusion-4-5-full'),
    { tags: [{ tag: 'blue hair' }] });
});

test('图库 Blob 上传保留原始字节和请求内容类型', async (t) => {
  const blob = new Blob(['final-image'], { type: 'image/png' });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.body, blob);
    assert.equal(options.headers.get('Content-Type'), 'image/png');
    assert.equal(options.headers.get('Idempotency-Key'), 'save-image-001');
    return new Response(JSON.stringify({ media_id: 7, status: 'processing' }),
      { status: 202, headers: { 'Content-Type': 'application/json' } });
  });
  await new ApiClient().request('/studio/media', { method: 'POST', body: blob,
    headers: { 'Idempotency-Key': 'save-image-001' } });
});

test('卸载批次删除请求可启用 keepalive', async (t) => {
  let requestOptions = null;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requestOptions = options;
    return new Response(JSON.stringify({ cancelled: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const client = new ApiClient();

  await client.cancelImageBatch('batch-on-unmount', true);

  assert.equal(requestOptions.method, 'DELETE');
  assert.equal(requestOptions.keepalive, true);
  assert.equal(requestOptions.body, JSON.stringify({ batch_id: 'batch-on-unmount' }));
});
