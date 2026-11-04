import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPusher, parsePushLine, PUSH_MARKERS } from '../push.mjs'

const T0 = Date.parse('2026-11-02T17:00:00.000Z')

function withPusher(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'fish-push-'))
  const file = join(dir, 'events.jsonl')
  const statePath = join(dir, 'push-state.json')
  const sent = []
  let failNext = 0
  const pusher = createPusher({
    file,
    statePath,
    deliver: async (item) => {
      if (failNext > 0) {
        failNext -= 1
        throw new Error('QQ 没连着')
      }
      sent.push(item)
    },
    log: () => {},
    now: () => T0,
  })
  const api = {
    pusher,
    sent,
    file,
    statePath,
    fail: (n = 1) => { failNext = n },
    write: (text) => appendFileSync(file, text),
    event: (over = {}) =>
      JSON.stringify({
        id: 'ev_1',
        type: 'utterance',
        source: 'tool',
        ts: new Date(T0).toISOString(),
        text: '（她主动说）今天风大。',
        ...over,
      }) + '\n',
  }
  return Promise.resolve()
    .then(() => fn(api))
    .finally(() => rmSync(dir, { recursive: true, force: true }))
}

// ---------------------------------------------------------------- 认标记

test('只认带标记的 utterance，别的都不推', () => {
  assert.equal(parsePushLine('不是 json'), null)
  assert.equal(parsePushLine(''), null)
  // growth_commit 记下的判断也是 utterance/source=tool，但不是她说出口的话
  assert.equal(parsePushLine(JSON.stringify({ type: 'utterance', source: 'tool', text: '我原来那句说重了' })), null)
  // 系统写的不算
  assert.equal(parsePushLine(JSON.stringify({ type: 'utterance', source: 'system', text: '（她主动说）喂' })), null)
  // 别的类型不算
  assert.equal(parsePushLine(JSON.stringify({ type: 'narration', source: 'tool', text: '（她主动说）喂' })), null)
  // 只有标记、没有正文不算
  assert.equal(parsePushLine(JSON.stringify({ type: 'utterance', source: 'tool', text: '（她主动说）' })), null)

  const one = parsePushLine(JSON.stringify({ id: 'ev_9', type: 'utterance', source: 'tool', ts: '2026-11-02T09:00:00.000Z', text: '（她主动说）今天风大。' }))
  assert.deepEqual(one, { id: 'ev_9', kind: 'proactive', text: '今天风大。', ts: '2026-11-02T09:00:00.000Z' })
})

test('标记表里每一类都认得出来（陪看将来直接可用）', () => {
  for (const m of PUSH_MARKERS) {
    const got = parsePushLine(JSON.stringify({ type: 'utterance', source: 'tool', text: `${m.tag}嗯。` }))
    assert.equal(got?.kind, m.kind)
    assert.equal(got?.text, '嗯。')
  }
  assert.equal(parsePushLine(JSON.stringify({ type: 'utterance', source: 'tool', text: '（陪你看）这段笑了。' }))?.kind, 'watch')
})

// ---------------------------------------------------------------- 增量读

test('第一次跑只记末尾，不补推历史', () =>
  withPusher(async ({ pusher, sent, file, statePath }) => {
    writeFileSync(file, '（她主动说）昨天的话。\n'.repeat(3).split('\n').filter(Boolean).map((t) => JSON.stringify({ type: 'utterance', source: 'tool', text: t })).join('\n') + '\n')
    const size = statSync(file).size
    const r = await pusher.tick()
    assert.equal(r.pushed, 0)
    assert.equal(sent.length, 0, '历史不该被推出去')
    assert.equal(pusher.offset, size)
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).offset, size, 'offset 要落盘')
  }))

test('新写的一条会被推，标记从正文里去掉', () =>
  withPusher(async ({ pusher, sent, file, event, write }) => {
    writeFileSync(file, event({ text: '（她主动说）以前的话。' }))
    await pusher.tick() // 基线
    write(event({ id: 'ev_2', text: '（她主动说）今天风大。' }))
    const r = await pusher.tick()
    assert.equal(r.pushed, 1)
    assert.deepEqual(sent.map((s) => s.text), ['今天风大。'])
    assert.equal(sent[0].kind, 'proactive')
    assert.equal(sent[0].id, 'ev_2')
  }))

test('没有标记的 utterance（她记下的判断）不推', () =>
  withPusher(async ({ pusher, sent, file, write }) => {
    writeFileSync(file, '')
    await pusher.tick()
    write(JSON.stringify({ id: 'ev_3', type: 'utterance', source: 'tool', text: '我原来那句说重了', ts: new Date(T0).toISOString() }) + '\n')
    write(JSON.stringify({ id: 'ev_4', type: 'meta', source: 'system', text: 'seen:xxx', ts: new Date(T0).toISOString() }) + '\n')
    const r = await pusher.tick()
    assert.equal(r.pushed, 0)
    assert.equal(sent.length, 0)
    assert.equal(pusher.offset, statSync(file).size, '不推的行也要把 offset 推过去')
  }))

test('半行不处理，补齐之后才推（写入中间被读到也不出错）', () =>
  withPusher(async ({ pusher, sent, file, event, write }) => {
    writeFileSync(file, '')
    await pusher.tick()
    const line = event({ text: '（她主动说）半行测试。' })
    const half = Math.floor(line.length / 2)
    write(line.slice(0, half))
    const r1 = await pusher.tick()
    assert.equal(r1.pushed, 0)
    assert.equal(sent.length, 0)
    write(line.slice(half))
    const r2 = await pusher.tick()
    assert.equal(r2.pushed, 1)
    assert.deepEqual(sent.map((s) => s.text), ['半行测试。'])
  }))

test('一次来了两条，按顺序推', () =>
  withPusher(async ({ pusher, sent, file, event, write }) => {
    writeFileSync(file, '')
    await pusher.tick()
    write(event({ id: 'ev_a', text: '（她主动说）第一句。' }) + event({ id: 'ev_b', text: '（她主动说）第二句。' }))
    await pusher.tick()
    assert.deepEqual(sent.map((s) => s.id), ['ev_a', 'ev_b'])
  }))

// ---------------------------------------------------------------- 失败与过期

test('推不出去就停在原处，下一轮重试', () =>
  withPusher(async ({ pusher, sent, file, event, write, fail }) => {
    writeFileSync(file, '')
    await pusher.tick()
    const before = pusher.offset
    write(event({ text: '（她主动说）重试我。' }))
    fail(2) // 这一轮两次都失败
    const r1 = await pusher.tick()
    assert.equal(r1.pushed, 0)
    assert.equal(r1.stopped, true)
    assert.equal(pusher.offset, before, 'offset 不能往前挪，否则这句就丢了')
    const r2 = await pusher.tick()
    assert.equal(r2.pushed, 1, '下一轮应该重试成功')
    assert.deepEqual(sent.map((s) => s.text), ['重试我。'])
  }))

test('放了太久的就不补发了（隔夜的话今早冒出来像鬼）', () =>
  withPusher(async ({ pusher, sent, file, write }) => {
    writeFileSync(file, '')
    await pusher.tick()
    const old = new Date(T0 - 10 * 60 * 1000).toISOString()
    write(JSON.stringify({ id: 'ev_old', type: 'utterance', source: 'tool', ts: old, text: '（她主动说）昨晚的话。' }) + '\n')
    const r = await pusher.tick()
    assert.equal(r.pushed, 0)
    assert.equal(sent.length, 0)
    assert.equal(pusher.offset, statSync(file).size, '过期丢弃也要把 offset 推过去，不然会卡死')
  }))

test('账本变小（被换过）就重新起算，不补推', () =>
  withPusher(async ({ pusher, sent, file, event }) => {
    writeFileSync(file, event({ text: '（她主动说）旧文件。' }) + event({ text: '（她主动说）旧文件二。' }))
    await pusher.tick()
    assert.equal(sent.length, 0)
    writeFileSync(file, event({ text: '（她主动说）新文件。' })) // 截断重写
    const r = await pusher.tick()
    assert.equal(r.pushed, 0)
    assert.equal(sent.length, 0)
    assert.equal(pusher.offset, statSync(file).size)
  }))

test('账本还不存在时不炸，等它出现', () =>
  withPusher(async ({ pusher, sent, file, event }) => {
    const r = await pusher.tick() // file 不存在
    assert.equal(r.pushed, 0)
    assert.equal(sent.length, 0)
    writeFileSync(file, event({ text: '（她主动说）来了。' }))
    const r2 = await pusher.tick() // 第一次见到文件 → 只记末尾
    assert.equal(r2.pushed, 0)
    appendFileSync(file, event({ id: 'ev_2', text: '（她主动说）再来一句。' }))
    const r3 = await pusher.tick()
    assert.equal(r3.pushed, 1)
    assert.deepEqual(sent.map((s) => s.text), ['再来一句。'])
  }))

test('中文与 emoji 不切坏（按字节走，不解码再回算）', () =>
  withPusher(async ({ pusher, sent, file, event, write }) => {
    writeFileSync(file, '')
    await pusher.tick()
    write(event({ text: '（她主动说）风好大🫘，你那边呢？' }))
    await pusher.tick()
    assert.deepEqual(sent.map((s) => s.text), ['风好大🫘，你那边呢？'])
  }))
