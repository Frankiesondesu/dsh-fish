/**
 * capability.js —— 横向·能力（2026-10-25，用户设计「横向·能力」）
 *
 * 用户的设计原话（m07739 拍板按方案二改）：
 *   纵向是立场清单（她站哪边），横向是能力（同一件事她做得比过去好）。
 *   能力不是数值，是**同一类任务上她的表现有没有变**。
 *
 * 只记两个能诚实量到的东西：
 *   ① 任务数 tasks：他每找她说一次话，算一次任务窗口
 *      （一次他说的话 + 她那一轮的回答）。
 *   ② 返工数 reworks：他下一句如果是在说「重做 / 不对 / 不是这样」，
 *      说明上一轮没被采纳。
 *   采纳率 adoption = 1 - reworks / tasks。
 *
 * 为什么不记「她答得好不好」：
 *   那需要给她的每句话打分，而这台机器没有人做标注。用「下一句是不是返工」
 *   是唯一不需要人打分、也不会把主观判断塞进她人格里的信号。
 *
 * 隐私纪律：只落一个 `task:0/1` 的 meta，**不落他的话**。
 *   事件流里本来就只该有她的事；他说的原话只存在于会话历史里。
 */

/** 样本少于这个数就不在界面上给百分比——五个数凑出来的「采纳率 80%」是假精确。 */
export const CAPABILITY_MIN_TASKS = 5

/** 什么算「上一轮没被采纳」：他把同一件事又要了一遍。 */
const REWORK_RE = /重做|重写|重新做|重新写|不对|不是这个|不是这样|不是我要的|再来一遍|再说一遍|再试一次|改一下|改改|还是没有|我说的是|你理解错|没听懂/

/**
 * 这句话像不像在返工。
 * 宁可漏判：把「不对」算成返工最多让采纳率低一点；把闲聊算成返工则会冤枉她。
 */
export function looksLikeRework(text) {
  const s = String(text ?? '').trim()
  if (!s) return false
  // 太长的那段更像在讲一件事，不像在催上一句的返工。
  if (s.length > 120) return false
  return REWORK_RE.test(s)
}

/** 落进事件流的那条 meta（只有 0/1，没有原话）。 */
export function taskMeta(rework) {
  return `task:${rework ? 1 : 0}`
}

/**
 * 从事件流里算能力。
 *
 * @param {Array} events 事件流
 * @returns {{tasks:number, reworks:number, adoption:number|null, enough:boolean, since:string|null, lastAt:string|null}}
 */
export function capabilityOf(events = []) {
  const list = Array.isArray(events) ? events : []
  let tasks = 0
  let reworks = 0
  let since = null
  let lastAt = null
  for (const e of list) {
    if (e?.type !== 'meta') continue
    const m = /^task:([01])$/.exec(String(e.text ?? ''))
    if (!m) continue
    tasks += 1
    if (m[1] === '1') reworks += 1
    if (!since) since = e.ts ?? e.at ?? null
    lastAt = e.ts ?? e.at ?? null
  }
  // 第一条任务没有「上一轮」，不能算进分母，否则第一句话就白扣一次。
  const judged = Math.max(0, tasks - 1)
  const adoption = judged > 0 ? Math.round((1 - reworks / tasks) * 100) / 100 : null
  return {
    tasks,
    reworks,
    adoption,
    enough: tasks >= CAPABILITY_MIN_TASKS,
    since,
    lastAt,
  }
}
