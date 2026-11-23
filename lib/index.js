/**
 * dsh-qq-notice —— 把 DSH 的三类时机推到 QQ：
 *   1. 审批请求      ctx.on('approval/request')        → 只旁听，立刻 next()（ADR-0001）
 *   2. 待选择        ctx.on('user-questions/request')  → 同上
 *   3. 任务完成      ctx.on('session/event') 里的 turn/end → 按 mergeWindow 合并
 *
 * 零 LLM：全部文案来自模板，不调用模型、不产生 token（ADR-0002）。
 * QQ 发不出去就立刻用邮件补发；补发也失败才落本地队列，按周期汇总重试（ADR-0006）。
 *
 * 配置是「活的」：设置页保存的 volatile 字段会原地更新，因此这里不缓存配置，
 * 而是每次使用时 `readSettings()` 重新解引用。改动（开关、收件人、SMTP、窗口）
 * 立即生效，不需要重载插件。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { ConfigSchema } from './config.js';
import { createTurnTracker } from './turns.js';
import { createThrottle } from './throttle.js';
import { createReminders } from './reminder.js';
import { createQqSender } from './qq.js';
import { createDigest } from './digest.js';
import { createCompensator } from './compensate.js';
import { sendMail } from './smtp.js';
import {
  formatApproval,
  formatApprovalReminder,
  formatChoice,
  formatCompletion,
  matchesCwd,
  sessionLabel,
} from './format.js';

export const name = 'qq-notify';
export const Config = ConfigSchema;
export const inject = [];

const TAG = 'qq-notify';
/** cosmokit 的 volatile 引用协议（在这里内联，避免再依赖一个宿主包） */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

function isVolatileReference(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value;
}

/** 把配置里的 volatile 引用递归解成普通值；普通对象/数组原样下钻 */
export function unwrap(value) {
  if (Array.isArray(value)) return value.map(unwrap);
  if (isVolatileReference(value)) return unwrap(value.get());
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = unwrap(item);
    return out;
  }
  return value;
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringsOf(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim().length > 0)
    : [];
}

/** 配置兜底：不信任「Schema 一定生效」，缺字段也要能跑 */
export function normalize(raw) {
  const config = raw ?? {};
  const digest = config.digest ?? {};
  const smtp = digest.smtp ?? {};
  return {
    enabled: config.enabled !== false,
    targets: stringsOf(config.targets),
    qq: {
      appId: config.qq?.appId ?? '',
      appSecret: config.qq?.appSecret ?? '',
    },
    events: {
      approval: config.events?.approval !== false,
      choice: config.events?.choice !== false,
      completion: config.events?.completion !== false,
    },
    commandClip: numberOr(config.commandClip, 800),
    approvalIntervalMs: numberOr(config.approvalIntervalMs, 20000),
    approvalReminderMs: numberOr(config.approvalReminderMs, 60000),
    lastOutputChars: numberOr(config.lastOutputChars, 150),
    mergeWindowMs: numberOr(config.mergeWindowMs, 8000),
    perTargetPerMinute: numberOr(config.perTargetPerMinute, 10),
    mutedCwds: stringsOf(config.mutedCwds),
    skipCwds: stringsOf(config.skipCwds),
    digest: {
      enabled: digest.enabled !== false,
      immediate: digest.immediate !== false,
      coalesceMs: numberOr(digest.coalesceMs, 3000),
      intervalMinutes: numberOr(digest.intervalMinutes, 60),
      dir: typeof digest.dir === 'string' && digest.dir.length > 0
        ? digest.dir
        : join(homedir(), '.dsh-qq-notice'),
      smtp: {
        host: smtp.host ?? '',
        port: numberOr(smtp.port, 465),
        secure: smtp.secure !== false,
        user: smtp.user ?? '',
        passwordRef: smtp.passwordRef || 'SMTP_PASSWORD',
        password: smtp.password ?? '',
        from: smtp.from ?? '',
      },
    },
  };
}

/** 从 loader 里找 im-qqbot 那一行，拿到它的 appId/appSecret/cwd/白名单 */
function findQqBotConfig(ctx) {
  try {
    const loader = ctx.get('loader');
    const entries = loader?.entries?.();
    if (entries === undefined) return undefined;
    for (const entry of entries) {
      const id = String(entry?.options?.id ?? '');
      const pkg = String(entry?.options?.name ?? '');
      if (id === 'im-qqbot' || id.endsWith('/im-qqbot') || id.endsWith(':im-qqbot')
        || pkg === '@tencent-connect/dsh-qqbot') {
        return entry.options.config ?? {};
      }
    }
  } catch {
    // loader 不可用（例如更早的宿主）：退回「没有 qqbot 配置」
  }
  return undefined;
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const normalize = (value) => value.replace(/[\\/]+$/, '').toLowerCase();
  return normalize(left) === normalize(right);
}

/**
 * 收件人固定为 SMTP 登录账号自己：这条通道只用来给自己兜底，
 * 没有抄送、没有多收件人，少一个填错的字段。
 */
export function mailRecipients(smtp) {
  const address = String(smtp?.user || smtp?.from || '').trim();
  return address.length > 0 ? [address] : [];
}

/** 审批请求本身不带命令原文，要按 callId 回查会话事件（宿主就是这么设计的） */
export function commandOf(request) {
  if (request?.callId === undefined) return undefined;
  const events = request?.agent?.session?.snapshotEvents?.();
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === null || typeof event !== 'object' || event.type !== 'tool/call') continue;
    const data = event.data ?? {};
    if (String(data.callId) !== String(request.callId)) continue;
    const raw = data.arguments;
    if (typeof raw !== 'string') return undefined;
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.command === 'string') {
        return parsed.command;
      }
    } catch {
      // 非 JSON：回退原始串
    }
    return raw;
  }
  return undefined;
}

export async function apply(ctx, config) {
  const logger = ctx.logger ?? console;

  /** 每次都重新解引用，设置页改完立即生效 */
  const readSettings = () => normalize(unwrap(config));

  if (!readSettings().enabled) logger.info(`${TAG}: 已禁用（enabled=false），可通过设置页重新打开`);

  const qqBotConfig = findQqBotConfig(ctx);
  const qqWorkspace = typeof qqBotConfig?.cwd === 'string' && qqBotConfig.cwd.length > 0
    ? qqBotConfig.cwd
    : join(homedir(), '.dsh-qqbot', 'workspace');

  function currentCredentials() {
    const settings = readSettings();
    return {
      appId: String(settings.qq.appId || qqBotConfig?.appId || process.env.QQBOT_APPID || ''),
      appSecret: String(settings.qq.appSecret || qqBotConfig?.appSecret || process.env.QQBOT_SECRET || ''),
    };
  }

  function currentTargets() {
    const settings = readSettings();
    if (settings.targets.length > 0) return settings.targets;
    return stringsOf(qqBotConfig?.access?.c2cAllow).map((openid) => `c2c:${openid}`);
  }

  const sender = createQqSender({
    logger,
    perTargetPerMinute: () => readSettings().perTargetPerMinute,
    getCredentials: async () => currentCredentials(),
  });

  const digest = createDigest({
    dir: readSettings().digest.dir,
    logger,
    enabled: true,
  });

  /** 邮件正文：一条失败通知一个段落；立即补发与周期汇总共用同一格式 */
  function mailBody(records) {
    return records
      .map((record) => `---\n${record.at} · ${record.kind}\n${record.text}${record.error ? `\n（QQ 发送失败：${record.error}）` : ''}`)
      .join('\n\n');
  }

  /**
   * QQ 发送失败后的补发策略（ADR-0006）：
   *   1. 先用邮件把这一批补发出去（窗口内的失败已经并成一批）；
   *   2. 没配 SMTP / 关掉了立即补发 / 补发邮件也失败 → 转本地队列，等周期汇总重试。
   * 任何情况下都不向上抛：通知链路不能被邮件打断。
   */
  async function compensateByMail(records) {
    const settings = readSettings();
    const smtp = settings.digest.smtp;
    const canMailNow = settings.digest.enabled
      && settings.digest.immediate
      && Boolean(smtp.host)
      && Boolean(smtp.user);
    if (!canMailNow) {
      await digest.pushMany(records);
      return;
    }
    try {
      await sendMailToSelf(
        smtp,
        `DSH 通知补发 ${records.length} 条（QQ 发送失败）`,
        mailBody(records),
      );
      logger.info(`${TAG}: 已用邮件补发 ${records.length} 条（QQ 发送失败）`);
    } catch (err) {
      logger.warn(`${TAG}: 补发邮件也失败，转入漏发队列（${err?.message ?? err}）`);
      await digest.pushMany(records);
    }
  }

  const compensator = createCompensator({
    getCoalesceMs: () => readSettings().digest.coalesceMs,
    dispatch: compensateByMail,
  });

  if (!currentCredentials().appId) {
    logger.warn(`${TAG}: 没有 QQ 凭据（本插件没配，也没找到 im-qqbot），通知将全部落到漏发队列`);
  }
  if (currentTargets().length === 0) {
    logger.warn(`${TAG}: 没有收件人（targets 为空且 im-qqbot 白名单为空），通知将不会发出`);
  }

  /** 是否该为这个会话发通知 */
  function shouldNotify(session, settings) {
    const header = session?.header;
    if (header === undefined || header === null) return false;
    if (header.origin === 'subagent') return false; // 子代理会话：一个任务会炸出十几条
    const cwd = header.cwd;
    if (typeof cwd === 'string') {
      if (samePath(cwd, qqWorkspace)) return false; // QQ 来源会话：人已经在 QQ 里
      if (matchesCwd(cwd, settings.skipCwds)) return false;
      if (matchesCwd(cwd, settings.mutedCwds)) return false;
    }
    return true;
  }

  /** 发送 + 失败落漏发队列（绝不向上抛，宿主的事件链不能被通知打断） */
  async function deliver(text, meta) {
    const targets = currentTargets();
    if (targets.length === 0) return;
    const failures = [];
    for (const target of targets) {
      try {
        await sender.send(target, text);
      } catch (err) {
        failures.push(`${target}: ${err?.message ?? err}`);
      }
    }
    if (failures.length === 0) return;
    logger.warn(`${TAG}: 发送失败，转邮件补发（${failures.join('; ')}）`);
    // 交给补发器攒批：窗口内的多条失败会合并成一封邮件（ADR-0006）
    compensator.add({
      at: new Date().toISOString(),
      kind: meta?.kind ?? 'unknown',
      sessionId: meta?.sessionId ?? '',
      text,
      error: failures.join('; '),
    });
  }

  function fireAndForget(text, meta) {
    void deliver(text, meta).catch((err) => {
      logger.warn(`${TAG}: 通知投递异常（${err?.message ?? err}）`);
    });
  }

  // ── 完成通知：同一会话的连续 turn 合并成一个窗口 ──
  const pendingCompletions = new Map();
  const tracker = createTurnTracker();
  // 审批通知节流：窗口锚点是你上一次作答（见 throttle.js）
  const approvalThrottle = createThrottle(() => readSettings().approvalIntervalMs);

  // 未处理提醒：审批推送出去（或被节流压掉）后，超过 approvalReminderMs 还没决策就补一条。
  // 它**刻意不走** approvalThrottle：这条的意义就是"你可能漏了"，被节流吞掉就废了。
  const reminders = createReminders({
    getTimeoutMs: () => readSettings().approvalReminderMs,
    onFire: (entry) => {
      const settings = readSettings();
      if (!settings.enabled || !settings.events.approval) return;
      if (!shouldNotify(entry.session, settings)) return;
      fireAndForget(
        formatApprovalReminder({
          label: entry.label,
          cwd: entry.cwd,
          toolName: entry.toolName,
          waitedMs: entry.waitedMs,
        }),
        { kind: 'approval', sessionId: entry.sessionId },
      );
    },
  });

  function flushCompletion(sessionId) {
    const entry = pendingCompletions.get(sessionId);
    if (entry === undefined) return;
    pendingCompletions.delete(sessionId);
    const text = formatCompletion({
      label: entry.label,
      cwd: entry.cwd,
      reasonKind: entry.reasonKind,
      error: entry.error,
      mergeCount: entry.count,
      durationMs: entry.durationMs,
      toolCalls: entry.toolCalls,
      lastOutput: entry.lastOutput,
      lastOutputChars: entry.lastOutputChars,
    });
    fireAndForget(text, { kind: 'completion', sessionId });
  }

  function enqueueCompletion(sessionId, label, cwd, payload, settings) {
    const existing = pendingCompletions.get(sessionId);
    if (existing !== undefined) {
      existing.count += 1;
      existing.durationMs = (existing.durationMs ?? 0) + (payload.durationMs ?? 0);
      existing.toolCalls = (existing.toolCalls ?? 0) + (payload.toolCalls ?? 0);
      existing.reasonKind = payload.reasonKind;
      existing.error = payload.error;
      existing.lastOutput = payload.lastOutput || existing.lastOutput;
      return;
    }
    const timer = setTimeout(() => flushCompletion(sessionId), settings.mergeWindowMs);
    timer.unref?.(); // 不阻止进程退出
    pendingCompletions.set(sessionId, {
      timer,
      label,
      cwd,
      count: 1,
      durationMs: payload.durationMs,
      toolCalls: payload.toolCalls,
      reasonKind: payload.reasonKind,
      error: payload.error,
      lastOutput: payload.lastOutput,
      lastOutputChars: settings.lastOutputChars,
    });
  }

  // ── 事件订阅（常驻注册，开关在回调里实时判断，这样设置页能立即停用某类通知） ──
  const disposers = [];

  disposers.push(ctx.on('approval/request', (request, next) => {
    /** 决策落地时撤掉未处理提醒 */
    let disarmReminder;
    let sessionId;
    try {
      const settings = readSettings();
      if (settings.enabled && settings.events.approval) {
        const session = request?.agent?.session;
        if (shouldNotify(session, settings)) {
          const header = session.header;
          sessionId = String(header.id);
          if (approvalThrottle.allow(sessionId)) {
            fireAndForget(formatApproval({
              label: sessionLabel(session),
              cwd: header.cwd,
              toolName: request.toolName,
              reason: request.displayReason?.zh ?? request.reason,
              command: commandOf(request),
              commandClip: settings.commandClip,
              suppressed: approvalThrottle.takeSuppressed(sessionId),
            }), { kind: 'approval', sessionId: header.id });
          }
          // 不管这一条推没推出去，都开始等：被节流压掉的那条更需要提醒
          disarmReminder = reminders.arm({
            sessionId,
            session,
            label: sessionLabel(session),
            cwd: header.cwd,
            toolName: request.toolName,
            waitedMs: settings.approvalReminderMs,
          });
        }
      }
    } catch (err) {
      logger.warn(`${TAG}: 审批通知生成失败（${err?.message ?? err}）`);
    }
    // 关键：无论如何都把决策权交回宿主（ADR-0001）。
    //
    // prepend 是必需的：Web 客户端（dsh-api-remotes + dsh-client-ui-approval）会
    // 在瀑布里 claim 这次审批并一直等界面点按钮。不 prepend 的话，本监听器排在
    // 它后面，人不在电脑前时永远不会被调用——通知恰好失效在最需要的场景。
    // 先 prepend、再立刻 next()，既不抢决策，也不会拖慢界面。
    const result = next();
    if (sessionId !== undefined) {
      // 这条 promise 结算 = 人已经作答（允许 / 拒绝 / 取消 / 不可用）。
      // 只用它来"知道什么时候"，结果交给宿主，插件不改写任何 outcome。
      const settled = () => {
        try {
          disarmReminder?.();
        } catch {
          // 取消失败不影响后续
        }
        try {
          approvalThrottle.decided(sessionId);
        } catch {
          // 同上
        }
      };
      Promise.resolve(result).then(settled, settled);
    }
    return result;
  }, { global: true, prepend: true }));

  disposers.push(ctx.on('user-questions/request', (request, next) => {
    try {
      const settings = readSettings();
      if (settings.enabled && settings.events.choice) {
        const session = request?.agent?.session;
        if (shouldNotify(session, settings)) {
          const header = session.header;
          fireAndForget(formatChoice({
            label: sessionLabel(session),
            cwd: header.cwd,
            questions: request.questions,
          }), { kind: 'choice', sessionId: header.id });
        }
      }
    } catch (err) {
      logger.warn(`${TAG}: 选择通知生成失败（${err?.message ?? err}）`);
    }
    // 同审批：Web 的提问 UI 也会 claim，必须排在它前面才能看到这次提问
    return next();
  }, { global: true, prepend: true }));

  disposers.push(ctx.on('session/event', (session, event) => {
    try {
      const header = session?.header;
      if (header === undefined || header === null) return;
      const payload = tracker.onEvent(String(header.id), event);
      if (payload === undefined) return;
      const settings = readSettings();
      if (!settings.enabled || !settings.events.completion) return;
      if (!shouldNotify(session, settings)) return;
      enqueueCompletion(String(header.id), sessionLabel(session), header.cwd, payload, settings);
    } catch (err) {
      logger.warn(`${TAG}: 完成通知生成失败（${err?.message ?? err}）`);
    }
  }, { global: true }));

  // ── 漏发汇总 ──
  /** 密码优先级：设置页直接填的 > credentials 引用 > 同名环境变量 */
  async function resolveSmtpPassword(smtp) {
    if (typeof smtp.password === 'string' && smtp.password.length > 0) return smtp.password;
    const ref = smtp.passwordRef;
    try {
      const credentialsService = ctx.get('credentials');
      const resolved = await credentialsService?.resolve?.(ref);
      if (typeof resolved === 'string' && resolved.length > 0) return resolved;
      if (resolved !== undefined && resolved !== null && typeof resolved.value === 'string') {
        return resolved.value;
      }
    } catch (err) {
      logger.warn(`${TAG}: 读取 SMTP 凭据失败（${err?.message ?? err}）`);
    }
    return process.env[ref] ?? '';
  }

  /** 发一封给自己：收件人固定是 SMTP 账号本身（mailRecipients），不抄送任何人 */
  async function sendMailToSelf(smtp, subject, text) {
    if (!smtp.host) throw new Error('SMTP 主机还没有配置');
    const to = mailRecipients(smtp);
    if (to.length === 0) throw new Error('SMTP 账号还没有配置（收件人就是它自己）');
    const password = await resolveSmtpPassword(smtp);
    if (!password) throw new Error(`没有 SMTP 密码：在设置里填，或把 ${smtp.passwordRef} 写进 DSH 凭据`);
    return sendMail({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      user: smtp.user,
      password,
      from: smtp.from || smtp.user,
      to,
      subject,
      text,
    }, { logger });
  }

  let digestRunning = false;

  async function flushDigest(settings) {
    if (!settings.digest.enabled || digestRunning) return;
    const smtp = settings.digest.smtp;
    if (!smtp.host || !smtp.user) {
      return; // 没配全：留在队列里，等设置页补上
    }
    digestRunning = true;
    try {
      const records = await digest.read();
      if (records.length === 0) return;
      await sendMailToSelf(smtp, `DSH 漏发通知 ${records.length} 条`, mailBody(records));
      await digest.clear();
    } catch (err) {
      logger.warn(`${TAG}: 汇总邮件发送失败，队列保留（${err?.message ?? err}）`);
    } finally {
      digestRunning = false;
    }
  }

  // ── 设置页的「发送测试邮件」入口：客户端 POST 这里，立即走一遍真实 SMTP ──
  function writeJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(body);
  }

  async function handleTestMail(req, res) {
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, message: '只接受 POST' });
      return;
    }
    try {
      const settings = readSettings();
      const smtp = settings.digest.smtp;
      await sendMailToSelf(
        smtp,
        'DSH QQ 通知 · 测试邮件',
        [
          '这是一封测试邮件，来自 dsh-qq-notice。',
          '',
          `时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Taipei' })}`,
          `SMTP：${smtp.host}:${smtp.port}`,
          `账号：${smtp.user || '(未填)'}`,
          '',
          '收到它说明邮件兜底通道是通的；漏发汇总会按设定周期合并发送。',
        ].join('\n'),
      );
      const to = mailRecipients(smtp)[0];
      logger.info(`${TAG}: 测试邮件已发送（${to}）`);
      writeJson(res, 200, { ok: true, message: `已发送到 ${to}，去收件箱看一下` });
    } catch (err) {
      const message = String(err?.message ?? err);
      logger.warn(`${TAG}: 测试邮件发送失败（${message}）`);
      // 用 200 + ok:false，让设置页原样显示原因，而不是一个笼统的 HTTP 错误
      writeJson(res, 200, { ok: false, message });
    }
  }

  // 注册测试邮件路由。必须走 ctx.inject(['webServer']) 而不是 ctx.get('webServer')：
  // cordis 的访问守卫要求服务先经 inject 声明，直接 get 会拿不到实例（插件照常加载，
  // 但路由不会注册），请求就落到 SPA 兜底——那个兜底只允许 GET/HEAD，于是 POST 变成 405。
  // inject 回调会在服务就绪/替换时重跑，并连带注销旧路由。
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.webServer;
    if (webServer === undefined || typeof webServer.register !== 'function') return;
    const disposeRoute = webServer.register({
      kind: 'exact',
      path: '/qq-notify/mail/test',
      handler: handleTestMail,
    });
    logger.info(`${TAG}: 测试邮件路由已注册（POST /qq-notify/mail/test）`);
    // 落一个标记：路由到底注册上没有，看这个文件在不在就行（排查 405 用）
    void (async () => {
      try {
        const dir = readSettings().digest.dir;
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'test-mail-route.json'), `${JSON.stringify({
          at: new Date().toISOString(),
          path: '/qq-notify/mail/test',
          method: 'POST',
        })}\n`, 'utf8');
      } catch {
        // 标记失败不影响功能
      }
    })();
    scoped.effect(() => disposeRoute, 'qq-notify.test-mail');
  });

  // 每分钟醒一次，按当前 intervalMinutes 判断该不该发——这样设置页改周期立即生效
  let lastDigestAt = Date.now();
  const digestTimer = setInterval(() => {
    try {
      const settings = readSettings();
      const intervalMs = Math.max(1, settings.digest.intervalMinutes) * 60_000;
      if (Date.now() - lastDigestAt < intervalMs) return;
      lastDigestAt = Date.now();
      void flushDigest(settings);
    } catch (err) {
      logger.warn(`${TAG}: 汇总任务异常（${err?.message ?? err}）`);
    }
  }, 60_000);
  digestTimer.unref?.();

  ctx.effect(() => () => {
    clearInterval(digestTimer);
    reminders.clearAll();
    // 卸载时把攒着还没补发的失败立刻派发出去，别凭空丢掉
    compensator.flush();
    for (const [sessionId, entry] of pendingCompletions) {
      clearTimeout(entry.timer);
      pendingCompletions.delete(sessionId);
    }
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 卸载期异常不 veto
      }
    }
  }, 'qq-notify.lifecycle');

  const initial = readSettings();
  logger.info(
    `${TAG}: 已启用（收件人 ${currentTargets().length} 个，审批=${initial.events.approval} 选择=${initial.events.choice} 完成=${initial.events.completion}，邮件汇总=${initial.digest.enabled}）`,
  );

  // 启动落一个标记文件：排查「设置页有没有加载到 schema」「插件到底有没有跑起来」时，
  // 看这个文件的时间戳和 schemaLoaded 就够了，不用猜。
  try {
    const dir = initial.digest.dir;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'last-apply.json'), `${JSON.stringify({
      at: new Date().toISOString(),
      schemaLoaded: ConfigSchema !== undefined,
      targets: currentTargets(),
      events: initial.events,
      smtp: { host: initial.digest.smtp.host, user: initial.digest.smtp.user, recipients: mailRecipients(initial.digest.smtp) },
    }, null, 2)}\n`, 'utf8');
  } catch (err) {
    logger.warn(`${TAG}: 启动标记写入失败（${err?.message ?? err}）`);
  }

  // 等 fiber 变 ACTIVE 之后再问宿主一次：设置服务认得哪些命名空间、我们的 entry 处于什么状态。
  // 这份快照是「设置页为什么看不到我」的唯一可靠依据。
  const diagnoseTimer = setTimeout(() => {
    void (async () => {
      const report = { at: new Date().toISOString() };
      try {
        const loader = ctx.get('loader');
        const entries = (loader?.entries?.() ?? []).filter(
          (entry) => String(entry?.options?.id ?? '').includes('qq-notify'),
        );
        report.entries = entries.map((entry) => ({
          id: entry?.options?.id,
          name: entry?.options?.name,
          state: String(entry?.fiber?.state),
          active: entry?.fiber?.state === 'active',
          hasRuntimeConfig: entry?.fiber?.runtime?.Config !== undefined,
          parentEntryId: entry?.parent?.tree?.ctx?.fiber?.entry?.id,
        }));
      } catch (err) {
        report.entriesError = String(err?.message ?? err);
      }
      try {
        const settings = ctx.get('settings');
        report.describeError = null;
        report.namespaces = (settings?.describe?.() ?? []).map((descriptor) => String(descriptor.ns));
      } catch (err) {
        report.describeError = String(err?.message ?? err);
      }
      try {
        const dir = readSettings().digest.dir;
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'diagnose.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      } catch (err) {
        logger.warn(`${TAG}: 诊断快照写入失败（${err?.message ?? err}）`);
      }
    })();
  }, 5000);
  diagnoseTimer.unref?.();
}
