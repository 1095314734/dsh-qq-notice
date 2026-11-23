import test from 'node:test';
import assert from 'node:assert/strict';
import { createReminders } from '../lib/reminder.js';

/** 假计时器：不依赖真实时间，手动触发 */
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

test('超时没人处理就补一条提醒，且只补一次', () => {
  const timers = fakeTimers();
  const fired = [];
  const reminders = createReminders({
    getTimeoutMs: () => 60_000,
    onFire: (entry) => fired.push(entry),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  reminders.arm({ sessionId: 's1', toolName: 'bash' });
  assert.equal(reminders.size(), 1);
  assert.deepEqual(timers.delays(), [60_000]);

  timers.fireAll();
  assert.deepEqual(fired.map((entry) => entry.sessionId), ['s1']);
  assert.equal(reminders.size(), 0, '触发后自己摘掉');
});

test('决策落地后取消，不会提醒', () => {
  const timers = fakeTimers();
  const fired = [];
  const reminders = createReminders({
    getTimeoutMs: () => 60_000,
    onFire: (entry) => fired.push(entry),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  const disarm = reminders.arm({ sessionId: 's1' });
  disarm();
  assert.equal(reminders.size(), 0);
  timers.fireAll();
  assert.deepEqual(fired, []);
  disarm(); // 重复调用安全
});

test('提醒也覆盖被节流压掉的那条（调用方照样 arm）', () => {
  const timers = fakeTimers();
  const fired = [];
  const reminders = createReminders({
    getTimeoutMs: () => 60_000,
    onFire: (entry) => fired.push(entry),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  // 两条同时等：各自独立计时
  reminders.arm({ sessionId: 's1', toolName: 'bash' });
  reminders.arm({ sessionId: 's1', toolName: 'pwsh' });
  assert.equal(reminders.size(), 2);
  timers.fireAll();
  assert.deepEqual(fired.map((entry) => entry.toolName).sort(), ['bash', 'pwsh']);
});

test('超时设为 0 表示不提醒，返回空的取消函数', () => {
  const timers = fakeTimers();
  const fired = [];
  const reminders = createReminders({
    getTimeoutMs: () => 0,
    onFire: (entry) => fired.push(entry),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  const disarm = reminders.arm({ sessionId: 's1' });
  assert.equal(reminders.size(), 0);
  assert.equal(timers.count(), 0);
  disarm();
  assert.deepEqual(fired, []);
});

test('超时随设置实时变化', () => {
  const timers = fakeTimers();
  let timeout = 60_000;
  const reminders = createReminders({
    getTimeoutMs: () => timeout,
    onFire: () => {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  reminders.arm({ sessionId: 's1' });
  timeout = 15_000; // 设置页改成 15 秒
  reminders.arm({ sessionId: 's2' });
  assert.deepEqual(timers.delays(), [60_000, 15_000]);
});

test('onFire 抛异常不会炸到审批链', () => {
  const timers = fakeTimers();
  const reminders = createReminders({
    getTimeoutMs: () => 1_000,
    onFire: () => {
      throw new Error('boom');
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  reminders.arm({ sessionId: 's1' });
  assert.doesNotThrow(() => timers.fireAll());
  assert.equal(reminders.size(), 0);
});

test('clearAll 清空所有等待中的提醒（卸载用）', () => {
  const timers = fakeTimers();
  const fired = [];
  const reminders = createReminders({
    getTimeoutMs: () => 60_000,
    onFire: (entry) => fired.push(entry),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  reminders.arm({ sessionId: 's1' });
  reminders.arm({ sessionId: 's2' });
  reminders.clearAll();
  assert.equal(reminders.size(), 0);
  assert.equal(timers.count(), 0);
  timers.fireAll();
  assert.deepEqual(fired, []);
});
