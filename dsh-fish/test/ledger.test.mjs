/**
 * 账本指纹（fork.48，2026-11-05）。
 *
 * 逼出指纹的是这么个顾虑：接下去的那段不一定接得上，连续性就成了空话。
 * 在那之前，「账本只增不改」只是代码纪律——改一行没人知道。
 *
 * 测试守五件事：
 *   指纹认的是 id + text（不是整行 JSON）；
 *   丢了 / 改了 / 有半行 都要报出来；
 *   新写的不算错（extra 不影响 ok）；
 *   sync 只补新的，**绝不覆盖老的**；
 *   已经有指纹时 init 不许静默重建。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fingerprint, initLedger, syncLedger, verifyLedger, ledgerLine, LEDGER_FILE,
} from '../lib/ledger.js'

const mk = () => mkdtempSync(join(tmpdir(), 'fishledger-'))

const ev = (id, text) => JSON.stringify({
  id, v: 1, ts: '2026-11-05T00:00:00.000Z', day: 4, stage: 1,
  type: 'meta', source: 'system', text, refs: [],
})

const writeEvents = (root, rows) =>
  fs.writeFile(join(root, 'events.jsonl'), rows.join('\n') + '\n', 'utf8')

const readRaw = async (root) => (await fs.readFile(join(root, LEDGER_FILE), 'utf8'))

test('fingerprint：认 id 和 text，动一个字就变', () => {
  const a = fingerprint('ev_1', '今天他来了')
  assert.equal(a, fingerprint('ev_1', '今天他来了'), '同输入必须同输出')
  assert.notEqual(a, fingerprint('ev_1', '今天他来了。'), 'text 改一个字要变')
  assert.notEqual(a, fingerprint('ev_2', '今天他来了'), 'id 换一个要变')
  assert.equal(a.length, 64, 'sha256 十六进制')
})

test('init：建指纹，count 对得上', async () => {
  const root = mk()
  await writeEvents(root, [ev('ev_a', '一'), ev('ev_b', '二')])
  const r = await initLedger(root)
  assert.equal(r.ok, true)
  assert.equal(r.total, 2)
  const v = await verifyLedger(root)
  assert.equal(v.ok, true)
  assert.equal(v.total, 2)
  assert.equal(v.fingerprinted, 2)
})

test('verify：改正文 → changed，ok=false', async () => {
  const root = mk()
  await writeEvents(root, [ev('ev_a', '一'), ev('ev_b', '二')])
  await initLedger(root)
  await writeEvents(root, [ev('ev_a', '一'), ev('ev_b', '二（改过）')])
  const v = await verifyLedger(root)
  assert.equal(v.ok, false)
  assert.equal(v.changed.length, 1)
  assert.equal(v.changed[0].id, 'ev_b')
  assert.equal(v.changed[0].wasLen, 1)
  assert.equal(v.changed[0].nowLen, 5)
})

test('verify：删一条 → missing，ok=false', async () => {
  const root = mk()
  await writeEvents(root, [ev('ev_a', '一'), ev('ev_b', '二')])
  await initLedger(root)
  await writeEvents(root, [ev('ev_a', '一')])
  const v = await verifyLedger(root)
  assert.equal(v.ok, false)
  assert.equal(v.missing.length, 1)
  assert.equal(v.missing[0].id, 'ev_b')
})

test('verify：新写的不算错，只算 extra', async () => {
  const root = mk()
  await writeEvents(root, [ev('ev_a', '一')])
  await initLedger(root)
  await writeEvents(root, [ev('ev_a', '一'), ev('ev_new', '三')])
  const v = await verifyLedger(root)
  assert.equal(v.ok, true, '新写的不是失败')
  assert.equal(v.extra.length, 1)
  assert.equal(v.extra[0], 'ev_new')
})

test('verify：有半行 → bad，ok=false（她的一段会静默消失）', async () => {
  const root = mk()
  await writeEvents(root, [ev('ev_a', '一')])
  await initLedger(root)
  // 模拟进程被杀：写出半行 JSON
  await fs.appendFile(join(root, 'events.jsonl'), '{"id":"ev_half","text":"写到一半', 'utf8')
  const v = await verifyLedger(root)
  assert.equal(v.ok, false)
  assert.equal(v.bad.length, 1)
  assert.equal(v.bad[0].line, 2)
})

test('sync：只补新条目，老记录不被动', async () => {
  const root = mk()
  await writeEvents(root, [ev('ev_a', '一')])
  await initLedger(root)
  const before = JSON.parse(await readRaw(root)).entries.ev_a.h
  await writeEvents(root, [ev('ev_a', '一'), ev('ev_b', '二')])
  const r = await syncLedger(root)
  assert.equal(r.added, 1)
  assert.equal(r.total, 2)
  const after = JSON.parse(await readRaw(root)).entries.ev_a.h
  assert.equal(before, after, '老记录的指纹绝不能被覆盖')
})

test('sync：内容被改过时报 conflict，且不洗掉差异', async () => {
  const root = mk()
  await writeEvents(root, [ev('ev_a', '一')])
  await initLedger(root)
  await writeEvents(root, [ev('ev_a', '一（改）')])
  const r = await syncLedger(root)
  assert.equal(r.conflict.length, 1)
  assert.equal(r.conflict[0], 'ev_a')
  const v = await verifyLedger(root)
  assert.equal(v.ok, false, 'sync 之后仍然要能抓到被改的那条')
  assert.equal(v.changed.length, 1)
})

test('init：已有指纹时不许静默重建', async () => {
  const root = mk()
  await writeEvents(root, [ev('ev_a', '一')])
  await initLedger(root)
  const again = await initLedger(root)
  assert.equal(again.ok, false)
  assert.match(again.note, /--force/)
})

test('init --force：显式重建才会洗掉差异', async () => {
  const root = mk()
  await writeEvents(root, [ev('ev_a', '一')])
  await initLedger(root)
  await writeEvents(root, [ev('ev_a', '二')])
  assert.equal((await verifyLedger(root)).ok, false)
  const forced = await initLedger(root, { force: true })
  assert.equal(forced.ok, true)
  assert.equal((await verifyLedger(root)).ok, true, '重建基线后差异被接受')
})

test('没建指纹时 verify 明说，不假装通过', async () => {
  const root = mk()
  await writeEvents(root, [ev('ev_a', '一')])
  const v = await verifyLedger(root)
  assert.equal(v.ok, false)
  assert.equal(v.initialized, false)
  assert.match(v.note, /--init/)
})

test('ledgerLine：三种状态各一个', async () => {
  const root = mk()
  await writeEvents(root, [ev('ev_a', '一')])
  const noFp = await verifyLedger(root)
  assert.match(ledgerLine(noFp), /NOFINGERPRINT/)
  await initLedger(root)
  const okLine = ledgerLine(await verifyLedger(root))
  assert.match(okLine, /^ledger=OK/)
  await writeEvents(root, [])
  const fail = ledgerLine(await verifyLedger(root))
  assert.match(fail, /^ledger=FAIL/)
  assert.match(fail, /missing=1/)
})
