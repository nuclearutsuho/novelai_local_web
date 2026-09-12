import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreVibePanel } from './vibePanelRecovery.mjs';

test('重新进入只将持久化转换中标记为中断，保留参数并区分恢复方式', () => {
  const item = { id: 'a', image: 'original', status: 'converting', informationExtracted: 0.3, encodingInfo: null };
  for (const studio of [true, false]) {
    const restored = restoreVibePanel([item], studio)[0];
    assert.equal(restored.status, 'interrupted');
    assert.equal(restored.recoveryMode, studio ? 'studio' : 'direct');
    assert.equal(restored.image, 'original');
    assert.equal(restored.informationExtracted, 0.3);
    assert.deepEqual(restored.encodingInfo, {});
  }
  assert.equal(item.status, 'converting');
  const done = { id: 'b', status: 'converted', encoding: 'saved', isTemporarilyDisabled: true };
  assert.deepEqual(restoreVibePanel([done], true), [done]);
});
