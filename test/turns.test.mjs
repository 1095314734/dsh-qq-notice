import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnTracker } from '../lib/turns.js';

const event = (type, data, time) => ({ type, data, time, seq: 0 });

test('完整一轮：耗时 / 工具次数 / 最后输出', () => {
  const tracker = createTurnTracker();
  assert.equal(tracker.onEvent('s1', event('turn/start', { turn: 1 }, 1_000)), undefined);
  tracker.onEvent('s1', event('tool/call', { turn: 1, callId: 'c1' }, 1_100));
  tracker.onEvent('s1', event('tool/call', { turn: 1, callId: 'c2' }, 1_200));
  tracker.onEvent('s1', event('assistant/message', {
    turn: 1,
    step: 1,
    message: { content: [{ type: 'text', text: '做完啦' }] },
  }, 1_300));

  const payload = tracker.onEvent('s1', event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 15_420));
  assert.equal(payload.durationMs, 14_420);
  assert.equal(payload.toolCalls, 2);
  assert.equal(payload.lastOutput, '做完啦');
  assert.equal(payload.reasonKind, 'completed');
  assert.equal(tracker.size(), 0, '结束后不应残留状态');
});

test('中途加载（没看到 turn/start）只给结束事实，不猜耗时', () => {
  const tracker = createTurnTracker();
  const payload = tracker.onEvent('s1', event('turn/end', { turn: 7, reason: { kind: 'aborted' } }, 5_000));
  assert.equal(payload.reasonKind, 'aborted');
  assert.equal(payload.durationMs, undefined);
  assert.equal(payload.toolCalls, 0);
  assert.equal(payload.lastOutput, '');
});

test('上一轮的工具调用不会算进下一轮', () => {
  const tracker = createTurnTracker();
  tracker.onEvent('s1', event('turn/start', { turn: 1 }, 0));
  tracker.onEvent('s1', event('tool/call', { turn: 1 }, 10));
  const first = tracker.onEvent('s1', event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 20));
  assert.equal(first.toolCalls, 1);

  tracker.onEvent('s1', event('turn/start', { turn: 2 }, 30));
  const second = tracker.onEvent('s1', event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 40));
  assert.equal(second.toolCalls, 0);
});

test('多个会话互不干扰', () => {
  const tracker = createTurnTracker();
  tracker.onEvent('a', event('turn/start', { turn: 1 }, 0));
  tracker.onEvent('b', event('turn/start', { turn: 1 }, 0));
  tracker.onEvent('a', event('tool/call', { turn: 1 }, 5));

  const payloadA = tracker.onEvent('a', event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 10));
  const payloadB = tracker.onEvent('b', event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 20));
  assert.equal(payloadA.toolCalls, 1);
  assert.equal(payloadB.toolCalls, 0);
});

test('无关事件被忽略', () => {
  const tracker = createTurnTracker();
  assert.equal(tracker.onEvent('s1', event('user/message', {}, 1)), undefined);
  assert.equal(tracker.onEvent('s1', event('step/start', { turn: 1, step: 1 }, 2)), undefined);
  assert.equal(tracker.onEvent('s1', null), undefined);
  assert.equal(tracker.onEvent('', event('turn/start', { turn: 1 }, 3)), undefined);
});

test('空文本不覆盖上一次的输出', () => {
  const tracker = createTurnTracker();
  tracker.onEvent('s1', event('turn/start', { turn: 1 }, 0));
  tracker.onEvent('s1', event('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '有内容' }] } }, 1));
  tracker.onEvent('s1', event('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'tool-call' }] } }, 2));
  const payload = tracker.onEvent('s1', event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3));
  assert.equal(payload.lastOutput, '有内容');
});
