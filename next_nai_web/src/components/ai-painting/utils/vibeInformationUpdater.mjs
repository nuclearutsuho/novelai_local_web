import { selectVibeEncoding } from './vibeTransferOperations.mjs';

export function applyVibeEncodingResult(items, request, changes) {
  return items.map(item => item.id === request.id && item.informationExtracted === request.informationExtracted
    ? { ...item, ...changes } : item);
}

// 查询归属于条目 ID、模型和最后一次选择，不能用旧数组覆盖整个面板。
export function createVibeInformationUpdater({ readCache, modelType, getModel, isOwner, updateItems }) {
  const latest = new Map();
  return {
    forget(id) { latest.delete(id); },
    async change(vibe, model, value) {
      if (!vibe || !isOwner() || vibe.isReadOnly) return;
      const ticket = Symbol();
      latest.set(vibe.id, ticket);
      const current = () => isOwner() && getModel() === model && latest.get(vibe.id) === ticket;
      const update = changes => updateItems(items => current()
        ? items.map(item => item.id === vibe.id ? { ...item, ...changes } : item) : items);
      // 等待新编码时立即停用旧编码，避免用户在查询期间提交不匹配的参数。
      update({ informationExtracted: value, ...(vibe.isV4Vibe
        ? { encoding: null, encodingInfo: {}, status: 'unconverted' } : {}) });
      if (!vibe.isV4Vibe) return;
      let cached;
      try { cached = await readCache(vibe.hash, model, value); }
      catch (error) { if (current()) throw error; return; }
      if (!current()) return;
      const encoding = selectVibeEncoding(cached, modelType(model), value);
      if (encoding) update({ encoding: encoding.encoding, status: 'converted', encodingInfo: { name: cached.name } });
    },
  };
}
