import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clip,
  describeReason,
  formatApproval,
  formatApprovalReminder,
  formatChoice,
  formatCompletion,
  formatDuration,
  matchesCwd,
  projectName,
  sessionLabel,
  shortId,
  textOf,
} from '../lib/format.js';

test('shortId 取前 6 位', () => {
  assert.equal(shortId('0123456789abcdef'), '012345');
  assert.equal(shortId(undefined), '');
});

test('projectName 取目录尾名，无 cwd 时给兜底', () => {
  assert.equal(projectName('D:\\work\\web-view\\qq-notify'), 'qq-notify');
  assert.equal(projectName('/home/me/repo/'), 'repo');
  assert.equal(projectName(undefined), '未命名会话');
  assert.equal(projectName(''), '未命名会话');
});

test('sessionLabel 是「项目名 · 短 id」', () => {
  const label = sessionLabel({ header: { cwd: '/a/b', id: '0123456' } });
  assert.equal(label, 'b · 012345');
});

test('clip 只在超长时截断', () => {
  assert.equal(clip('abc', 10), 'abc');
  assert.equal(clip('abcdef', 3), 'abc…');
  assert.equal(clip(undefined, 3), '');
});

test('formatDuration 覆盖秒/分/时与未知值', () => {
  assert.equal(formatDuration(9_500), '10s');
  assert.equal(formatDuration(252_000), '4m12s');
  assert.equal(formatDuration(3_930_000), '1h5m');
  assert.equal(formatDuration(undefined), '');
  assert.equal(formatDuration(-1), '');
});

test('describeReason 区分完成 / 异常 / 未知', () => {
  assert.deepEqual(describeReason('completed'), { icon: '✅', title: '完成' });
  assert.equal(describeReason('max-tokens').icon, '⚠️');
  const failed = describeReason('error', { message: 'rate limited' });
  assert.equal(failed.icon, '❌');
  assert.match(failed.title, /rate limited/);
  assert.match(describeReason('weird-kind').title, /weird-kind/);
});

test('matchesCwd 支持通配、子串与大小写不敏感', () => {
  assert.equal(matchesCwd('D:\\work\\scratch-a', ['D:/work/scratch-*']), true);
  assert.equal(matchesCwd('D:/work/scratch-a', ['d:/work/scratch-*']), true);
  assert.equal(matchesCwd('D:/work/a/b', ['*b']), false); // * 不跨目录分隔符
  assert.equal(matchesCwd('D:/work/a/b', ['work/a']), true); // 无通配 = 子串
  assert.equal(matchesCwd('D:/other', ['D:/work/*']), false);
  assert.equal(matchesCwd(undefined, ['x']), false);
  assert.equal(matchesCwd('D:/work', []), false);
});

test('formatApproval 带命令原文并截断', () => {
  const text = formatApproval({
    label: 'proj · abc123',
    cwd: 'D:/work/proj',
    toolName: 'bash',
    reason: '需要执行命令',
    command: 'pnpm install --frozen-lockfile',
    commandClip: 800,
  });
  assert.match(text, /🔐 需要授权 · proj · abc123/);
  assert.match(text, /目录 D:\/work\/proj/);
  assert.match(text, /工具 bash · 原因：需要执行命令/);
  assert.match(text, /\$ pnpm install --frozen-lockfile/);

  const clipped = formatApproval({
    label: 'x', cwd: undefined, toolName: 'bash', command: 'a'.repeat(50), commandClip: 10,
  });
  assert.match(clipped, /\$ aaaaaaaaaa…/);
});

test('formatApproval 拿不到命令时明确说明，而不是空白', () => {
  const text = formatApproval({ label: 'x', toolName: 'bash' });
  assert.match(text, /拿不到命令原文/);
});

test('formatApproval 带上被节流合并的条数', () => {
  const text = formatApproval({ label: 'x', toolName: 'bash', command: 'ls', suppressed: 2 });
  assert.match(text, /节流窗口内另有 2 条审批通知已合并/);
  const plain = formatApproval({ label: 'x', toolName: 'bash', command: 'ls' });
  assert.doesNotMatch(plain, /节流窗口/);
});

test('formatApprovalReminder 说清「已经等多久、只提醒一次」', () => {
  const text = formatApprovalReminder({
    label: 'proj · abc123',
    cwd: 'D:/work/proj',
    toolName: 'bash',
    waitedMs: 60_000,
  });
  assert.match(text, /⏰ 还在等你授权 · proj · abc123/);
  assert.match(text, /目录 D:\/work\/proj/);
  assert.match(text, /工具 bash · 已经等了 60 秒仍未处理/);
  assert.match(text, /只提醒一次/);

  // 不足 1 秒也按 1 秒说，不出现「0 秒」
  const tiny = formatApprovalReminder({ label: 'x', toolName: 'bash', waitedMs: 200 });
  assert.match(tiny, /1 秒/);
});

test('formatChoice 列出问题与选项', () => {
  const text = formatChoice({
    label: 'proj · abc123',
    cwd: 'D:/work/proj',
    questions: [{
      question: '迁移策略选哪个？',
      options: [{ label: '停机迁移' }, { label: '双写过渡' }],
    }],
  });
  assert.match(text, /❓ 待你选择 · proj · abc123/);
  assert.match(text, /1\) 迁移策略选哪个？/);
  assert.match(text, /停机迁移/);
  assert.match(text, /双写过渡/);
});

test('formatChoice 支持多选标记', () => {
  const text = formatChoice({
    label: 'x',
    questions: [{ question: 'q', multiSelect: true, options: [{ label: 'a' }] }],
  });
  assert.match(text, /（可多选）/);
});

test('formatCompletion 正常完成 / 合并 / 最后输出', () => {
  const text = formatCompletion({
    label: 'proj · abc123',
    cwd: 'D:/work/proj',
    reasonKind: 'completed',
    mergeCount: 2,
    durationMs: 200_000,
    toolCalls: 23,
    lastOutput: '编译通过',
    lastOutputChars: 150,
  });
  assert.match(text, /✅ 完成（合并 2 轮） · proj · abc123/);
  assert.match(text, /耗时 3m20s · 2 轮 · 23 次工具调用/);
  assert.match(text, /最后输出：编译通过/);
});

test('formatCompletion 异常结束换图标并带错误信息', () => {
  const text = formatCompletion({
    label: 'x', cwd: undefined, reasonKind: 'error', error: { message: 'boom' },
  });
  assert.match(text, /❌ 失败：boom/);
});

test('formatCompletion 没有最后输出时不硬造一行', () => {
  const text = formatCompletion({ label: 'x', reasonKind: 'completed', lastOutput: '   ' });
  assert.doesNotMatch(text, /最后输出/);
});

test('textOf 只取 text block 并拼接', () => {
  const message = {
    content: [
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: '第一段' },
      { type: 'tool-call' },
      { type: 'text', text: '第二段' },
    ],
  };
  assert.equal(textOf(message), '第一段\n第二段');
  assert.equal(textOf(undefined), '');
  assert.equal(textOf({ content: 'not-an-array' }), '');
});
