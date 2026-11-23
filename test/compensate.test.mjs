import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompensator } from '../lib/compensate.js';

/** 假计时器：手动触发，测“窗口从第一条开始算”这类时序 */
function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimer(fn, ms) {
      seq += 1;
      const handle = { id: seq, unref() {} };
      pending.set(seq, { fn, ms });
      return handle;
    },
    clearTimer(handle) {
      pending.delete(handle.id);
    },
    fireAll() {
      const snapshot = [...pending.values()];
      pending.clear();
      for (const entry of snapshot) entry.fn();
    },
    count() {
      return pending.size;
    },
    delays() {
      return [...pending.values()].map((entry) => entry.ms);
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('窗口内的多条失败合并成一封', async () => {
  const timers = fakeTimers();
  const batches = [];
  const compensator = createCompensator({
    getCoalesceMs: () => 3000,
    dispatch: async (records) => batches.push(records),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  compensator.add({ text: 'a' });
  compensator.add({ text: 'b' });
  compensator.add({ text: 'c' });
  assert.equal(compensator.size(), 3);
  assert.equal(batches.length, 0, '窗口没到不该发');

  timers.fireAll();
  await tick();

  assert.equal(batches.length, 1, '三条应该只触发一次派发');
  assert.deepEqual(batches[0].map((r) => r.text), ['a', 'b', 'c']);
  assert.equal(compensator.size(), 0, '派发后缓冲区应清空');
});

test('窗口从第一条开始算，不被后续失败推迟', () => {
  const timers = fakeTimers();
  const compensator = createCompensator({
    getCoalesceMs: () => 3000,
    dispatch: async () => {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  compensator.add({ text: 'a' });
  compensator.add({ text: 'b' });
  compensator.add({ text: 'c' });
  assert.equal(timers.count(), 1, '只该有一个计时器');
  assert.deepEqual(timers.delays(), [3000], '延迟不随新记录变长');
});

test('合并窗口为 0 时逐条立即派发', async () => {
  const batches = [];
  const compensator = createCompensator({
    getCoalesceMs: () => 0,
    dispatch: async (records) => batches.push(records),
  });

  compensator.add({ text: 'a' });
  compensator.add({ text: 'b' });
  await tick();

  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map((batch) => batch[0].text), ['a', 'b']);
});

test('flush 立即派发缓冲，不等计时器', async () => {
  const timers = fakeTimers();
  const batches = [];
  const compensator = createCompensator({
    getCoalesceMs: () => 3000,
    dispatch: async (records) => batches.push(records),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  compensator.add({ text: 'a' });
  compensator.flush();
  await tick();

  assert.equal(batches.length, 1);
  assert.equal(timers.count(), 0, 'flush 应清掉计时器');
  compensator.flush(); // 空缓冲：再 flush 不应重复派发
  await tick();
  assert.equal(batches.length, 1);
});

test('dispatch 同步/异步抛错都不会炸掉后续补发', async () => {
  const timers = fakeTimers();
  let calls = 0;
  const compensator = createCompensator({
    getCoalesceMs: () => 10,
    dispatch: () => {
      calls += 1;
      if (calls === 1) throw new Error('sync boom');
      return Promise.reject(new Error('async boom'));
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  compensator.add({ text: 'a' });
  assert.doesNotThrow(() => timers.fireAll());
  await tick();
  compensator.add({ text: 'b' });
  timers.fireAll();
  await tick();
  assert.equal(calls, 2);
});

test('窗口长度随设置实时变化', () => {
  const timers = fakeTimers();
  let ms = 3000;
  const compensator = createCompensator({
    getCoalesceMs: () => ms,
    dispatch: async () => {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  compensator.add({ text: 'a' });
  ms = 500;
  compensator.add({ text: 'b' });
  assert.deepEqual(timers.delays(), [3000], '已开的窗口不受新设置影响');
  timers.fireAll();
  compensator.add({ text: 'c' });
  assert.deepEqual(timers.delays(), [500], '下一条用新设置');
});
