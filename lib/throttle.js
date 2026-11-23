/**
 * 审批通知节流。
 *
 * 窗口的锚点是**你上一次作答**（点允许 / 拒绝 / 取消），不是上一次推送：
 * 你点完之后 approvalIntervalMs 内，审批通知一条都不推，只把条数累起来，
 * 跟着下一条真正发出去的通知一起报「另有 N 条」。
 *
 * 为什么锚点换成作答：人刚点完按钮，注意力就在屏幕上，紧接着的第二次授权
 * 没必要再往 QQ 推一遍；而按"上次推送"计时，人在 60 秒后才点，下一秒的新
 * 审批反而会被当成"过了窗口"推出去——正好是反的。
 *
 * 为什么按会话而不是全局：全局窗口会让「A 会话刚推过」把「B 会话的审批」也吞掉，
 * 而 B 可能是你更关心的那条。
 *
 * 被压掉的通知不会自己冒出来，兜底交给 reminder.js（超时补一条提醒）。
 */

const MAX_KEYS = 500;

export function createThrottle(getIntervalMs, now = () => Date.now()) {
  const lastDecision = new Map();
  const suppressed = new Map();
  // 允许直接传数字，也允许传 getter（设置页实时改间隔）
  const intervalOf = typeof getIntervalMs === 'function' ? getIntervalMs : () => getIntervalMs;

  function remember(map, key, value) {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_KEYS) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }

  return {
    /**
     * 这条审批该不该推送。
     * @param key - 会话 id
     * @returns true 表示现在发；false 表示落在窗口内，已计入被合并的条数
     */
    allow(key) {
      const interval = Math.max(0, Number(intervalOf()) || 0);
      const last = lastDecision.get(key);
      if (interval > 0 && last !== undefined && now() - last < interval) {
        remember(suppressed, key, (suppressed.get(key) ?? 0) + 1);
        return false;
      }
      return true;
    },

    /**
     * 记下一次作答：窗口从现在重新开始计时。
     * 调用时机是宿主那条审批 promise 结算（允许 / 拒绝 / 取消 / 不可用都算），
     * 所以"你点了"和"你什么时候点的"都由宿主决定，插件不猜。
     */
    decided(key) {
      remember(lastDecision, key, now());
    },

    /** 取出并清空该会话被合并的条数（真正发通知时调用） */
    takeSuppressed(key) {
      const count = suppressed.get(key) ?? 0;
      suppressed.delete(key);
      return count;
    },

    /** 测试与诊断用 */
    size() {
      return lastDecision.size;
    },
  };
}
