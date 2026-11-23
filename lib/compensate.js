/**
 * QQ 发送失败后的即时邮件补发（ADR-0006）。
 *
 * 为什么不是"每条失败立刻发一封"：一次限流能让十几条通知同时失败，逐条发信
 * 就把"一次限流"放大成十几封邮件——这正是 ADR-0004 当初反对的。所以这里加一个
 * 很短的合并窗口（默认 3 秒）：窗口内攒到的失败并成一封，人看着仍是"立刻"，
 * 但不会刷屏。
 *
 * 窗口从**第一条**失败开始计时，后续失败不重置——保证最坏延迟有上界（≈ 窗口长度
 * 加上一次 SMTP 往返），不会被持续的失败流无限推迟。
 *
 * 派发逻辑本身在调用方（怎么发、发失败落到哪），这里只负责攒批和定时。
 */

export function createCompensator({
  getCoalesceMs,
  dispatch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let buffered = [];
  let timer;

  function flush() {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
    if (buffered.length === 0) return;
    const batch = buffered;
    buffered = [];
    try {
      // dispatch 是 async 的；这里不等它，通知链路不能被邮件拖住
      Promise.resolve(dispatch(batch)).catch(() => {});
    } catch {
      // dispatch 同步抛错也不能影响后续补发
    }
  }

  return {
    /** 记一条 QQ 发送失败，等窗口到点合并补发 */
    add(record) {
      buffered.push(record);
      if (timer !== undefined) return;
      const coalesceMs = Math.max(0, Number(getCoalesceMs()) || 0);
      if (coalesceMs === 0) {
        flush(); // 0 = 关掉合并，逐条立即发
        return;
      }
      timer = setTimer(flush, coalesceMs);
      timer?.unref?.();
    },

    /** 立即派发缓冲区（卸载时用，别让攒着的通知凭空消失） */
    flush,

    /** 测试与诊断用 */
    size() {
      return buffered.length;
    },
  };
}
