// 仅用于已有任务的只读状态查询；创建、取消和图片下载不经过自动重试。
export async function queryStudioStatus(read, check, sleep) {
  for (let attempt = 0; ; attempt += 1) {
    check();
    try {
      const result = await read();
      check();
      return result;
    } catch (error) {
      check();
      const temporary = error?.code === 'NETWORK_ERROR'
        || [408, 502, 503, 504].includes(error?.status);
      if (!temporary) throw error;
      if (attempt === 3) throw Object.assign(new Error('STUDIO_STATUS_UNAVAILABLE'), {
        code: 'STUDIO_STATUS_UNAVAILABLE', category: 'network', cause: error,
      });
      await sleep(1000 * 2 ** attempt);
    }
  }
}

export function studioRecoveryMessage(error) {
  const code = error?.code || error?.message;
  const messages = {
    idlecloud_result_expired: '临时图片已过期或丢失，可清除这条恢复记录。重新生成需要另行发起。',
    STUDIO_STATUS_UNAVAILABLE: '暂时无法查询任务，记录已保留。连接恢复后可继续查询，不会重新提交生成。',
    NETWORK_ERROR: '连接中断，记录已保留，请稍后恢复已有任务。',
    STUDIO_WAIT_TIMEOUT: '本次等待已结束，任务不一定失败。可继续查询已有任务，不会重新生成。',
    STUDIO_IDENTITY_CHANGED: '登录用户已变化，请从当前账号重新进入。',
    STUDIO_LOGIN_REQUIRED: '登录已失效，请重新从 Studio 进入后恢复任务。',
    STUDIO_TASK_FAILED: '服务器任务已失败，可清除已结束记录后调整参数。',
    STUDIO_PLAN_PAUSED: '计划已暂停。检查额度和权限后，可继续生成剩余图片。',
    STUDIO_TASK_CANCELED: '排队任务已取消，可清除已结束记录。',
    STUDIO_TASK_PARTIAL_SUCCESS: '本批只有部分任务成功，请先领取可用图片。',
    STUDIO_RESULT_AVAILABLE: '图片仍然可用，请恢复结果，无须清除记录。',
    STUDIO_RECORD_CHANGED: '恢复记录已变化，请查看当前任务列表。',
    STUDIO_TASK_PENDING: '已有任务正在处理，请等待当前操作结束。',
  };
  if (messages[code]) return messages[code];
  if (error?.status === 401) return messages.STUDIO_LOGIN_REQUIRED;
  if (error?.status === 403) return '当前账号无权执行此操作，请检查 Studio 授权。';
  return '操作未完成，记录已保留。请稍后重试；恢复不会重新提交生成。';
}
