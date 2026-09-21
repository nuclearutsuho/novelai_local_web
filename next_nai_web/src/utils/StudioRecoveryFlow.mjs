// 恢复中的每个异步阶段都属于点击时的用户；页面卸载也会使本次恢复失效。
export async function recoverStudioResult({ runner, checkOwner, createItem, applyItem, releaseItem, requestId }) {
  let item;
  let applied = false;
  try {
    checkOwner();
    await runner.resume(() => checkOwner(), requestId, async result => {
      checkOwner();
      const workspace = result.studio_workspace
        ? await runner.workspaceStore.load(result.studio_request_id) : null;
      checkOwner();
      if (result.studio_workspace && !workspace) {
        throw Object.assign(new Error('工作区快照缺失'), { code: 'STUDIO_WORKSPACE_MISSING' });
      }
      item = createItem(result);
      await applyItem(item, workspace, checkOwner);
      checkOwner();
      applied = true;
      runner.acknowledge(result.studio_request_id);
    });
  } finally {
    // 失败时释放本次创建的图片 URL，服务器任务及本地恢复摘要继续保留。
    if (item && !applied) releaseItem(item);
  }
}
