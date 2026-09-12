"use client";

import { useEffect, useRef, useState } from 'react';
import apiClient from '@/utils/ApiClient';
import { chooseConnection } from '@/utils/userStorage.mjs';
import styles from '../transition.module.css';

export default function StudioStartPage() {
  const operation = useRef(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    if (!operation.current) {
      const channel = new URLSearchParams(window.location.hash.slice(1)).get('bridge');
      const parent = window.opener;
      window.history.replaceState(null, '', '/studio/start');
      operation.current = (async () => {
        const result = await apiClient.request('/studio/start', { method: 'POST', body: {} });
        // 独立登录保留原有导航协议；从 Studio 打开的窗口全程留在 Idlecloud。
        if (!channel || !parent) {
          if (channel) throw new Error('Studio 窗口连接已中断，请从 Studio 重新打开。');
          return result.authorize_url;
        }
        const authorize = new URL(result.authorize_url);
        const state = authorize.searchParams.get('state');
        const code = await new Promise((resolve, reject) => {
          const cleanup = () => { window.removeEventListener('message', receive); window.clearTimeout(timer); };
          const receive = event => {
            const data = event.data;
            // 来源以本机后端配置为准，并同时核对窗口、随机通道和本次 state。
            if (event.source !== parent || event.origin !== authorize.origin || data?.type !== 'idlecloud:authorized'
              || data.channel !== channel || data.state !== state) return;
            cleanup();
            if (data.error || !/^[A-Za-z0-9_-]{43}$/.test(data.code || '')) reject(new Error('Studio 登录已变化，请重新打开。'));
            else resolve(data.code);
          };
          const timer = window.setTimeout(() => { cleanup(); reject(new Error('Studio 连接超时，请从 Studio 重新打开。')); }, 20000);
          window.addEventListener('message', receive);
          parent.postMessage({ type: 'idlecloud:authorize', channel, state,
            challenge: authorize.searchParams.get('code_challenge'), redirect: authorize.searchParams.get('redirect_uri'),
          }, authorize.origin);
        });
        const session = await apiClient.request('/studio/complete', { method: 'POST', body: { code, state } });
        chooseConnection('studio', session.user.id);
        // 完成交接后断开 opener，不保留长期窗口控制关系。
        window.opener = null;
        return '/main';
      })();
    }
    operation.current.then(destination => {
      if (active) window.location.replace(destination);
    }).catch(failure => { if (active) setError(failure.message || '暂时无法连接 Studio，请重新打开。'); });
    return () => { active = false; };
  }, []);
  return <main className={styles.page}>
    {error ? <section className={styles.panel}>
      <p className={styles.error} role="alert">{error}</p>
      <a className={styles.back} href="/login">使用登录页重试</a>
    </section> : <p className={styles.loading} role="status">正在打开创作工作台…</p>}
  </main>;
}
