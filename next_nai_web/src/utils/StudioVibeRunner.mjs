// 同一用户、图片和编码参数恢复同一操作；同步存储只保留摘要与请求 ID。
import { queryStudioStatus } from './StudioStatusQuery.mjs';
const resultUnavailable = error => error?.status === 410 &&
  ['idlecloud_tool_result_expired', 'idlecloud_tool_result_corrupt'].includes(error.code);
export class StudioVibeRunner {
  constructor({ request, storage, scope, tool = 'vibe-encode', createId = () => crypto.randomUUID(), digest = async (value) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
      .map((n) => n.toString(16).padStart(2, '0')).join(''),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onTerminal = () => {} }) {
    if (!['vibe-encode', 'upscale', 'director'].includes(tool)) throw new Error('STUDIO_TOOL_INVALID');
    Object.assign(this, { request, storage, scope, tool, createId, digest, sleep, onTerminal });
    this.active = new Map();
  }

  async encode(payload, { resumeOnly = false } = {}) {
    const owner = this.scope();
    const check = () => { if (!/^studio:[1-9][0-9]*:$/.test(owner) || this.scope() !== owner) throw new Error('STUDIO_IDENTITY_CHANGED'); };
    check();
    // 放大的模糊参数与字段存在性也参与去重，不能复用另一组参数的结果。
    const identity = this.tool === 'director' ? Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))
      : this.tool === 'vibe-encode' ? [payload.model, payload.information_extracted, payload.image]
      : [payload.model, Object.hasOwn(payload, 'declared_blur_sigma'), payload.declared_blur_sigma, payload.image];
    const namespace = this.tool === 'vibe-encode' ? 'vibe' : this.tool;
    const key = `idlecloud.${namespace}.` + await this.digest(JSON.stringify(identity));
    check();
    const activeKey = owner + key;
    if (this.active.has(activeKey)) return this.active.get(activeKey);
    const operation = this.run(payload, key, check, owner, resumeOnly);
    this.active.set(activeKey, operation);
    try { return await operation; } finally { this.active.delete(activeKey); }
  }

  async run(payload, key, check, owner, resumeOnly = false) {
    let record = JSON.parse(this.storage.getItem(key) || 'null');
    const save = () => { check(); this.storage.setItem(key, JSON.stringify(record)); };
    if (!record) {
      // 页面恢复只能领取原操作；摘要缺失时不把“恢复”悄悄变成新的收费请求。
      if (resumeOnly) throw Object.assign(new Error('STUDIO_TOOL_RECORD_MISSING'), { code: 'STUDIO_TOOL_RECORD_MISSING' });
      record = { request_id: this.createId() };
      save();
      try {
        const created = await this.request(`/studio/tools/${this.tool}`, { method: 'POST', body: { request_id: record.request_id, request: payload } });
        check(); record.id = created.id; save();
      } catch (error) {
        check();
        if ([400, 401, 403, 422].includes(error.status)) this.storage.removeItem(key);
        throw error;
      }
    }
    if (!record.id) {
      const found = await this.request(`/studio/tools/by-request/${encodeURIComponent(record.request_id)}`);
      check(); record.id = found.id; save();
    }
    for (let attempt = 0; attempt < 400; attempt += 1) {
      check();
      const state = await queryStudioStatus(() => this.request(`/studio/tools/${record.id}`), check, this.sleep);
      check();
      if (['failed', 'failed_unknown', 'canceled'].includes(state.status)) {
        this.onTerminal({ key, owner, request_id: record.request_id, id: record.id, tool: this.tool, status: state.status });
        throw new Error(state.error_code || `STUDIO_TOOL_${state.status}`);
      }
      if (state.status === 'succeeded') {
        let result;
        try { result = await this.request(`/studio/tools/${record.id}/result`,
          this.tool === 'vibe-encode' ? {} : { responseType: 'image', headers: { Accept: 'image/*' } }); }
        catch (error) {
          check();
          if (resultUnavailable(error)) this.onTerminal({ key, owner, request_id: record.request_id,
            id: record.id, tool: this.tool, status: 'result_unavailable' });
          throw error;
        }
        check();
        // 调用方持久化原版 Vibe 缓存后才确认，断线或缓存失败可以再次领取。
        const receipt = this.tool === 'vibe-encode' ? 'studio_vibe_receipt' : `studio_${this.tool}_receipt`;
        return { ...result, [receipt]: { key, owner, request_id: record.request_id } };
      }
      await this.sleep(1500);
    }
    throw Object.assign(new Error('STUDIO_WAIT_TIMEOUT'), { code: 'STUDIO_WAIT_TIMEOUT', category: 'timeout' });
  }

  acknowledge(receipt) {
    if (!receipt || this.scope() !== receipt.owner) return;
    const record = JSON.parse(this.storage.getItem(receipt.key) || 'null');
    if (record?.request_id === receipt.request_id) this.storage.removeItem(receipt.key);
  }

  async refreshTerminals() {
    const owner = this.scope();
    if (!/^studio:[1-9][0-9]*:$/.test(owner)) return;
    const prefix = `idlecloud.${this.tool === 'vibe-encode' ? 'vibe' : this.tool}.`;
    const check = () => { if (this.scope() !== owner) throw new Error('STUDIO_IDENTITY_CHANGED'); };
    let firstError;
    for (const key of this.storage.keys?.() || []) {
      if (!key.startsWith(prefix) || this.active.has(owner + key)) continue;
      check();
      try {
      const original = this.storage.getItem(key);
      const record = JSON.parse(original || 'null');
      if (!record?.request_id) continue;
      const state = await this.request(record.id ? `/studio/tools/${record.id}`
        : `/studio/tools/by-request/${encodeURIComponent(record.request_id)}`);
      check();
      // 查询期间已领取、删除或换成新请求时，不用迟到响应恢复旧记录。
      if (this.storage.getItem(key) !== original) continue;
      if (!Number.isSafeInteger(state.id) || state.id <= 0) continue;
      record.id = state.id;
      this.storage.setItem(key, JSON.stringify(record));
      if (['failed', 'failed_unknown', 'canceled'].includes(state.status)) {
        this.onTerminal({ key, owner, request_id: record.request_id, id: record.id, tool: this.tool, status: state.status });
      }
      } catch (error) {
        check();
        // 单条损坏或查询失败不能挡住其他可恢复记录，原始内容仍保留。
        firstError ||= error;
      }
    }
    if (firstError) throw firstError;
  }

  async forgetTerminal(receipt) {
    const check = () => {
      if (!receipt || this.scope() !== receipt.owner || receipt.tool !== this.tool) throw new Error('STUDIO_IDENTITY_CHANGED');
      const record = JSON.parse(this.storage.getItem(receipt.key) || 'null');
      if (record?.request_id !== receipt.request_id || record?.id !== receipt.id || !Number.isSafeInteger(receipt.id)) {
        throw new Error('STUDIO_RECORD_CHANGED');
      }
    };
    check();
    const state = await this.request(`/studio/tools/${receipt.id}`);
    check();
    if (state.status === 'succeeded' && receipt.status === 'result_unavailable') {
      try {
        await this.request(`/studio/tools/${receipt.id}/result`);
      } catch (error) {
        check();
        // 只有服务端再次明确确认过期或损坏，才允许清除；网络故障不等于结果消失。
        if (!resultUnavailable(error)) throw error;
        this.storage.removeItem(receipt.key);
        return;
      }
      check();
      throw new Error('STUDIO_TOOL_RESULT_AVAILABLE');
    }
    // 必须重新向服务器核对终态；清除仅解除本地阻塞，不能在这里自动创建新请求。
    if (!['failed', 'failed_unknown', 'canceled'].includes(state.status)) throw new Error('STUDIO_TOOL_NOT_TERMINAL');
    this.storage.removeItem(receipt.key);
  }
}
