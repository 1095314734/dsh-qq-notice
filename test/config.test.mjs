import test from 'node:test';
import assert from 'node:assert/strict';
import { mailRecipients, normalize, unwrap } from '../lib/index.js';

const WRITE = Symbol.for('cosmokit.volatile.write');

/** 伪造一个 cosmokit volatile 引用（DSH 把 `.volatile()` 字段包成这种对象） */
function ref(value) {
  return { [WRITE](_next) {}, get: () => value };
}

test('unwrap 解引用 volatile 字段，普通值原样返回', () => {
  assert.equal(unwrap(ref(7)), 7);
  assert.equal(unwrap('plain'), 'plain');
  assert.deepEqual(unwrap([ref(1), 2]), [1, 2]);
  assert.deepEqual(
    unwrap({ a: ref('x'), nested: { b: ref(3) }, list: [ref('y')] }),
    { a: 'x', nested: { b: 3 }, list: ['y'] },
  );
});

test('unwrap 对深层嵌套的引用也能穿透', () => {
  const raw = { digest: { smtp: { host: ref('smtp.qq.com'), port: ref(465) } } };
  assert.deepEqual(unwrap(raw), { digest: { smtp: { host: 'smtp.qq.com', port: 465 } } });
});

test('normalize 给空配置补齐全部默认值', () => {
  const settings = normalize(unwrap({}));
  assert.equal(settings.enabled, true);
  assert.deepEqual(settings.targets, []);
  assert.equal(settings.commandClip, 800);
  assert.equal(settings.approvalIntervalMs, 20_000, '审批通知间隔默认 20 秒');
  assert.equal(settings.approvalReminderMs, 60_000, '未处理提醒默认 60 秒');
  assert.equal(settings.lastOutputChars, 150);
  assert.equal(settings.mergeWindowMs, 8000);
  assert.equal(settings.perTargetPerMinute, 10);
  assert.equal(settings.events.approval, true);
  assert.equal(settings.digest.enabled, true);
  assert.equal(settings.digest.intervalMinutes, 60);
  assert.equal(settings.digest.smtp.port, 465);
  assert.equal(settings.digest.smtp.passwordRef, 'SMTP_PASSWORD');
  assert.ok(settings.digest.dir.endsWith('.dsh-qq-notice'));
});

test('normalize 让 volatile 引用里的设置生效', () => {
  const settings = normalize(unwrap({
    enabled: ref(false),
    targets: ref(['c2c:abc']),
    events: { approval: ref(false), choice: ref(true), completion: ref(true) },
    digest: { smtp: { user: ref('me@qq.com') } },
  }));
  assert.equal(settings.enabled, false);
  assert.deepEqual(settings.targets, ['c2c:abc']);
  assert.equal(settings.events.approval, false);
  assert.equal(settings.digest.smtp.user, 'me@qq.com');
});

test('邮件收件人固定为 SMTP 账号自己', () => {
  assert.deepEqual(mailRecipients({ user: 'me@qq.com' }), ['me@qq.com']);
  assert.deepEqual(mailRecipients({ user: ' me@qq.com ' }), ['me@qq.com']);
  assert.deepEqual(mailRecipients({ user: '', from: 'bot@qq.com' }), ['bot@qq.com']);
  assert.deepEqual(mailRecipients({ user: '', from: '' }), []);
  assert.deepEqual(mailRecipients(undefined), []);
});

test('normalize 过滤空字符串收件人，坏类型回退默认', () => {
  const settings = normalize({
    targets: ['c2c:a', '  ', 42, null],
    commandClip: Number.NaN,
    mutedCwds: 'not-an-array',
  });
  assert.deepEqual(settings.targets, ['c2c:a']);
  assert.equal(settings.commandClip, 800);
  assert.deepEqual(settings.mutedCwds, []);
});
