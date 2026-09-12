"use client";
import { useEffect, useState } from 'react';
import { Alert, Box, Button } from '@mui/material';
import apiClient from '@/utils/ApiClient';
import { currentStorageScope } from '@/utils/userStorage.mjs';
import { useI18n } from '@/i18n/I18nProvider';

export default function StudioToolRecovery() {
  const { t } = useI18n();
  const [entries, setEntries] = useState([]);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const ended = ({ detail }) => {
      if (!detail || detail.owner !== currentStorageScope()) return;
      setEntries(previous => [...previous.filter(item => item.key !== detail.key && item.owner === detail.owner), detail]);
      setMessage('');
    };
    window.addEventListener('studio:tool-ended', ended);
    let active = true;
    const owner = currentStorageScope();
    // 新页面只查询现有请求，不重新编码，也不下载成功结果的大体积图片。
    Promise.all([apiClient.studioVibes, apiClient.studioUpscales, apiClient.studioDirectors]
      .map(runner => runner.refreshTerminals())).catch(() => {
        if (active && owner === currentStorageScope()) setMessage('checkFailed');
      });
    return () => { active = false; window.removeEventListener('studio:tool-ended', ended); };
  }, []);
  const clear = async (entry) => {
    setBusy(entry.key);
    setMessage('');
    try {
      const runner = { 'vibe-encode': apiClient.studioVibes, upscale: apiClient.studioUpscales, director: apiClient.studioDirectors }[entry.tool];
      if (!runner) return;
      await runner.forgetTerminal(entry);
      if (entry.owner !== currentStorageScope()) return;
      setEntries(previous => previous.filter(item => item.key !== entry.key));
      setMessage('cleared');
    } catch {
      if (entry.owner === currentStorageScope()) setMessage('checkFailed');
    } finally { setBusy(null); }
  };
  if (!apiClient.isStudio()) return null;
  const key = 'painting.workspace.toolRecovery.';
  return <Box sx={{ px: 1 }}>
    {entries.filter(entry => entry.owner === currentStorageScope()).map(entry => <Alert key={entry.key} severity="warning" sx={{ my: 1 }}>
      <div>{t(key + 'title', { tool: t(key + entry.tool), id: entry.id })}</div>
      <div>{t(key + (entry.status === 'failed_unknown' ? 'unknown' : entry.status === 'result_unavailable' ? 'unavailable' : 'ended'))}</div>
      <Button disabled={busy !== null} onClick={() => clear(entry)}>{t(key + 'clear')}</Button>
    </Alert>)}
    {message && <Alert severity={message === 'cleared' ? 'info' : 'warning'} onClose={() => setMessage('')}>{t(key + message)}</Alert>}
  </Box>;
}
