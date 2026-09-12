"use client";
import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button } from '@mui/material';
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
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    mounted.current = true;
    const refresh = () => {
      if (!apiClient.isStudio()) return;
      try { setRecords(apiClient.studioTasks.pendingAll()); setBusy(apiClient.studioTasks.busy); }
      catch { setMessage('任务记录无法读取，请保留浏览器数据并检查。'); }
    };
    refresh();
    window.addEventListener('studio:task-changed', refresh);
    return () => { mounted.current = false; window.removeEventListener('studio:task-changed', refresh); };
  }, []);
  const resume = async (requestId) => {
    if (recovering.current) return;
    recovering.current = true;
    setApplying(true);
    const owner = currentStorageScope();
    const checkOwner = () => {
      if (!mounted.current || owner !== currentStorageScope()) {
        throw Object.assign(new Error('恢复身份已变化'), { code: 'STUDIO_IDENTITY_CHANGED' });
      }
    };
    setMessage('');
    try {
      await recoverStudioResult({
        runner: apiClient.studioTasks, checkOwner, applyItem: onRecovered, requestId,
        releaseItem: item => revokeObjectUrl(item.objectUrlToRevoke),
        createItem: result => {
          const image = result.images[0];
          const blob = image.blob || createBlobFromBase64(image.data, image.mime_type);
          const url = createObjectUrlFromBlob(blob);
          return { id: `studio-${result.studio_request_id}`, src: url, originalSrc: url, downloadSrc: url,
            cachedBlob: blob, objectUrlToRevoke: url, seed: image.seed, width: image.width, height: image.height,
            prompt: result.studio_parameters.positivePrompt || result.studio_parameters.prompt || '',
            model: result.studio_parameters.model, isComposited: false };
        },
      });
    } catch (error) {
      if (mounted.current && owner === currentStorageScope()) setMessage(studioRecoveryMessage(error));
    } finally {
      recovering.current = false;
      if (mounted.current) setApplying(false);
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
  if (!records.length || busy) return message && !busy ? <Alert severity="warning">{message}</Alert> : null;
  return <Box sx={{ p: 1 }}><Alert severity="info">
    Studio 有 {records.length} 项待处理任务。恢复不会重复生成。
    {message && <div>{message}</div>}
    {records.length > 1 && <Button disabled={applying} onClick={async () => {
      const owner = currentStorageScope();
      for (const record of records) {
        if (!mounted.current || owner !== currentStorageScope()) break;
        if (!['paused', 'failed', 'canceled', 'result_expired'].includes(record.phase)) await resume(record.request_id);
      }
    }}>恢复可用结果</Button>}
    {[...new Map(records.filter(record => record.plan && record.phase === 'paused').map(record => [record.id, record])).values()].map(record =>
      <Box key={`plan-${record.id}`}>计划已暂停，请检查额度和权限。
        <Button disabled={applying} onClick={() => updateRecord(record, id => apiClient.studioTasks.resumePlan(id))}>继续生成剩余图片</Button>
      </Box>)}
    <details open={records.length <= 4}><summary>逐张查看与处理</summary>
    {records.map(record => <Box key={record.request_id}>
      {Number.isInteger(record.index) ? `第 ${record.index + 1} 张` : '生成任务'}
      {record.phase === 'result_expired' && <div>{studioRecoveryMessage({ code: 'idlecloud_result_expired' })}</div>}
      {record.phase === 'paused' && <div>计划已暂停，请检查额度和权限后继续。</div>}
      {['waiting_timeout', 'waiting_connection'].includes(record.phase) && <div>{studioRecoveryMessage({ code: record.phase === 'waiting_timeout' ? 'STUDIO_WAIT_TIMEOUT' : 'STUDIO_STATUS_UNAVAILABLE' })}</div>}
      <Button onClick={() => resume(record.request_id)} disabled={applying}>{['waiting_timeout', 'waiting_connection'].includes(record.phase) ? '继续查询任务' : '恢复结果'}</Button>
      {record.phase === 'result_expired'
        ? <Button disabled={applying} onClick={() => updateRecord(record, id => apiClient.studioTasks.forgetExpired(id))}>清除过期记录</Button>
        : <Button disabled={applying} onClick={() => updateRecord(record, id => apiClient.studioTasks.cancel(id))}>{record.submission_request_id ? '取消本批排队' : '取消排队'}</Button>}
      {['failed', 'canceled', 'partial_success'].includes(record.phase) && <Button disabled={applying} onClick={() => apiClient.studioTasks.acknowledge(record.request_id)}>清除已结束记录</Button>}
    </Box>)}
    </details>
  </Alert></Box>;
}
