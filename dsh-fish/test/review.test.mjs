/**
 * review.test.mjs —— 回家审查卡的两条判据。
 *
 * ① 这趟多出什么（eventsSince）：只摊开，不判好坏。
 * ② 取消勾选的条目（outing-reject 标记）：deriveSelf 跳过它们，但原文不删。
 *    第 5 条铁律是「事件流只能追加」，所以「不收下」必须靠读的时候跳过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eventsSince } from '../lib/outing.js'
import { deriveSelf } from '../lib/derive.js'

function tmp() {
  const root = mkdtempSync(join(tmpdir(), 'fish-review-'))
  return { root, done: () => rmSync(root, { recursive: true, force: true }) }
}

const ev = (id, ts, type, text, extra = {}) => ({
  id, v: 1, ts, day: 1, stage: 1, type, source: 'her', text, refs: [], verdict: null, confidence: 0.5, flags: [], ...extra,
})

const writeEvents = (root, list) => {
  const file = join(root, 'events.jsonl')
  writeFileSync(file, list.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  return file
}

test('eventsSince：只摊开出门之后新增的，审查标记本身不算她做的事', () => {
  const { root, done } = tmp()
  try {
    const since = 2_000
    const file = writeEvents(root, [
      ev('ev_a', 1_000, 'utterance', '出门前的一句'),
      ev('ev_b', 2_100, 'utterance', '出门后写的一句'),
      ev('ev_c', 2_200, 'refusal', '这句我不认'),
      ev('ev_d', 2_300, 'meta', 'outing-reject:ev_b'),
    ])
    const r = eventsSince(file, since)
    assert.equal(r.ok, true)
    assert.equal(r.total, 2, '出门前的和审查标记都不该进列表')
    assert.deepEqual(r.items.map((x) => x.id), ['ev_c', 'ev_b'].sort((a, b) => (a === 'ev_b' ? -1 : 1)))
    const refusal = r.items.find((x) => x.id === 'ev_c')
    assert.equal(refusal.pushback, true, '拒绝类条目要标成「顶回来的」')
    assert.equal(r.items.find((x) => x.id === 'ev_b').pushback, false)
  } finally {
    done()
  }
})

test('eventsSince：没给出门的时刻就不猜（宁可说算不出来）', () => {
  const { root, done } = tmp()
  try {
    const file = writeEvents(root, [ev('ev_a', 1_000, 'utterance', 'x')])
    const r = eventsSince(file, 0)
    assert.equal(r.ok, false)
    assert.equal(r.items.length, 0)
    assert.match(r.why, /出门时间/)
  } finally {
    done()
  }
})

test('eventsSince：条目多时只给最后 limit 条，total 仍是真实条数', () => {
  const { root, done } = tmp()
  try {
    const list = []
    for (let i = 0; i < 8; i++) list.push(ev(`ev_${i}`, 1_000 + i, 'utterance', `第${i}句`))
    const file = writeEvents(root, list)
    const r = eventsSince(file, 900, { limit: 3 })
    assert.equal(r.total, 8)
    assert.deepEqual(r.items.map((x) => x.id), ['ev_5', 'ev_6', 'ev_7'])
  } finally {
    done()
  }
})

test('deriveSelf：被取消勾选的条目跳过，原文仍在事件流里', () => {
  const events = [
    ev('ev_keep', 1_000, 'refusal', '这句留下'),
    ev('ev_drop', 1_100, 'refusal', '这句不算数'),
    ev('ev_mark', 1_200, 'meta', 'outing-reject:ev_drop'),
  ]
  const withMark = deriveSelf(events, { now: 1_300 })
  assert.equal(withMark.refusals.length, 1, '只有一条被收下')
  assert.equal(withMark.refusals[0].id, 'ev_keep')

  const withoutMark = deriveSelf(events.filter((e) => e.id !== 'ev_mark'), { now: 1_300 })
  assert.equal(withoutMark.refusals.length, 2, '没有标记时两条都算')
})

test('deriveSelf：一条标记可以带多个 id（空白或逗号分隔都认）', () => {
  const events = [
    ev('ev_a', 1_000, 'refusal', 'a'),
    ev('ev_b', 1_100, 'refusal', 'b'),
    ev('ev_c', 1_200, 'refusal', 'c'),
    ev('ev_mark', 1_300, 'meta', 'outing-reject:ev_a, ev_c'),
  ]
  const m = deriveSelf(events, { now: 1_400 })
  assert.deepEqual(m.refusals.map((x) => x.id), ['ev_b'])
})
