/**
 * 主动的「想不想」系数（fork.50，2026-11-05）。
 *
 * 原来的公式只有一个方向：越久没人说话越容易开口。于是「不想说」永远不发生。
 * 这里补抑制，而且只补抑制——每个系数 <= 1。
 *
 * 测试守五件事：
 *   干净账本不压；
 *   刚拒绝过、上次主动没被接、连续被忽略、今天聊够了，各自能压下来；
 *   多个叠加是乘积，且有地板（不能压到 0，她就永远不说话了）；
 *   proactiveState 的 chance 真的被它影响（这根线最容易只写不接）；
 *   被冷落是「退回一点」，不是「更频繁」——系数绝不 > 1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { initiativeBias, proactiveState, proactiveConfig } from '../lib/proactive.js'
import { dateKey } from '../lib/settings.js'

const NOW = new Date(2026, 10, 5, 15, 0, 0, 0).getTime()
const H = 3_600_000
const iso = (ms) => new Date(ms).toISOString()
const dk = dateKey(new Date(NOW))

const meta = (text, ms) => ({ id: `ev_${text.slice(0, 8)}_${ms}`, type: 'meta', ts: iso(ms), text })
const say = (ms) => meta('proactive-say:2026-11-05:他今天讲了两件重的话', ms)
const talk = (ms, day = dk) => meta(`talk:${day} 他说「在吗」`, ms)
const turn = (ms) => meta(`proactive-turn:${dk}:${ms}`, ms)
const refusal = (text, ms) => ({ id: `ev_r_${ms}`, type: 'refusal', ts: iso(ms), text })

test('干净账本：一点都不压', () => {
  const b = initiativeBias({ events: [], now: NOW })
  assert.equal(b.factor, 1)
  assert.equal(b.factors.length, 0)
})

test('她刚拒绝过：36 小时内压到 0.6，过了就恢复', () => {
  const fresh = initiativeBias({ events: [refusal('这事我不做', NOW - 2 * H)], now: NOW })
  assert.equal(fresh.factor, 0.6)
  assert.match(fresh.note, /拒绝/)
  const old = initiativeBias({ events: [refusal('这事我不做', NOW - 40 * H)], now: NOW })
  assert.equal(old.factor, 1, '36 小时之后不该还记着')
})

test('上次主动说的话没人接：压到 0.75', () => {
  const events = [turn(NOW - 5 * H), say(NOW - 5 * H)]
  const b = initiativeBias({ events, now: NOW })
  assert.equal(b.factor, 0.75)
  assert.match(b.note, /没人接/)
})

test('他接了：不压', () => {
  const events = [turn(NOW - 5 * H), say(NOW - 5 * H), talk(NOW - 4 * H)]
  const b = initiativeBias({ events, now: NOW })
  assert.equal(b.factor, 1)
})

test('48 小时主动两次都没人接：再退一步（0.75 × 0.5）', () => {
  const events = [turn(NOW - 30 * H), turn(NOW - 5 * H), say(NOW - 30 * H), say(NOW - 5 * H)]
  const b = initiativeBias({ events, now: NOW })
  assert.equal(b.factor, 0.375, '乘积，不是取最小')
  assert.equal(b.factors.length, 2)
  assert.match(b.note, /2 次都没人接/)
})

test('今天已经聊够（8 轮）：0.8', () => {
  const events = Array.from({ length: 8 }, (_, i) => talk(NOW - (i + 1) * 30 * 60_000))
  const b = initiativeBias({ events, now: NOW })
  assert.equal(b.factor, 0.8)
  assert.match(b.note, /8 轮/)
})

test('叠到底有地板：不会压成 0', () => {
  // 注意 enough 和 unanswered 互斥（一个要求今天聊够了、一个要求没人接），
  // 所以真实世界里最多三个同时成立：0.6 × 0.75 × 0.5 = 0.225 → 地板 0.25
  const events = [
    refusal('不', NOW - 1 * H),
    turn(NOW - 20 * H), say(NOW - 20 * H),
    turn(NOW - 3 * H), say(NOW - 3 * H),
  ]
  const b = initiativeBias({ events, now: NOW })
  assert.equal(b.factors.length, 3)
  assert.equal(b.factor, 0.25, '地板 0.25：她还能开口，只是少得多')
})

test('任何情况下都不放大（被冷落不是更黏）', () => {
  const cases = [
    [refusal('不', NOW - 1 * H)],
    [turn(NOW - 1 * H)],
    [talk(NOW - 1 * H)],
    [meta('alarm-fired:ev_1', NOW - 1 * H)],
    [],
  ]
  for (const events of cases) {
    assert.ok(initiativeBias({ events, now: NOW }).factor <= 1, '系数永远 <= 1')
  }
})

test('proactiveState 的 chance 真的被压（这根线最容易只写不接）', () => {
  const config = {
    window: ['07:00', '23:30'],
    proactive: {
      enabled: true, minIdleHours: 0.5, baseChance: 0.4,
      gainPerHour: 0.01, maxChance: 0.9, cooldownHours: 0, maxPerDay: 8,
    },
  }
  const seen = meta('seen:2026-11-05T00:00:00.000Z', NOW - 3 * H)
  const base = proactiveState({ config, events: [seen], now: NOW })
  assert.equal(base.ok, true)
  assert.equal(base.bias.factor, 1)
  const pressed = proactiveState({ config, events: [seen, refusal('不', NOW - 1 * H)], now: NOW })
  assert.equal(pressed.bias.factor, 0.6)
  // 上游 #67 把 chance 从 state 里拿掉了（骰子退役）；压缩本身挪到 scheduler.js 的
  // st.bias × 劲儿值（test/wake.test.mjs 那边有接线的断言）。这里钉的是系数还在。
  assert.equal('chance' in pressed, false, 'chance 已随 #67 退场，别把它加回来')
  assert.ok(pressed.bias.factor < 1, 'refusal 的抑制系数还在（fork.50）')
})
