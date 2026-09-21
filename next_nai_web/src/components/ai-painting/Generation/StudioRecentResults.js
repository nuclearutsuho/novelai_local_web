"use client";
import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, ButtonBase, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  Checkbox, Chip, IconButton, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { Close, History, Refresh, ImageOutlined, ChevronLeft, ChevronRight, Download } from '@mui/icons-material';
import apiClient from '@/utils/ApiClient';
import { currentStorageScope } from '@/utils/userStorage.mjs';
import { createObjectUrlFromBlob, revokeObjectUrl } from '@/utils/mediaAssets';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { groupRecentResults, mergeRecentResults, processRecentResults } from './recentResultOperations.mjs';
import { useI18n } from '@/i18n/I18nProvider';

function ResultPreview({ row, disabled, onClick, label, full = false }) {
  const host = useRef(null);
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!row.available) return;
    const controller = new AbortController();
    const owner = currentStorageScope();
    let url;
    let requested = false;
    // 只请求滚动区域内的小图；关闭弹窗会取消请求并释放预览内存。
    const observer = new IntersectionObserver(entries => {
      const onScreen = entries.some(entry => entry.isIntersecting);
      setVisible(onScreen);
      if (!onScreen || requested) return;
      requested = true;
      apiClient.request(`/studio/tasks/${row.submission_id}/results/${row.task_id}${full ? '' : '/thumbnail'}`,
        { responseType: 'image', headers: { Accept: 'image/*' }, signal: controller.signal })
        .then(result => {
          if (controller.signal.aborted || owner !== currentStorageScope()) return;
          url = createObjectUrlFromBlob(result.images[0].blob);
          setSrc(url);
        }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    });
    observer.observe(host.current);
    return () => { observer.disconnect(); controller.abort(); if (url) revokeObjectUrl(url); };
  }, [row.available, row.submission_id, row.task_id, full]);
  return <ButtonBase ref={host} disabled={disabled} onClick={onClick} aria-label={label('view')}
    sx={{ width: '100%', aspectRatio: full ? undefined : '1', height: full ? '60vh' : undefined, bgcolor: 'action.hover', overflow: 'hidden' }}>
    {src && visible ? <Box component="img" loading="lazy" decoding="async" src={src} alt={row.prompt || label('untitled')}
      sx={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      : row.available && !failed ? <CircularProgress size={24} />
        : <Stack alignItems="center" spacing={1} sx={{ color: 'text.secondary' }}>
          <ImageOutlined sx={{ fontSize: 36, opacity: 0.5 }} />
          <Typography variant="caption">{label(failed ? 'previewFailed' : row.status === 'success' ? 'expired' : row.status)}</Typography>
        </Stack>}
  </ButtonBase>;
}

export default function StudioRecentResults({ onReceive, generatedItems }) {
  const { t, formatDate } = useI18n();
  const label = key => t(`painting.workspace.recentResults.${key}`);
  const text = (key, values) => t(`painting.workspace.recentResults.${key}`, values);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [retention, setRetention] = useState(60);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('available');
  const [selected, setSelected] = useState(new Set());
  const [previewId, setPreviewId] = useState(null);
  const [archive, setArchive] = useState(null);
  const [progress, setProgress] = useState('');
  const [now, setNow] = useState(Date.now());
  const session = useRef(0);
  const fetching = useRef(false);
  const operation = useRef(null);
  const listController = useRef(null);
  const sentinel = useRef(null);
  const loadRef = useRef(null);
  const owner = useRef(currentStorageScope());
  useEffect(() => () => {
    session.current++; operation.current?.abort(); listController.current?.abort();
  }, []);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [open]);
  const cancel = () => { operation.current?.abort(); operation.current = null; setBusy(false); setProgress(''); };
  const close = () => {
    session.current++; cancel(); listController.current?.abort(); fetching.current = false;
    setLoading(false); setOpen(false); setPreviewId(null); setArchive(null);
  };
  const load = async (before = null) => {
    if (fetching.current) return;
    fetching.current = true; setLoading(true); setError('');
    const revision = session.current;
    const controller = new AbortController(); listController.current = controller;
    try {
      const data = await apiClient.request(`/studio/results/recent${before ? `?before=${before}` : ''}`, { signal: controller.signal });
      if (revision !== session.current || owner.current !== currentStorageScope()) return;
      setItems(previous => before ? mergeRecentResults(previous, data.items) : data.items);
      setCursor(data.next_cursor); setRetention(Math.ceil(data.retention_seconds / 60));
    } catch {
      if (!controller.signal.aborted && revision === session.current) setError(label('loadFailed'));
    } finally {
      if (revision === session.current) { fetching.current = false; setLoading(false); }
    }
  };
  loadRef.current = load;
  // 有限页连续加载；请求失败停止自动翻页，避免网络错误时循环请求。
  useEffect(() => {
    if (!open || !cursor || loading || busy || error || previewId || !sentinel.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadRef.current(cursor);
    }, { rootMargin: '160px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [open, cursor, loading, busy, error, filter, previewId]);
  const available = items.filter(row => row.available);
  const visible = filter === 'available' ? available : items;
  const chosen = available.filter(row => selected.has(row.task_id));
  const received = new Set(generatedItems.map(item => item.studioResultId));
  const previewIndex = available.findIndex(row => row.task_id === previewId);
  const preview = available[previewIndex];
  const toggleRows = rows => {
    const ids = rows.filter(row => row.available).map(row => row.task_id);
    setSelected(previous => {
      const next = new Set(previous), remove = ids.every(id => previous.has(id));
      ids.forEach(id => remove ? next.delete(id) : next.add(id)); return next;
    });
  };
  const forget = ids => setSelected(previous => new Set([...previous].filter(id => !ids.includes(id))));
  const selectAllRecent = async (groupId = null) => {
    if (operation.current || fetching.current) return;
    const controller = new AbortController(); operation.current = controller;
    const revision = session.current;
    const current = () => !controller.signal.aborted && revision === session.current && owner.current === currentStorageScope();
    setBusy(true); setError(''); setProgress(label('collecting'));
    let collected = items, next = cursor;
    try {
      // 整批/全部选择只补齐分页元数据，不下载未浏览图片的原图。
      while (next && current()) {
        const data = await apiClient.request(`/studio/results/recent?before=${next}`, { signal: controller.signal });
        if (!current()) return;
        collected = mergeRecentResults(collected, data.items); next = data.next_cursor;
      }
      if (!current()) return;
      setItems(collected); setCursor(next);
      const ids = collected.filter(row => row.available && (!groupId || (row.group_id || row.submission_id) === groupId)).map(row => row.task_id);
      setSelected(previous => new Set([...previous, ...ids]));
    } catch { if (current()) setError(label('loadFailed')); }
    finally {
      if (operation.current === controller) { operation.current = null; setBusy(false); setProgress(''); }
    }
  };
  const run = async (rows, mode) => {
    if (operation.current || !rows.length) return;
    const controller = new AbortController(); operation.current = controller;
    const revision = session.current;
    const isCurrent = () => !controller.signal.aborted && revision === session.current && owner.current === currentStorageScope();
    setBusy(true); setError(''); setNotice(''); setProgress(text('progress', { done: 0, total: rows.length }));
    const zip = mode === 'download' ? new JSZip() : null;
    try {
      const result = await processRecentResults({ rows, isCurrent,
        maxBytes: zip ? 32 * 1024 * 1024 : Infinity,
        read: async row => {
          const data = await apiClient.request(`/studio/tasks/${row.submission_id}/results/${row.task_id}`,
            { responseType: 'image', headers: { Accept: 'image/*' }, signal: controller.signal });
          return data.images[0];
        },
        accept: async (row, image) => {
          if (zip) {
            const extension = image.blob.type.includes('webp') ? 'webp' : image.blob.type.includes('jpeg') ? 'jpg' : 'png';
            const data = await image.blob.arrayBuffer();
            if (isCurrent()) zip.file(`IdleCloud-${row.task_id}-${row.seed ?? 0}.${extension}`, data);
          } else {
            const url = createObjectUrlFromBlob(image.blob);
            if (!url) throw new Error('image unavailable');
            try {
              const accepted = onReceive({ id: `studio-result-${row.task_id}`, studioResultId: row.task_id,
                src: url, originalSrc: url, downloadSrc: url, cachedBlob: image.blob, objectUrlToRevoke: url,
                seed: image.seed ?? row.seed, width: row.width, height: row.height,
                prompt: row.prompt, model: row.model, isComposited: false });
              if (!accepted) throw new Error('image not accepted');
              forget([row.task_id]);
            } catch (failure) { revokeObjectUrl(url); throw failure; }
          }
        }, onProgress: (done, total) => { if (isCurrent()) setProgress(text('progress', { done, total })); },
      });
      if (!isCurrent()) return;
      const expired = result.failed.filter(item => item.status === 410).map(item => item.id);
      setItems(previous => previous.map(row => expired.includes(row.task_id) ? { ...row, available: false } : row));
      if (result.failed.length) setError(text('partialFailed', { count: result.failed.length }));
      if (zip && result.completed.length) {
        // PNG/WebP 已压缩，不再次压缩；每次仅保留一份有界下载包。
        const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
        if (isCurrent()) setArchive({ blob, ids: result.completed, owner: owner.current });
      } else if (result.completed.length) setNotice(text('added', { count: result.completed.length }));
    } catch {
      if (isCurrent()) setError(label('receiveFailed'));
    } finally {
      if (operation.current === controller) { operation.current = null; setBusy(false); setProgress(''); }
    }
  };
  const download = () => {
    if (!archive || archive.owner !== currentStorageScope()) return;
    saveAs(archive.blob, `IdleCloud-${Date.now()}.zip`);
    forget(archive.ids); setArchive(null); setNotice(label('downloadStarted'));
  };
  const start = () => {
    owner.current = currentStorageScope(); setOpen(true); setItems([]); setCursor(null);
    setSelected(new Set()); setNotice(''); setFilter('available'); load();
  };
  return <>
    <Button size="small" startIcon={<History fontSize="small" />} sx={{ textTransform: 'none', whiteSpace: 'nowrap' }} onClick={start}>{label('title')}</Button>
    <Dialog open={open} onClose={close} maxWidth="md" fullWidth PaperProps={{ sx: { borderRadius: 2, height: '85vh' } }}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, borderBottom: 1, borderColor: 'divider' }}>
        <History color="primary" /><Typography component="span" variant="h6" sx={{ flex: 1 }}>{label('title')}</Typography>
        <IconButton size="small" disabled={busy || loading || !!archive} onClick={() => { setSelected(new Set()); load(); }} aria-label={label('refresh')}><Refresh /></IconButton>
        <IconButton size="small" onClick={close} aria-label={label('close')}><Close /></IconButton>
      </DialogTitle>
      <Box sx={{ px: 3, py: 1, borderBottom: 1, borderColor: 'divider' }}>
        <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_, value) => { if (value) setFilter(value); }}>
          <ToggleButton value="available">{label('availableOnly')}</ToggleButton><ToggleButton value="all">{label('allTasks')}</ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>{text('browseHelp', { minutes: retention })}</Typography>
      </Box>
      <DialogContent sx={{ pt: 2 }}>
        {!loading && !error && !visible.length && !cursor && <Typography color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>{label('empty')}</Typography>}
        {groupRecentResults(visible).map(([id, rows]) => {
          const selectable = rows.filter(row => row.available);
          const checked = selectable.length > 0 && selectable.every(row => selected.has(row.task_id));
          return <Box key={id} sx={{ mb: 2.5 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.75 }}>
              <Typography variant="caption" color="text.secondary">{formatDate(rows[0].created_at, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · {text('count', { count: rows.length })}</Typography>
              {!!selectable.length && <Button size="small" disabled={busy || loading || !!archive} onClick={() => checked ? toggleRows(rows) : selectAllRecent(id)}>{label(checked ? 'unselectBatch' : 'selectBatch')}</Button>}
            </Stack>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' }, gap: 1 }}>
              {rows.map(row => <Box key={row.task_id} sx={{ position: 'relative', overflow: 'hidden', border: 1,
                borderColor: selected.has(row.task_id) ? 'primary.main' : 'divider', borderRadius: 1.5 }}>
                {open && <ResultPreview row={row} disabled={!row.available} onClick={() => setPreviewId(row.task_id)} label={label} />}
                {row.available && <Checkbox checked={selected.has(row.task_id)} disabled={busy || !!archive}
                  onChange={() => toggleRows([row])} inputProps={{ 'aria-label': text('selectImage', { id: row.task_id }) }}
                  sx={{ position: 'absolute', top: 2, right: 2, p: 0.5, bgcolor: 'background.paper', borderRadius: 1 }} />}
                <Box sx={{ p: 0.75 }}>
                  <Typography variant="caption" noWrap display="block">{row.prompt || label('untitled')}</Typography>
                  <Typography variant="caption" color="text.secondary" display="block">{row.available ? row.expires_at
                    ? text('remaining', { minutes: Math.max(0, Math.ceil((Date.parse(row.expires_at) - now) / 60000)) }) : label('available')
                    : label(row.status === 'success' ? 'expired' : row.status)}</Typography>
                  {received.has(row.task_id) && <Typography variant="caption" color="primary">{label('received')}</Typography>}
                </Box>
              </Box>)}
            </Box>
          </Box>;
        })}
        <Box ref={sentinel} sx={{ display: 'flex', justifyContent: 'center', py: 1, minHeight: 32 }}>
          {loading ? <CircularProgress size={22} /> : cursor ? <Button disabled={busy} onClick={() => load(cursor)}>{label(error ? 'retry' : 'more')}</Button> : null}
        </Box>
      </DialogContent>
      <Box sx={{ px: 2, py: 1, borderTop: 1, borderColor: 'divider' }}>
        {error && <Alert severity="warning" sx={{ mb: 1 }}>{error}</Alert>}
        {notice && <Typography variant="caption" color="primary" display="block">{notice}</Typography>}
        {busy ? <Stack direction="row" alignItems="center" spacing={1}><CircularProgress size={18} /><Typography variant="body2" sx={{ flex: 1 }}>{progress}</Typography><Button onClick={cancel}>{label('stop')}</Button></Stack>
          : archive ? <Stack spacing={1}>
            <Typography variant="body2">{text('archiveReady', { count: archive.ids.length })}</Typography>
            <Stack direction="row" spacing={1}><Button variant="contained" startIcon={<Download />} onClick={download}>{label('saveZip')}</Button><Button onClick={() => setArchive(null)}>{label('discardZip')}</Button></Stack>
          </Stack> : <>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Chip size="small" variant="outlined" label={text('selected', { count: chosen.length })} />
              <Button size="small" onClick={() => selectAllRecent()} disabled={loading || (!available.length && !cursor)}>{label('selectAll')}</Button>
              {!!selected.size && <Button size="small" onClick={() => setSelected(new Set())}>{label('clearSelection')}</Button>}
            </Stack>
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              <Button size="small" variant="contained" disabled={!chosen.length} onClick={() => run(chosen, 'download')}>{label('downloadSelected')}</Button>
              <Button size="small" disabled={!chosen.some(row => !received.has(row.task_id))}
                onClick={() => run(chosen.filter(row => !received.has(row.task_id)), 'gallery')}>{label('addSelected')}</Button>
            </Stack>
          </>}
      </Box>
    </Dialog>
    <Dialog open={open && !!preview} onClose={() => setPreviewId(null)} maxWidth="md" fullWidth>
      {preview && <>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography component="span" sx={{ flex: 1 }}>{previewIndex + 1} / {available.length}</Typography>
          <IconButton aria-label={label('closePreview')} onClick={() => setPreviewId(null)}><Close /></IconButton>
        </DialogTitle>
        <DialogContent sx={{ p: 1 }}><ResultPreview key={preview.task_id} row={preview} label={label} full /></DialogContent>
        <DialogActions sx={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <IconButton aria-label={label('previous')} disabled={previewIndex <= 0} onClick={() => setPreviewId(available[previewIndex - 1].task_id)}><ChevronLeft /></IconButton>
          <Button disabled={busy || !!archive} onClick={() => toggleRows([preview])}>{label(selected.has(preview.task_id) ? 'unselect' : 'select')}</Button>
          <Button disabled={busy || received.has(preview.task_id)} onClick={() => run([preview], 'gallery')}>{label(received.has(preview.task_id) ? 'received' : 'receive')}</Button>
          <IconButton aria-label={label('next')} disabled={previewIndex >= available.length - 1} onClick={() => setPreviewId(available[previewIndex + 1].task_id)}><ChevronRight /></IconButton>
        </DialogActions>
      </>}
    </Dialog>
  </>;
}
