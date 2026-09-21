"use client";
import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogTitle, DialogContent, DialogActions } from '@mui/material';
import apiClient from '@/utils/ApiClient';
import { createBlobFromBase64, createObjectUrlFromBlob, revokeObjectUrl } from '@/utils/mediaAssets';
import { currentStorageScope } from '@/utils/userStorage.mjs';
import { recoverStudioResult } from '@/utils/StudioRecoveryFlow.mjs';
import { studioRecoveryMessage } from '@/utils/StudioStatusQuery.mjs';

export default function StudioTaskRecovery({ onRecovered }) {
  const [records, setRecords] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const mounted = useRef(false);
  const recovering = useRef(false);
  const stopRecovery = useRef(false);
  const [applying, setApplying] = useState(false);
  const [workspaceRecovering, setWorkspaceRecovering] = useState(false);
  useEffect(() => {
    mounted.current = true;
    const refresh = () => {
      if (!apiClient.isStudio()) return;
      try { setRecords(apiClient.studioTasks.pendingAll()); setBusy(apiClient.studioTasks.busy); }
      catch { setMessage('任务记录无法读取，请检查浏览器存储。'); }
    };
    refresh();
    window.addEventListener('studio:task-changed', refresh);
    return () => { mounted.current = false; window.removeEventListener('studio:task-changed', refresh); };
  }, []);
  const resume = async (requestId) => {
    if (recovering.current) return;
    recovering.current = true;
    stopRecovery.current = false;
    setApplying(true);
    const owner = currentStorageScope();
    const checkOwner = () => {
      if (stopRecovery.current) throw Object.assign(new Error('已停止领取，任务记录仍保留。'), { code: 'STUDIO_RECOVERY_STOPPED' });
      if (!mounted.current || owner !== currentStorageScope()) {
        throw Object.assign(new Error('恢复身份已变化'), { code: 'STUDIO_IDENTITY_CHANGED' });
      }
    };
    setMessage('');
    try {
      checkOwner();
      const record = apiClient.studioTasks.pending(requestId);
      if (!record) return;
      setWorkspaceRecovering(Boolean(record.workspace));
      await recoverStudioResult({
        runner: apiClient.studioTasks, checkOwner, applyItem: onRecovered, requestId,
        releaseItem: item => revokeObjectUrl(item.objectUrlToRevoke),
        createItem: result => {
          const image = result.images[0];
          const blob = image.blob || createBlobFromBase64(image.data, image.mime_type);
          const url = createObjectUrlFromBlob(blob);
          return { id: `studio-${result.studio_request_id}`, studioRequestId: result.studio_request_id, src: url, originalSrc: url, downloadSrc: url,
            cachedBlob: blob, objectUrlToRevoke: url, seed: image.seed, width: image.width, height: image.height,
            prompt: result.studio_parameters.positivePrompt || result.studio_parameters.prompt || '',
            model: result.studio_parameters.model, isComposited: false };
        },
      });
    } catch (error) {
      if (mounted.current && owner === currentStorageScope()) setMessage(studioRecoveryMessage(error));
    } finally {
      recovering.current = false;
      if (mounted.current) { setApplying(false); setWorkspaceRecovering(false); }
    }
  };
  const updateRecord = async (record, action) => {
    if (recovering.current) return;
    recovering.current = true;
    setApplying(true);
    const owner = currentStorageScope();
    setMessage('');
    try { await action(record.request_id); }
    catch (error) {
      if (mounted.current && owner === currentStorageScope()) setMessage(studioRecoveryMessage(error));
    } finally {
      recovering.current = false;
      if (mounted.current && owner === currentStorageScope()) setApplying(false);
    }
  };
  // 模态焦点与遮罩保护底图/蒙版，直到整个画布恢复结束；不能只锁生成按钮。
  const recoveryDialog = <Dialog open={workspaceRecovering} onKeyDown={event => event.stopPropagation()} aria-labelledby="studio-workspace-recovery-title">
    <DialogTitle id="studio-workspace-recovery-title">正在恢复画布</DialogTitle>
    <DialogContent>正在领取结果并恢复底图、蒙版和预览，完成前暂停其他编辑。</DialogContent>
    <DialogActions><Button onClick={() => { stopRecovery.current = true; }}>停止恢复</Button></DialogActions>
  </Dialog>;
  if (!records.length || busy) return <>{recoveryDialog}{message && !busy && <Alert severity="warning">{message}</Alert>}</>;
  return <Box sx={{ p: 1 }}>{recoveryDialog}<Alert severity="info">
    有 {records.length} 项任务待处理，不影响新生成。手动领取不会重新生成；刷新后清空普通图片；尚未确认结束的任务保留查询和取消入口。
    {message && <div>{message}</div>}
    {records.length > 1 && <Button disabled={applying} onClick={async () => {
      const owner = currentStorageScope();
      for (const record of records) {
        if (!mounted.current || owner !== currentStorageScope()) break;
        if (!['paused', 'failed', 'canceled', 'partial_success', 'result_expired'].includes(record.phase)) await resume(record.request_id);
      }
    }}>领取可用结果</Button>}
    {[...new Map(records.filter(record => record.plan && record.phase === 'paused').map(record => [record.id, record])).values()].map(record =>
      <Box key={`plan-${record.id}`}>计划已暂停，请检查额度和权限。
        <Button disabled={applying} onClick={() => updateRecord(record, id => apiClient.studioTasks.resumePlan(id))}>继续生成剩余图片</Button>
      </Box>)}
    <details open={records.length <= 4}><summary>逐张查看与处理</summary>
    {records.map(record => <Box key={record.request_id}>
      {Number.isInteger(record.index) ? `第 ${record.index + 1} 张` : '生成任务'}
      {['ready', 'result_pending'].includes(record.phase) && <div>图片已生成，等待领取。</div>}
      {record.workspace && <div>画布结果请手动恢复，避免覆盖当前编辑。</div>}
      {record.phase === 'result_expired' && <div>{studioRecoveryMessage({ code: 'idlecloud_result_expired' })}</div>}
      {record.phase === 'paused' && <div>计划已暂停，请检查额度和权限后继续。</div>}
      {['waiting_timeout', 'waiting_connection'].includes(record.phase) && <div>{studioRecoveryMessage({ code: record.phase === 'waiting_timeout' ? 'STUDIO_WAIT_TIMEOUT' : 'STUDIO_STATUS_UNAVAILABLE' })}</div>}
      {!['failed', 'canceled', 'partial_success', 'result_expired'].includes(record.phase) && <Button onClick={() => resume(record.request_id)} disabled={applying}>{['waiting_timeout', 'waiting_connection'].includes(record.phase) ? '继续查询任务' : '领取结果'}</Button>}
      {!['ready', 'result_pending', 'result_expired', 'failed', 'canceled', 'partial_success'].includes(record.phase)
          && record.server_status !== 'success'
          && <Button disabled={applying} onClick={() => updateRecord(record, id => apiClient.studioTasks.cancel(id))}>{record.submission_request_id ? '取消本批排队' : '取消排队'}</Button>}
      {['ready', 'result_pending', 'result_expired', 'failed', 'canceled', 'partial_success'].includes(record.phase) && <Button disabled={applying} onClick={() => apiClient.studioTasks.acknowledge(record.request_id)}>移除记录</Button>}
    </Box>)}
    </details>
  </Alert></Box>;
}
