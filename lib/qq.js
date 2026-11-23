/**
 * QQ 发送器：只发 HTTP，永远不 start gateway（ADR-0003）。
 *
 * 复用同一台机器上 im-qqbot 的机器人身份，但两条连接互不相干：
 * 发送只依赖 access token + POST /v2/users|groups/{id}/messages。
 */

const RETRY_DELAY_MS = 500;
const WINDOW_MS = 60_000;

/** "c2c:<openid>" / "group:<openid>" → { scope, targetId }；非法返回 undefined */
export function parseTarget(raw) {
  if (typeof raw !== 'string') return undefined;
  const index = raw.indexOf(':');
  if (index <= 0) return undefined;
  const scope = raw.slice(0, index);
  const targetId = raw.slice(index + 1).trim();
  if (targetId.length === 0) return undefined;
  if (scope !== 'c2c' && scope !== 'group') return undefined;
  return { scope, targetId };
}

/** 滑动窗口限流：limit 可以是数字，也可以是每次现取的函数（设置页可实时调） */
export function createRateLimiter(limit, now = () => Date.now()) {
  const buckets = new Map();
  const limitOf = typeof limit === 'function' ? limit : () => limit;
  return function rateLimited(targetId) {
    const max = limitOf();
    if (!(max > 0)) return false;
    const stamp = now();
    const recent = (buckets.get(targetId) ?? []).filter((at) => stamp - at < WINDOW_MS);
    if (recent.length >= max) {
      buckets.set(targetId, recent);
      return true;
    }
    recent.push(stamp);
    buckets.set(targetId, recent);
    return false;
  };
}

export function createQqSender({ getCredentials, logger, perTargetPerMinute = 10 }) {
  const rateLimited = createRateLimiter(perTargetPerMinute);
  let botPromise;

  async function bot() {
    if (botPromise !== undefined) return botPromise;
    botPromise = (async () => {
      const credentials = await getCredentials();
      if (!credentials?.appId || !credentials?.appSecret) {
        throw new Error('QQ 凭据缺失：既没有配置本插件，也没有找到 im-qqbot 的 appId/appSecret');
      }
      const sdk = await import('@tencent-connect/qqbot-nodejs');
      return new sdk.QQBot({
        appId: credentials.appId,
        appSecret: credentials.appSecret,
        markdownSupport: false,
      });
    })();
    // 失败不缓存，下一次发送重新尝试（凭证可能刚被补上）
    botPromise.catch(() => {
      botPromise = undefined;
    });
    return botPromise;
  }

  async function sendOnce(target, text) {
    const instance = await bot();
    return instance.sendText({ scope: target.scope, targetId: target.targetId }, text);
  }

  return {
    /** 发送一条文本；失败抛出（调用方决定是否进漏发汇总） */
    async send(rawTarget, text) {
      const target = parseTarget(rawTarget);
      if (target === undefined) throw new Error(`收件人格式错误：${rawTarget}`);
      if (rateLimited(target.targetId)) throw new Error(`限流：${rawTarget} 每分钟超过 ${perTargetPerMinute} 条`);
      try {
        return await sendOnce(target, text);
      } catch (first) {
        logger?.warn?.(`qq-notify: 首次发送失败，500ms 后重试（${first?.message ?? first}）`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        return sendOnce(target, text);
      }
    },
  };
}
