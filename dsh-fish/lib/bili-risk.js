/**
 * bili-risk.js —— 请求限速与风控熔断（从 bili.js 原样搬出，fork.29）
 *
 * 为什么单独一层：限速和熔断是**模块级状态**（RISK / PACE），被 createClient
 * 的每个实例共享；它们和「怎么签名」「怎么解析弹幕」没有关系。
 * bili.js 保留 createClient，并把这里的导出原样 re-export——调用方一行不用改。
 */

/** 这些返回码代表"被风控了"，不是"接口坏了" */
export const RISK_CODES = new Set([-352, -412, -509])

/**
 * 风控熔断（issue #5 重做，2026-10-28）。
 *
 * 原来的写法是**全局一个 30 分钟闸**：任何一次 -412 就把所有接口一起关掉。
 * 在机房 IP / 无 cookie 的场景下，搜索这类"本来就容易 -412"的接口只要踩一次，
 * 接下来的热门、看视频、看画面、写评论全被挡在门外半小时——
 * 一次偶发失败被放大成"插件半小时不干活"。issue #5 报的就是这个。
 *
 * 现在分两级，且**只关自己那一级**：
 *   - 读：起点 60 秒，连续复发翻倍，上限 10 分钟。读请求不该被一次失手打死。
 *   - 写：起点 5 分钟，翻倍，上限 30 分钟。写被风控的代价高，保守些。
 * 任意一次同类请求成功就把该级的连击计数清零——"恢复正常"要能被感知到。
 */
const RISK_READ_BASE_MS = 60_000
const RISK_READ_MAX_MS = 10 * 60_000
const RISK_WRITE_BASE_MS = 5 * 60_000
const RISK_WRITE_MAX_MS = 30 * 60_000

function freshRisk() {
  return { until: 0, streak: 0 }
}
export const RISK = { read: freshRisk(), write: freshRisk() }

/**
 * 请求节奏（issue #5 第二条诉求：间隔可配置）。
 *
 * 放在模块级而不是 createClient 的参数里：客户端被 look / watch / scheduler /
 * comment / video 等七八处各自 new 出来，逐个传参会漏（漏一处就是固定 800ms）。
 * 启动时由 index.js 读设置调一次 setPacing，**所有**客户端跟着变。
 */
export const PACE = { minIntervalMs: 800, jitterMs: 500 }

/**
 * 坏值一律回默认，**绝不当成 0**：0 间隔等于把限速关掉，是最危险的错值。
 * null / '' 也算坏值（Number(null) === 0，不特判就会静默变成不限速）。
 */
function paceNum(v, dflt) {
  if (v === null || v === undefined || v === '') return dflt
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

export function setPacing(o = {}) {
  PACE.minIntervalMs = Math.max(200, Math.min(120_000, paceNum(o.minIntervalMs, 800)))
  PACE.jitterMs = Math.max(0, Math.min(60_000, paceNum(o.jitterMs, 500)))
}

export function getPacing() {
  return { ...PACE }
}

/** 测试用：清掉熔断状态 */
export function resetRisk() {
  RISK.read = freshRisk()
  RISK.write = freshRisk()
}

/** @param {'read'|'write'} kind */
export function inCooldown(kind = 'read', now = Date.now()) {
  const r = RISK[String(kind) === 'write' ? 'write' : 'read']
  return now < r.until
}

/** 记一次风控命中，返回本次冷却时长（毫秒） */
export function noteRisk(kind, now) {
  const k = kind === 'write' ? 'write' : 'read'
  const r = RISK[k]
  r.streak = Math.min(20, r.streak + 1)
  const base = k === 'write' ? RISK_WRITE_BASE_MS : RISK_READ_BASE_MS
  const cap = k === 'write' ? RISK_WRITE_MAX_MS : RISK_READ_MAX_MS
  const ms = Math.min(cap, base * 2 ** (r.streak - 1))
  r.until = now + ms
  return ms
}

/** 一次成功就说明已经恢复，连击清零 */
export function noteOk(kind) {
  const r = RISK[kind === 'write' ? 'write' : 'read']
  r.streak = 0
  r.until = 0
}

/** 冷却多久（给日志/提示用，0 = 没在冷却） */
export function cooldownLeft(kind = 'read', now = Date.now()) {
  const r = RISK[String(kind) === 'write' ? 'write' : 'read']
  return Math.max(0, r.until - now)
}

/**
 * 内存里还剩多久（毫秒）。给观测台用：这一层是进程内的，重启就没了，
 * 和 risk.js 落盘的那份是两个口径，界面要把两句话分开说。
 */
export function memoryCooldown(now = Date.now()) {
  return {
    readMs: Math.max(0, RISK.read.until - now),
    writeMs: Math.max(0, RISK.write.until - now),
    readStreak: RISK.read.streak,
    writeStreak: RISK.write.streak,
  }
}

export const fmtWait = (ms) => (ms >= 60_000 ? `${Math.ceil(ms / 60_000)} 分钟` : `${Math.ceil(ms / 1000)} 秒`)
