import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationFailure, createGenerationError, normalizeGenerationErrorCode, GENERATION_ERROR_MESSAGE_KEYS } from './errors.js';

test('恢复中断和本地阻塞经过单张错误包装后仍保留具体原因', () => {
  for (const code of ['STUDIO_TASK_PENDING', 'STUDIO_RESULT_DOWNLOAD_FAILED', 'STUDIO_RECORD_WRITE_FAILED', 'STUDIO_STATUS_UNAVAILABLE', 'STUDIO_WAIT_TIMEOUT']) {
    const result = createGenerationFailure(normalizeGenerationErrorCode({ code }));
    const error = createGenerationError(normalizeGenerationErrorCode(result));
    assert.equal(error.code, code);
    assert.notEqual(GENERATION_ERROR_MESSAGE_KEYS[code], GENERATION_ERROR_MESSAGE_KEYS.GENERATION_FAILED);
    assert.ok(GENERATION_ERROR_MESSAGE_KEYS[code]);
  }
});
