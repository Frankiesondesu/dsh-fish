/**
 * fork.54：免打扰时段（config.proactive.dnd）的守卫。
 *
 * 来源：AstrBot proactive_chat（522★）的那一课——`window` 是"她什么时候醒着"，
 * 不是"他什么时候不想被打扰"。PAUSE（fork.49）是手动档，dnd 是自动档。
 * 三条必须同时成立：挡得住、可跨零点、不碰她自己的闹钟。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeDnd, dndActive, proactiveState } from '../lib/proactive.js'

const at = (h, m) => new Date(2026, 10, 6, h, m, 0).getTime()

test('normalizeDnd：形状不对的整对丢掉，合法的保留', () => {
  assert.deepEqual(normalizeDnd([['23:00', '07:30']]), [['23:00', '07:30']])
  assert.deepEqual(normalizeDnd([['23:00'], '07:30', [9, 30], ['24:00', '07:00'], ['8:5', '9:00']]), [])
  // 数字会被原样拒绝（时间就是字符串，别猜）
  assert.deepEqual(normalizeDnd('23:00-07:30'), [])
  assert.deepEqual(normalizeDnd(undefined), [])
  assert.deepEqual(normalizeDnd([[' 7:00 ', ' 23:30 ']]), [['7:00', '23:30']], '两侧空格剥掉')
})

test('dndActive：段内挡、段外不挡、跨零点生效', () => {
  const dnd = [['23:00', '07:30']]
  assert.equal(dndActive(dnd, new Date(at(23, 10))), true, '夜里 23:10 在段内')
  assert.equal(dndActive(dnd, new Date(at(3, 40))), true, '凌晨 3:40 在跨零点段内')
  assert.equal(dndActive(dnd, new Date(at(7, 30))), true, '结束时刻含在段内')
  assert.equal(dndActive(dnd, new Date(at(12, 0))), false, '中午不该挡')
  assert.equal(dndActive([], new Date(at(23, 10))), false, '没配就不挡')
  // 多段：任意一段命中就算
  assert.equal(dndActive([['12:30', '13:30'], ['23:00', '07:30']], new Date(at(13, 0))), true)
})

test('proactiveState：dnd 生效于系统叫醒，且各默认闸照旧', () => {
  // 事件流里他 9 小时前说过话（idle 够），上午 10 点——不在任何 dnd 内
  const now = at(10, 0)
  const events = [{ type: 'meta', text: `talk:2026-11-06 他说「早」／她答「早」`, ts: new Date(now - 9 * 3600_000).toISOString() }]
  const base = {
    window: ['07:00', '23:30'],
    proactive: { enabled: true, maxPerDay: 8, minIdleHours: 2, baseChance: 0.25, cooldownHours: 0.5 },
  }
  const off = proactiveState({ config: { ...base, proactive: { ...base.proactive, dnd: [['23:00', '07:30']] } }, events, now })
  assert.equal(off.ok, true, '白天不在免打扰段，不挡')

  const night = at(23, 10)
  const evs2 = [{ type: 'meta', text: `talk:2026-11-06 他说「早」／她答「早」`, ts: new Date(night - 9 * 3600_000).toISOString() }]
  const on = proactiveState({ config: { ...base, proactive: { ...base.proactive, dnd: [['23:00', '07:30']] } }, events: evs2, now: night })
  assert.equal(on.ok, false)
  assert.equal(on.why, '现在是免打扰时段')
  // 同一时刻，没配 dnd 的配置不挡（默认关闭，不加新行为）
  const noCfg = proactiveState({ config: base, events: evs2, now: night })
  assert.equal(noCfg.ok, true)
})
