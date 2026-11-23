import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMail, dotStuff, encodeSubject, takeReply } from '../lib/smtp.js';

test('encodeSubject 是可解码的 RFC2047 编码', () => {
  const encoded = encodeSubject('DSH 漏发通知 3 条');
  assert.match(encoded, /^=\?UTF-8\?B\?/);
  const base64 = encoded.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
  assert.equal(Buffer.from(base64, 'base64').toString('utf8'), 'DSH 漏发通知 3 条');
});

test('buildMail 头部齐全、正文是 base64 且可还原', () => {
  const mail = buildMail({
    from: 'bot@example.com',
    to: ['me@example.com', 'me2@example.com'],
    subject: '漏发',
    text: '第一行\n第二行',
    date: new Date('2026-11-23T08:00:00Z'),
    messageId: '<fixed@dsh-qq-notice>',
  });
  assert.match(mail, /^From: bot@example\.com\r\n/);
  assert.match(mail, /To: me@example\.com, me2@example\.com\r\n/);
  assert.match(mail, /Message-ID: <fixed@dsh-qq-notice>\r\n/);
  assert.match(mail, /Content-Transfer-Encoding: base64\r\n/);
  assert.ok(mail.includes('\r\n\r\n'), '头与正文之间必须是空行');

  const body = mail.slice(mail.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, '');
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), '第一行\n第二行');
});

test('buildMail 正文按 76 字符折行', () => {
  const mail = buildMail({
    from: 'a@b.c', to: 'd@e.f', subject: 's', text: 'x'.repeat(500),
  });
  const body = mail.slice(mail.indexOf('\r\n\r\n') + 4);
  for (const line of body.split('\r\n').filter(Boolean)) {
    assert.ok(line.length <= 76, `行长度超限: ${line.length}`);
  }
});

test('dotStuff 只处理行首的点', () => {
  assert.equal(dotStuff('.hello'), '..hello');
  assert.equal(dotStuff('a\n.b\nc'), 'a\n..b\nc');
  assert.equal(dotStuff('a.b'), 'a.b');
  assert.equal(dotStuff(''), '');
});

test('takeReply 只把「码+空格」当结束行', () => {
  const single = takeReply('220 smtp.qq.com ready\r\n')
  assert.equal(single.code, 220)
  assert.equal(single.rest, '')
});

test('takeReply 把多行 EHLO 应答收成一条（回归：250-PIPELINING 错位）', () => {
  const buffer = [
    '250-smtp.qq.com',
    '250-PIPELINING',
    '250-SIZE 73400320',
    '250-AUTH LOGIN PLAIN',
    '250 OK',
    '',
  ].join('\r\n')
  const reply = takeReply(buffer)
  assert.equal(reply.code, 250)
  assert.match(reply.text, /250-AUTH LOGIN PLAIN/)
  assert.match(reply.text, /250 OK/)
  assert.equal(reply.rest, '')
});

test('takeReply 一条应答后面还跟着下一条时，rest 保留剩余', () => {
  const reply = takeReply('250-a\r\n250 ok\r\n334 VXNlcm5hbWU6\r\n')
  assert.equal(reply.code, 250)
  assert.equal(reply.rest, '334 VXNlcm5hbWU6\r\n')
  const next = takeReply(reply.rest)
  assert.equal(next.code, 334)
});

test('takeReply 半行不该被当成应答', () => {
  assert.equal(takeReply('250-PIPE'), undefined)
  assert.equal(takeReply('250-PIPELINING\r\n250-AUTH'), undefined)
  assert.equal(takeReply(''), undefined)
});
