/**
 * askinchat.js —— 让她在会话里直接问那个人（0.7.5，2026-10-29）
 *
 * 以前两件事都只能去观测台点按钮：撒娇式表达的解锁申请、出门想带东西回家。
 * 那两处本质上都是「需要那个人点头」，而点头这件事本来就该在对话里发生——
 * 卡片长在**她那条会话的输入框上方**，人在看她的地方顺手就答了。
 *
 * 这里只做三件事，不碰业务判断：
 *   1. 找到发起这次提问的 live root agent（宿主只认它）
 *   2. 用宿主 `userQuestions.ask()` 把问题丢出去，自己管一个超时
 *   3. 把回答整形成 `{ ok, answers }`，失败一律降级返回，**绝不抛**
 *
 * 为什么不用 `askTimed`：那个通道要求有 `callId` 让客户端登记「前台等待」，
 * 而插件是从工具执行之外（定时器里）发问，没有 callId；一旦客户端没接手，
 * `askTimed` 会走到 noAnswerer 直接 NO_PROVIDER。`ask()` 不带 callId 一样能
 * 渲染卡片（只是没有前台 claim），回答经 waterfall 返回给我们，正是要的路径。
 *
 * 宿主侧限制（asar 已核实，别改成猜的）：
 *   - 带 agent 时必须 `agents.get(agent.id) === agent` 且 `agents.roots()` 含它，
 *     否则 CALLER_NOT_LIVE / DELEGATED_CALLER
 *   - 没人在线时 noAnswerer 抛 NO_PROVIDER
 *   - 卡片挂在 `ctx.sessions.scopeOf(agent)` 那条会话上
 */

import { liveAgentOf } from './identity.js'

/** 一次提问默认等多久：5 分钟。超时不当失败，当「这次没问到」。 */
export const ASK_TIMEOUT_MS = 5 * 60_000

/**
 * 把她想问的话丢进会话里，等那个人选一个。
 *
 * @param {object} ctx 插件上下文（需要注入 userQuestions）
 * @param {object} opts
 * @param {string} opts.sessionId 会话 id（卡片就挂在这条会话上）
 * @param {Array}  opts.questions 宿主格式的问题数组
 * @param {number} [opts.timeoutMs]
 * @param {object} [opts.signal] 外部取消信号（例如这一轮已经结束了）
 * @returns {Promise<{ok: boolean, answers?: Array, code?: string}>}
 */
export async function askInChat(ctx, opts = {}) {
  const {
    sessionId = '',
    questions = [],
    timeoutMs = ASK_TIMEOUT_MS,
    signal = undefined,
    waitAgentMs = 10_000,
  } = opts
  if (!Array.isArray(questions) || questions.length === 0) return { ok: false, code: 'NO_QUESTIONS' }

  // 宿主只接受 live root agent。她那轮刚被 wake 顶起来时，agent 可能还没就位，
  // 所以这里给一小段等待窗口（默认 10 秒）而不是一次查不到就放弃。
  const agent = await waitAgent(ctx, sessionId, { totalMs: waitAgentMs, signal })
  if (!agent) return { ok: false, code: 'NO_AGENT' }

  const service = ctx?.userQuestions
  if (!service || typeof service.ask !== 'function') return { ok: false, code: 'NO_SERVICE' }

  // 自己管超时：宿主的 ask() 没有超时参数，signal 一断它就 reject。
  const ac = new AbortController()
  const kill = setTimeout(() => ac.abort(), Math.max(1, Number(timeoutMs) || ASK_TIMEOUT_MS))
  const onOuter = () => ac.abort()
  if (signal && typeof signal.addEventListener === 'function') {
    if (signal.aborted) ac.abort()
    else signal.addEventListener('abort', onOuter, { once: true })
  }

  try {
    const result = await service.ask({ questions, agent, signal: ac.signal })
    const answers = Array.isArray(result?.answers) ? result.answers : []
    if (!answers.length) return { ok: false, code: 'NO_ANSWER' }
    return { ok: true, answers }
  } catch (err) {
    // 超时、没人接、agent 已经不在了——都是「这次没问到」，不是错误。
    const code = String(err?.code ?? err?.name ?? 'ASK_FAILED')
    return { ok: false, code }
  } finally {
    clearTimeout(kill)
    if (signal && typeof signal.removeEventListener === 'function') {
      try { signal.removeEventListener('abort', onOuter) } catch { /* ignore */ }
    }
  }
}

/**
 * 等那条会话的 live root agent 就位（最多 totalMs）。
 * 她那轮刚被 wake 起来时，agent 可能还在注册路上；查不到就隔一会儿再查。
 * 没有 agent（单测环境、会话已关）时快速返回 null，不做无谓等待。
 */
async function waitAgent(ctx, sessionId, { totalMs = 0, signal = undefined } = {}) {
  const first = liveAgentOf(ctx, sessionId)
  if (first) return first
  // 单测 / 老宿主里没有 agents 注册表：再怎么等也不会有，立刻返回。
  if (!ctx?.get?.('agents')) return null
  const deadline = Date.now() + Math.max(0, Number(totalMs) || 0)
  while (Date.now() < deadline) {
    if (signal?.aborted) return null
    await new Promise((r) => setTimeout(r, 250))
    const hit = liveAgentOf(ctx, sessionId)
    if (hit) return hit
  }
  return null
}

/**
 * 从回答里取出某个问题的选项（没选中返回 ''）。
 *
 * 宿主回传的 `selected[0]` 不一定就是字符串：也可能是 `{label}` / `{value}` / `{text}`。
 * 2026-10-30 真机（用户 m01756）：大肥鱼问了一次，卡片消失却没人记账——
 * 旧实现直接 `String(sel[0])`，拿到对象就变成 `[object Object]`，永远对不上选项。
 * 这里统一拆成文本；`ask.js` 的 `askChoiceIndex` 还会再兜一层下标。
 */
export function picked(answers, id) {
  const hit = (Array.isArray(answers) ? answers : []).find((a) => a?.id === id)
  const sel = hit?.selected
  if (Array.isArray(sel) && sel.length) {
    const one = sel[0]
    const text = one && typeof one === 'object' ? one.label ?? one.value ?? one.text ?? '' : one
    return String(text ?? '').trim()
  }
  if (typeof hit?.custom === 'string' && hit.custom.trim()) return hit.custom.trim()
  return ''
}
