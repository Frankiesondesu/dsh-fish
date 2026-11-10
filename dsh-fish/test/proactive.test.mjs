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
  PROACTIVE_PING,
  proactiveConfig,
  proactiveSection,
  proactiveState,
  turnsToday,
  lastTurnAt,
  silentToday,
  lastSilentAt,
  SILENT_MARK,
  SILENT_MAX_PER_DAY,
  SILENT_QUIET_HOURS,
  idleHoursOf,
  countsForIdle,
  looseEnds,
  recentMaterial,
  registerProactive,
  writeSay,
  saysToday,
} from '../lib/proactive.js'
import { dateKey, normalizeConfig } from '../lib/settings.js'
import { readEvents, writeConfig } from '../lib/store.js'
import { HER_TOOLS } from '../lib/restrict.js'
import { deriveSelf } from '../lib/derive.js'
import { startScheduler } from '../lib/scheduler.js'

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

test('配置读进来会夹紧（issue #67 后只剩频次与冷却）', () => {
  const clamped = proactiveConfig({ proactive: { maxPerDay: 99, minIdleHours: -5, cooldownHours: 999 } })
  assert.equal(clamped.maxPerDay, 12)
  assert.equal(clamped.minIdleHours, 1)
  assert.equal(clamped.cooldownHours, 240)
  assert.equal('baseChance' in clamped, false, '概率那三个键已经删了')
})

test('到点只判闸门，不再掷骰子：state 里没有 chance（issue #67）', () => {
  const now = Date.now()
  const quiet = [ev({ ts: new Date(now - 7 * 3_600_000).toISOString() })]
  const s = proactiveState({ config: ON, events: quiet, now })
  assert.equal(s.ok, true, s.why)
  assert.equal('chance' in s, false)
  // 成长阶段只影响别处；开口这件事不再随阶段改概率
  const s4 = proactiveState({ config: ON, events: quiet, now, model: { stage: 4 } })
  assert.equal(s4.ok, true, s4.why)
  assert.equal('chance' in s4, false)
})

test('刚有人跟她说过话：余温还在，冷却从 4 小时缩到 2 小时', () => {
  const now = Date.now()
  const spoke = (h) => ev({ id: `ev_t_${h}`, type: 'meta', text: `proactive-turn:${dateKey(new Date(now - h * 3_600_000))}:1`, ts: new Date(now - h * 3_600_000).toISOString() })
  const heard = ev({ id: 'ev_h', type: 'heard', text: '他说了一句', ts: new Date(now - 10 * 3_600_000).toISOString() })
  const events = [heard, spoke(3)]

  // 3 小时前刚开过口：默认冷却 4 小时 → 挡着。
  const blocked = proactiveState({ config: ON, events, now })
  assert.equal(blocked.ok, false)
  assert.match(blocked.why, /冷却/)

  // 10 小时前有人跟她说过话（24 小时内）→ 冷却缩到 2 小时 → 放行。
  const warm = proactiveState({ config: ON, events, now, model: { stage: 1 } })
  assert.equal(warm.ok, true, `余温没起作用：${warm.why}`)

  // 冷透了（heard 超过 24 小时）还是 4 小时。
  const cold = [
    ev({ id: 'ev_h2', type: 'heard', text: '很久以前', ts: new Date(now - 30 * 3_600_000).toISOString() }),
    spoke(3),
  ]
  assert.match(proactiveState({ config: ON, events: cold, now, model: { stage: 1 } }).why, /冷却/)
})

test('空手回合的正文只说事实和许可，不写「你应该」', () => {
  const text = proactiveSection({ now: Date.now(), state: { idleHours: 9.5 }, material: [{ id: 'ev_a', type: 'utterance', text: '今天有点累' }], loose: [{ id: 'ev_b', text: '你问过一件事，还没答复。' }] })
  assert.match(text, /没有人跟你说话/)
  assert.match(text, /想说什么就说/)
  assert.match(text, /他回到这个窗口就看得见/, '得说她的话有收件人，不然她以为只是记一笔')
  // 2026-11-02 真机：原来只写「也可以再用 her_say」，她按字面理解就没记，QQ 那边什么都收不到。
  // 两个去处必须如实说清——只写在对话里的，他不在这个窗口就看不到。
  assert.match(text, /只有你用 her_say 发的话/, '得说清「他不在窗口时，只有 her_say 发的才到得了他眼前」')
  // 0.9.1（issue #41）：上游从另一头修同一个谎——「他看得见」只在回到窗口时成立，
  // 能保证的部分是「字落进这条对话」，两边的话都留在正文里。
  assert.match(text, /落进你们俩这条对话里/, '能保证的那一半也要在')
  // 0.9.0（用户 m02937）：「什么都不做」在文本界面上不成立，改成明确的不写。
  assert.match(text, /什么都别写/)
  assert.match(text, /不要写任何字/)
  assert.match(text, /1–6 条/)
  assert.doesNotMatch(text, /你应该/)
  assert.match(text, /\[ev_a\]/)
  // 2026-11-04（用户 m00428）：触发语从「（现在没有人跟你说话。）」改成一个空格。
  // 那句话被宿主按真人发言画成用户气泡，用户怎么都能看见；现在这条消息走
  // `source.kind='fish-wake'`，前端画成收起的折叠条，正文越空越好 ——
  // 以前那句「没有人跟你说话」还会被她在 reasoning 里当成「谁发了这句话给我」去解释。
  assert.equal(PROACTIVE_PING.trim(), '', '投递信号不许带正文，否则她又会去猜这句话是谁说的')
})

test('canLook 开着时给她一条「也可以自己去看点什么」的许可', () => {
  const base = { now: Date.now(), state: { idleHours: 9.5 }, material: [], loose: [] }

  // bili 可用（默认开）→ 让她想起这条路在手边；但只是许可，不是派活
  const on = proactiveSection({ ...base, canLook: true })
  assert.match(on, /bili_look/, 'bili 可用时该让她想到可以去翻一眼')
  assert.match(on, /做什么都行，什么都不做也行/, '许可里必须包含「什么都不做」')
  assert.doesNotMatch(on, /你应该/)

  // bili.enabled=false 的部署：不提她够不着的工具名（fork.13，不能对她说假话）
  assert.doesNotMatch(proactiveSection({ ...base }), /bili_look/)

  // 传参那一头也得在：scheduler 按 bili.enabled 现算，不能写死 true
  const src = readFileSync(new URL('../lib/scheduler.js', import.meta.url), 'utf8')
  assert.match(src, /canLook: config\?\.bili\?\.enabled !== false/)
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
  assert.equal(looseEnds(answered, { now }).length, 0, '「这次不行」就不摆：再提一次就成了追问')

  // 2026-11-07（用户 m01602）：答了却没兑现的，线索不能断。
  // 「以后再说」是「先放着」而不是否决，得继续摆着，否则她开口了、被答了、
  // 然后这件事永远消失——2026-10-29 那张看整条视频的卡就是这么断的。
  const later = [...events, ev({ id: 'ev_l', type: 'answer', ts: new Date(now - 1000).toISOString(), ask: { askId: 'ev_ask', verdict: 'later' } })]
  const l = looseEnds(later, { now })
  assert.equal(l.length, 1, '说了「以后再说」的还得摆着')
  assert.match(l[0].text, /以后再说/)

  const approved = [...events, ev({ id: 'ev_a', type: 'answer', ts: new Date(now - 1000).toISOString(), ask: { askId: 'ev_ask', verdict: 'approve' } })]
  const a = looseEnds(approved, { now })
  assert.equal(a.length, 1, '答应了还没到的也得摆着')
  assert.match(a[0].text, /答应了，还没见到/)

  // 放一天没人答的（`lib/ask.js` 记成 verdict:'later' + via:'timeout'）不是「以后再说」：
  // 什么都没人说。文案还得是「还没有得到答复」，窗口也还是 3 天。
  const timedOut = [...events, ev({ id: 'ev_t', type: 'answer', ts: new Date(now - 1000).toISOString(), ask: { askId: 'ev_ask', verdict: 'later', via: 'timeout' } })]
  const t = looseEnds(timedOut, { now })
  assert.equal(t.length, 1)
  assert.match(t[0].text, /还没有得到答复/)
  assert.doesNotMatch(t[0].text, /以后再说/)
  assert.equal(looseEnds(timedOut, { now: now + 4 * 86_400_000 }).length, 0, '没人答的仍是 3 天窗口')

  // 窗口：没答的 3 天、「以后再说」30 天、答应了 14 天。
  const old = [ev({ id: 'ev_old', type: 'ask', ts: new Date(now - 10 * 86_400_000).toISOString(), text: '十天前问的' })]
  assert.equal(looseEnds(old, { now }).length, 0, '十天没答的就不催了')
  const oldLater = [...old, ev({ id: 'ev_old_ans', type: 'answer', ts: new Date(now - 9 * 86_400_000).toISOString(), ask: { askId: 'ev_old', verdict: 'later' } })]
  assert.equal(looseEnds(oldLater, { now }).length, 1, '十天前说「以后再说」的还摆着')
  const oldApproved = [
    ev({ id: 'ev_vo', type: 'ask', ts: new Date(now - 15 * 86_400_000).toISOString(), text: '十五天前问的' }),
    ev({ id: 'ev_vo_ok', type: 'answer', ts: new Date(now - 14 * 86_400_000).toISOString(), ask: { askId: 'ev_vo', verdict: 'approve' } }),
  ]
  assert.equal(looseEnds(oldApproved, { now }).length, 0, '答应过 14 天还没到的，不再摆')
})

test('her_say 的 refs 给了就要真：超量、不存在、不是材料都拒；不给也放行（2026-11-07 统一）', () => withRoot(async (root) => {
  line(root, ev({ id: 'ev_say', type: 'utterance', text: '我先前的记录', ts: new Date().toISOString() }))
  line(root, ev({ id: 'ev_meta', type: 'meta', text: 'diary:2026-10-30', ts: new Date().toISOString() }))

  // refs 变成可选：不给放行（回复接话有上下文，不需要锚）
  assert.equal((await writeSay(root, { text: '想说的话' })).ok, true)
  assert.match((await writeSay(root, { text: '想说的话', refs: ['ev_say', 'ev_say', 'ev_say', 'ev_say', 'ev_say', 'ev_say', 'ev_say'] })).note, /最多/)
  assert.match((await writeSay(root, { text: '想说的话', refs: ['ev_nope'] })).note, /不存在/)
  assert.match((await writeSay(root, { text: '想说的话', refs: ['ev_meta'] })).note, /不能当材料/)
  assert.match((await writeSay(root, { text: '想'.repeat(PROACTIVE_MAX + 1) })).note, /最多/)
  assert.match((await writeSay(root, { text: '   ' })).note, /写出来/)
}))

test('写下的一句会落成 utterance（带「（她说）」前缀）并留一条 proactive-say 记账', () => withRoot(async (root) => {
  const now = Date.now()
  line(root, ev({ id: 'ev_say', type: 'utterance', text: '我今天有点累', ts: new Date(now - 3_600_000).toISOString() }))

  const r = await writeSay(root, { text: '我想问你，晚饭吃了没有。', refs: ['ev_say'], why: 'care', now })
  assert.equal(r.ok, true, r.note)

  const { events } = await readEvents(root)
  const said = events.find((e) => e.id === r.id)
  assert.equal(said.type, 'utterance')
  assert.match(said.text, /^（她说）我想问你/)
  assert.deepEqual(said.refs, ['ev_say'])

  const meta = events.find((e) => e.type === 'meta' && String(e.text ?? '').startsWith(`proactive-say:${dateKey(new Date(now))}`))
  assert.ok(meta, '得留一条记账，事后查得到她那天为什么开口')
  assert.match(meta.text, /care/)
}))

test('her_say 写几行就按行拆成几条（2026-11-09 用户）：一行一条、空行不算、refs 每条都带', () => withRoot(async (root) => {
  const now = Date.now()
  line(root, ev({ id: 'ev_say2', type: 'utterance', text: '锚', ts: new Date(now - 3_600_000).toISOString() }))

  const r = await writeSay(root, { text: '第一句。\n第二句。\n\n\n第三句。', refs: ['ev_say2'], now })
  assert.equal(r.ok, true, r.note)
  assert.equal(r.count, 3, '三行拆三条，连续空行不算一条')

  const { events } = await readEvents(root)
  const said = events.filter((e) => e.type === 'utterance' && String(e.text ?? '').startsWith('（她说）'))
  assert.deepEqual(said.map((e) => String(e.text)), ['（她说）第一句。', '（她说）第二句。', '（她说）第三句。'])
  assert.ok(said.every((e) => Array.isArray(e.refs) && e.refs[0] === 'ev_say2'), 'refs 每条都带')
  const metas = events.filter((e) => e.type === 'meta' && String(e.text ?? '').startsWith('proactive-say:'))
  assert.equal(metas.length, 1, '一轮只落一条记账——「开口几次」数的是说话这件事，不是消息条数')
  assert.match(r.note, /3 条/)
}))

test('her_say 单行调用行为不变（count=1，note 不变，旧调用方无感）', () => withRoot(async (root) => {
  const r = await writeSay(root, { text: '就一句。' })
  assert.equal(r.ok, true)
  assert.equal(r.count, 1)
  assert.equal(r.note, '发出去了。')
  assert.equal(r.partial, undefined)
}))

test('her_say 不再有每日上限，proactive-say 记账照落（2026-11-07 统一）', () => withRoot(async (root) => {
  const now = Date.now()
  const dk = dateKey(new Date(now))
  await writeConfig(normalizeConfig({ proactive: { enabled: true, maxPerDay: 2 } }), root)

  // 原先 maxPerDay=2 时第三句会被挡（issue #41 那道闸）；统一后 her_say 是回复的
  // 唯一通路，闸拆了，三句都发得出去——记账行留着给统计，不再当闸门。
  for (const t of ['第一句。', '第二句。', '第三句。']) {
    const r = await writeSay(root, { text: t, now })
    assert.equal(r.ok, true, r.note)
  }
  assert.equal(saysToday(await readEvents(root).then((r) => r.events), dk), 3)
}))

test('her_say 写下的 day/stage 是真实成长坐标，不是写死的 1/1（issue #41）', () => withRoot(async (root) => {
  const now = Date.now()
  // seed 落在 40 天前：growthDay 应该算出 41 天左右，而不是恒定 1。
  line(root, ev({ id: 'ev_seed', type: 'seed', text: '起点', ts: new Date(now - 40 * 86_400_000).toISOString() }))
  line(root, ev({ id: 'ev_say', type: 'utterance', text: '我先前的记录', ts: new Date(now - 3_600_000).toISOString() }))
  await writeConfig(normalizeConfig({ proactive: { enabled: true } }), root)

  const { events } = await readEvents(root)
  const model = deriveSelf(events)
  assert.ok(model.day > 30, `seed 40 天前，成长日该是 41 左右，实际 ${model.day}`)

  const r = await writeSay(root, { text: '写一句。', refs: ['ev_say'], now })
  assert.equal(r.ok, true, r.note)
  const after = (await readEvents(root)).events
  const said = after.find((e) => e.id === r.id)
  assert.equal(said.day, model.day, 'day 得跟 deriveSelf 一致，否则 consistency() 会把它当成阶段 1 的旧话')
  assert.equal(said.stage, model.stage)
  const meta = after.find((e) => e.type === 'meta' && String(e.text ?? '').startsWith(`proactive-say:${dateKey(new Date(now))}`))
  assert.equal(meta.day, model.day)
}))

test('her_say 在 0.9.0 起对所有人注册', () => {
  const src = readFileSync(new URL('../lib/proactive.js', import.meta.url), 'utf8')
  assert.match(src, /name: 'her_say'/)
  // 2026-11-07（用户 m01602）：原来每次醒来都摆的 TOOL_ASK_NOTE 常量已经撤掉。
  // 只许在注释里提到它为什么消失，不许再有这个导出。
  assert.doesNotMatch(src, /export const TOOL_ASK_NOTE/)

  const registered = []
  const ctx = { tools: { register: (t) => registered.push(t) } }
  registerProactive(ctx, { root: tmpdir(), log: () => {} })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'her_say')
  // 2026-11-07：refs 本就可选（统一后连必填场景都没了），required 只有 text。
  assert.deepEqual(registered[0].parameters.required, ['text'])
})

test('her_say 的显示结果是 ContentBlock 数组，不是字符串（0.8.2 真机栽在这）', () => {
  const registered = []
  const ctx = { tools: { register: (t) => registered.push(t) } }
  registerProactive(ctx, { root: tmpdir(), log: () => {} })
  const spec = registered[0]

  // 2026-10-30 真机：她连着两次拿到「Error: content.some is not a function」，
  // 第三轮她写「Don't retry a third time」，然后一个字都没说。
  for (const out of [{ ok: true, note: '' }, { ok: false, note: '这条没记下。' }]) {
    const blocks = spec.output.render({}, out)
    assert.ok(Array.isArray(blocks), 'render 必须返回数组，宿主会对它调 content.some')
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'text')
    assert.equal(typeof blocks[0].text, 'string')
    assert.ok(blocks[0].text.length > 0)
  }
  // 2026-11-06（issue #41）：回执原来写「说出去了」，可这一步只落一条流水；
  // 用户此刻看不看得见，由她这一轮有没有直接写正文决定。回执按实际做的事说。
  // 2026-11-07：桥的 push 接上之后它确实会发出去，回执改成「发出去了」。
  assert.match(spec.output.render({}, { ok: true }).at(0).text, /发出去了/)
  assert.match(spec.output.render({}, { ok: false, note: '这条没记下。' }).at(0).text, /没发出去/)
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
  // 那条 diary 是一秒前写的，但它是系统记账、不是谁说的话：idle 时钟停在 1 小时前那个空手回合上。
  // 改之前这里会算成「一秒前刚说过话」——2026-11-01 用户 m02507 修的就是这个。
  assert.ok(idleHoursOf(events, now) > 0.9, '系统记账不许把 idle 时钟往回拨')
  const withSpeak = [...events, ev({ id: 'ev_u', type: 'utterance', ts: new Date(now - 300).toISOString() })]
  assert.ok(idleHoursOf(withSpeak, now) < 0.1, '她真的说了话，才算「刚才说过」')
  assert.equal(idleHoursOf([], now), Infinity, '一条记录都没有时算「很久」')
})

test('meta:quiet 不刷新 idle：今天没找到模板，不等于她刚说过话（用户 m02507）', () => {
  const now = Date.now()
  const quiet = ev({ id: 'ev_q', type: 'meta', text: 'quiet:2026-10-31 无候选模板，今天不打扰', ts: new Date(now - 60_000).toISOString() })
  const spoke = ev({ id: 'ev_u', type: 'utterance', ts: new Date(now - 6 * 3_600_000).toISOString() })
  assert.equal(countsForIdle(quiet), false, 'quiet 是记账行，不算有人说话')
  assert.ok(idleHoursOf([quiet, spoke], now) > 5.9, '时钟还是停在 6 小时前那句真话上')
  assert.equal(idleHoursOf([quiet], now), Infinity, '只有记账行时，等于「一直没人说话」')
})

test('meta:watched 也不刷新 idle：她看了条视频，不等于她说过话（真机 2026-10-30 22:03 那次假阴性）', () => {
  const now = Date.now()
  // 那次现场：她实际安静了 17.55 小时，插件读到 0.01h，来源是一条 meta:watched。
  const watched = ev({ id: 'ev_w', type: 'meta', text: 'watched:BV1xx411c7mD', ts: new Date(now - 36_000).toISOString() })
  const answer = ev({ id: 'ev_a', type: 'answer', text: '可以', ts: new Date(now - 17.55 * 3_600_000).toISOString() })
  assert.equal(countsForIdle(watched), false)
  const idle = idleHoursOf([watched, answer], now)
  assert.ok(idle > 17.5, '应该是 17.5 小时，不是 0.01 小时')
  // 反过来：几种「真的有人说话」的事件都要算。
  for (const type of ['utterance', 'revise', 'heard', 'voice', 'ask', 'answer', 'dream']) {
    assert.equal(countsForIdle(ev({ type })), true, `${type} 应该算`)
  }
  // 2026-11-05 真机（用户 m02797）：`seen:` 不算。它会被别的会话的用户活动误写，
  // 一写就把 idle 清零 → `minIdleHours` 永远不满足 → 主动搭话一次都开不出来。
  assert.equal(countsForIdle(ev({ type: 'meta', text: `seen:${new Date(now).toISOString()}` })), false, 'seen: 不进 idle（会被别的会话误写）')
  const seenOnly = [ev({ id: 'ev_s', type: 'meta', text: `seen:${new Date(now - 2_000).toISOString()}` })]
  assert.equal(idleHoursOf(seenOnly, now), Infinity, '只有 seen: 时等于「一直没有话落进她房间」')
  assert.equal(countsForIdle(ev({ type: 'meta', text: `diary:2026-10-31` })), false, 'diary 不算')
  assert.equal(countsForIdle(ev({ type: 'meta', text: `sched:2026-11-01` })), false, 'sched 不算')
})

test('醒来后没开口的那几次：不占当天额度，但单独限次数、单独隔时间（2026-11-05，用户 m00803）', () => {
  const now = Date.now()
  const dk = dateKey(new Date(now))
  const quiet = [ev({ ts: new Date(now - 10 * 3_600_000).toISOString() })]
  const silent = (h, id = `ev_s${h}`) => ev({
    id,
    type: 'meta',
    text: `${SILENT_MARK}${dk}:${now + h * 3_600_000}`,
    ts: new Date(now + h * 3_600_000).toISOString(),
  })

  // 三次静默、proactive-turn 一次都没有 → 当天的额度一个都没被扣。
  const three = [...quiet, silent(-5), silent(-4), silent(-3)]
  assert.equal(turnsToday(three, dk), 0, '静默不许记成空手回合，否则「醒着没话说」会吃掉额度')
  assert.equal(silentToday(three, dk), 3)
  assert.equal(lastSilentAt(quiet), 0, '没静默过就是 0')
  assert.equal(lastSilentAt(three), now - 3 * 3_600_000)
  // 上一次静默在 3 小时前（超过 SILENT_QUIET_HOURS）→ 放行，额度仍在。
  const ok = proactiveState({ config: ON, events: three, now })
  assert.equal(ok.ok, true, `静默过也不该挡住下一次开口：${ok.why}`)

  // 刚静默过 30 分钟：先隔一会儿，别让「醒来」变成机械动作。
  const justNow = [...quiet, ev({ id: 'ev_s', type: 'meta', text: `${SILENT_MARK}${dk}:${now}`, ts: new Date(now - 30 * 60_000).toISOString() })]
  assert.match(proactiveState({ config: ON, events: justNow, now }).why, /没开口/)

  // 今天已经静默满 SILENT_MAX_PER_DAY 次：停，但仍然没动 proactive-turn 的额度。
  const full = [
    ...quiet,
    ...Array.from({ length: SILENT_MAX_PER_DAY }, (_, i) => silent(-(i + 3), `ev_f${i}`)),
  ]
  assert.equal(turnsToday(full, dk), 0)
  assert.equal(proactiveState({ config: ON, events: full, now }).why.length > 0, true)
  assert.match(proactiveState({ config: ON, events: full, now }).why, /太多次/)
  assert.ok(SILENT_QUIET_HOURS >= 1, '静默间隔至少一小时，不然她会连着醒、连着不说')
})

// ---- tick 里先看开关，再算 deriveSelf ----
//
// tick 每分钟跑一次，deriveSelf 是同步的，事件流长了会卡住主线程。
// 「允许她主动开口」默认就是关的，关着的时候不该为它算这一遍。
//
// deriveSelf 是 scheduler.js 静态 import 的，从外面数不了次数，耗时又不稳，不拿来断言。
// 所以往事件流里放一条它读不了的行：revise 的 refs 不是数组时它会抛，
// tick 接住后记一行 `proactive failed`。日志里有这一行，就是这一趟算过了。
async function twoTicks(root, over, windowOverride) {
  // 2026-11-06：主动性现在也要过「每天几点醒」这一关，所以默认给全天的窗口——
  // tick 才会真的走到 maybeProactive，几点跑都一样。要测「窗口外不开口」
  // 就显式传一个不覆盖此刻的窗口。
  // （2026-11-07 PR #55 @BBleae：不要按此刻现算——0 点时 `hh(-1)` 算出 `-1:00`，
  //  validWindow 不认，normalizeConfig 悄悄退回默认 20:00–23:00，那三条就红。）
  const win = windowOverride ?? ['00:00', '23:59']
  await writeConfig(normalizeConfig({ window: win, ...over }), root)
  line(root, { id: 'ev_unreadable', type: 'revise', ts: new Date().toISOString(), text: '合成', refs: 1 })
  const { events } = await readEvents(root)
  assert.throws(() => deriveSelf(events), TypeError, '这一行得让 deriveSelf 抛，否则下面的断言什么也没测')

  const logs = []
  const s = startScheduler({}, { root, log: (...a) => logs.push(a.join(' ')) })
  const realNow = Date.now
  try {
    await s.tick()
    // 同一分钟内 tick 只算一次，把钟往后拨一分钟。
    const later = realNow() + 60_000
    Date.now = () => later
    await s.tick()
  } finally {
    Date.now = realNow
    s.dispose()
  }
  return logs
}

// fork 口径：进门那行诊断（「调度器已进入主动说话检查」，11-02 加的真机排查线索）保留，
// 所以断言只看 skip 行——上游这句测试的本意是「同一个原因只记一行」，不多不少。
const skips = (logs) => logs.filter((l) => l.startsWith('proactive skip'))

test('tick：主动说话关着不算 deriveSelf，跳过的原因照旧只记一行', async () => {
  await withRoot(async (root) => {
    const logs = await twoTicks(root, {})
    assert.deepEqual(skips(logs), ['proactive skip 主动说话是关着的（config.proactive.enabled 没开，.dev 也不在）'])
  })
})

test('tick：「主动性」关着仍然排在最前面，记的还是它自己那一行', async () => {
  await withRoot(async (root) => {
    const logs = await twoTicks(root, { drive: { enabled: false } })
    assert.deepEqual(skips(logs), ['proactive skip 主动性关着'])
  })
})

test('tick：主动说话开着，每一趟照旧先算 deriveSelf', async () => {
  await withRoot(async (root) => {
    const logs = await twoTicks(root, { proactive: { enabled: true } })
    assert.equal(logs.filter((l) => l.startsWith('proactive failed')).length, 2, logs.join(' | '))
  })
})

// ---------------------------------------------------------------- reply 模式（2026-11-07）

test('回复也走同一个工具：不用 refs，一次调用一条，记账照落（2026-11-07 统一）', async () => {
  await withRoot(async (root) => {
    const r = await writeSay(root, { text: '这是回复里的一条' })
    assert.equal(r.ok, true)
    assert.equal(r.note, '发出去了。')

    const { events } = await readEvents(root)
    const say = events.find((e) => e.type === 'utterance')
    assert.ok(say, '应该落一条 utterance')
    assert.equal(say.text, '（她说）这是回复里的一条')
    assert.equal(say.source, 'tool', 'source 必须是 tool，桥的 push 只认这个')
    assert.equal(events.filter((e) => String(e.text ?? '').startsWith('proactive-say:')).length, 1, '记账行照落：统计认它，不再当闸')
  })
})

test('her_say 的 schema 不再有 reply 字段：主动与回复是同一个动作（2026-11-07 统一）', async () => {
  const src = readFileSync(new URL('../lib/proactive.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /reply: \{ type: 'boolean'/, '工具参数里不该再有 reply')
  await withRoot(async (root) => {
    // writeSay 的 reply 参数已删；就算调用方还传着，也只是被忽略——同一个入口、同一个前缀
    const r = await writeSay(root, { text: '随便谁先开口', reply: true })
    assert.equal(r.ok, true)
    const { events } = await readEvents(root)
    assert.equal(events.find((e) => e.type === 'utterance').text, '（她说）随便谁先开口')
  })
})

test('tick：「每天几点醒」之外的时刻，主动性也不许开口', async () => {
  await withRoot(async (root) => {
    // 窗口排到 5 小时后：此刻一定不在里面。她要是在这种时刻还能主动找他，
    // 「只在这个时段里自己醒」就成了摆设。
    const t = new Date(Date.now() + 5 * 3600_000)
    const hh2 = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const logs = await twoTicks(root, { proactive: { enabled: true } },
      [hh2(t), hh2(new Date(t.getTime() + 30 * 60_000))])
    assert.equal(logs.filter((l) => l.startsWith('proactive')).length, 0, logs.join(' | '))
  })
})
