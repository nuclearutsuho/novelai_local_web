// 顺序读取原图，限制下载峰值；取消或换号后不再安装图片，也不继续请求。
export async function processRecentResults({ rows, read, accept, isCurrent, onProgress,
  maxBytes = Infinity }) {
  const completed = [];
  const failed = [];
  let bytes = 0;
  for (const row of rows) {
    if (!isCurrent() || bytes >= maxBytes) break;
    try {
      const image = await read(row);
      if (!isCurrent()) break;
      await accept(row, image);
      if (!isCurrent()) break;
      bytes += image.blob.size;
      completed.push(row.task_id);
    } catch (error) {
      if (!isCurrent()) break;
      failed.push({ id: row.task_id, status: error.status });
    }
    onProgress?.(completed.length + failed.length, rows.length);
  }
  return { completed, failed, bytes, cancelled: !isCurrent() };
}

export function mergeRecentResults(previous, incoming) {
  const rows = new Map(previous.map(row => [row.task_id, row]));
  for (const row of incoming) rows.set(row.task_id, row);
  return [...rows.values()];
}

export function groupRecentResults(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.group_id || row.submission_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()];
}
