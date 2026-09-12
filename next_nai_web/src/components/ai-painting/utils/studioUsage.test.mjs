import test from 'node:test';
import assert from 'node:assert/strict';
import { describeStudioUsage } from './studioUsage.mjs';

const params = { model: 'nai-diffusion-4-full', width: 1024, height: 1024, steps: 28, batchSize: 2 };
const snapshot = { permissions: { can_use_nai_v5_generation: false }, quota: {
  tasks: { daily_remaining: 0, monthly_remaining: 12 },
  anlas: { daily_remaining: null, monthly_remaining: null },
  v5_tasks: { daily_remaining: null, monthly_remaining: null },
} };

test('个人账本预估遵守免费边界、超规格公式和 V5 二次向上取整', () => {
  assert.equal(describeStudioUsage(snapshot, params).perImage, 0);
  assert.equal(describeStudioUsage(snapshot, { ...params, steps: 29 }).perImage, 21);
  assert.equal(describeStudioUsage(snapshot, { ...params, steps: 29, model: 'nai-diffusion-5-full' }).perImage, 32);
  assert.equal(describeStudioUsage(snapshot, { ...params, width: 0 }).perImage, null);
  assert.equal(describeStudioUsage(snapshot, { ...params, model: 'nai-diffusion-5-full', allow_v5_anlas_fallback: true }).perImage, null);
});

test('展示个人额度，零额度、无限额、未开通和快照缺失相互区分', () => {
  assert.equal(describeStudioUsage(snapshot, params).quotaLabel, '个人额度已用完');
  assert.match(describeStudioUsage(snapshot, params).quotaHelp, /Anlas：今日 不限额/);
  assert.equal(describeStudioUsage(snapshot, { ...params, model: 'nai-diffusion-5-full' }).quotaLabel, 'V5 未开通');
  const allowed = { ...snapshot, permissions: { can_use_nai_v5_generation: true } };
  assert.equal(describeStudioUsage(allowed, { ...params, model: 'nai-diffusion-5-full' }).quotaLabel, '不限额');
  assert.equal(describeStudioUsage(null, params).quotaLabel, '额度待刷新');
});


test('简洁余量服从较紧周期，不重复叠加贡献；额外名额不伪装成个人余额', () => {
  const usage = (quota, model = params.model) => describeStudioUsage({
    permissions: { can_use_nai_v5_generation: true },
    quota: { tasks: quota, v5_tasks: quota },
  }, { ...params, model });
  assert.equal(usage({ daily_remaining: 80, monthly_remaining: 3 }).quotaLabel, '本期剩余 3 张');
  assert.equal(usage({ daily_remaining: 8, monthly_remaining: null }).quotaLabel, '今日剩余 8 张');
  assert.equal(usage({ daily_remaining: null, monthly_remaining: 0 }).quotaLabel, '个人额度已用完');
  assert.equal(usage({ daily_remaining: 8 }).quotaLabel, '额度待刷新');
  assert.equal(usage({ daily_remaining: 8, monthly_remaining: 20, contribution_remaining: 5 }, 'nai-diffusion-5-full').quotaLabel, '今日剩余 8 张');
  const quota = { daily_remaining: 0, monthly_remaining: 0, overflow: { daily_remaining: 20, resets_at: '2099-01-01T00:00:00Z' } };
  assert.equal(usage(quota, 'nai-diffusion-5-full').quotaLabel, '额外剩余 20 张');
  assert.match(usage(quota, 'nai-diffusion-5-full').quotaHelp, /调度状态/);
  assert.equal(usage({ ...quota, overflow: { ...quota.overflow, resets_at: '2000-01-01T00:00:00Z' } }, 'nai-diffusion-5-full').quotaLabel, '额外额度待刷新');
});


test('本张与本批计算实际发送参考，不计算停用、被覆盖和模型不支持的缓存', () => {
  const precise = { ...params, model: 'nai-diffusion-4-5-full', director_reference_images_cached: ['a', 'b'] };
  const result = describeStudioUsage(snapshot, precise);
  assert.equal(result.perImage, 10);
  assert.equal(result.total, 20);
  assert.equal(result.costLabel, '预计 10 Anlas/张 · 本批 20');
  assert.match(result.costHelp, /精准参考 2 项 \+10/);
  assert.equal(describeStudioUsage(snapshot, { ...precise, steps: 29 }).perImage, 31);
  assert.equal(describeStudioUsage(snapshot, { ...precise, model: 'nai-diffusion-5-full' }).perImage, 0);
  const vibe = { use_v4_vibe: true, reference_image_multiple: Array(6).fill('ref'), images: Array(6).fill('ref') };
  assert.equal(describeStudioUsage(snapshot, { ...params, vibeTransfer: vibe }).perImage, 0);
  assert.equal(describeStudioUsage(snapshot, { ...precise, vibeTransfer: vibe }).perImage, 10);
  assert.equal(describeStudioUsage(snapshot, { ...params, model: 'nai-diffusion-3', vibeTransfer: vibe }).perImage, 4);
});
