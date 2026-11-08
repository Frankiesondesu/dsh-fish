/**
 * observe.mjs —— 观测台/上网/记忆/数据 四页的数据层（2026-11-07 迁移自 DSH 插件侧）
 *
 * 为什么能搬：DSH 侧的观测台（observe.js 约 45 条路由）绝大多数数据来自
 * **纯文件/纯事件函数**（events.jsonl、config.json、diary/、outings.json…），
 * 只要有 root 就能在任何进程里算。viewer 直接 import 插件 lib 的同一批函数——
 * 聚合口径与 DSH 侧一字不差，不养第二套算法（坑 #17）。
 *
 * 搬不了的（进程绑定，页面要注明「去 DSH 侧」）：
 *   B 站扫码登录 / owner cookie（活在 DSH 内存）、评论区「等回复」扫描（要那个 cookie）、
 *   出门/请神的 start/end（要 ctx.agents）、插件自升级、selfcheck（要宿主五件套）、
 *   重置执行 / 迁移执行 / 恢复备份（要 ctx 或属破坏性操作）。
 *
 * 动作只做纯文件写的那几件：裁决（recordGrant）、结申请（settleAsk）、信箱标已读、
 * 清风控、备份导出；叫醒走 DSH 的 /local/wake（local.key 鉴权，与对讲机同一条路）。
 */

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fishRoot } from '../shared/root.mjs'
import { discoverHer, fishKey } from './intercom.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const FISH = join(HERE, '..', 'dsh-fish')
export const ROOT = fishRoot()

const libCache = new Map()
/** 按文件名 import 插件 lib（缓存模块对象；函数内部自带文件戳校验，跨进程安全） */
export async function lib(name) {
  if (!libCache.has(name)) {
    libCache.set(name, await import('file:///' + join(FISH, 'lib', name).replace(/\\/g, '/')))
  }
  return libCache.get(name)
}

/** 每节独立兜底：一节读崩不影响整页，页面上照实说哪节坏了 */
async function section(fn, label) {
  try {
    return { ok: true, ...(await fn()) }
  } catch (err) {
    return { ok: false, why: `${label}：${String(err?.message ?? err)}` }
  }
}

// ---------------------------------------------------------------- 数据聚合

export async function observeData() {
  const store = await lib('store.js')
  const settings = await lib('settings.js')
  const { events } = await store.readEvents(ROOT)
  const { config } = await settings.loadConfig(ROOT)
  const derive = await lib('derive.js')
  const m = derive.deriveSelfCached(events, { growthDays: config.growthDays })

  const [state, away, asks, inbox, bili, memory, data] = await Promise.all([
    section(() => buildState(events, config, m), '状态'),
    section(() => buildAway(), '你不在的时候'),
    section(() => buildAsks(events), '待答申请'),
    section(() => buildInbox(), '信箱'),
    section(() => buildBili(events, config), '上网'),
    section(() => buildMemory(events, config, m), '记忆'),
    section(() => buildDataPages(events), '数据'),
  ])

  return { at: Date.now(), root: ROOT, state, away, asks, inbox, bili, memory, data }
}

/**
 * stability 的缓存（2026-11-08）：#57 抽样池一次 1.9s（k 次留一重算 deriveSelf），
 * 而它是纯函数——账本不变结果不变。账本是追加式的，条数+末条 id 就是可靠签名；
 * stability 还吃 docBudget/beliefsShown/growthDays 三个配置，一并进键。
 * 不缓存的话：每次 /api/observe 冷算 2.4s，其中 81% 是它。
 */
let stabilityCache = { key: '', value: null }
function stabilityKey(events, config, m) {
  const lastId = String(events[events.length - 1]?.id ?? '')
  return [events.length, lastId, config?.memory?.docBudget, config?.memory?.beliefsShown, config?.growthDays, m?.persona?.imported === true].join('|')
}

/** 记忆体检同款缓存（99ms，纯事件计算）。 */
let healthCache = { key: '', value: null }

/** /state 的文件可算部分（tenancy/compat/host/upgrade 是进程信息，不搬） */
async function buildState(events, config, m) {
  const meta = await lib('meta.js')
  const quality = await lib('quality.js')
  const unlock = await lib('unlock.js')
  const rules = await lib('rules.js')
  const stance = await lib('stance.js')
  const home = await lib('home.js')
  const derive = await lib('derive.js')

  const sk = stabilityKey(events, config, m)
  const st = stabilityCache.key === sk
    ? stabilityCache.value
    : (stabilityCache = { key: sk, value: quality.stability(events, { growthDays: config.growthDays }, {
        shown: config?.memory?.beliefsShown,
        budget: config?.memory?.docBudget,
        withBans: m?.persona?.imported !== true,
      }) }).value
  const p = unlock.pendingOffer(events, Date.now())
  const pending = p
    ? (() => {
        const r = rules.ruleById(p.grant?.rule)
        return { id: p.id, rule: p.grant?.rule, title: r?.title ?? '', text: p.text ?? '', day: p.day ?? null }
      })()
    : null
  const c = meta.countEvents(events)
  return {
    day: m.day,
    growthDays: m.growthDays,
    stage: m.stage,
    stageName: m.stageName,
    pendingGate: m.stageGate?.pending ?? null,
    name: m.name,
    beliefCount: m.beliefCount,
    absenceDays: m.absenceDays,
    tension: m.tensions?.[0]
      ? { count: m.tensions.length, a: m.tensions[0].a.text, b: m.tensions[0].b.text }
      : null,
    solidCount: m.solid?.length ?? 0,
    scarCount: m.scars?.length ?? 0,
    stanceCount: stance.buildStances(m).length,
    stanceReady: stance.gatesDone(m),
    counts: {
      utterance: events.filter((e) => e.type === 'utterance').length,
      chat: events.filter((e) => e.type === 'utterance' && Array.isArray(e.flags) && e.flags.includes('uncommitted')).length,
      revise: events.filter((e) => e.type === 'revise').length,
      refusal: events.filter((e) => e.type === 'refusal').length,
      reunion: events.filter((e) => e.type === 'reunion').length,
      total: c.real,
      all: c.all,
      meta: c.meta,
      noise: c.noise,
    },
    quality: {
      stability: { ...st, band: quality.stabilityBand(st) },
      consistency: derive.consistency(events),
      novelty: derive.novelty(events),
    },
    rules: unlock.ruleStatus(events, m, Date.now()),
    pending,
    grants: unlock.activeGrants(events, Date.now()),
    home: await home.homeStatus(ROOT),
  }
}

/** /away：她这两天替你记下的「你不在的时候」 */
async function buildAway() {
  const a = await lib('away.js')
  return { summary: await a.readAway(ROOT) }
}

/** /ask：待答申请（quota + pending + 已答清单） */
async function buildAsks(events) {
  const ask = await lib('ask.js')
  return {
    quota: ask.quotaOf(events),
    pending: ask.pendingAsks(events).map((e) => ({
      id: e.id,
      ts: e.ts,
      kind: String(e?.ask?.kind ?? ''),
      subject: String(e?.ask?.subject ?? ''),
      question: String(e.text ?? ''),
      options: Array.isArray(e?.ask?.options) ? e.ask.options : [],
    })),
    items: ask.askView(events),
  }
}

/** /inbox：她留给你的话（未读在前） */
async function buildInbox() {
  const inbox = await lib('inbox.js')
  const box = await inbox.readInbox(ROOT, { limit: 60, lettersOnly: true })
  return { box }
}

/** /browse /history /comment /risk 的文件可算部分 */
async function buildBili(events, config) {
  const settings = await lib('settings.js')
  const browse = await lib('browse.js')
  const whatseen = await lib('whatseen.js')
  const history = await lib('history.js')
  const comment = await lib('comment.js')
  const risk = await lib('risk.js')
  const dk = settings.dateKey()

  const items = browse.itemsFromEvents(events, dk)
  const seen = whatseen.seenOn(events, dk)
  const lookedAll = []
  for (const e of events) {
    if (e?.type !== 'meta') continue
    const t = String(e.text ?? '')
    if (t.startsWith('looked:')) lookedAll.push(t.slice(7))
  }
  // 评论区「等回复」要 DSH 内存里的 B 站 cookie，搬不了——这里只给账本里她发过的
  const c = config?.comment ?? {}
  const groups = history.historyFromEvents(events, { days: 14 })

  return {
    today: {
      items,
      usedToday: browse.browseCountToday(events, dk),
      watched: seen.watched,
      watchedCount: seen.watched.length,
      glancedCount: seen.glanced.length,
      handed: seen.handed,
      lookedCount: lookedAll.length,
      lookedRecent: lookedAll.slice(-20).reverse(),
    },
    config: {
      browseEnabled: Boolean(config?.browse?.enabled),
      perDay: Number(config?.browse?.perDay ?? 0),
      biliEnabled: Boolean(config?.bili?.enabled),
    },
    history: { groups },
    comment: {
      enabled: c.enabled === true,
      perDay: Number(c.perDay ?? 0),
      usedToday: comment.commentCountToday(events, dk),
      replyPerDay: Number(c.replyPerDay ?? 0),
      replyUsedToday: comment.replyCountToday(events, dk),
      mine: comment.herComments(events, dk),
      needsHostForReplies: true,
    },
    // 内存冷却期（memoryCooldown）活在 DSH 进程里，这里看不到——页面注明
    risk: risk.riskState(ROOT),
  }
}

/** /memory /health：上下文用量与记忆体检（都是纯事件计算） */
async function buildMemory(events, config, m) {
  const selfdoc = await lib('selfdoc.js')
  const persona = await lib('persona.js')
  const store = await lib('store.js')
  const health = await lib('health.js')
  const settings = await lib('settings.js')

  const doc = selfdoc.selfDocStatus(ROOT)
  const budget = Number(config?.memory?.docBudget ?? 2400)
  const shownCap = persona.shownCount(config?.memory?.beliefsShown ?? persona.BELIEF_SHOWN)
  const pb = persona.personaBudget(m, { budget, withBans: m?.persona?.imported !== true, shown: shownCap })
  const diary = await store.listDiary(ROOT).catch(() => [])
  const shown = Math.min(shownCap, m.beliefs.length)
  const folded = Math.max(0, m.beliefs.length - shown)
  const lastSleep = [...events].reverse()
    .find((e) => e?.type === 'meta' && String(e.text ?? '').startsWith('sleep:'))
    const hk = stabilityKey(events, config, m) + ':health'
    const healthV = healthCache.key === hk ? healthCache.value : (healthCache = { key: hk, value: health.examine(events, { growthDays: config?.growthDays }) }).value
  return {
    selfDoc: { chars: pb.used, budget, usedRatio: pb.usedRatio, dropped: pb.dropped, mtime: doc.mtime },
    sections: {
      beliefsShown: shown,
      beliefsFolded: folded,
      refuted: m.refuted.length,
      refused: m.facts?.refused ?? m.refusals.length,
      tensions: m.tensions?.length ?? 0,
      solid: m.solid?.length ?? 0,
      hurts: m.facts?.hurts ?? 0,
      reactions: m.facts?.reactions ?? { accept: 0, insist: 0, hurt: 0, leave: 0, other: 0 },
    },
    diaryCount: diary.length,
    lastSleep: lastSleep?.ts ?? '',
    health: healthV,
  }
}

/** /paths /reports /log /backup /move /import /reset 的状态面（动作不搬） */
async function buildDataPages(events) {
  const store = await lib('store.js')
  const report = await lib('report.js')
  const log = await lib('log.js')
  const move = await lib('move.js')
  const reset = await lib('reset.js')
  const backup = await lib('backup.js')

  const dates = await report.listReports(ROOT)
  const tail = log.tailLog(ROOT, { lines: 80 })
  const hasSeed = events.some((e) => e.type === 'seed')
  return {
    paths: store.paths(ROOT),
    reportDates: dates,
    logTail: tail,
    backupNote: '备份导出在这里就能做；恢复是破坏性操作，留在 DSH 侧。',
    moveStatus: move.moveStatus(ROOT),
    importStatus: { canImport: !hasSeed, reason: hasSeed ? '她已经有自己的起点了。' : '' },
    resetState: await reset.describeState(ROOT),
  }
}

/** 某一天的每日报告（与落盘同一份 buildReport 口径，observe.js /reports 同款） */
export async function reportFor(date) {
  const store = await lib('store.js')
  const settings = await lib('settings.js')
  const report = await lib('report.js')
  const whatseen = await lib('whatseen.js')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) return { ok: false, why: 'date 要写成 2026-11-07' }
  const { events } = await store.readEvents(ROOT)
  const { config } = await settings.loadConfig(ROOT)
  const diary = await store.readDaily('diaryDir', date, ROOT).catch(() => null)
  const md = report.buildReport({
    dateKey: date,
    seen: whatseen.seenOn(events, date),
    events,
    diary,
    diaryVisible: config?.diary?.visible === true,
  })
  return { ok: true, date, md }
}

// ---------------------------------------------------------------- 动作（纯文件写 + /local/wake）

/** 结一张申请（ask.js settleAsk，纯事件写） */
export async function settleAsk({ askId, verdict, reason = '' } = {}) {
  const ask = await lib('ask.js')
  const r = await ask.settleAsk(ROOT, { askId, verdict, reason, via: 'viewer' })
  return r
}

/** 裁决规则卡（grant.js recordGrant，纯事件写；与 DSH /decide 同一条路） */
export async function decideOffer({ verdict, reason = '' } = {}) {
  const store = await lib('store.js')
  const unlock = await lib('unlock.js')
  const grant = await lib('grant.js')
  const { events } = await store.readEvents(ROOT)
  const p = unlock.pendingOffer(events, Date.now())
  if (!p) return { ok: false, error: '现在没有待裁决的申请' }
  const r = await grant.recordGrant(ROOT, {
    offerId: p.id,
    rule: p.grant?.rule || '',
    verdict,
    reason,
  })
  return r.ok ? { ok: true, verdict } : { ok: false, error: r.error }
}

/** 信箱标已读 + 幂等重写 inbox.md */
export async function markInboxRead() {
  const inbox = await lib('inbox.js')
  const r = await inbox.markRead(ROOT)
  await inbox.writeInboxFile(ROOT).catch(() => null)
  return r
}

/** 清 B 站风控（risk.js clearRisk，纯文件写） */
export async function clearBiliRisk() {
  const risk = await lib('risk.js')
  risk.clearRisk(ROOT)
  return { ok: true }
}

/** 备份导出：单文件 json 原样返回（前端下载），不落第二份盘 */
export async function backupBundle() {
  const backup = await lib('backup.js')
  const b = await backup.collectBackup(ROOT)
  return { ...b, fileName: backup.backupFileName() }
}

/**
 * 叫醒：POST DSH 的 /local/wake（2026-11-07 新开的本地通路，local.key 鉴权）。
 * DSH 没开 / 端口探不到时如实说，不假装叫醒了。
 */
export async function wakeHer({ focus = '' } = {}) {
  const port = await discoverHer()
  if (!port) return { ok: false, why: '没找到她的通路（DSH 开着吗？）' }
  try {
    const r = await fetch(`http://127.0.0.1:${port}/dsh-fish/local/wake${focus ? `?focus=${encodeURIComponent(focus)}` : ''}`, {
      method: 'POST',
      headers: { 'x-fish-key': fishKey() },
      signal: AbortSignal.timeout(30_000),
    })
    const j = await r.json().catch(() => null)
    if (!r.ok) return { ok: false, why: String(j?.error ?? `HTTP ${r.status}`) }
    return j
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err) }
  }
}
