// 一次提交生成计划，Studio 后台分批；本地分项接收保持原版画廊行为。
export async function runStudioBatch({ runner, batchId, count, paramsFor, generate, receive,
  onStatus = () => {}, onError = () => {}, isCurrent = () => true, release = () => {} }) {
  const total = Math.min(64, Math.max(1, Math.trunc(Number(count)) || 1));
  runner.beginBatch(batchId, total, { plan: true });
  const status = { active: true, current: 1, total, completed: 0, failed: 0, errors: [], waitingTime: 0 };
  const publish = () => { if (isCurrent()) onStatus({ ...status, errors: [...status.errors] }); };
  try {
    publish();
    // 启动前冻结整批参数与种子，完成顺序不影响每张归属，也不读取生成中的新参数。
    const frozen = paramsFor(0);
    const jobs = Array.from({ length: total }, (_, index) => ({ ...frozen, batch_id: batchId, index, batch_size: total }));
    await Promise.allSettled(jobs.map(async (params, index) => {
      let item;
      try {
        if (!isCurrent()) return;
        item = await generate(params);
        if (!isCurrent()) { if (item) release(item); return; }
        if (!item) throw Object.assign(new Error('生成未返回结果'), { code: 'GENERATION_FAILED' });
        await receive(item);
        status.completed += 1;
      } catch (error) {
        if (!isCurrent()) return;
        status.failed += 1;
        const detail = { code: error.code || 'GENERATION_FAILED', category: error.category || 'unknown',
          statusCode: error.statusCode || null, errorId: error.errorId || null, model: params.model, index };
        status.errors.push(detail);
        // 某张失败不重发，也不抹掉已提交的其他任务；未知结果留待按请求 ID 恢复。
        onError(detail, index + 1, total);
      } finally {
        status.current = Math.min(total, status.completed + status.failed + 1);
        publish();
      }
    }));
  } finally {
    status.active = false;
    runner.endBatch(batchId);
    publish();
  }
  return status;
}
