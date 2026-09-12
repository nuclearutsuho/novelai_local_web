// 以最终图片内容生成稳定键，断线重试仍指向同一次保存，不重复创建图库记录。
export async function saveStudioImage({ blob, request, scope, storage = null, onStatus = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const owner = scope();
  const checkOwner = () => {
    if (!/^studio:[1-9][0-9]*:$/.test(owner) || scope() !== owner) throw new Error('STUDIO_IDENTITY_CHANGED');
  };
  checkOwner();
  const hash = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
  checkOwner();
  onStatus('uploading');
  const storageKey = `studio-library-key:${hash}`;
  let key = storage?.getItem(storageKey) || `idlecloud-save-${hash}`;
  if (!/^idlecloud-save-[a-f0-9]{64}$/.test(key)) throw new Error('STUDIO_MEDIA_INVALID_KEY');
  let saved;
  for (let recovery = 0; recovery < 4; recovery += 1) {
    checkOwner();
    try {
      saved = await request('/studio/media', { method: 'POST', body: blob,
        headers: { 'Idempotency-Key': key } });
      break;
    } catch (error) {
      checkOwner();
      // 只有服务器明确确认旧媒体已删除才换键；断网、超时和容量不足沿用原键。
      if (error.code !== 'idempotent_target_gone' || error.status !== 410) throw error;
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${key}:restore`));
      checkOwner();
      key = `idlecloud-save-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      // 确定性后继键让两个标签同时恢复仍复用同一次保存；先记键再发送，断线可恢复。
      storage?.setItem(storageKey, key);
    }
  }
  if (!saved) throw new Error('STUDIO_MEDIA_RETRY');
  checkOwner();
  let state = saved;
  for (let attempt = 0; attempt <= 60; attempt += 1) {
    checkOwner();
    if (state.status === 'ready') { onStatus('ready'); return state; }
    if (state.status === 'failed') throw new Error('STUDIO_MEDIA_FAILED');
    if (state.status !== 'processing' || !Number.isSafeInteger(state.media_id) || state.media_id <= 0) {
      throw new Error('STUDIO_MEDIA_INVALID_RESPONSE');
    }
    onStatus('processing');
    if (attempt === 60) break;
    await sleep(1500);
    checkOwner();
    state = await request(`/studio/media/${state.media_id}`);
  }
  throw new Error('STUDIO_MEDIA_PENDING');
}
