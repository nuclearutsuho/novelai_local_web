// 提交前保留任务摘要；普通终态仅存本页内存，未完成任务和画布按存储适配器持久化。手动领取绝不重发生成。
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
    this.recoveries = new Set();
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
    if (this.busy) throw failure('STUDIO_TASK_PENDING');
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
  recordKey(record) { return record.separate || record.concurrent ? BATCH_TASK_PREFIX + record.request_id : PENDING_TASK_KEY; }

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
    if (batch ? batch.canceled || batch.failed || batch.started >= batch.count : this.busy) throw failure('STUDIO_TASK_PENDING');
    // 每次显式生成保留独立摘要，不因新请求覆盖本页尚未领取的结果。
    if (batch) batch.started += 1;
    const record = { request_id: this.createId(), parameters, phase: 'submitting', workspace: Boolean(workspace),
      separate: true, batch_id: parameters.batch_id || null, index: parameters.index ?? (batch ? batch.started - 1 : undefined), concurrent: Boolean(batch), submission_request_id: batch?.requestId, plan: Boolean(batch?.plan) };
    try { this.save(record); }
    catch (error) {
      // 尚未凑齐整批时不能提交；一项落盘失败必须唤醒其他等待者，而不是永久等待。
      if (batch) {
        batch.failed = true;
        batch.reject(Object.assign(failure('STUDIO_RECORD_WRITE_FAILED'), { status: 400 }));
      }
      throw Object.assign(failure('STUDIO_RECORD_WRITE_FAILED'), { cause: error });
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

  async perform(action, requestId, { recovery = false } = {}) {
    const active = recovery ? this.recoveries : this.active;
    active.add(requestId);
    this.notify();
    try { return await action(); }
    finally { active.delete(requestId); this.notify(); }
  }

  async resume(progress = () => {}, requestId, receive = result => result) {
    const owner = this.scope();
    if (this.busy) throw failure('STUDIO_TASK_PENDING');
    const record = this.pending(requestId);
    if (!record) throw failure('STUDIO_NO_PENDING_TASK');
    if (this.recoveries.has(record.request_id)) throw failure('STUDIO_TASK_PENDING');
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
      const result = await this.watch(record, progress, owner);
      // 画布互斥覆盖图片读取、快照加载和补丁安装，不能在网络响应后提前解锁。
      return await receive(result);
    }, record.request_id, { recovery: !record.workspace });
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
      record.server_status = state.status;
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
        // 已生成与已领取是不同状态；下载中断后也不能再展示取消排队。
        record.phase = 'result_pending'; this.save(record);
        let result;
        try { result = await this.readResult(record, owner); }
        catch (error) {
          this.checkOwner(owner);
          if (error.status === 410 && error.code === 'idlecloud_result_expired') {
            record.phase = 'result_expired'; this.save(record);
            throw error;
          }
          throw Object.assign(failure('STUDIO_RESULT_DOWNLOAD_FAILED'), { cause: error });
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

  async cancelRecord(record, owner) {
    if (!record.id) {
      const found = await this.ownedRequest(owner, `/studio/${record.plan ? 'plans' : 'tasks'}/by-request/${encodeURIComponent(record.submission_request_id || record.request_id)}`);
      record.id = found.id;
    }
    const result = await this.ownedRequest(owner, `/studio/${record.plan ? 'plans' : 'tasks'}/${record.id}/cancel`, { method: 'POST', body: {} });
    // 计划取消只停止未派发部分；仍在运行的图片不能被本地标成可清除的终态。
    const related = this.pendingAll().filter(item => item.plan === record.plan && (item.id === record.id ||
      (record.submission_request_id && item.submission_request_id === record.submission_request_id)));
    if (!related.some(item => item.request_id === record.request_id)) related.push(record);
    for (const item of related) {
      const state = item.plan ? result.tasks?.find(task => task.index === item.index)?.status
        : item.task_id ? result.tasks?.find(task => task.id === item.task_id)?.status : result.status;
      if (!state) continue;
      item.server_status = state;
      if (['failed', 'canceled', 'partial_success'].includes(state)) item.phase = state;
      if (state === 'success' && item.phase !== 'result_expired') item.phase = 'result_pending';
      this.save(item);
    }
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
