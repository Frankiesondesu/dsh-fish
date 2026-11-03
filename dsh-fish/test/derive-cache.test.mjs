/**
 * deriveSelfCached（fork.27）的语义守卫。
 *
 * 缓存的是「同一本账本、同一分钟、同一 growthDays」的模型。守的是：
 *   - 同输入 → 同一个对象（真缓存，不是每次重算）；
 *   - 账本一变 → 立刻重算（不能拿旧模型）；
 *   - 显式 now / growthDays 不同 → 分开缓存（测试与体检靠这个拿确定结果）；
 *   - 返回的对象是冻结的（谁想改它会当场炸，而不是悄悄把缓存改坏）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSelf, deriveSelfCached, forgetDerived } from '../lib/derive.js'

function seed(ts = '2026-10-01T00:00:00.000Z') {
  return {
    id: 'ev_seed',
    v: 2,
    ts,
    type: 'seed',
    day: 1,
    stage: 1,
    source: 'system',
    text: '开局',
  }
}

function utterance(id, text, ts = '2026-10-02T00:00:00.000Z') {
  return {
    id,
    v: 2,
    ts,
    type: 'utterance',
    day: 2,
    stage: 1,
    source: 'tool',
    text,
  }
}

const NOW = Date.parse('2026-10-05T12:00:00.000Z')

test('同一本账本、同一 now：返回同一个对象', () => {
  forgetDerived()
  const events = [seed(), utterance('ev_1', '我不喜欢被安排。')]
  const a = deriveSelfCached(events, { growthDays: 30, now: NOW })
  const b = deriveSelfCached([...events], { growthDays: 30, now: NOW })
  assert.equal(a, b, '内容相同的两份数组必须命中同一个缓存')
  assert.deepEqual(a, deriveSelf(events, { growthDays: 30, now: NOW }), '缓存结果必须和现算一模一样')
})

test('账本变了：立刻重算，不返回旧模型', () => {
  forgetDerived()
  const events = [seed(), utterance('ev_1', '我不喜欢被安排。')]
  const before = deriveSelfCached(events, { growthDays: 30, now: NOW })
  assert.equal(before.beliefs.length, 1)

  const after = deriveSelfCached([...events, utterance('ev_2', '我想自己决定。')], {
    growthDays: 30,
    now: NOW,
  })
  assert.notEqual(after, before, '加了一条事件就必须是新对象')
  assert.equal(after.beliefs.length, 2)
})

test('改同一条事件的内容也要重算（不能只认 id）', () => {
  forgetDerived()
  const events = [seed(), utterance('ev_1', '我不喜欢被安排。')]
  const before = deriveSelfCached(events, { growthDays: 30, now: NOW })

  const changed = [{ ...events[0] }, { ...events[1], text: '我喜欢被安排。' }]
  const after = deriveSelfCached(changed, { growthDays: 30, now: NOW })
  assert.notEqual(after, before)
  assert.equal(after.beliefs[0].text, '我喜欢被安排。')
})

test('显式 now 不同：分开缓存（成长日会变）', () => {
  forgetDerived()
  const events = [seed()]
  const d5 = deriveSelfCached(events, { growthDays: 30, now: Date.parse('2026-10-05T12:00:00.000Z') })
  const d6 = deriveSelfCached(events, { growthDays: 30, now: Date.parse('2026-10-06T12:00:00.000Z') })
  assert.equal(d5.day, 5)
  assert.equal(d6.day, 6)
  assert.notEqual(d5, d6)
})

test('growthDays 不同：分开缓存（阶段门按成长期算）', () => {
  forgetDerived()
  const events = [seed()]
  const a = deriveSelfCached(events, { growthDays: 30, now: NOW })
  const b = deriveSelfCached(events, { growthDays: 7, now: NOW })
  assert.equal(a.growthDays, 30)
  assert.equal(b.growthDays, 7)
})

test('返回的对象是深冻结的：改它会当场报错', () => {
  forgetDerived()
  const m = deriveSelfCached([seed(), utterance('ev_1', '我不喜欢被安排。')], {
    growthDays: 30,
    now: NOW,
  })
  assert.ok(Object.isFrozen(m))
  assert.ok(Object.isFrozen(m.beliefs), '嵌套数组也要冻')
  assert.throws(() => {
    m.beliefs[0].text = '改掉'
  }, TypeError)
  assert.throws(() => {
    m.beliefs.push({})
  }, TypeError)
})

test('forgetDerived 之后重算（新对象）', () => {
  forgetDerived()
  const events = [seed()]
  const a = deriveSelfCached(events, { growthDays: 30, now: NOW })
  forgetDerived()
  const b = deriveSelfCached(events, { growthDays: 30, now: NOW })
  assert.notEqual(a, b)
  assert.deepEqual(a, b)
})
