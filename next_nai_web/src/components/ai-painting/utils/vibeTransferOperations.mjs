import { buildVibeZipEntries } from './vibeExport.mjs';

const informationOf = (data, entry) => entry?.params?.information_extracted ?? data.importInfo?.information_extracted ?? 0.7;

export function selectVibeEncoding(data, modelType, information) {
  const entries = Object.values(data?.encodings?.[modelType] || {}).filter(entry => typeof entry?.encoding === 'string');
  // 指定提取值时不能回退到第一份；旧缓存可能只为一份编码建立了索引。
  if (information !== undefined) return entries.find(entry => informationOf(data, entry) === information) || null;
  return entries.find(entry => informationOf(data, entry) === data?.importInfo?.information_extracted) || entries[0] || null;
}

// 每个模型写入前后都校验，不能在换号后把导入文件余下的编码写进新用户缓存。
export async function cacheImportedVibe({ data, hash, models, modelType, write, checkOwner }) {
  checkOwner();
  for (const modelKey of Object.keys(data.encodings || {})) {
    const model = models.find(option => modelType(option.value) === modelKey)?.value;
    if (!model) continue;
    const indexed = new Set();
    for (const encoding of Object.values(data.encodings[modelKey] || {})) {
      if (typeof encoding?.encoding !== 'string') continue;
      const information = informationOf(data, encoding);
      if (indexed.has(information)) continue;
      indexed.add(information);
      checkOwner();
      await write(data, hash, model, information);
      checkOwner();
    }
  }
}

export async function downloadVibeZip({ readAll, createZip, save, checkOwner }) {
  checkOwner();
  const vibes = await readAll();
  checkOwner();
  if (!vibes?.length) return false;
  const zip = createZip();
  for (const entry of buildVibeZipEntries(vibes)) zip.file(entry.filename, entry.content);
  const content = await zip.generateAsync({ type: 'blob' });
  // 压缩可能很慢；此时原页面已卸载或用户已切换，就不再下载私有文件。
  checkOwner();
  save(content, 'vibes_database.zip');
  return true;
}
