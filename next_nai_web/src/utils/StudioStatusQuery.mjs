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

// 只以明确业务错误清理；普通 HTTP 404、授权失败和网络错误都保留恢复机会。
export function isStudioRecoveryUnavailable(error) {
  return (error?.status === 404 && ['idlecloud_task_not_found', 'idlecloud_plan_not_found'].includes(error?.code))
    || (error?.status === 410 && error?.code === 'idlecloud_result_expired');
}

export function studioRecoveryMessage(error) {
  const code = error?.code || error?.message;
  const messages = {
    idlecloud_task_not_found: '任务不存在',
    idlecloud_plan_not_found: '计划不存在',
    STUDIO_RECOVERY_STOPPED: '已停止恢复',
    idlecloud_result_expired: '图片已过期',
    STUDIO_STATUS_UNAVAILABLE: '暂时无法查询任务',
    NETWORK_ERROR: '连接中断',
    STUDIO_WAIT_TIMEOUT: '任务状态待确认',
    STUDIO_IDENTITY_CHANGED: '账号已切换',
    STUDIO_LOGIN_REQUIRED: '登录已失效，请重新从 Studio 进入',
    STUDIO_PERMISSION_DENIED: '当前账号无权操作',
    STUDIO_TASK_FAILED: '生成失败',
    STUDIO_PLAN_PAUSED: '计划已暂停',
    STUDIO_TASK_CANCELED: '任务已取消',
    STUDIO_TASK_PARTIAL_SUCCESS: '部分图片生成失败',
    STUDIO_RECORD_CHANGED: '任务状态已变化',
    STUDIO_NO_PENDING_TASK: '任务已移除',
    STUDIO_BATCH_RESPONSE_INVALID: '任务状态不匹配',
    STUDIO_WORKSPACE_MISSING: '画布快照已丢失',
    STUDIO_WORKSPACE_INVALID: '画布快照无法读取',
    STUDIO_WORKSPACE_NOT_MOUNTED: '画布尚未就绪',
    STUDIO_WORKSPACE_RECOVERY_FAILED: '画布恢复失败',
    idlecloud_request_id_invalid: '任务无法查询',
    CSRF_INVALID: '登录已失效，请重新从 Studio 进入',
    STUDIO_TASK_PENDING: '任务正在处理',
    STUDIO_RESULT_DOWNLOAD_FAILED: '图片接收失败',
    STUDIO_RECORD_WRITE_FAILED: '无法保存任务，请检查浏览器存储空间',
  };
  if (messages[code]) return messages[code];
  if (error?.status === 401) return messages.STUDIO_LOGIN_REQUIRED;
  if (error?.status === 403) return '当前账号无权操作';
  return '操作失败，请重试';
}
