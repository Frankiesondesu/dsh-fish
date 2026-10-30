/**
 * proactive.test.mjs —— 她主动开口（0.8.1 本机实验，用户 m04610，只在 .dev 下启用）
 *
 * 为什么单独测：这一层最容易长成「系统命令她说话」。
 * 这里钉住四条边界：
 *   - 触发只是开门，不是任务（prompt 里可以什么都不做，不含「你应该」）；
 *   - 她说的话必须指回真实事件（refs 1–6 条，且得是她自己的话/听见的话）；
 *   - 频率是上限（一天最多几次、冷却几小时），不是每天必须说；
 *   - 工具默认不在白名单里，只有 .dev + 开关打开才会出现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PROACTIVE_MAX,
  PROACTIVE_TRIGGER,
  proactiveConfig,
  proactiveSection,
  proactiveState,
  turnsToday,
  lastTurnAt,
  idleHoursOf,
  looseEnds,
  recentMaterial,
  registerProactive,
  writeSay,
} from '../lib/proactive.js'
import { dateKey } from '../lib/settings.js'
import { readEvents } from '../lib/store.js'
import { HER_TOOLS } from '../lib/restrict.js'

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'fish-proactive-'))
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'events.jsonl'), '', 'utf8')
    return await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function line(root, ev) {
  appendFileSync(join(root, 'events.jsonl'), `${JSON.stringify({ v: 1, stage: 1, refs: [], verdict: null, confidence: 0.5, flags: [], ...ev })}\n`, 'utf8')
}

/** 事件数组直接造出来，避免每个用例都落一次盘。 */
function ev(over = {}) {
  const now = Date.now()
  return {
    id: 'ev_x',
    v: 1,
    ts: new Date(now).toISOString(),
    day: dateKey(new Date(now)),
    stage: 1,
    type: 'utterance',
    source: 'tool',
    text: '一句话',
    refs: [],
    verdict: null,
    confidence: 0.5,
    flags: [],
    ...over,
  }
}

const ON = { proactive: { enabled: true } }

test('六种不该开口的情况各有各的理由，别混成一句「不到时候」', () => {
  const now = Date.now()
  const old = new Date(now - 10 * 3_600_000).toISOString()
  const quiet = [ev({ ts: old })]

  assert.match(proactiveState({ config: {}, events: quiet, now }).why, /关着/)
  assert.match(proactiveState({ config: ON, events: quiet, now, away: { kind: 'outing' } }).why, /不在家/)
  assert.match(proactiveState({ config: ON, events: quiet, now, rested: true }).why, /请了假/)

  const used = [ev({ ts: old }), ev({ id: 'ev_t1', type: 'meta', text: `proactive-turn:${dateKey(new Date(now))}:1`, ts: new Date(now - 3 * 3_600_000).toISOString() }), ev({ id: 'ev_t2', type: 'meta', text: `proactive-turn:${dateKey(new Date(now))}:2`, ts: new Date(now - 2 * 3_600_000).toISOString() })]
  assert.match(proactiveState({ config: ON, events: used, now }).why, /上限/)

  const cooling = [ev({ ts: old }), ev({ id: 'ev_t', type: 'meta', text: `proactive-turn:${dateKey(new Date(now))}:x`, ts: new Date(now - 30 * 60_000).toISOString() })]
  assert.match(proactiveState({ config: ON, events: cooling, now }).why, /冷却/)

  const fresh = [ev({ ts: new Date(now - 60_000).toISOString() })]
  assert.match(proactiveState({ config: ON, events: fresh, now }).why, /还不到时候/)

  // 时间窗：她醒着的时段之外不开口。凌晨三点的一句「我想你了」不是自主，是作息被打乱。
  const away = (new Date(now).getHours() + 2) % 24
  const win = [`${String(away).padStart(2, '0')}:00`, `${String((away + 1) % 24).padStart(2, '0')}:00`]
  assert.match(proactiveState({ config: { ...ON, window: win }, events: quiet, now }).why, /时段/)
})

test('概率随「多久没说话」上升，但有上限；配置读进来会夹紧', () => {
  const now = Date.now()
  const hours = (h) => ev({ ts: new Date(now - h * 3_600_000).toISOString() })
  const a = proactiveState({ config: ON, events: [hours(7)], now })
  const b = proactiveState({ config: ON, events: [hours(20)], now })
  assert.equal(a.ok, true)
  assert.ok(b.chance > a.chance, '越久没说话，越可能开口')
  assert.ok(b.chance <= proactiveConfig(ON).maxChance)

  const far = proactiveState({ config: { proactive: { enabled: true, maxChance: 0.3 } }, events: [hours(99)], now })
  assert.ok(far.chance <= 0.3, '封顶必须生效，不然久了就必触发')

  const clamped = proactiveConfig({ proactive: { maxPerDay: 99, minIdleHours: -5, baseChance: 7 } })
  assert.equal(clamped.maxPerDay, 12)
  assert.equal(clamped.minIdleHours, 0)
  assert.equal(clamped.baseChance, 1)
})

test('空手回合的正文只说事实和许可，不写「你应该」', () => {
  const text = proactiveSection({ now: Date.now(), state: { idleHours: 9.5, chance: 0.3 }, material: [{ id: 'ev_a', type: 'utterance', text: '今天有点累' }], loose: [{ id: 'ev_b', text: '你问过一件事，还没答复。' }] })
  assert.match(text, /没有人跟你说话/)
  assert.match(text, /可以.*什么都不做|也可以什么都不做/)
  assert.match(text, /1–6 条/)
  assert.doesNotMatch(text, /你应该/)
  assert.match(text, /\[ev_a\]/)
  assert.equal(PROACTIVE_TRIGGER.includes('应该'), false, '触发句不布置任务')
  assert.match(PROACTIVE_TRIGGER, /没有人跟你说话/)
})

test('材料只取她自己的话与听见的东西，悬着的事只列未答的 ask', () => {
  const now = Date.now()
  const events = [
    ev({ id: 'ev_u', ts: new Date(now - 3_600_000).toISOString(), text: '我说过一句' }),
    ev({ id: 'ev_m', type: 'meta', ts: new Date(now - 3_600_000).toISOString(), text: 'diary:2026-10-30' }),
    ev({ id: 'ev_h', type: 'heard', ts: new Date(now - 3_600_000).toISOString(), text: '听见一句' }),
    ev({ id: 'ev_ask', type: 'ask', ts: new Date(now - 3_600_000).toISOString(), text: '我想问你一件事' }),
  ]
  const m = recentMaterial(events, { now })
  assert.deepEqual(m.map((x) => x.id).sort(), ['ev_h', 'ev_u'])
  const loose = looseEnds(events, { now })
  assert.equal(loose.length, 1)
  assert.match(loose[0].text, /还没有得到答复/)

  const answered = [...events, ev({ id: 'ev_ans', type: 'answer', ts: new Date(now - 1000).toISOString(), ask: { askId: 'ev_ask', verdict: 'reject' } })]
  assert.equal(looseEnds(answered, { now }).length, 0, '答过了就不再算悬着')
})

test('her_say 必须指回真实事件：没 refs、超量、不存在、不是材料都写不进去', () => withRoot(async (root) => {
  line(root, ev({ id: 'ev_say', type: 'utterance', text: '我先前的记录', ts: new Date().toISOString() }))
  line(root, ev({ id: 'ev_meta', type: 'meta', text: 'diary:2026-10-30', ts: new Date().toISOString() }))

  assert.match((await writeSay(root, { text: '想说的话' })).note, /refs/)
  assert.match((await writeSay(root, { text: '想说的话', refs: ['ev_say', 'ev_say', 'ev_say', 'ev_say', 'ev_say', 'ev_say', 'ev_say'] })).note, /最多/)
  assert.match((await writeSay(root, { text: '想说的话', refs: ['ev_nope'] })).note, /不存在/)
  assert.match((await writeSay(root, { text: '想说的话', refs: ['ev_meta'] })).note, /不能当材料/)
  assert.match((await writeSay(root, { text: '想'.repeat(PROACTIVE_MAX + 1), refs: ['ev_say'] })).note, /最多/)
  assert.match((await writeSay(root, { text: '   ', refs: ['ev_say'] })).note, /写出来/)
}))

test('写下的一句会落成 utterance（带「她主动说」前缀）并留一条 proactive-say 记账', () => withRoot(async (root) => {
  const now = Date.now()
  line(root, ev({ id: 'ev_say', type: 'utterance', text: '我今天有点累', ts: new Date(now - 3_600_000).toISOString() }))

  const r = await writeSay(root, { text: '我想问你，晚饭吃了没有。', refs: ['ev_say'], why: 'care', now })
  assert.equal(r.ok, true, r.note)

  const { events } = await readEvents(root)
  const said = events.find((e) => e.id === r.id)
  assert.equal(said.type, 'utterance')
  assert.match(said.text, /^（她主动说）我想问你/)
  assert.deepEqual(said.refs, ['ev_say'])

  const meta = events.find((e) => e.type === 'meta' && String(e.text ?? '').startsWith(`proactive-say:${dateKey(new Date(now))}`))
  assert.ok(meta, '得留一条记账，事后查得到她那天为什么开口')
  assert.match(meta.text, /care/)
}))

test('默认白名单里没有 her_say；只有 .dev 下注册了才看得见', () => {
  assert.equal(HER_TOOLS.includes('her_say'), false, '公开版不能有这个工具')
  const src = readFileSync(new URL('../lib/proactive.js', import.meta.url), 'utf8')
  assert.match(src, /name: 'her_say'/)
  assert.match(src, /devModeSync/, '注册要跟提示词、界面共用同一个 .dev 判据')

  const registered = []
  const ctx = { tools: { register: (t) => registered.push(t) } }
  registerProactive(ctx, { root: tmpdir(), log: () => {} })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'her_say')
  assert.deepEqual(registered[0].parameters.required, ['text', 'refs'])
})

test('turnsToday / lastTurnAt 只认当日与最近一次，不把别人的 meta 算进来', () => {
  const now = Date.now()
  const dk = dateKey(new Date(now))
  const events = [
    ev({ id: 'ev_t', type: 'meta', text: `proactive-turn:${dk}:${now - 3_600_000}`, ts: new Date(now - 3_600_000).toISOString() }),
    ev({ id: 'ev_d', type: 'meta', text: `proactive-turn:2020-01-01:1`, ts: new Date(now - 5 * 86_400_000).toISOString() }),
    ev({ id: 'ev_other', type: 'meta', text: 'diary:2026-10-30', ts: new Date(now - 1000).toISOString() }),
  ]
  assert.equal(turnsToday(events, dk), 1)
  assert.equal(lastTurnAt(events), now - 3_600_000)
  // ev_other 那一秒前刚写过，所以「安静了多久」要按最近的那条算，别被几小时前的空手回合骗了。
  assert.ok(idleHoursOf(events, now) < 1)
  assert.equal(idleHoursOf([], now), Infinity, '一条记录都没有时算「很久」')
})
