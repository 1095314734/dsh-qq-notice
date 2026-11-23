/**
 * 「等了太久还没人处理」的补发提醒。
 *
 * 为什么需要：审批通知会被 throttle 压掉（你刚点完的那 20 秒内），被压的那条
 * 只留一个计数，人要是这时候走开了，那个等待就变隐形了——恰好是本插件存在的
 * 理由。所以每条审批被放行/被压制时都起一个计时器：超过 approvalReminderMs
 * 还没拿到决策，就补一条提醒；决策一到立刻取消计时器。
 *
 * 判断"处理完了"的依据是宿主那条审批 promise 什么时候结算，不猜结果内容：
 * 允许、拒绝、取消、不可用，都算人已经处理过。
 *
 * 计时器可注入，测试里用假计时器，不依赖真实时间。
 */

export function createReminders({
  getTimeoutMs,
  onFire,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const armed = new Map();
  let seq = 0;

  return {
    /**
     * 开始等一条审批的处理结果。
     * @param entry - 提醒内容（原样传给 onFire）；超时设为 0 时不计时
     * @returns 取消等待的函数（决策落地时调用）
     */
    arm(entry) {
      const timeoutMs = Math.max(0, Number(getTimeoutMs()) || 0);
      if (timeoutMs <= 0) return () => {};

      seq += 1;
      const id = seq;
      const timer = setTimer(() => {
        // 先摘掉自己：一条审批只提醒一次
        armed.delete(id);
        try {
          onFire(entry);
        } catch {
          // 提醒失败绝不能影响审批链
        }
      }, timeoutMs);
      timer?.unref?.();
      armed.set(id, timer);

      return () => {
        const pending = armed.get(id);
        if (pending === undefined) return;
        armed.delete(id);
        clearTimer(pending);
      };
    },

    /** 测试与诊断用 */
    size() {
      return armed.size;
    },

    /** 卸载时清空，别留悬空计时器 */
    clearAll() {
      for (const timer of armed.values()) clearTimer(timer);
      armed.clear();
    },
  };
}
