/**
 * wake-spacing.test.mjs —— 一天的几次叫醒不该一分钟一个地连着发（2026-10-29）。
 *
 * 真机：daily.events=2、wakesPerDay=4 时，落点一到，tick 每分钟都问 plan()，
 * plan() 每次都说「还没满，醒」，于是第二次叫醒在第一次之后一分钟进同一个会话。
 * 连带两处「处境被收走」：
 *   - 叫醒排在她正在说的那一轮后面时，watcher 认会话不认这一轮，
 *     那一轮的 turn/end 先把 fish:wake 清掉，真正醒来的那一轮什么都看不到；
 *   - 90 秒兜底不管这一轮结束没有，到点就清（读字幕、看画面常常超过 90 秒）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startScheduler, nextWakeAt } from '../lib/scheduler.js'
import { appendEvent, readEvents, writeConfig } from '../lib/store.js'
import { normalizeConfig, dateKey } from '../lib/settings.js'
import { getWakeSection, clearWakeSection } from '../lib/identity.js'

const at = (h, m, day = 29) => new Date(2026, 9, day, h, m).getTime()
const wakeEv = (t, dk = '2026-10-29') => ({ type: 'meta', text: `wake:${dk} x`, ts: new Date(t).toISOString() })
const cfgA = { window: ['10:00', '03:00'], daily: { events: 2 }, wakesPerDay: 4 }

test('nextWakeAt：今天还没醒过不拦；醒过之后把剩下的摊到时段结束前', () => {
  assert.equal(nextWakeAt([], cfgA, '2026-10-29'), 0)
  // 跨零点的时段在 21:39 醒过：摊到当天午夜前（过了零点日期一换，计数从头算）
  assert.equal(nextWakeAt([wakeEv(at(21, 39))], cfgA, '2026-10-29'), at(21, 39) + (at(24, 0) - at(21, 39)) / 2)
  // 不跨零点：摊到时段结束前
  assert.equal(nextWakeAt([wakeEv(at(14, 0))], { ...cfgA, window: ['08:00', '23:00'] }, '2026-10-29'), at(18, 30))
  // 跨零点而这次是零点后醒的：时段在今天之内结束
  assert.equal(nextWakeAt([wakeEv(at(1, 0))], cfgA, '2026-10-29'), at(2, 0))
  // 太晚了也至少隔 45 分钟
  assert.equal(nextWakeAt([wakeEv(at(23, 40))], cfgA, '2026-10-29'), at(23, 40) + 45 * 60_000)
  // 配额满了交给 plan()；昨天的叫醒不算
  assert.equal(nextWakeAt([wakeEv(at(12, 0)), wakeEv(at(18, 0))], cfgA, '2026-10-29'), 0)
  assert.equal(nextWakeAt([wakeEv(at(12, 0), '2026-10-28')], cfgA, '2026-10-29'), 0)
})

// ---- 真的跑 tick：假宿主 + 临时状态库，时间用 Date.now 偏移推进 ----

function fakeHost(onCreate) {
  const listeners = []
  const prompts = []
  const ctx = {
    on: (ev, fn) => {
      if (ev !== 'session/event') return () => {}
      listeners.push(fn)
      return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) }
    },
    sessionController: {
      create: async () => { await onCreate?.(); throw new Error('exists') },
      prompt: async (req) => { prompts.push({ req, section: getWakeSection() }) },
    },
  }
  const emit = (type) => { for (const fn of [...listeners]) fn({ id: 's-main' }, { type }) }
  return { ctx, prompts, emit, listeners }
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-wake-'))
  const oldHomes = process.env.DSH_FISH_HOMES
  process.env.DSH_FISH_HOMES = join(root, 'homes.json')
  const realNow = Date.now
  const realST = globalThis.setTimeout
  let offset = 0
  Date.now = () => realNow() + offset
  // 等她说完的轮询（2s）、兜底重试（30s）、兜底（90s）压成几毫秒，其余定时器不动
  globalThis.setTimeout = (f, ms, ...a) => realST(f, [2000, 30_000, 90_000].includes(ms) ? 5 : ms, ...a)
  try {
    await writeConfig(normalizeConfig({
      window: ['00:00', '23:59'],
      daily: { events: 2 },
      wakesPerDay: 4,
      browse: { enabled: false },
      comment: { enabled: false },
      rules: { offers: false },
      memory: { sleepEveryDays: 0 },
    }), root)
    // 今天的落点挪到 10 分钟前
    await appendEvent({ type: 'meta', text: `sched:${dateKey()} ${new Date(realNow() - 10 * 60_000).toISOString()}` }, { day: 0, stage: 1, source: 'timer' }, root)
    return await fn(root, { advance: (ms) => { offset += ms }, sleep: (ms) => new Promise((r) => realST(r, ms)) })
  } finally {
    Date.now = realNow
    globalThis.setTimeout = realST
    clearWakeSection()
    if (oldHomes === undefined) delete process.env.DSH_FISH_HOMES
    else process.env.DSH_FISH_HOMES = oldHomes
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('落点之后不再一分钟一个地连着叫；第二次等时间到、也等她说完', async () => {
  await withRoot(async (root, { advance, sleep }) => {
    const h = fakeHost()
    const s = startScheduler(h.ctx, { root, sessionId: 's-main', log: () => {} })
    try {
      await s.tick()
      assert.equal(h.prompts.length, 1, '落点到了醒第一次')
      assert.match(h.prompts[0].section, /叫醒你的信号/)
      h.emit('turn/start'); h.emit('turn/end')
      assert.equal(getWakeSection(), '', '这一轮结束处境撤掉')

      advance(61_000); await s.tick()
      assert.equal(h.prompts.length, 1, '一分钟后不该再叫（修之前这里会醒第二次）')

      const { events } = await readEvents(root)
      const due = nextWakeAt(events, { window: ['00:00', '23:59'], daily: { events: 2 }, wakesPerDay: 4 }, dateKey())
      assert.ok(due >= Date.now() + 40 * 60_000, '第二次至少隔开几十分钟')

      advance(due - Date.now() + 1000)
      h.emit('turn/start') // 到点时她正在跟人说话
      await s.tick()
      assert.equal(h.prompts.length, 1, '她正在说话：先不叫')
      h.emit('turn/end')
      advance(61_000); await s.tick()
      assert.equal(h.prompts.length, 2, '她说完了再叫第二次')

      h.emit('turn/start') // 第二次醒来的这一轮迟迟没结束
      await sleep(40)
      assert.notEqual(getWakeSection(), '', '90 秒兜底到点但这一轮还在：处境不抽走')
      h.emit('turn/end')
      assert.equal(getWakeSection(), '', '这一轮结束才撤')

      advance(6 * 3600_000); await s.tick()
      assert.equal(h.prompts.length, 2, '配额满了不再叫')
      await sleep(30)
      assert.equal(h.listeners.length, 1, '叫醒用的监听用完就摘，只剩忙闲监听')
    } finally {
      s.dispose()
    }
    assert.equal(h.listeners.length, 0, 'dispose 摘掉忙闲监听')
  })
})

test('叫醒准备的几秒里她刚好开始了别的一轮：等那一轮说完再挂处境', async () => {
  await withRoot(async (root) => {
    let h
    h = fakeHost(async () => { h.emit('turn/start'); setTimeout(() => h.emit('turn/end'), 60) })
    const s = startScheduler(h.ctx, { root, sessionId: 's-main', log: () => {} })
    try {
      await s.tick()
      assert.equal(h.prompts.length, 1)
      assert.match(h.prompts[0].section, /叫醒你的信号/, '叫的时候处境还在，没被那一轮的 turn/end 收走')
    } finally {
      s.dispose()
    }
  })
})
