/**
 * ledger.js —— 账本指纹（fork.48，2026-11-05）
 *
 * 为什么要有它：
 * 「账本只增不改」在这之前**只是代码纪律**。任何人（包括接手的 AI）改一行、
 * 删一条，都不会有任何人发现——包括她自己。她的整个存在建立在这本账上，
 * 至少得有一样东西能回答「这四天是不是一条连续的路」。
 *
 * 它管什么、不管什么（边界必须说清，否则就是过度承诺）：
 *   ✅ 管：写进账本**之后**有没有被改过、有没有少掉、有没有留下写了一半的行。
 *   ❌ 不管：写进去**之前**是不是她的原话。后者靠 store/schema 的只搬原话纪律，
 *           哈希管不了——它只能证明「这一段没动过」，不能证明「这一段是真的」。
 *
 * 为什么指纹认 `id + text` 而不是整行 JSON：
 *   整行会因为字段顺序、空白、`v` 字段补齐而碎——那些都不是篡改。
 *   而 id 或 text 动一个字都会被抓到，这正是我们关心的两个字段。
 *
 * 为什么自己读盘、不用 readEvents()：
 *   那个函数带缓存（eventsStamp 命中就直接返回内存里那份）。校验必须看**磁盘上
 *   现在是什么**，拿缓存校验等于自己骗自己。
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { paths, rootDir, writeAtomic } from './store.js'

export const LEDGER_FILE = 'ledger-sha256.json'
export const LEDGER_VERSION = 1
export const LEDGER_ALGO = 'sha256(id\\ntext)'

/** 一条事件的指纹：id 和 text 各动一个字都会变。 */
export function fingerprint(id, text) {
  return createHash('sha256')
    .update(String(id ?? ''))
    .update('\n')
    .update(String(text ?? ''))
    .digest('hex')
}

export function ledgerPath(root = rootDir()) {
  return join(paths(root).root, LEDGER_FILE)
}

/**
 * 读指纹文件。不存在时 exists=false，不抛——第一次用是正常状态。
 * 文件坏了（JSON 解析失败）也返回 exists=false 并把原因带出来，
 * 让调用方决定是重建还是报警，不在这里替人做决定。
 */
export async function readLedger(root = rootDir()) {
  try {
    const raw = await fs.readFile(ledgerPath(root), 'utf8')
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || !data.entries) {
      return { exists: false, ledger: null, note: '指纹文件结构不对' }
    }
    return { exists: true, ledger: data, note: '' }
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, ledger: null, note: '' }
    return { exists: false, ledger: null, note: `指纹文件读不了：${err.message}` }
  }
}

export async function writeLedger(ledger, root = rootDir()) {
  await writeAtomic(ledgerPath(root), JSON.stringify(ledger, null, 2) + '\n', 0o600)
  return ledger
}

/**
 * 直接扫磁盘上的 events.jsonl。
 *
 * 返回 bad：解析不了的行（写了一半、被截断、非 JSON）。这些行在 readEvents()
 * 里是「跳过但计数」——也就是说她的一段会静默消失，没人知道少的是哪一段。
 * 校验要把行号带出来。
 */
export async function scanEvents(root = rootDir()) {
  const p = paths(root).events
  let raw = ''
  try {
    raw = await fs.readFile(p, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { events: [], bad: [], bytes: 0 }
    throw err
  }
  const events = []
  const bad = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim()
    if (!s) continue
    try {
      const ev = JSON.parse(s)
      if (ev && typeof ev === 'object' && ev.id) events.push(ev)
      else bad.push({ line: i + 1, why: '没有 id' })
    } catch (err) {
      bad.push({ line: i + 1, why: err.message.slice(0, 80) })
    }
  }
  return { events, bad, bytes: Buffer.byteLength(raw, 'utf8') }
}

/**
 * 第一次建指纹。已经有指纹时默认拒绝覆盖——覆盖等于把「被改过」洗成正常，
 * 那是最坏的一种失败方式。要重建必须显式 force。
 */
export async function initLedger(root = rootDir(), { force = false } = {}) {
  const cur = await readLedger(root)
  if (cur.exists && !force) {
    return { ok: false, note: '指纹已存在。要重建请加 --force（它会洗掉已有的差异记录）' }
  }
  const { events, bad, bytes } = await scanEvents(root)
  const entries = {}
  for (const ev of events) {
    entries[ev.id] = { h: fingerprint(ev.id, ev.text), n: String(ev.text ?? '').length }
  }
  const now = new Date().toISOString()
  const ledger = {
    v: LEDGER_VERSION,
    algo: LEDGER_ALGO,
    createdAt: now,
    updatedAt: now,
    count: events.length,
    bytes,
    entries,
  }
  await writeLedger(ledger, root)
  return { ok: true, total: events.length, bad: bad.length, bytes }
}

/**
 * 补新条目。老记录**绝不覆盖**——这是这个模块存在的理由。
 *
 * 如果新事件的 id 已经在指纹里但哈希不同，说明它被改过（或者 id 撞了）。
 * 这种情况不静默改写，报成 conflict 让 verify 去抓。
 */
export async function syncLedger(root = rootDir()) {
  const cur = await readLedger(root)
  if (!cur.exists) {
    const r = await initLedger(root)
    return { ok: r.ok, added: r.total ?? 0, total: r.total ?? 0, conflict: [], created: true, note: r.note ?? '' }
  }
  const ledger = cur.ledger
  if (!ledger.entries) ledger.entries = {}
  const { events, bad } = await scanEvents(root)
  let added = 0
  const conflict = []
  for (const ev of events) {
    const h = fingerprint(ev.id, ev.text)
    const old = ledger.entries[ev.id]
    if (!old) {
      ledger.entries[ev.id] = { h, n: String(ev.text ?? '').length }
      added++
    } else if (old.h !== h) {
      // 不覆盖。让 verify 报出来，人来决定这是不是一次合法的迁移。
      conflict.push(ev.id)
    }
  }
  ledger.updatedAt = new Date().toISOString()
  ledger.count = Object.keys(ledger.entries).length
  await writeLedger(ledger, root)
  return { ok: true, added, total: ledger.count, conflict, bad: bad.length, created: false }
}

/**
 * 校验。四类问题分开报，因为处理方式完全不同：
 *   missing  —— 指纹里有、账本里没有：**丢了**。要么被删，要么文件被回退。
 *   changed  —— 哈希对不上：**被改过**。这是最严重的一类。
 *   extra    —— 账本里有、指纹里没有：新写的，还没 sync。正常，只提示。
 *   bad      —— 解析不了的行：写了一半 / 被截断。她那一段静默消失了。
 *
 * 只有 missing / changed / bad 会让 ok=false。extra 是日常状态。
 */
export async function verifyLedger(root = rootDir()) {
  const cur = await readLedger(root)
  if (!cur.exists) {
    return {
      ok: false,
      initialized: false,
      note: cur.note || '还没有指纹文件，先跑一次 --init',
      missing: [], changed: [], extra: [], bad: [], total: 0,
    }
  }
  const ledger = cur.ledger
  const entries = ledger.entries ?? {}
  const { events, bad } = await scanEvents(root)
  const seen = new Set()
  const missing = []
  const changed = []
  const extra = []
  for (const ev of events) {
    seen.add(ev.id)
    const old = entries[ev.id]
    if (!old) { extra.push(ev.id); continue }
    const h = fingerprint(ev.id, ev.text)
    if (old.h !== h) {
      changed.push({
        id: ev.id,
        wasLen: old.n,
        nowLen: String(ev.text ?? '').length,
        preview: String(ev.text ?? '').slice(0, 60),
      })
    }
  }
  for (const id of Object.keys(entries)) {
    if (!seen.has(id)) missing.push({ id, len: entries[id].n })
  }
  const ok = missing.length === 0 && changed.length === 0 && bad.length === 0
  return {
    ok,
    initialized: true,
    note: '',
    total: events.length,
    fingerprinted: Object.keys(entries).length,
    missing, changed, extra, bad,
  }
}

/** 给体检/日志用的一行。不解释、不评价，只报事实。 */
export function ledgerLine(r) {
  if (!r) return 'ledger=UNKNOWN'
  if (!r.initialized) return 'ledger=NOFINGERPRINT'
  if (r.ok) return `ledger=OK total=${r.total} fp=${r.fingerprinted} extra=${r.extra.length}`
  return `ledger=FAIL total=${r.total} missing=${r.missing.length} changed=${r.changed.length} bad=${r.bad.length}`
}
