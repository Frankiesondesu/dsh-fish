/**
 * 记忆的「今天状态」（fork.37，2026-11-04）。
 *
 * fork.36 之后「想不起来」是确定的：同一个词、同一天，问一百次答案一样。
 * 人的回忆不是这样——话到嘴边，今天出得来，明天可能就卡住。
 *
 * 但随机不能是每次调用掷骰子：那会让她以为工具坏了，也没法复现。
 * 所以用「北京日序号 + 事件 id」哈希：同一天、同一条，永远同一个数；
 * 换一天，边缘那一批换一批。
 *
 * 这里守三件事：
 *   1. 同一天问两次，答案必须一样（可复现）
 *   2. 跨天，边缘的那批会变（像人）
 *   3. 核心不受影响：很具体的词永远翻得到，纯泛词永远翻不到
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { searchEvents, RECALL_JITTER } from '../lib/recall.js'

const DAY = 86400000
/** 起点：北京时间 08:00，避开 UTC/北京日的边界 */
const T0 = Date.parse('2026-11-04T00:00:00Z')

const iso = (ms) => new Date(ms).toISOString()

/**
 * 一条卡在门槛附近的账本：
 *   N=32，关键词出现 6 次 → 归一化区分度 ≈ 0.44，
 *   正好落在 needCue 的抖动区间（0.45 × [0.8,1.2] = 0.36~0.54）里。
 */
function edgeLedger(now, word = '皮影') {
  const events = []
  for (let i = 0; i < 6; i++) {
    events.push({ id: `k${i}`, type: 'utterance', ts: iso(now - 400 * DAY), text: `关于${word}的第${i}条` })
  }
  for (let i = 0; i < 26; i++) {
    events.push({ id: `f${i}`, type: 'utterance', ts: iso(now - 1 * DAY), text: `今天天气不错第${i}回` })
  }
  return events
}

const ids = (rows) => rows.map((r) => r.id).sort().join(',')

test('同一天问两次：答案必须一模一样（可复现）', () => {
  const now = T0 + 5 * 3600e3 // 北京 13:00
  const a = searchEvents(edgeLedger(now), '皮影', { now })
  const b = searchEvents(edgeLedger(now), '皮影', { now })
  assert.equal(ids(a.rows), ids(b.rows), '同一天、同一条，哈希必须给出同一个数')
})

test('跨天会变：边缘那一批今天想得起来、明天可能就想不起来', () => {
  const days = Array.from({ length: 30 }, (_, i) => T0 + i * DAY + 5 * 3600e3)
  // 盯**同一条**（k0）：六条一起看的话，只要有一条运气好就算"想起来"，抖动就被平均掉了
  const hit = days.map((now) =>
    searchEvents(edgeLedger(now), '皮影', { now }).rows.some((r) => r.id === 'k0'))
  const yes = hit.filter(Boolean).length
  const no = hit.length - yes
  assert.ok(yes > 0, '总有几天想得起来')
  assert.ok(no > 0, '也总有几天卡住——否则抖动没生效')
})

test('核心不受影响：具体的词跨天都记得', () => {
  const days = Array.from({ length: 20 }, (_, i) => T0 + i * DAY + 5 * 3600e3)
  for (const now of days) {
    // 只在这一条里出现的词：区分度 ≈ 0.80，远高于门槛上限 0.54
    const events = [
      { id: 'only', type: 'utterance', ts: iso(now - 400 * DAY), text: '那条只讲皮影的' },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, type: 'utterance', ts: iso(now - DAY), text: `今天天气不错第${i}回` })),
    ]
    const { rows } = searchEvents(events, '皮影', { now })
    assert.ok(rows.some((r) => r.id === 'only'), '具体的词不该被"今天状态"影响')
  }
})

test('核心不受影响：纯泛词跨天都翻不到', () => {
  const days = Array.from({ length: 20 }, (_, i) => T0 + i * DAY + 5 * 3600e3)
  for (const now of days) {
    // 每条都有「视频」→ 区分度 0，抖动乘多少都过不了
    const events = Array.from({ length: 30 }, (_, i) => ({
      id: `v${i}`, type: 'utterance', ts: iso(now - 400 * DAY), text: `今天看了个视频第${i}回`,
    }))
    const { rows } = searchEvents(events, '视频', { now })
    assert.equal(rows.length, 0, '到处都有的词不该因为运气好就被翻出来')
  }
})

test('jitter=0 退回 fork.36：跨天也完全确定', () => {
  const days = Array.from({ length: 30 }, (_, i) => T0 + i * DAY + 5 * 3600e3)
  const hit = days.map((now) =>
    searchEvents(edgeLedger(now), '皮影', { now, jitter: 0 }).rows.some((r) => r.id === 'k0'))
  assert.equal(new Set(hit).size, 1, '关掉抖动后，30 天的结果必须完全一致')
})

test('默认抖动幅度是 0.2（±20%）', () => {
  assert.equal(RECALL_JITTER, 0.2)
})
