import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDigest } from '../lib/digest.js';

async function freshDigest() {
  const dir = await mkdtemp(join(tmpdir(), 'qq-notify-test-'));
  return { dir, digest: createDigest({ dir, logger: undefined, enabled: true }) };
}

test('push → read → clear 的基本闭环', async () => {
  const { digest } = await freshDigest();
  await digest.push({ at: '2026-11-23T08:00:00.000Z', kind: 'approval', text: '需要授权' });
  await digest.push({ at: '2026-11-23T08:01:00.000Z', kind: 'completion', text: '完成' });

  const records = await digest.read();
  assert.equal(records.length, 2);
  assert.equal(records[0].kind, 'approval');

  await digest.clear();
  assert.deepEqual(await digest.read(), []);
});

test('队列不存在时读成空数组', async () => {
  const { digest } = await freshDigest();
  assert.deepEqual(await digest.read(), []);
});

test('坏行被跳过，好行照读', async () => {
  const { dir, digest } = await freshDigest();
  await digest.push({ at: 'x', kind: 'k', text: 'ok' });
  await appendFile(digest.queueFile, 'not json\n', 'utf8');
  const records = await digest.read();
  assert.equal(records.length, 1);
  assert.equal(records[0].text, 'ok');
  assert.ok(dir.length > 0);
});

test('enabled=false 时不写盘也不读', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-notify-off-'));
  const digest = createDigest({ dir, enabled: false });
  await digest.push({ at: 'x', kind: 'k', text: 't' });
  assert.deepEqual(await digest.read(), []);
});
