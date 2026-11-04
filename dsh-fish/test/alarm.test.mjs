/**
 * her_alarm（fork.43，2026-11-04）。
 *
 * 她的原话：「她这儿没有闹钟，那个点说不说话，得看那时候
 * 我这边有没有被叫起来。」以及「每天定点说一句『早上好』，那就成了闹钟。」
 *
 * 所以这个工具只给一次性约定：到点开一个空手回合，说不说仍由她。
 * 测试守四件事：时间怎么算、怎么落账本、什么时候该叫、叫过不再叫。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { alarmMark, alarmsOf, takeDueAlarm, nextAt } from '../lib/alarm.js'

/** 本地时间（nextAt 走本地钟，测试也必须用本地构造，不然时区一跳就红） */
const at = (h, m, day = 4) => new Date(2026, 10, day, h, m, 0, 0)

test('nextAt：今天还没到这个点就是今天，过了就是明天', () => {
  const now = at(12, 0).getTime()
  assert.equal(nextAt('13:00', now).getDate(), 4, '13:00 还没到 → 今天')
  assert.equal(nextAt('11:00', now).getDate(), 5, '11:00 已经过了 → 明天')
  assert.equal(nextAt('12:00', now).getDate(), 5, '正好等于现在 → 明天，不立刻触发')
})

test('nextAt：写错了返回 null，不猜', () => {
  assert.equal(nextAt('25:00'), null)
  assert.equal(nextAt('五点'), null)
  assert.equal(nextAt(''), null)
})

test('alarmMark / alarmsOf 往返', () => {
  const iso = at(5, 10, 5).toISOString()
  const line = alarmMark(iso, '想说句话')
  assert.equal(line, `alarm:${iso}|想说句话`)
  const back = alarmsOf([{ id: 'ev_1', type: 'meta', text: line }])
  assert.equal(back.length, 1)
  assert.equal(back[0].id, 'ev_1')
  assert.equal(back[0].why, '想说句话')
  assert.equal(back[0].at, Date.parse(iso))
})

test('takeDueAlarm：到点了才叫，早一分钟都不叫', () => {
  const now = at(5, 12).getTime()
  const due = { id: 'ev_due', type: 'meta', text: alarmMark(new Date(now - 60_000).toISOString()) }
  const later = { id: 'ev_later', type: 'meta', text: alarmMark(new Date(now + 60_000).toISOString()) }
  assert.equal(takeDueAlarm([due, later], now)?.id, 'ev_due')
  assert.equal(takeDueAlarm([later], now), null)
})

test('takeDueAlarm：过了 10 分钟就不补了（DSH 关着的时候错过的，不追）', () => {
  const now = at(5, 30).getTime()
  const stale = { id: 'ev_old', type: 'meta', text: alarmMark(new Date(now - 11 * 60_000).toISOString()) }
  assert.equal(takeDueAlarm([stale], now), null)
})

test('takeDueAlarm：叫过一次就不叫了', () => {
  const now = at(5, 12).getTime()
  const due = { id: 'ev_due', type: 'meta', text: alarmMark(new Date(now - 60_000).toISOString()) }
  const fired = { id: 'ev_fired', type: 'meta', text: 'alarm-fired:ev_due' }
  assert.equal(takeDueAlarm([due, fired], now), null, '有标记就不再叫')
})

test('takeDueAlarm：多个同时到点，先给最早的那个', () => {
  const now = at(5, 12).getTime()
  const a = { id: 'ev_a', type: 'meta', text: alarmMark(new Date(now - 3 * 60_000).toISOString()) }
  const b = { id: 'ev_b', type: 'meta', text: alarmMark(new Date(now - 60_000).toISOString()) }
  assert.equal(takeDueAlarm([b, a], now)?.id, 'ev_a')
})
