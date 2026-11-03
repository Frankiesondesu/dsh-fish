/**
 * wake-math.js —— 唤醒节奏的纯计算（从 scheduler.js 原样搬出，fork.30）
 *
 * 这一层回答的全是「今天还能醒几次、下一次最早什么时候、空档怎么补偿」这类问题：
 * 给定事件流和配置必有确定答案，不读盘、不发请求、不碰调度器的定时器。
 * scheduler.js 原样 re-export，测试从 scheduler 导入的那几个名字一行不用改。
 */

import { findTemplate } from './events.js'
import { dateKey } from './settings.js'

// 一天的第二次及以后的叫醒，离上一次至少隔这么久（见 nextWakeAt）
const WAKE_MIN_GAP_MS = 45 * 60_000

/**
 * 唤醒那一刻的时间与缘由（2026-10-27 用户反馈）。
 *
 * 她在会话里第一次醒来时，只看到「（醒一醒）」，然后自己猜「大概不是我的时段」，
 * 还以为是权限出了问题。与其让她猜，不如把事实摆给她：现在几点、这一次是谁让醒的。
 *
 * `manual` = 有人按了叫醒（观测台按钮 / 首次建屋），否则是定时醒来；
 * `insideWindow` = 这一刻在不在她平时的活动时段里（跨零点窗口也交给 inWindow 判）。
 */
export function wakeTimeLine(now, { manual = false, insideWindow = true } = {}) {
  const d = now instanceof Date ? now : new Date(now)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const t = `${hh}:${mm}`
  if (!manual) return `现在是 ${t}，这一次是你自己醒的。`
  return insideWindow
    ? `现在是 ${t}。有人刚按了叫醒，要你现在醒。`
    : `现在是 ${t}。有人刚按了叫醒——这个点不在你平时的时段，是有人要你现在醒。`
}

/**
 * 今日配额：从事件流里数，不用内存。
 *
 * 2026-10-25 修：原来两处都数不到东西——
 *   · `sent` 只数 `event:` 前缀，但全库没人写 `event:`（唤醒写的是 `wake:`）→ 恒 0；
 *   · `questions` 声明后从不累加 → `daily.questions`（设置页「会向你进行几次提问」）永远拦不住。
 * 于是「每天最多几个事件」「最多几个问题」两个旋钮都是摆设，真正生效的只有 wakesPerDay。
 *
 * 现在统一从 `wake:<日期> <模板id>` 数：一条 wake 就是一个事件；
 * 模板的 asks 决定它算不算一次提问（静态表查询，不依赖模型）。
 */
export function todayCounts(events = [], dk) {
  let sent = 0
  let questions = 0
  let proactive = 0
  for (const e of events) {
    if (e.type !== 'meta') continue
    const t = String(e.text ?? '')
    if (!t.startsWith('wake:')) continue
    const [head, id] = t.slice(5).trim().split(/\s+/)
    if (head !== dk) continue
    proactive++
    sent++
    const tpl = id ? findTemplate(id) : null
    if (tpl?.asks) questions++
  }
  return { dateKey: dk, sent, questions, proactive }
}

/**
 * 这一醒是不是「今天最后一段」（2026-10-29，用户 m01296 B）。
 *
 * plan() 的两个闸门同时生效：`daily.events` 管当天事件数、`wakesPerDay` 管主动唤醒数，
 * 所以当天真正还能醒几次由两者里更小的那个决定。这里按同一口径回答一句话：
 * 已经醒过 `counts.sent` 次，加上这一次是否就顶到上限。
 *
 * 只用于「给个时机」，不参与该不该醒的判断——判断在 plan() 里，别把两件事混成一件。
 */
export function isLastWakeOfDay(config, counts) {
  const cap = Math.min(Number(config?.daily?.events ?? 1), Number(config?.wakesPerDay ?? 1))
  if (!Number.isFinite(cap) || cap <= 0) return false
  return Number(counts?.sent ?? 0) + 1 >= cap
}

/**
 * 今天下一次叫醒最早什么时候（2026-10-29）。
 *
 * 今天还没醒过就不拦（返回 0，交给落点判断）。醒过之后，把剩下的几次摊在
 * 「上一次 → 今天时段结束」这段里：间隔 = 剩余时长 / (剩余次数 + 1)，至少 WAKE_MIN_GAP_MS。
 * 结束点取时段结束与当天午夜里早的那个——过了零点日期一换，计数就从头算了。
 * 配额已满返回 0：那是 plan() 的事（它会 skip），这里不重复判断。
 */
export function nextWakeAt(events = [], config = {}, dk = dateKey()) {
  let last = 0
  for (const e of events) {
    if (e?.type !== 'meta') continue
    const [head] = String(e.text ?? '').startsWith('wake:') ? String(e.text).slice(5).trim().split(/\s+/) : []
    if (head !== dk) continue
    const at = Date.parse(e.ts || '') || 0
    if (at > last) last = at
  }
  if (!last) return 0
  const quota = Math.min(Number(config?.daily?.events ?? 1), Number(config?.wakesPerDay ?? 1))
  const left = quota - todayCounts(events, dk).sent
  if (!(left > 0)) return 0
  const d = new Date(last)
  let end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  const [eh, em] = String(config?.window?.[1] ?? '').split(':').map(Number)
  const windowEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), eh, em).getTime()
  // 不跨零点的时段，或跨零点而这次是零点后醒的：时段在今天之内就结束
  if (Number.isFinite(windowEnd) && windowEnd > last) end = Math.min(end, windowEnd)
  return last + Math.max(WAKE_MIN_GAP_MS, Math.floor((end - last) / (left + 1)))
}

/**
 * 空档天数（2026-10-25）。
 *
 * 她不是一直在跑：DSH 关掉几天、或者某天没到点在窗里，这段空白会白白吃掉成长期。
 * 这里只回答一件事——「距上一次唤醒过了几天」，由调用方决定怎么补偿。
 * 没有任何唤醒记录（刚装好/刚重置）返回 0，不做补偿。
 */
export function gapSinceLastWake(events = [], now = Date.now()) {
  let last = 0
  for (const e of events) {
    if (e.type !== 'meta' || !String(e.text ?? '').startsWith('wake:')) continue
    const at = Date.parse(e.ts || '') || 0
    if (at > last) last = at
  }
  if (!last) return 0
  return Math.max(0, (Number(now ?? Date.now()) - last) / 86_400_000)
}

/**
 * 空档补偿系数。
 *
 * 断了两天以上，这一次唤醒的冷却按一半算——否则短成长期（7 天）里
 * 一次三天没开，剩下的四天就轮不完四张卡。
 * 系数只作用于**这一次**唤醒，不写盘、不累积。
 */
export function gapSqueeze(gapDays) {
  const g = Number(gapDays) || 0
  if (g >= 4) return 0.35
  if (g >= 2) return 0.5
  return 1
}

/**
 * skip 日志要不要写（2026-10-28）。
 *
 * 背景：用户发来的运行日志里，22:15 到 23:00 每分钟一条
 * `skip 今日主动唤醒已满(1/1)`，几十条同样的字把日志刷满，
 * 真正的报错（比如工具有没有注册上）反而被埋掉。
 *
 * 配额是当天的固定值，原因不变就没有重述的必要：同一小时 + 同一原因只记一条。
 * 纯内存判定，不写 events.jsonl——这只是日志噪音，不该污染她的记忆。
 *
 * @param {string} prev  上一次的记录，形如 `2026-10-28T22|今日主动唤醒已满(1/1)`
 * @param {string} dk    日期键 YYYY-MM-DD
 * @param {number} now   毫秒时间戳
 * @param {string} why   这次 skip 的原因
 * @returns {string}     要存下来的新记录；返回等同 prev 时调用方就不该写日志
 */
export function shouldLogSkip(prev, dk, now, why) {
  const hourKey = `${dk}T${new Date(Number(now) || Date.now()).getHours()}`
  const next = `${hourKey}|${String(why ?? '')}`
  return next === prev ? '' : next
}

