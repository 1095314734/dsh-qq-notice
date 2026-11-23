/**
 * 通知文案：纯函数，无 IO、无副作用、不调用模型（ADR-0002）。
 *
 * 变量：你要求不脱敏，因此命令原文、完整 cwd 都原样发出，只做长度截断。
 */
import { basename } from 'node:path';

/** 会话 id 前 6 位，够区分同一目录下的多个会话 */
export function shortId(id) {
  return String(id ?? '').slice(0, 6);
}

/** 项目名：目录尾名。根目录/无 cwd 时给一个可读的兜底 */
export function projectName(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return '未命名会话';
  const trimmed = cwd.replace(/[\\/]+$/, '');
  const name = basename(trimmed);
  return name.length > 0 ? name : trimmed;
}

/** 会话标识：项目名 + 短 id（CONTEXT: 会话标识） */
export function sessionLabel(session) {
  const cwd = session?.header?.cwd;
  return `${projectName(cwd)} · ${shortId(session?.header?.id)}`;
}

/** 截断：超长时保留头部并以省略号结尾 */
export function clip(text, max) {
  if (typeof text !== 'string') return '';
  if (typeof max !== 'number' || max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** 人类可读耗时；未知给空串（调用方负责省略） */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

/** 结束原因 → 文案。未知 kind 不静默吞掉，原样显示 */
export function describeReason(reasonKind, error) {
  switch (reasonKind) {
    case 'completed':
      return { icon: '✅', title: '完成' };
    case 'aborted':
      return { icon: '⚠️', title: '已中断' };
    case 'blocked':
      return { icon: '⚠️', title: '被阻塞' };
    case 'error': {
      const detail = error?.message ? `：${clip(String(error.message), 200)}` : '';
      return { icon: '❌', title: `失败${detail}` };
    }
    case 'max-tokens':
      return { icon: '⚠️', title: '超长截断' };
    case undefined:
      return { icon: '✅', title: '结束' };
    default:
      return { icon: '⚠️', title: `结束（${reasonKind}）` };
  }
}

/**
 * cwd 静音匹配：支持 * 通配（不跨目录分隔符）与 ?，无通配时按子串匹配。
 * Windows 路径大小写不敏感，统一小写比较。
 */
export function matchesCwd(cwd, patterns) {
  if (typeof cwd !== 'string' || !Array.isArray(patterns)) return false;
  const target = cwd.replace(/\\/g, '/').toLowerCase();
  return patterns.some((raw) => {
    if (typeof raw !== 'string' || raw.trim().length === 0) return false;
    const pattern = raw.replace(/\\/g, '/').toLowerCase();
    if (!/[*?]/.test(pattern)) return target.includes(pattern);
    const source = pattern
      .split('')
      .map((ch) => {
        if (ch === '*') return '[^/]*';
        if (ch === '?') return '.';
        return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      })
      .join('');
    try {
      return new RegExp(`^${source}$`).test(target);
    } catch {
      return false;
    }
  });
}

function cwdLine(cwd) {
  return typeof cwd === 'string' && cwd.length > 0 ? `\n目录 ${cwd}` : '';
}

/** 审批请求（CONTEXT: 审批请求） */
export function formatApproval({ label, cwd, toolName, reason, command, commandClip = 800, suppressed = 0 }) {
  const head = `🔐 需要授权 · ${label}`;
  const tool = `\n工具 ${toolName ?? '未知工具'}${reason ? ` · 原因：${clip(String(reason), 200)}` : ''}`;
  const body = typeof command === 'string' && command.length > 0
    ? `\n$ ${clip(command, commandClip)}`
    : '\n（拿不到命令原文；会话可能已不在内存中）';
  const merged = suppressed > 0 ? `\n（节流窗口内另有 ${suppressed} 条审批通知已合并）` : '';
  return `${head}${cwdLine(cwd)}${tool}${body}${merged}`;
}

/**
 * 审批提醒：推送过了，但一直没人处理（不是新请求，别让人以为又来一次）。
 * waitedMs 是这次等待的门限，不是精确的已等时长——计时器就是这个值。
 */
export function formatApprovalReminder({ label, cwd, toolName, waitedMs }) {
  const seconds = Math.max(1, Math.round((Number(waitedMs) || 0) / 1000));
  const head = `⏰ 还在等你授权 · ${label}`;
  const tool = `\n工具 ${toolName ?? '未知工具'} · 已经等了 ${seconds} 秒仍未处理`;
  const tail = '\n（这条只提醒一次；处理完它，agent 才会继续）';
  return `${head}${cwdLine(cwd)}${tool}${tail}`;
}

/** 待选择（CONTEXT: 待选择） */
export function formatChoice({ label, cwd, questions }) {
  const head = `❓ 待你选择 · ${label}`;
  const list = Array.isArray(questions) ? questions : [];
  const blocks = list.map((item, index) => {
    const question = clip(String(item?.question ?? ''), 400) || '（无问题文本）';
    const options = Array.isArray(item?.options) ? item.options : [];
    const labels = options.map((opt) => `     ${opt?.label ?? ''}`).join('\n');
    const multi = item?.multiSelect ? '（可多选）' : '';
    return `\n${index + 1}) ${question}${multi}${labels ? `\n${labels}` : ''}`;
  });
  return `${head}${cwdLine(cwd)}${blocks.join('')}`;
}

/**
 * 任务完成 / 异常结束（CONTEXT: 任务完成、异常结束）。
 * mergeCount > 1 表示该窗口内合并了多个 turn。
 */
export function formatCompletion({
  label,
  cwd,
  reasonKind,
  error,
  mergeCount = 1,
  durationMs,
  toolCalls,
  lastOutput,
  lastOutputChars = 150,
}) {
  const { icon, title } = describeReason(reasonKind, error);
  const merged = mergeCount > 1 ? `（合并 ${mergeCount} 轮）` : '';
  const facts = [];
  const duration = formatDuration(durationMs);
  if (duration) facts.push(`耗时 ${duration}`);
  if (mergeCount > 1) facts.push(`${mergeCount} 轮`);
  if (typeof toolCalls === 'number' && toolCalls > 0) facts.push(`${toolCalls} 次工具调用`);
  const meta = facts.length > 0 ? `\n${facts.join(' · ')}` : '';
  const tail = typeof lastOutput === 'string' && lastOutput.trim().length > 0
    ? `\n最后输出：${clip(lastOutput.trim().replace(/\s+/g, ' '), lastOutputChars)}`
    : '';
  return `${icon} ${title}${merged} · ${label}${cwdLine(cwd)}${meta}${tail}`;
}

/** 从 assistant 消息的 content blocks 里取纯文本 */
export function textOf(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}
