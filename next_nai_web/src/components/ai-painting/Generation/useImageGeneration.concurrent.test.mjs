import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 仅替换 React 生命周期和网络边界，执行真实 hook、批次流程与任务记录器。
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const runnerUrl = new URL('../../../utils/StudioTaskRunner.mjs', import.meta.url).href;
const fixtureUrl = url(`
  import { StudioTaskRunner } from ${JSON.stringify(runnerUrl)};
  const data = new Map(); const waiting = []; const ready = new Set(); const submissions = new Map();
  export const effects = []; export const posts = []; export const canceled = [];
  export const useRef = current => ({ current });
  export const useState = value => [value, () => {}];
  export const useCallback = value => value;
  export const useEffect = callback => effects.push(callback);
  export const currentStorageScope = () => 'studio:1:';
  export const revokeObjectUrl = () => {};
  const runner = new StudioTaskRunner({ sleep: async () => {}, scope: currentStorageScope, createId: () => crypto.randomUUID(),
    storage: { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k), keys: () => [...data.keys()] },
    request: async (path, options) => {
      if ((path === '/studio/tasks' || path === '/studio/plans')) { posts.push(options.body); const id = posts.length; const tasks = Array.from({ length: options.body.task_count || 1 }, (_, index) => ({ id: options.body.task_count ? index + 1 : id, index })); submissions.set(id, tasks); return { id, tasks }; }
      const id = Number(path.split('/')[3]);
      if (path.includes('/results/') || path.endsWith('/result')) return { images: [{ image: 'png', seed: path.includes('/results/') ? Number(path.split('/').at(-1)) + (path.includes('/plans/') ? 1 : 0) : id }] };
      await new Promise(resolve => { waiting.push(resolve); });
      return { status: ready.has(id) ? 'success' : 'queued', tasks: submissions.get(id).map(task => ({ ...task, status: ready.has(task.id) ? 'success' : 'queued' })) };
    } });
  export const complete = id => { ready.add(id); waiting.splice(0).forEach(resolve => resolve()); };
  export const apiClient = { isStudio: () => true, studioTasks: runner, cancelImageBatch: async id => { canceled.push(id); } };
  export const generateImage = async params => {
    const result = await runner.start(params);
    return { success: true, studioRequestId: result.studio_request_id, seed: result.images[0].seed, imageUrl: 'blob:fixture' };
  };
`);
const fixture = await import(fixtureUrl);
let source = await readFile(new URL('./useImageGeneration.js', import.meta.url), 'utf8');
source = source.replace("from 'react'", `from '${fixtureUrl}'`)
  .replace("from './ImageGenerationService'", `from '${fixtureUrl}'`)
  .replace("import apiClient from '@/utils/ApiClient';", `import { apiClient } from '${fixtureUrl}';`)
  .replace("from '@/utils/userStorage.mjs'", `from '${fixtureUrl}'`)
  .replace("from '@/utils/mediaAssets'", `from '${fixtureUrl}'`)
  .replace("from '@/utils/StudioBatchFlow.mjs'", `from '${new URL('../../../utils/StudioBatchFlow.mjs', import.meta.url).href}'`)
  .replace("from '../tools/BatchGeneration/BatchGenerationService'", `from '${new URL('../tools/BatchGeneration/BatchGenerationService.js', import.meta.url).href}'`)
  .replace("from './errors'", `from '${new URL('./errors.js', import.meta.url).href}'`);
const { default: useImageGeneration } = await import(url(source));

test('真实生成 hook 不再被单任务引用锁串行化，重复点击不覆盖在途批次', async () => {
  const hook = useImageGeneration();
  const cleanups = fixture.effects.map(effect => effect());
  const received = [];
  const done = hook.startBatchGeneration({ batchSize: 3, model: 'nai-diffusion-4-full' }, item => {
    received.push(item.seed); fixture.apiClient.studioTasks.acknowledge(item.studioRequestId);
  });
  assert.equal(fixture.posts.length, 1);
  assert.equal(fixture.posts[0].task_count, 3);
  assert.equal(fixture.apiClient.studioTasks.pendingAll().length, 3);
  await assert.rejects(hook.startBatchGeneration({ batchSize: 2 }), { code: 'STUDIO_TASK_PENDING' });
  await new Promise(resolve => setImmediate(resolve));
  fixture.complete(2);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, [2]);
  fixture.complete(1); fixture.complete(3);
  const status = await done;
  assert.equal(status.completed, 3);
  assert.equal(status.active, false);
  assert.equal(fixture.apiClient.studioTasks.pending(), null);
  cleanups.forEach(cleanup => cleanup?.());
});


test('官方直连与 Director 工具仍逐张执行，不进入 Studio 并发批次', async () => {
  const { default: controller } = await import('../tools/BatchGeneration/BatchGenerationService.js');
  const oldDelay = controller.config.bufferTime;
  controller.config.bufferTime = 15; // 即使旧配置仍存在，生产 hook 也不再调用等待。
  try {
    for (const studio of [false, true]) {
      fixture.effects.length = 0;
      fixture.apiClient.isStudio = () => studio;
      const hook = useImageGeneration();
      const cleanups = fixture.effects.map(effect => effect());
      const initial = fixture.posts.length;
      const done = hook.startBatchGeneration({ batchSize: 2, imageToImage: { directorTools: { active: true } } }, item => {
        fixture.apiClient.studioTasks.acknowledge(item.studioRequestId);
      });
      assert.equal(fixture.posts.length, initial + 1);
      await new Promise(resolve => setImmediate(resolve));
      fixture.complete(initial + 1);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(fixture.posts.length, initial + 2);
      fixture.complete(initial + 2);
      assert.equal((await done).completed, 2);
      cleanups.forEach(cleanup => cleanup?.());
    }
  } finally { controller.config.bufferTime = oldDelay; fixture.apiClient.isStudio = () => true; }
});
