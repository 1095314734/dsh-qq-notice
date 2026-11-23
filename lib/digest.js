/**
 * 漏发队列：QQ 发不出去的通知落在这里，由汇总任务合并成一封邮件（ADR-0004）。
 *
 * 存储是一个 JSONL 文件，逐行追加；损坏的行直接跳过而不是让整个队列失效。
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createDigest({ dir, logger, enabled = true }) {
  const queueFile = join(dir, 'pending.jsonl');
  let ensured;

  async function ensureDir() {
    if (ensured === undefined) ensured = mkdir(dir, { recursive: true });
    return ensured;
  }

  /** 批量记漏发：一次写盘，用于「补发邮件也失败」时整批转入队列 */
  async function pushMany(records) {
    if (!enabled || records.length === 0) return;
    try {
      await ensureDir();
      await appendFile(queueFile, records.map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8');
    } catch (err) {
      logger?.warn?.(`qq-notify: 漏发队列写入失败（${err?.message ?? err}）`);
    }
  }

  return {
    enabled,
    queueFile,

    /** 记一条漏发；enabled=false 或写盘失败都只告警，不影响主流程 */
    async push(record) {
      await pushMany([record]);
    },

    pushMany,

    /** 读出全部漏发；坏行跳过 */
    async read() {
      if (!enabled) return [];
      let raw;
      try {
        raw = await readFile(queueFile, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') return [];
        throw err;
      }
      const records = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          records.push(JSON.parse(trimmed));
        } catch {
          logger?.warn?.('qq-notify: 漏发队列中有无法解析的行，已跳过');
        }
      }
      return records;
    },

    /** 邮件发出后清空；只在发送成功后调用 */
    async clear() {
      if (!enabled) return;
      try {
        await ensureDir();
        await writeFile(queueFile, '', 'utf8');
      } catch (err) {
        logger?.warn?.(`qq-notify: 漏发队列清空失败（${err?.message ?? err}）`);
      }
    },
  };
}
