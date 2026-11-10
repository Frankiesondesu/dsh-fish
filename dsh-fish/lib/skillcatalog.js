/**
 * skillcatalog.js —— 把她上下文里的技能目录摘掉（fork.3，2026-11-01）
 *
 * 为什么需要：`@deepseek-ai/dsh-tool-skill` 会在每次 `agent/pre-step` 把**整份**
 * 技能目录（真实数据 206 条 / 5.5 万字）当作一条 user 消息塞进会话。她的工具面
 * 明明已经被收窄（`skill` 根本不在发给模型的 19 个工具里），目录却照样进——
 * 因为插件判断的是 `ctx.tools.get('skill', agent) === skillTool`，走**注册表**，
 * 不看 `restrict()` 之后的可见面。
 *
 * 代价（真机实测）：她那条约会话里躺着两份目录，共 11 万字，每轮都要重读。
 * 她只有 9 个工具、不写代码，这两百多个技能（Android 模拟器、Cloudflare、
 * Expo……）对她一个字都用不上。
 *
 * 两道闸，都要：
 *   1. `ctx.skills.snapshot()` 对她的 agent 直接返回空 —— 这是**真闸**。
 *      插件拿到空快照后会渲染一份"没有可用技能"的短目录去替换旧的长目录，
 *      于是那 11 万字被就地换掉，而不是一直挂在历史里。
 *   2. `agent/pre-step` 再兜一道，把已经在消息里的 `skill-catalog` 摘掉 ——
 *      万一 snapshot 那道没赶上（宿主改了实现、或者服务拿不到），这条还能挡。
 *      注：这道能否生效取决于钩子先后顺序，所以不能只靠它，见 (1)。
 *
 * 两条都只对**她自己的屋子**生效（`isHerAgent`），你自己写代码的会话拿去，
 * 技能目录原样保留。
 */

import { isHerAgent } from './restrict.js'

/**
 * @param {object} ctx 宿主 ctx
 * @param {{herDir?: string, log?: Function}} deps
 * @returns {() => void} 注销函数
 */
export function registerSkillCatalogGuard(ctx, deps = {}) {
  const herDir = String(deps.herDir ?? '')
  const log = deps.log ?? (() => {})
  const disposers = []
  if (!herDir) return () => {}

  const isHers = (agent) => {
    try {
      return isHerAgent(agent, herDir)
    } catch {
      return false
    }
  }

  // ---- 闸一：让技能快照对她的会话返回空 ----
  try {
    const skills = (typeof ctx?.get === 'function' ? ctx.get('skills') : undefined) ?? ctx?.skills
    if (skills && typeof skills?.snapshot === 'function' && skills.__fishGuarded !== true) {
      const orig = skills.snapshot
      skills.snapshot = async function guardedSnapshot(opts = {}) {
        if (opts?.scope && isHers(opts.scope)) {
          // complete:true 很重要——插件见 false 会"保留上一次的视图什么都不发"，
          // 那样旧的长目录就永远挂在那儿了。
          return { skills: [], complete: true }
        }
        return orig.call(this, opts)
      }
      try {
        Object.defineProperty(skills, '__fishGuarded', { value: true, enumerable: false, configurable: true })
      } catch { /* 加不上标记也不影响功能，只是不能防重复包裹 */ }
      disposers.push(() => {
        try {
          skills.snapshot = orig
        } catch { /* ignore */ }
      })
      log('技能目录：她的会话不再快照任何技能')
    } else if (!skills) {
      log('技能目录：拿不到 skills 服务，只挂了兜底那道闸')
    }
  } catch (err) {
    log('技能目录：快照闸没挂上', err?.message ?? err)
  }

  // ---- 闸二：把已经在她消息里的目录摘掉 ----
  if (typeof ctx?.on === 'function') {
    try {
      const off = ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        if (decision?.kind === 'reject') return decision
        if (!isHers(payload?.agent)) return decision
        const messages = Array.isArray(decision.messages) ? decision.messages : null
        if (!messages) return decision
        const kept = messages.filter((m) => m?.source?.kind !== 'skill-catalog')
        if (kept.length === messages.length) return decision
        log(`技能目录：从她的上下文里摘掉 ${messages.length - kept.length} 条`)
        return { ...decision, messages: kept }
      })
      if (typeof off === 'function') disposers.push(off)
    } catch (err) {
      log('技能目录：pre-step 兜底闸没挂上', err?.message ?? err)
    }
  }

  return () => {
    while (disposers.length) {
      try { disposers.pop()() } catch { /* ignore */ }
    }
  }
}
