import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./BatchGenerationService.js', import.meta.url), 'utf8');
const serviceModule = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const { BatchGenerationController } = serviceModule;

test('默认计时器保持浏览器原生调用上下文，等待可正常取消', async (t) => {
  let scheduled = 0;
  let cleared = 0;
  t.mock.method(globalThis, 'setTimeout', function () {
    assert.ok(this === undefined || this === globalThis, '不能以 clock 对象调用原生计时器');
    scheduled++;
    return 7;
  });
  t.mock.method(globalThis, 'clearTimeout', function (timer) {
    assert.ok(this === undefined || this === globalThis);
    assert.equal(timer, 7);
    cleared++;
  });
  const controller = new BatchGenerationController({ now: () => 0 });
  controller.initialize(2);
  const waiting = controller.wait(15);
  controller.cancel();
  await waiting;
  assert.equal(scheduled, 1);
  assert.equal(cleared, 1);
});

const createFakeClock = () => {
  let currentTime = 0;
  let nextTimerId = 1;
  const timers = new Map();

  return {
    now: () => currentTime,
    setTimeout(callback, delay) {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, { callback, runAt: currentTime + delay });
      return timerId;
    },
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
    advanceBy(milliseconds) {
      const targetTime = currentTime + milliseconds;
      while (true) {
        const nextTimer = [...timers.entries()]
          .filter(([, timer]) => timer.runAt <= targetTime)
          .sort((left, right) => left[1].runAt - right[1].runAt)[0];
        if (!nextTimer) break;
        const [timerId, timer] = nextTimer;
        timers.delete(timerId);
        currentTime = timer.runAt;
        timer.callback();
      }
      currentTime = targetTime;
    },
    pendingCount: () => timers.size,
  };
};

test('部署版批次不再添加人为等待，16 张完成后正确结束', async () => {
  const clock = createFakeClock();
  const batch = new BatchGenerationController(clock);
  batch.initialize(16);
  await batch.wait(batch.config.bufferTime);
  assert.equal(clock.pendingCount(), 0);
  assert.equal(batch.getStatus().waitingTime, 0);
  for (let index = 0; index < 16; index += 1) batch.completeCurrentImage(true);
  assert.equal(batch.getStatus().completed, 16);
  assert.equal(batch.shouldContinue(), false);
});

test('首张错误立即停止且不会继续等待', () => {
  const clock = createFakeClock();
  const controller = new BatchGenerationController(clock);
  controller.initialize(8);
  controller.completeCurrentImage(false);
  assert.equal(controller.handleError({ code: 'TEST_FAILURE' }), 'stop');
  assert.equal(controller.getStatus().failed, 1);
  assert.equal(controller.getStatus().errors.length, 1);
  assert.equal(controller.shouldContinue(), false);
  assert.equal(clock.pendingCount(), 0);
});

test('卸载取消会立即打断等待且不再发送后续批次', async () => {
  const clock = createFakeClock();
  const controller = new BatchGenerationController(clock);
  controller.initialize(8);
  controller.completeCurrentImage(true);
  const pendingWait = controller.wait(1);
  assert.equal(clock.pendingCount(), 1);

  controller.cancel();
  await pendingWait;
  assert.equal(controller.shouldContinue(), false);
  assert.equal(controller.getStatus().waitingTime, 0);
  assert.equal(clock.pendingCount(), 0);

  clock.advanceBy(1_000);
  assert.equal(clock.pendingCount(), 0);
});
