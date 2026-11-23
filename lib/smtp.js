/**
 * 最小 SMTP 客户端：只支持 SMTP over TLS（465）。
 *
 * 为什么不引 nodemailer：profile 里没有任何邮件依赖，为一条兜底通道增加一个
 * 需要长期跟着升级的依赖不划算（ADR-0004）。587/STARTTLS 暂不支持，配置成
 * secure=false 会明确报错而不是静默失败。
 */
import { connect as tlsConnect } from 'node:tls';

const CLIENT_NAME = 'dsh-qq-notice';
const DEFAULT_TIMEOUT_MS = 20_000;

/** UTF-8 主题头编码（RFC 2047 B 编码） */
export function encodeSubject(subject) {
  return `=?UTF-8?B?${Buffer.from(String(subject ?? ''), 'utf8').toString('base64')}?=`;
}

/** 整封邮件（CRLF 头 + base64 正文）；纯函数，便于单测 */
export function buildMail({ from, to, subject, text, date = new Date(), messageId }) {
  const recipients = Array.isArray(to) ? to : [to];
  const body = Buffer.from(String(text ?? ''), 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
  const id = messageId
    ?? `<${date.getTime()}.${Math.random().toString(16).slice(2, 10)}@dsh-qq-notice>`;
  const headers = [
    `From: ${from}`,
    `To: ${recipients.join(', ')}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}

/** SMTP DATA 的点填充：行首的 "." 必须写成 ".."（含开头） */
export function dotStuff(text) {
  return String(text ?? '').replace(/^\./gm, '..');
}

/**
 * 从缓冲区里取出一个**完整**的 SMTP 应答。
 *
 * SMTP 的多行应答形如：
 *   250-PIPELINING
 *   250-AUTH LOGIN
 *   250 OK
 * 中间行用 `NNN-`，**最后一行**才用 `NNN `（空格）。只认「码+空格」为结束，
 * 否则会把 EHLO 的每一行都当成独立应答，后面所有应答整体错位
 * （典型症状：`AUTH LOGIN` 的应答变成上一轮残行 `250-PIPELINING`）。
 *
 * @returns 取到完整应答时的 { code, text, rest }；还没收全时 undefined
 */
export function takeReply(buffer) {
  const lines = String(buffer ?? '').split('\r\n');
  // 最后一段要么是空串（刚好收全），要么是半行（等更多数据），两种情况都不当作终止行
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!/^\d{3} /.test(lines[index])) continue;
    return {
      code: Number(lines[index].slice(0, 3)),
      text: lines.slice(0, index + 1).join('\r\n'),
      rest: lines.slice(index + 1).join('\r\n'),
    };
  }
  return undefined;
}

/** 建一条带超时 & 行缓冲的通道 */
function createChannel(socket, timeoutMs) {
  let buffer = '';
  let closed = false;
  let rejectPending;
  const waiters = [];

  function settle() {
    while (waiters.length > 0) {
      const reply = takeReply(buffer);
      if (reply === undefined) return;
      buffer = reply.rest;
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve({ code: reply.code, line: `${reply.text}\r\n` });
    }
  }

  const onData = (chunk) => {
    buffer += chunk;
    settle();
  };
  const onError = (err) => fail(err);
  const onClose = () => fail(new Error('SMTP 连接被关闭'));

  function fail(err) {
    if (closed) return;
    closed = true;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    rejectPending?.(err);
  }

  socket.setEncoding('utf8');
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);

  return {
    /** 等一条应答 */
    read() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error(`SMTP 应答超时（${timeoutMs}ms）`)), timeoutMs);
        waiters.push({ resolve, reject, timer });
        settle();
      });
    },
    write(data) {
      socket.write(data);
    },
    async command(line) {
      socket.write(`${line}\r\n`);
      return this.read();
    },
    close() {
      closed = true;
      socket.removeListener('data', onData);
      socket.end();
      socket.destroy();
    },
  };
}

function expectCode(reply, allowed, label) {
  const list = Array.isArray(allowed) ? allowed : [allowed];
  if (!list.includes(reply.code)) {
    throw new Error(`SMTP ${label} 失败：${reply.line.trim()}`);
  }
  return reply;
}

export async function sendMail(options, { timeoutMs = DEFAULT_TIMEOUT_MS, logger } = {}) {
  const {
    host,
    port = 465,
    secure = true,
    user,
    password,
    from,
    to,
    subject,
    text,
  } = options ?? {};

  if (!host) throw new Error('SMTP host 未配置');
  if (!from) throw new Error('SMTP 发件人未配置');
  const recipients = Array.isArray(to) ? to.filter(Boolean) : [];
  if (recipients.length === 0) throw new Error('SMTP 收件人未配置');
  if (secure === false) throw new Error('暂只支持 SMTP over TLS（465）；请把 port 设为 465 且 secure=true');
  if (!password) throw new Error('SMTP 密码未取到（检查 ctx.credentials 的引用名）');

  const socket = tlsConnect({ host, port, servername: host });
  socket.setTimeout(timeoutMs);
  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve);
    socket.once('error', reject);
    socket.once('timeout', () => reject(new Error(`连接 ${host}:${port} 超时`)));
  });

  const channel = createChannel(socket, timeoutMs);
  try {
    expectCode(await channel.read(), 220, '欢迎语');
    expectCode(await channel.command(`EHLO ${CLIENT_NAME}`), 250, 'EHLO');
    if (user) {
      expectCode(await channel.command('AUTH LOGIN'), 334, 'AUTH LOGIN');
      expectCode(await channel.command(Buffer.from(user, 'utf8').toString('base64')), 334, '用户名');
      expectCode(await channel.command(Buffer.from(password, 'utf8').toString('base64')), 235, '密码');
    }
    expectCode(await channel.command(`MAIL FROM:<${from}>`), 250, 'MAIL FROM');
    for (const recipient of recipients) {
      expectCode(await channel.command(`RCPT TO:<${recipient}>`), [250, 251], 'RCPT TO');
    }
    expectCode(await channel.command('DATA'), 354, 'DATA');
    channel.write(`${dotStuff(buildMail({ from, to: recipients, subject, text }))}\r\n.\r\n`);
    expectCode(await channel.read(), 250, '邮件正文');
    await channel.command('QUIT').catch(() => {});
    logger?.info?.(`qq-notify: 汇总邮件已发送（${recipients.length} 个收件人）`);
  } finally {
    channel.close();
  }
}
