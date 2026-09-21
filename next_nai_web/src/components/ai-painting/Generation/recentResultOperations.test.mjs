import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { processRecentResults, mergeRecentResults, groupRecentResults } from './recentResultOperations.mjs';

const rows = [1, 2, 3].map(task_id => ({ task_id, submission_id: task_id === 3 ? 8 : 7 }));
test('取消后的迟到结果不安装，也不再读取后续原图', async () => {
  let current = true;
  const fetched = [], accepted = [];
  const result = await processRecentResults({ rows, isCurrent: () => current,
    read: async row => { fetched.push(row.task_id); current = false; return { blob: new Blob(['x']) }; },
    accept: async row => accepted.push(row.task_id) });
  assert.deepEqual(fetched, [1]); assert.deepEqual(accepted, []); assert.equal(result.cancelled, true);
});
test('个别过期不阻断整批，失败与成功分别保留', async () => {
  const result = await processRecentResults({ rows, isCurrent: () => true,
    read: async row => { if (row.task_id === 2) throw { status: 410 }; return { blob: new Blob(['x']) }; },
    accept: async () => {} });
  assert.deepEqual(result.completed, [1, 3]); assert.deepEqual(result.failed, [{ id: 2, status: 410 }]);
});
test('达到包大小后不预读剩余图片，下一次可继续处理', async () => {
  const fetched = [];
  const result = await processRecentResults({ rows, maxBytes: 2, isCurrent: () => true,
    read: async row => { fetched.push(row.task_id); return { blob: new Blob(['xx']) }; }, accept: async () => {} });
  assert.deepEqual(fetched, [1]); assert.deepEqual(result.completed, [1]);
});
test('翻页合并去重并保持批次顺序', () => {
  const merged = mergeRecentResults(rows.slice(0, 2), [{ ...rows[1], available: false }, rows[2]]);
  assert.equal(merged.length, 3); assert.equal(merged[1].available, false);
  assert.deepEqual(groupRecentResults(merged).map(([id, items]) => [id, items.length]), [[7, 2], [8, 1]]);
});
test('同一计划的不同提交合并为用户可选择的一批', () => {
  const grouped = groupRecentResults(rows.map(row => ({ ...row, group_id: 'plan-1' })));
  assert.equal(grouped.length, 1); assert.equal(grouped[0][1].length, 3);
});
test('批量包包含每张原始内容，失败图片不会生成空条目', async () => {
  const zip = new JSZip();
  const result = await processRecentResults({ rows, isCurrent: () => true,
    read: async row => {
      if (row.task_id === 2) throw { status: 410 };
      return { blob: new Blob([`original-${row.task_id}`]) };
    }, accept: async (row, image) => zip.file(`${row.task_id}.png`, await image.blob.arrayBuffer()) });
  const restored = await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array', compression: 'STORE' }));
  assert.deepEqual(Object.keys(restored.files), ['1.png', '3.png']);
  assert.equal(await restored.file('3.png').async('string'), 'original-3');
  assert.equal(result.failed.length, 1);
});
