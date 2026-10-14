"use client";
import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogTitle, DialogContent, DialogActions, Typography } from '@mui/material';
import apiClient from '@/utils/ApiClient';
import { createBlobFromBase64, createObjectUrlFromBlob, revokeObjectUrl } from '@/utils/mediaAssets';
import { currentStorageScope } from '@/utils/userStorage.mjs';
import { recoverStudioResult } from '@/utils/StudioRecoveryFlow.mjs';
import { isStudioRecoveryUnavailable, studioRecoveryMessage } from '@/utils/StudioStatusQuery.mjs';
import styles from './StudioTaskRecovery.module.css';

const readyPhases = ['ready', 'result_pending'];
const endedPhases = ['failed', 'canceled', 'partial_success'];
const brokenWorkspace = ['STUDIO_WORKSPACE_MISSING', 'STUDIO_WORKSPACE_INVALID'];

export default function StudioTaskRecovery({ onRecovered }) {
  const [records, setRecords] = useState([]);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(new Set());
  const [applying, setApplying] = useState(null);
  const [workspaceRecovering, setWorkspaceRecovering] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [storageError, setStorageError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const mounted = useRef(false);
  const recovering = useRef(false);
  const stopRecovery = useRef(false);
  const refreshRef = useRef(() => {});

  useEffect(() => {
    mounted.current = true;
    let owner = currentStorageScope();
    const inspected = new Set();
    let timer;
    const refresh = () => {
      if (!apiClient.isStudio()) return;
      if (owner !== currentStorageScope()) {
        owner = currentStorageScope();
        inspected.clear();
        setChecking(new Set());
        setConfirming(null);
      }
      try {
        const pending = apiClient.studioTasks.pendingAll();
        setRecords(pending);
        setBusy(apiClient.studioTasks.busy);
        setStorageError('');
        window.clearTimeout(timer);
        // 等提交同步阶段结束再检查旧摘要，避免把正在创建但尚不可查的任务当作丢失。
        timer = window.setTimeout(async () => {
          if (!mounted.current || apiClient.studioTasks.busy || recovering.current) return;
          const candidates = apiClient.studioTasks.pendingAll().filter(record => !inspected.has(record.request_id));
          const checkingOwner = currentStorageScope();
          candidates.forEach(record => inspected.add(record.request_id));
          setChecking(previous => new Set([...previous, ...candidates.map(record => record.request_id)]));
          await Promise.allSettled(candidates.map(record => apiClient.studioTasks.inspect(record.request_id)));
          if (mounted.current && checkingOwner === currentStorageScope()) {
            setChecking(previous => {
              const next = new Set(previous);
              candidates.forEach(record => next.delete(record.request_id));
              return next;
            });
          }
        }, 0);
      } catch { setStorageError('任务无法读取，请检查浏览器存储'); }
    };
    refreshRef.current = refresh;
    refresh();
    window.addEventListener('studio:task-changed', refresh);
    return () => {
      mounted.current = false;
      window.clearTimeout(timer);
      window.removeEventListener('studio:task-changed', refresh);
    };
  }, []);

  const run = async (record, action, workspace = false) => {
    if (recovering.current || apiClient.studioTasks.busy) return;
    const owner = currentStorageScope();
    recovering.current = true;
    stopRecovery.current = false;
    setApplying(record.request_id);
    setWorkspaceRecovering(workspace);
    const checkOwner = () => {
      if (stopRecovery.current) throw Object.assign(new Error('STUDIO_RECOVERY_STOPPED'), { code: 'STUDIO_RECOVERY_STOPPED' });
      if (!mounted.current || owner !== currentStorageScope()) {
        throw Object.assign(new Error('STUDIO_IDENTITY_CHANGED'), { code: 'STUDIO_IDENTITY_CHANGED' });
      }
    };
    try { checkOwner(); await action(checkOwner); }
    catch (error) {
      if (mounted.current && owner === currentStorageScope() && !isStudioRecoveryUnavailable(error)) {
        apiClient.studioTasks.noteRecoveryError(record.request_id, error, owner);
      }
    } finally {
      recovering.current = false;
      if (mounted.current && owner === currentStorageScope()) {
        setApplying(null);
        setWorkspaceRecovering(false);
        refreshRef.current();
      }
    }
  };

  const receive = (record, restoreWorkspace = record.workspace) => run(record, checkOwner =>
    recoverStudioResult({
      runner: apiClient.studioTasks, checkOwner, applyItem: onRecovered,
      requestId: record.request_id, restoreWorkspace,
      releaseItem: item => revokeObjectUrl(item.objectUrlToRevoke),
      createItem: result => {
        const image = result.images[0];
        const blob = image.blob || createBlobFromBase64(image.data, image.mime_type);
        const url = createObjectUrlFromBlob(blob);
        return {
          id: `studio-${result.studio_request_id}`, studioRequestId: result.studio_request_id,
          src: url, originalSrc: url, downloadSrc: url, cachedBlob: blob, objectUrlToRevoke: url,
          seed: image.seed, width: image.width, height: image.height,
          prompt: result.studio_parameters.positivePrompt || result.studio_parameters.prompt || '',
          model: result.studio_parameters.model, isComposited: false,
        };
      },
    }), Boolean(restoreWorkspace));

  const visible = records.filter(record => record.phase !== 'result_expired' && !checking.has(record.request_id));
  // 计划的未派发项只展示一个操作，已生成图片仍逐张接收。
  const pausedPlans = new Set();
  const rows = visible.filter(record => {
    if (!record.plan || record.phase !== 'paused') return true;
    const key = record.id || record.submission_request_id;
    if (pausedPlans.has(key)) return false;
    pausedPlans.add(key);
    return true;
  });
  const shown = showAll ? rows : rows.slice(0, 3);

  return <>
    <Dialog open={workspaceRecovering} onKeyDown={event => event.stopPropagation()} aria-labelledby="studio-workspace-recovery-title">
      <DialogTitle id="studio-workspace-recovery-title">正在恢复画布</DialogTitle>
      <DialogActions><Button onClick={() => { stopRecovery.current = true; }}>停止恢复</Button></DialogActions>
    </Dialog>
    <Dialog open={Boolean(confirming)} onClose={() => setConfirming(null)} aria-labelledby="studio-workspace-confirm-title">
      <DialogTitle id="studio-workspace-confirm-title">恢复到画布？</DialogTitle>
      <DialogContent>将覆盖当前画布和蒙版。</DialogContent>
      <DialogActions>
        <Button onClick={() => setConfirming(null)}>取消</Button>
        <Button onClick={() => {
          const record = confirming;
          setConfirming(null);
          if (record.owner === currentStorageScope()) void receive(record);
        }}>恢复</Button>
      </DialogActions>
    </Dialog>
    {storageError && <Alert severity="warning" onClose={() => setStorageError('')}>{storageError}</Alert>}
    {!busy && shown.length > 0 && <Box className={styles.root}>
      {shown.map((record, index) => {
        const ended = endedPhases.includes(record.phase);
        const ready = readyPhases.includes(record.phase);
        const missingWorkspace = brokenWorkspace.includes(record.recovery_error);
        const disabled = Boolean(applying) || checking.has(record.request_id);
        const label = applying === record.request_id ? workspaceRecovering ? '正在恢复画布' : '正在接收图片'
          : record.recovery_error ? studioRecoveryMessage({ code: record.recovery_error })
          : ready ? record.workspace ? '画布结果可恢复' : '图片已生成'
          : record.phase === 'paused' ? '计划已暂停'
          : ended ? studioRecoveryMessage({ code: `STUDIO_TASK_${record.phase.toUpperCase()}` })
          : record.server_status === 'queued' ? '任务排队中'
          : record.server_status ? '任务生成中' : '任务状态待确认';
        return <Box key={record.request_id} className={styles.row}>
          <Typography className={styles.label} component="span" variant="body2">
            {rows.length > 1 ? `第 ${index + 1} 张：` : ''}{label}
          </Typography>
          <Box className={styles.actions}>
            {ended ? <Button size="small" disabled={disabled} onClick={() => apiClient.studioTasks.acknowledge(record.request_id)}>关闭</Button>
              : record.phase === 'paused' ? <Button size="small" disabled={disabled} onClick={() => run(record, () => apiClient.studioTasks.resumePlan(record.request_id))}>继续生成</Button>
                : ready ? <Button size="small" disabled={disabled} onClick={() => {
                  if (record.workspace && !missingWorkspace) setConfirming({ ...record, owner: currentStorageScope() });
                  else void receive(record, false);
                }}>{record.workspace && !missingWorkspace ? '恢复到画布' : record.recovery_error === 'STUDIO_RESULT_DOWNLOAD_FAILED' ? '重试接收' : '接收图片'}</Button>
                  : <Button size="small" disabled={disabled} onClick={() => run(record, () => apiClient.studioTasks.inspect(record.request_id))}>
                    {record.recovery_error ? '重试查询' : '查询状态'}
                  </Button>}
            {!ready && !ended && <Button size="small" disabled={disabled} onClick={() => run(record, () => apiClient.studioTasks.cancel(record.request_id))}>
              {record.submission_request_id ? '取消本批排队' : '取消排队'}
            </Button>}
          </Box>
        </Box>;
      })}
      {rows.length > 3 && <Button size="small" disabled={Boolean(applying)} onClick={() => setShowAll(value => !value)}>
        {showAll ? '收起' : `其余 ${rows.length - 3} 张`}
      </Button>}
    </Box>}
  </>;
}
