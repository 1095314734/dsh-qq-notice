/**
 * turn 跟踪：从 session 事件流里低成本攒出「耗时 / 工具调用次数 / 最后输出」。
 *
 * 只读事件、只存增量状态，不做 snapshotEvents（那是 O(整个会话) 的拷贝）。
 * 插件可能在 turn 中途才被加载，因此缺失 turn/start 时降级为「不知道耗时」，
 * 而不是猜一个数字。
 */
import { textOf } from './format.js';

const MAX_SESSIONS = 500;

export function createTurnTracker({ maxSessions = MAX_SESSIONS } = {}) {
  const state = new Map();

  function remember(sessionId, value) {
    state.delete(sessionId);
    state.set(sessionId, value);
    if (state.size > maxSessions) {
      const oldest = state.keys().next().value;
      if (oldest !== undefined) state.delete(oldest);
    }
  }

  return {
    /** @returns 完成载荷（turn/end 时）或 undefined */
    onEvent(sessionId, event) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
      if (event === null || typeof event !== 'object') return undefined;
      const data = event.data ?? {};

      switch (event.type) {
        case 'turn/start':
          remember(sessionId, {
            turn: data.turn,
            startTime: typeof event.time === 'number' ? event.time : undefined,
            toolCalls: 0,
            lastOutput: '',
          });
          return undefined;

        case 'tool/call': {
          const current = state.get(sessionId);
          if (current !== undefined && data.turn === current.turn) current.toolCalls += 1;
          return undefined;
        }

        case 'assistant/message': {
          const current = state.get(sessionId);
          if (current === undefined) return undefined;
          const text = textOf(data.message);
          if (text.length > 0) current.lastOutput = text;
          return undefined;
        }

        case 'turn/end': {
          const current = state.get(sessionId);
          state.delete(sessionId);
          const reasonKind = data.reason?.kind;
          if (current === undefined || current.turn !== data.turn) {
            // 中途加载：只有结束事实，没有过程数据
            return { turn: data.turn, reasonKind, error: data.reason?.error, toolCalls: 0, lastOutput: '' };
          }
          const durationMs = typeof event.time === 'number' && typeof current.startTime === 'number'
            ? event.time - current.startTime
            : undefined;
          return {
            turn: data.turn,
            reasonKind,
            error: data.reason?.error,
            durationMs,
            toolCalls: current.toolCalls,
            lastOutput: current.lastOutput,
          };
        }

        default:
          return undefined;
      }
    },

    /** 测试与诊断用 */
    size() {
      return state.size;
    },
  };
}
