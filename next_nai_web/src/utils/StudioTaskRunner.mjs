// 任务记录先落盘再提交；恢复过程只查询已有任务，绝不自动重发生成。
import { studioWorkspaceStore } from './StudioWorkspaceStore.mjs';
import { queryStudioStatus } from './StudioStatusQuery.mjs';
export const PENDING_TASK_KEY = 'idlecloud.pending-task';
export const BATCH_TASK_PREFIX = 'idlecloud.batch-task:';
const failure = (code) => Object.assign(new Error(code), { code });
// 恢复只领取服务器已有结果，所需信息仅为画廊描述；不在 localStorage 重复存放原图/蒙版。
const recoveryParameters = (parameters) => Object.fromEntries(
  ['width', 'height', 'seed', 'positivePrompt', 'negativePrompt', 'prompt', 'model']
    .filter((name) => ['string', 'number'].includes(typeof parameters[name]))
    .map((name) => [name, parameters[name]])
);

export class StudioTaskRunner {
  constructor({ request, storage, createId, scope = () => '', workspaceStore = studioWorkspaceStore, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), notify = () => {} }) {
    Object.assign(this, { request, storage, createId, scope, workspaceStore, sleep, notify });
    this.active = new Set();
    this.statusRequests = new Map();
    this.batch = null;
  }

  checkOwner(owner) {
    if (this.scope() !== owner) throw failure('STUDIO_IDENTITY_CHANGED');
  }

  async ownedRequest(owner, ...args) {
    this.checkOwner(owner);
    try {
      const result = await this.request(...args);
      this.checkOwner(owner);
      return result;
    } catch (error) {
      this.checkOwner(owner);
      throw error;
    }
  }

  get busy() { return this.active.size > 0 || this.batch !== null; }

  beginBatch(id, count = 1, { plan = false } = {}) {
    if (this.busy || this.pending()) throw failure('STUDIO_TASK_PENDING');
    if (!Number.isInteger(count) || count < 1 || count > (plan ? 64 : 16)) throw failure('STUDIO_TASK_INVALID');
    let resolve, reject;
    const creation = new Promise((yes, no) => { resolve = yes; reject = no; });
    creation.catch(() => {});
    this.batch = { id, count, plan, requestId: this.createId(), owner: this.scope(), canceled: false, started: 0,
      members: [], creation, resolve, reject };
    this.notify();
  }
  isBatch(id) { return Boolean(id && this.batch?.id === id && this.batch.owner === this.scope()); }
  endBatch(id) { if (this.isBatch(id)) { this.batch = null; this.notify(); } }

  pendingAll() {
    // 每项独立存储，异步完成或其他标签领取时不会覆盖同批其他任务；旧单任务记录兼容读取。
    const keys = [PENDING_TASK_KEY, ...(this.storage.keys?.() || []).filter(key => key.startsWith(BATCH_TASK_PREFIX))];
    return keys.flatMap(key => {
      const value = this.storage.getItem(key);
      if (!value) return [];
      const record = JSON.parse(value);
      if (!record?.request_id || !record.parameters) throw failure('STUDIO_RECORD_INVALID');
      return [record];
    });
  }
  pending(requestId) { return this.pendingAll().find(record => !requestId || record.request_id === requestId) || null; }
  recordKey(record) { return record.concurrent ? BATCH_TASK_PREFIX + record.request_id : PENDING_TASK_KEY; }

  save(record) {
    this.storage.setItem(this.recordKey(record), JSON.stringify({ ...record, parameters: recoveryParameters(record.parameters) }));
    this.notify();
  }
  acknowledge(requestId) {
    const record = this.pending(requestId);
    if (record) {
      if (record.workspace) this.workspaceStore.remove(requestId).catch(() => {});
      this.storage.removeItem(this.recordKey(record));
    }
    this.notify();
  }

  async start(parameters, progress = () => {}, workspace = null) {
    const owner = this.scope();
    const batch = this.isBatch(parameters.batch_id) ? this.batch : null;
    if (batch ? batch.canceled || batch.failed || batch.started >= batch.count : this.busy || this.pending()) throw failure('STUDIO_TASK_PENDING');
    if (batch) batch.started += 1;
    const record = { request_id: this.createId(), parameters, phase: 'submitting', workspace: Boolean(workspace),
      batch_id: parameters.batch_id || null, index: parameters.index ?? (batch ? batch.started - 1 : undefined), concurrent: Boolean(batch), submission_request_id: batch?.requestId, plan: Boolean(batch?.plan) };
    try { this.save(record); }
    catch (error) {
      // 尚未凑齐整批时不能提交；一项落盘失败必须唤醒其他等待者，而不是永久等待。
      if (batch) {
        batch.failed = true;
        batch.reject(Object.assign(failure('STUDIO_RECORD_WRITE_FAILED'), { status: 400 }));
      }
      throw error;
    }
    return this.perform(async () => {
      if (workspace) {
        try { await this.workspaceStore.save(record.request_id, workspace); }
        catch (error) { batch?.reject(error); this.checkOwner(owner); this.acknowledge(record.request_id); throw error; }
      }
      this.checkOwner(owner);
      let created;
      try {
        if (batch) {
          batch.members.push(record);
          if (batch.members.length === batch.count) {
            // 计划只 POST 一次，后续 submission 均由 Studio 后台组织。
            if (batch.canceled) batch.reject(Object.assign(failure('STUDIO_TASK_CANCELED'), { status: 400 }));
            else this.ownedRequest(owner, batch.plan ? '/studio/plans' : '/studio/tasks', { method: 'POST', body: {
              request_id: batch.requestId, parameters: batch.members[0].parameters, task_count: batch.count,
            } }).then(batch.resolve, batch.reject);
          }
          created = await batch.creation;
          this.checkOwner(owner);
          if (!Array.isArray(created.tasks) || created.tasks.length !== batch.count) throw failure('STUDIO_BATCH_RESPONSE_INVALID');
          record.task_id = created.tasks[record.index]?.id;
          if (!record.task_id && !record.plan) throw failure('STUDIO_BATCH_RESPONSE_INVALID');
        } else created = await this.ownedRequest(owner, '/studio/tasks', { method: 'POST', body: record });
      }
      catch (error) {
        this.checkOwner(owner);
        // 明确的准入拒绝没有创建任务；网络/服务端不确定结果必须保留恢复记录。
        if ([400, 401, 403, 422].includes(error.status) || error.code === 'idlecloud_no_account_available') this.acknowledge(record.request_id);
        throw error;
      }
      record.id = created.id;
      record.phase = 'waiting';
      this.save(record);
      if (batch?.canceled) {
        batch.cancelAfterCreate ||= this.cancelRecord(record, owner);
        await batch.cancelAfterCreate;
      }
      return this.watch(record, progress, owner);
    }, record.request_id);
  }

  async perform(action, requestId) {
    this.active.add(requestId);
    this.notify();
    try { return await action(); }
    finally { this.active.delete(requestId); this.notify(); }
  }

  async resume(progress = () => {}, requestId) {
    const owner = this.scope();
    if (this.busy) throw failure('STUDIO_TASK_PENDING');
    const record = this.pending(requestId);
    if (!record) throw failure('STUDIO_NO_PENDING_TASK');
    return this.perform(async () => {
      if (!record.id) {
        const found = await this.ownedRequest(owner, `/studio/${record.plan ? 'plans' : 'tasks'}/by-request/${encodeURIComponent(record.submission_request_id || record.request_id)}`);
        record.id = found.id;
        if (record.submission_request_id) {
          record.task_id = found.tasks?.[record.index]?.id;
          if (!record.task_id && !record.plan) throw failure('STUDIO_BATCH_RESPONSE_INVALID');
        }
        this.save(record);
      }
      return this.watch(record, progress, owner);
    }, record.request_id);
  }

  async readStatus(record, owner) {
    const key = `${owner}:${record.plan ? 'plan' : 'task'}:${record.id}`;
    if (!this.statusRequests.has(key)) {
      const pending = queryStudioStatus(() => this.ownedRequest(owner, `/studio/${record.plan ? 'plans' : 'tasks'}/${record.id}`),
        () => this.checkOwner(owner), this.sleep);
      this.statusRequests.set(key, pending);
      pending.finally(() => { if (this.statusRequests.get(key) === pending) this.statusRequests.delete(key); }).catch(() => {});
    }
    return this.statusRequests.get(key);
  }

  async watch(record, progress, owner = this.scope()) {
    for (let attempt = 0; attempt < (record.plan ? 57600 : 400); attempt += 1) {
      let submission;
      try { submission = await this.readStatus(record, owner); }
      catch (error) {
        this.checkOwner(owner);
        if (error.code === 'STUDIO_STATUS_UNAVAILABLE') { record.phase = 'waiting_connection'; this.save(record); }
        throw error;
      }
      const state = record.plan ? submission.tasks?.find(task => task.index === record.index)
        : record.task_id ? submission.tasks?.find(task => task.id === record.task_id) : submission;
      if (!state) throw failure('STUDIO_BATCH_RESPONSE_INVALID');
      if (record.plan && submission.status === 'paused' && state.status === 'planned') {
        record.phase = 'paused'; this.save(record);
        throw failure('STUDIO_PLAN_PAUSED');
      }
      progress({ status: state.status === 'queued' ? 'queued' : 'processing', studioStatus: state.status });
      if (['failed', 'canceled', 'partial_success'].includes(state.status)) {
        record.phase = state.status;
        this.save(record);
        throw failure(`STUDIO_TASK_${state.status.toUpperCase()}`);
      }
      if (state.status === 'success') {
        let result;
        try { result = await this.readResult(record, owner); }
        catch (error) {
          this.checkOwner(owner);
          if (error.status === 410 && error.code === 'idlecloud_result_expired') {
            record.phase = 'result_expired'; this.save(record);
          }
          throw error;
        }
        record.phase = 'ready';
        this.save(record);
        return { studio_request_id: record.request_id, studio_parameters: record.parameters, studio_workspace: record.workspace,
          images: result.images.map((image) => ({ blob: image.blob, data: image.image, seed: image.seed,
            mime_type: image.mime_type || (image.image?.startsWith('/9j/') ? 'image/jpeg' : image.image?.startsWith('UklGR') ? 'image/webp' : 'image/png'),
            width: record.parameters.width, height: record.parameters.height })) };
      }
      await this.sleep(1500);
    }
    this.checkOwner(owner);
    record.phase = 'waiting_timeout'; this.save(record);
    throw Object.assign(failure('STUDIO_WAIT_TIMEOUT'), { category: 'timeout' });
  }

  readResult(record, owner) {
    return this.ownedRequest(owner, record.plan ? `/studio/plans/${record.id}/results/${record.index}`
      : record.task_id ? `/studio/tasks/${record.id}/results/${record.task_id}` : `/studio/tasks/${record.id}/result`,
      { responseType: 'image', headers: { Accept: 'image/*' } });
  }

  async forgetExpired(requestId) {
    const owner = this.scope();
    const record = this.pending(requestId);
    if (!record || record.phase !== 'result_expired' || this.busy) throw failure('STUDIO_RECORD_CHANGED');
    const original = this.storage.getItem(this.recordKey(record));
    try { await this.readResult(record, owner); }
    catch (error) {
      this.checkOwner(owner);
      // 清理前再次确认过期；网络故障或其他标签的改动不能导致记录被删除。
      if (error.status !== 410 || error.code !== 'idlecloud_result_expired') throw error;
      if (this.storage.getItem(this.recordKey(record)) !== original) throw failure('STUDIO_RECORD_CHANGED');
      this.acknowledge(requestId);
      return;
    }
    throw failure('STUDIO_RESULT_AVAILABLE');
  }

  async cancelRecord(record, owner) {
    if (!record.id) {
      const found = await this.ownedRequest(owner, `/studio/${record.plan ? 'plans' : 'tasks'}/by-request/${encodeURIComponent(record.submission_request_id || record.request_id)}`);
      record.id = found.id;
    }
    const result = await this.ownedRequest(owner, `/studio/${record.plan ? 'plans' : 'tasks'}/${record.id}/cancel`, { method: 'POST', body: {} });
    // 计划取消只停止未派发部分；仍在运行的图片不能被本地标成可清除的终态。
    const canceled = record.plan ? result.tasks?.find(item => item.index === record.index)?.status === 'canceled'
      : result.status === 'canceled';
    if (canceled) { record.phase = 'canceled'; this.save(record); }
    return result;
  }

  async resumePlan(requestId) {
    const owner = this.scope();
    const record = this.pending(requestId);
    if (!record?.plan || !record.id || this.busy) throw failure('STUDIO_RECORD_CHANGED');
    await this.ownedRequest(owner, `/studio/plans/${record.id}/resume`, { method: 'POST', body: {} });
    for (const item of this.pendingAll().filter(item => item.plan && item.id === record.id && item.phase === 'paused')) {
      item.phase = 'waiting'; this.save(item);
    }
  }

  async cancel(requestId = null, batchId = null) {
    const owner = this.scope();
    if (this.batch?.owner === owner && (!batchId || this.batch.id === batchId) && !requestId) this.batch.canceled = true;
    const records = this.pendingAll().filter(record => (!requestId || record.request_id === requestId)
      && (!batchId || record.batch_id === batchId));
    if (!records.length) return { canceled: false };
    const unique = [...new Map(records.map(record => [record.id || record.submission_request_id || record.request_id, record])).values()];
    const results = await Promise.allSettled(unique.map(record => this.cancelRecord(record, owner)));
    // 创建响应尚未返回时查询可能找不到；start 在收到创建结果后还会复查批次取消标志。
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    return results.length === 1 ? results[0].value : { items: results.map(result => result.value) };
  }
}
