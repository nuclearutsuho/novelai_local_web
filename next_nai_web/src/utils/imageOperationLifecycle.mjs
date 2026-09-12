// 读取原图可能跨越退出或换号，不能随后以新身份提交旧图片。
export async function loadOwnedImageSource({ source, fetchSource, encodeBlob, checkOwner }) {
  checkOwner();
  const response = await fetchSource(source);
  checkOwner();
  if (!response.ok) throw Object.assign(new Error('MEDIA_ASSET_DOWNLOAD_FAILED'), { code: 'MEDIA_ASSET_DOWNLOAD_FAILED', statusCode: response.status });
  const blob = await response.blob();
  checkOwner();
  const encoded = await encodeBlob(blob);
  checkOwner();
  return encoded;
}

// 画廊拒收或写入失败时保留服务端恢复摘要，不提前确认领取。
export function publishGeneratedItem({ item, isCurrent, release, append, acknowledge }) {
  if (!isCurrent()) { release(item); return null; }
  try { append(item); }
  catch (error) { release(item); throw error; }
  acknowledge(item);
  return item;
}

export async function applyOwnedPreview({ item, apply, checkOwner, release, acknowledge }) {
  try {
    checkOwner();
    const applied = await apply(item, checkOwner);
    checkOwner();
    if (!applied) throw Object.assign(new Error('INPAINT_PREVIEW_LOAD_FAILED'), { code: 'INPAINT_PREVIEW_LOAD_FAILED' });
    acknowledge(item);
  } finally {
    // 预览只由画布持有解码后的图像；所有退出路径均释放本次临时 URL。
    release(item);
  }
}
