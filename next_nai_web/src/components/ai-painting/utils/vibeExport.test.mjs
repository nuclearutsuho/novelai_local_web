import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { buildVibeBundle, buildVibeZipEntries } from './vibeExport.mjs';

test('同名、跨模型与路径字符的 Vibe 导出后逐条完整保留', async () => {
  const vibes = ['v4full', 'v4curated', 'v4full', 'v45full'].map((model, index) => ({
    identifier: 'novelai-vibe-transfer', version: 1, id: index < 2 ? 'same-hash' : `hash-${index}`,
    name: index === 3 ? '../same/name' : 'same', image: `original-${index}`,
    importInfo: { information_extracted: 0.7 }, encodings: { [model]: { data: `encoding-${index}` } }
  }));
  const zip = new JSZip();
  const entries = buildVibeZipEntries(vibes);
  for (const entry of entries) {
    assert.doesNotMatch(entry.filename, /[/\\]/);
    zip.file(entry.filename, entry.content);
  }
  const restored = await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }));
  assert.equal(Object.keys(restored.files).length, vibes.length);
  for (const [index, entry] of entries.entries()) {
    assert.deepEqual(JSON.parse(await restored.file(entry.filename).async('string')), vibes[index]);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(buildVibeBundle(vibes))).vibes, vibes);
});

test('缺失缓存不能静默导出不完整的 bundle', () => {
  assert.throws(() => buildVibeBundle([{ id: 'present' }, undefined]), { code: 'VIBE_DATA_NOT_FOUND' });
});
