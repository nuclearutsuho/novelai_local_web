// 导出只改变容器和文件名，不改动原版 Vibe 的图像、编码或模型信息。
export function buildVibeBundle(vibes) {
  if (!Array.isArray(vibes) || vibes.some(vibe => !vibe)) {
    throw Object.assign(new Error('VIBE_DATA_NOT_FOUND'), { code: 'VIBE_DATA_NOT_FOUND' });
  }
  return { identifier: 'novelai-vibe-transfer-bundle', version: 1, vibes };
}

export function buildVibeZipEntries(vibes) {
  buildVibeBundle(vibes);
  const counts = new Map();
  for (const vibe of vibes) counts.set(vibe.id, (counts.get(vibe.id) || 0) + 1);
  const used = new Set();
  return vibes.map(vibe => {
    const base = String(vibe.name || vibe.id || 'vibe').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
    const information = vibe.importInfo?.information_extracted;
    const suffix = counts.get(vibe.id) > 1 ? `_ie${typeof information === 'number' ? information.toFixed(1) : 'unknown'}` : '';
    const stem = base + suffix;
    let filename = `${stem}.naiv4vibe`;
    let index = 2;
    // ZIP 使用文件名作为键，同名记录必须另起文件，避免覆盖另一张图或另一模型编码。
    while (used.has(filename.toLowerCase())) filename = `${stem} (${index++}).naiv4vibe`;
    used.add(filename.toLowerCase());
    return { filename, content: JSON.stringify(vibe, null, 2) };
  });
}
