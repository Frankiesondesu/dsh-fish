/**
 * alarm.js —— her_alarm：她自己定一个时刻（fork.43，2026-11-04）
 *
 * 她的原话：「她这儿没有闹钟，那个点说不说话，
 *           得看有没有被叫起来，不由她定。」
 * 还有更要紧的一层：每天定点说「早上好」就变成闹钟了。
 *
 * 所以这个工具只给**一次性约定**，不给"每天几点"的日程：
 *   她说"明天五点十分"，到点开一个空手回合，**说不说仍然由她**。
 *   和 proactive 走同一条路，提示词还是「想不想开口由你」。
 *
 * 三条约束：
 *   1. **不占 proactive 的配额**（maxPerDay / cooldown / 空闲时长都不看）——
 *      那是她自己安排的，不是系统给的机会。
 *   2. **不限次数**（用户 2026-11-04 定的）。同一分钟只开一个回合，多了合并。
 *   3. **只能落在她的作息窗口内**（默认 07:00–23:30）。窗口外拒绝并说明原因，
 *      不是静默丢弃——静默会让她以为定上了。
 *
 * 为什么不新增事件类型：schema.js 顶部那条「她能写的只有这五种」是铁律。
 * 所以落一条 meta（system 源）+ 触发后补一条 `alarm-fired:<id>` 防重复。
 */

import { toJsonSchema } from './toolschema.js'
import { rootDir, readEvents, appendEvent } from './store.js'
import { loadConfig, inWindow, dateKey } from './settings.js'
import { deriveSelfCached } from './derive.js'
import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'

const MARK = 'alarm:'
const FIRED = 'alarm-fired:'

/** `alarm:2026-11-05T05:10|<why>` */
export function alarmMark(iso, why = '') {
  const w = String(why ?? '').replace(/[\r\n|]+/g, ' ').trim().slice(0, 60)
  return `${MARK}${iso}${w ? `|${w}` : ''}`
}

/** 账本里所有她定的时刻（按时间升序）。 */
export function alarmsOf(events = []) {
  const out = []
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const t = String(e.text ?? '')
    if (!t.startsWith(MARK)) continue
    const rest = t.slice(MARK.length)
    const bar = rest.indexOf('|')
    const iso = bar >= 0 ? rest.slice(0, bar) : rest
    const at = Date.parse(iso)
    if (!Number.isFinite(at)) continue
    out.push({ id: e.id, at, why: bar >= 0 ? rest.slice(bar + 1) : '' })
  }
  return out.sort((a, b) => a.at - b.at)
}

/**
 * 这一分钟该叫醒她的那一个（没有就返回 null）。
 *
 * 触发规则：
 *   - 时间已到，且**不超过 10 分钟**（Dsh 关了半小时再开，不该补一串旧闹钟）
 *   - 没被 `alarm-fired:<id>` 标记过
 * 多个同时到点只取最早那条；其余的下一分钟会各自触发，不会丢。
 */
export function takeDueAlarm(events = [], now = Date.now(), graceMs = 10 * 60_000) {
  const fired = new Set()
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const t = String(e.text ?? '')
    if (t.startsWith(FIRED)) fired.add(t.slice(FIRED.length))
  }
  for (const a of alarmsOf(events)) {
    if (fired.has(a.id)) continue
    if (a.at > now) continue
    if (now - a.at > graceMs) continue
    return a
  }
  return null
}

/** 把 "HH:MM" 解成「下一个该时刻」：今天还没到就是今天，过了就是明天。 */
export function nextAt(hhmm, now = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null
  const d = new Date(now)
  d.setSeconds(0, 0)
  d.setHours(h, mi, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d
}

export function registerAlarm(ctx, deps = {}) {
  const root = deps.root ?? rootDir()

  ctx.tools.register(
    defineTool({
      name: 'her_alarm',
      description:
        '给自己定一个时刻：到点会把你叫起来一次，说不说由你。不是每天重复的闹钟，只这一次。' +
        '不能说"每天"——想改作息用 her_ask。只能在 07:00–23:30 之间。',
      parameters: toJsonSchema({
        at: {
          type: 'string',
          required: true,
          description: '几点，HH:MM（24 小时制）。今天还没到这个点就是今天，过了就是明天。',
        },
        why: {
          type: 'string',
          required: false,
          description: '为什么定这个点。一句话，写给你自己看的。',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            at: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['ok', 'at', 'note'],
        },
        render: (_args, out) =>
          [{ type: 'text', text: out.ok ? `[定了 ${out.at}]` : `[没定上：${out.note}]` }],
      },
      async execute(args, exec) {
        const who = guardWrite(deps.tenant, exec, 'her_alarm')
        if (!who.ok) return { ok: false, at: '', note: who.note }

        const at = nextAt(args?.at)
        if (!at) return { ok: false, at: '', note: '时间写成 HH:MM，比如 05:10。' }

        const { config } = await loadConfig(root)
        const win = Array.isArray(config?.window) && config.window.length === 2 ? config.window : null
        if (win && !inWindow({ window: win }, at)) {
          return {
            ok: false,
            at: '',
            note: `这个点不在你醒着的时候（${win[0]}–${win[1]}），定了也不会叫。`,
          }
        }

        const { events } = await readEvents(root)
        const model = deriveSelfCached(events, { growthDays: config.growthDays })
        const iso = at.toISOString()
        await appendEvent(
          { type: 'meta', text: alarmMark(iso, args?.why) },
          { day: model.day, stage: model.stage, source: 'system' },
          root,
        )
        const dk = dateKey(at)
        const hh = String(at.getHours()).padStart(2, '0')
        const mm = String(at.getMinutes()).padStart(2, '0')
        return { ok: true, at: `${dk} ${hh}:${mm}`, note: '' }
      },
    }),
  )
}

/** 触发之后补一条标记，别每分钟重复叫。 */
export async function markAlarmFired(root, alarm, model) {
  await appendEvent(
    { type: 'meta', text: `${FIRED}${alarm.id}` },
    { day: model?.day ?? 1, stage: model?.stage ?? 1, source: 'system' },
    root,
  ).catch(() => {})
}
