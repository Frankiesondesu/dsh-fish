/**
 * swap.mjs 体检逻辑测试（2026-11-12）。
 * 只用临时目录与内存数据，不碰真实账本、不连真实端口、不跑真实 git。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { PORTS, ledgerStats, render } from '../scripts/swap.mjs'

const ev = (n) => JSON.stringify({ type: 'utterance', source: 'tool', text: `（她说）第 ${n} 句`, ts: '2026-11-12T00:00:00Z' })

test('账本指纹：行数与最后一行 sha256 前 12 位', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swap-ledger-'))
  const f = join(dir, 'events.jsonl')
  writeFileSync(f, [ev(1), ev(2), ev(3)].join('\n') + '\n')
  const r = ledgerStats(f)
  assert.equal(r.ok, true)
  assert.equal(r.lines, 3)
  assert.equal(r.lastHash, createHash('sha256').update(ev(3)).digest('hex').slice(0, 12))
})

test('账本指纹：末尾空行不算一条，空账本不编指纹', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swap-ledger-'))
  const f = join(dir, 'events.jsonl')
  writeFileSync(f, ev(1) + '\n\n\n')
  assert.equal(ledgerStats(f).lines, 1)
  writeFileSync(f, '')
  const empty = ledgerStats(f)
  assert.equal(empty.ok, true)
  assert.equal(empty.lines, 0)
  assert.equal(empty.lastHash, '')
})

test('账本指纹：文件不存在如实报读不到，不抛异常', () => {
  const r = ledgerStats(join(tmpdir(), 'swap-no-such-file-xyz', 'events.jsonl'))
  assert.equal(r.ok, false)
  assert.equal(r.lines, 0)
})

test('尾指纹只随最后一行变：中间改了不影响，末尾改了立刻变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swap-ledger-'))
  const f = join(dir, 'events.jsonl')
  writeFileSync(f, [ev(1), ev(2)].join('\n') + '\n')
  const a = ledgerStats(f).lastHash
  writeFileSync(f, [ev(99), ev(2)].join('\n') + '\n')
  assert.equal(ledgerStats(f).lastHash, a, '中间行不影响尾指纹')
  writeFileSync(f, [ev(1), ev(2), ev(3)].join('\n') + '\n')
  assert.notEqual(ledgerStats(f).lastHash, a, '末尾新增一行必须立刻变')
})

test('render：端口仍在跑时明确拒绝交接，全 DOWN 才说安全', () => {
  const base = {
    platform: 'win32',
    ledger: { ok: true, lines: 10, lastHash: 'abcdef123456' },
    repos: { 主仓: { ok: true, head: 'aaa1111', dirty: 0 }, 子仓: { ok: true, head: 'bbb2222', dirty: 2 } },
    snapshot: { ok: true, kb: 85000, mtime: '2026-11-12 00:09' },
  }
  const busy = render({ ...base, ports: PORTS.map((port) => ({ port, up: port === 7788 })) })
  assert.match(busy, /仍在跑：7788/)
  assert.match(busy, /先停全栈，别交接/)
  assert.match(busy, /2 个未提交改动/)

  const clear = render({ ...base, ports: PORTS.map((port) => ({ port, up: false })) })
  assert.match(clear, /全部 DOWN · 可安全交接/)
  assert.match(clear, /10 行 · 尾指纹 abcdef123456/)
  assert.match(clear, /out \/ in 尚未交付/, '不许把没实现的交接说成可用')
})

test('render：git 不可用 / 没快照都如实说，不编数字', () => {
  const r = render({
    platform: 'linux',
    ledger: { ok: false, lines: 0, lastHash: '' },
    repos: { 主仓: { ok: false, head: '', dirty: 0 }, 子仓: { ok: false, head: '', dirty: 0 } },
    ports: PORTS.map((port) => ({ port, up: false })),
    snapshot: { ok: false, kb: 0, mtime: '' },
  })
  assert.match(r, /读不到/)
  assert.match(r, /git 不可用/)
  assert.match(r, /没找到/)
})
