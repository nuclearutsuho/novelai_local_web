"use client";

import { useEffect, useRef, useState } from 'react';
import styles from '../transition.module.css';
import apiClient from '@/utils/ApiClient';
import { chooseConnection } from '@/utils/userStorage.mjs';

export default function StudioCallbackPage() {
  const started = useRef(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const values = new URLSearchParams(window.location.hash.slice(1));
    // 尽早清除片段；不将授权码写入浏览器存储、日志或后续导航。
    window.history.replaceState(null, '', '/studio/callback');
    apiClient.request('/studio/complete', { method: 'POST', body: {
      code: values.get('code'), state: values.get('state'),
    } }).then((result) => {
      chooseConnection('studio', result.user.id);
      window.location.replace('/main');
    })
      .catch(() => setError('连接未完成或授权已过期，请重新发起 Studio 登录。'));
  }, []);
  return <main className={styles.page}>
    {error ? <section className={styles.panel}>
      <p className={styles.error} role="alert">{error}</p>
      <a className={styles.back} href="/studio/start">重新连接</a>
    </section> : <p className={styles.loading} role="status">正在打开创作工作台…</p>}
  </main>;
}
