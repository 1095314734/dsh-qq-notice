import test from 'node:test';
import assert from 'node:assert/strict';
import { createThrottle } from '../lib/throttle.js';

test('没作答记录时一律放行（首次审批不会被吞）', () => {
  const throttle = createThrottle(20_000);
  assert.equal(throttle.allow('s1'), true);
  assert.equal(throttle.allow('s1'), true);
  assert.equal(throttle.takeSuppressed('s1'), 0);
});

test('作答后窗口内不再放行，窗口结束恢复', () => {
  let now = 1_000_000;
  const throttle = createThrottle(20_000, () => now);
  throttle.decided('s1');
  now += 1_000;
  assert.equal(throttle.allow('s1'), false);
  now += 18_999; // 累计 19_999，仍在窗口内
  assert.equal(throttle.allow('s1'), false);
  now += 1; // 累计 20_000，窗口结束
  assert.equal(throttle.allow('s1'), true);
});

test('每次作答都重新计时', () => {
  let now = 1_000_000;
  const throttle = createThrottle(20_000, () => now);
  throttle.decided('s1');
  now += 15_000;
  throttle.decided('s1'); // 又点了一次：窗口从这一刻重新算
  now += 6_000; // 距上次作答只有 6 秒，虽然距上上次已 21 秒
  assert.equal(throttle.allow('s1'), false);
  now += 14_000; // 距上次作答 20 秒
  assert.equal(throttle.allow('s1'), true);
});

test('不同会话互不影响', () => {
  let now = 1_000_000;
  const throttle = createThrottle(20_000, () => now);
  throttle.decided('s1');
  now += 500;
  assert.equal(throttle.allow('s1'), false);
  assert.equal(throttle.allow('s2'), true, '另一个会话没作答过，照推');
});

test('被合并的条数会被记录并能取走', () => {
  let now = 1_000_000;
  const throttle = createThrottle(20_000, () => now);
  throttle.decided('s1');
  now += 100;
  throttle.allow('s1');
  throttle.allow('s1');
  now += 100;
  throttle.allow('s1');
  assert.equal(throttle.takeSuppressed('s1'), 3);
  assert.equal(throttle.takeSuppressed('s1'), 0, '取过一次应清零');
  assert.equal(throttle.takeSuppressed('other'), 0);
});

test('间隔为 0 表示不节流', () => {
  const throttle = createThrottle(0);
  throttle.decided('s1');
  assert.equal(throttle.allow('s1'), true);
  assert.equal(throttle.allow('s1'), true);
  assert.equal(throttle.takeSuppressed('s1'), 0);
});

test('间隔可运行时变化（设置页改了立即生效）', () => {
  let now = 1_000_000;
  let interval = 20_000;
  const throttle = createThrottle(() => interval, () => now);
  throttle.decided('s1');
  now += 5_000;
  assert.equal(throttle.allow('s1'), false);
  interval = 1_000; // 改成 1 秒后，5 秒前的作答已经出窗口
  assert.equal(throttle.allow('s1'), true);
});

test('负间隔按不节流处理', () => {
  const throttle = createThrottle(-5);
  throttle.decided('s1');
  assert.equal(throttle.allow('s1'), true);
  assert.equal(throttle.allow('s1'), true);
});
