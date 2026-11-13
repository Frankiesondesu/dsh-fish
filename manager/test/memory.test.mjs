/**
 * memory.mjs 的测试（2026-11-12，管理器「记忆同步」面板）。
 *
 * 重点钉两件事：
 *   1. **判定不能看 git sha** —— vault 是滚动静默（每次 amend），sha 变了不代表
 *      记忆变了、sha 没变也不代表没新记忆。靠的是「账本 mtime vs 上次备份成功时刻」。
 *   2. **读不到就说读不到**，不猜、不拿行数冒充结论。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { verdictOf, readLedger, vaultDir } from '../memory.mjs'

test('判定：账本比上次备份新 → local-newer（本机有新记忆还没上去）', () => {
  const v = verdictOf(
    { mtime: '2026-11-12T20:02:00.000Z' },
    { fileAt: '2026-11-12T18:41:00.000Z' },
  )
  assert.equal(v.kind, 'local-newer')
  assert.match(v.note, /还没上去/)
  assert.equal(v.ledgerAt, '2026-11-12T20:02:00.000Z')
  assert.equal(v.backupAt, '2026-11-12T18:41:00.000Z')
})

test('判定：账本不晚于上次备份 → same', () => {
  const v = verdictOf({ mtime: '2026-11-12T18:41:00.000Z' }, { fileAt: '2026-11-12T18:41:00.000Z' })
  assert.equal(v.kind, 'same')
})

test('判定：缺账本或缺备份记录 → unknown，不拿行数或时间猜', () => {
  assert.equal(verdictOf(null, { fileAt: 'x' }).kind, 'unknown')
  assert.equal(verdictOf({ mtime: 'x' }, null).kind, 'unknown')
  assert.match(verdictOf({ mtime: 'x' }, null).note, /备份记录/)
})

test('readLedger：行数照数（坏行也算一行），但 recent 里不许出现坏行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fish-mem-'))
  try {
    const lines = []
    for (let i = 0; i < 50; i += 1) {
      lines.push(JSON.stringify({
        ts: `2026-11-12T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        type: i % 5 === 0 ? 'utterance' : 'meta',
        text: 't' + i,
      }))
    }
    lines.push('{这不是合法 JSON')
    writeFileSync(join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8')

    const r = readLedger(dir)
    assert.equal(r.ok, true)
    assert.equal(r.lines, 51, '账本行数就是文件里有多少行，坏行也占一行')
    assert.ok(r.recent.length <= 6)
    assert.equal(r.recent[0].text, 't49', '倒序：第一条是最后写下的那条')
    assert.ok(r.recent.every((e) => e.text !== ''), '坏行不该混进 recent')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readLedger：没有账本时 ok=false 且给出原因，不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fish-mem-empty-'))
  try {
    const r = readLedger(dir)
    assert.equal(r.ok, false)
    assert.match(r.why, /events\.jsonl/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('vaultDir 指向仓外的 fish-private/vault，不能指到仓库里面', () => {
  const d = vaultDir()
  assert.match(d, /fish-private[\\/]vault$/)
  assert.doesNotMatch(d, /[\\/]fish[\\/]fish-private[\\/]/, '不能在仓库目录里（它是仓外的私人层）')
})
