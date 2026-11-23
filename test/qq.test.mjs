import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, parseTarget } from '../lib/qq.js';

test('parseTarget 接受 c2c / group', () => {
  assert.deepEqual(parseTarget('c2c:A0ADA1F8'), { scope: 'c2c', targetId: 'A0ADA1F8' });
  assert.deepEqual(parseTarget('group:G1'), { scope: 'group', targetId: 'G1' });
});

test('parseTarget 拒绝非法输入', () => {
  assert.equal(parseTarget('c2c:'), undefined);
  assert.equal(parseTarget('im:x'), undefined);
  assert.equal(parseTarget('nocolon'), undefined);
  assert.equal(parseTarget(undefined), undefined);
  assert.equal(parseTarget(''), undefined);
});

test('限流：超限拒绝，窗口过去后恢复', () => {
  let now = 1_000_000;
  const limited = createRateLimiter(2, () => now);
  assert.equal(limited('t1'), false);
  assert.equal(limited('t1'), false);
  assert.equal(limited('t1'), true, '第三条应被拒');
  assert.equal(limited('t2'), false, '另一个收件人不受影响');
  now += 60_001;
  assert.equal(limited('t1'), false, '窗口过后恢复');
});

test('limit 为 0 表示不限流', () => {
  const limited = createRateLimiter(0);
  for (let index = 0; index < 100; index += 1) assert.equal(limited('t'), false);
});
