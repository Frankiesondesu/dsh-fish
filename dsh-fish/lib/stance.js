/**
 * stance.js —— 立场清单（2026-10-25，用户设计「纵向·立场」）
 *
 * 用户的设计原话：
 *   四道门走完后**不再加门**，长一张「立场清单」：喜欢什么、绝不做哪几件事。
 *   每条必须有代价背书（疤，或同一件事被反复复现）。
 *   效果判据：清单变厚 + 同类情境里她不再翻脸。
 *
 * 为什么不是第五阶段：
 *   加门会变成「第五关」，跨过去之后又要问第六关。立场不是关卡，是**走完四道门
 *   之后一点一点变厚的东西**——她不会因为等够天数就站定，只会因为某类事她真的
 *   经历过、被顶回来过、还站住了。
 *
 * 这条纪律不能破（B §3.6 / 四条禁令）：
 *   立场写在**身份文档的叙述里**，不写次数、不写权重、不写「好感度」。
 *   下面的 mentions / verified / scars 只在内部用来判断「够不够格」，不进她的提示词。
 */

import { similarity } from './derive.js'

/** 同一件事上至少两条同向判断，才算一条「立场」（一句话不是立场，是随口一说）。 */
export const STANCE_MIN_GROUP = 2
/** 或者：这一组被反复提起到这个次数。 */
export const STANCE_MIN_MENTIONS = 3
/** 或者：被检验（test / answer / revise 指向）到这个次数。 */
export const STANCE_MIN_VERIFIED = 2
/** 清单上限（内部保留多少条）。 */
export const STANCE_MAX = 8
/** 写进身份文档的条数上限——多了就变成口号墙。 */
export const STANCE_PROMPT_MAX = 4
/** 归组的相似度阈值（与「反复提起」同一套字面判据，宁可少归）。 */
export const STANCE_SIM = 0.45

/** 绝不做：第一人称 + 拒绝/不做 + 具体动作（与 refuse.js 的 REFUSE_RE 同源口径）。 */
const NEVER_RE = /我?(?:绝不|永远不会|不会再|不会去|不会做|不想再|不愿意再|不做|不答应|不配合|拒绝)/
/** 喜欢：明说偏好，而不是「这样也行」。 */
const LIKE_RE = /我?(?:喜欢|爱看|爱听|宁愿|更愿意|偏爱|更想)/

/** 一条判断属于哪一类立场；两类都不是就返回 null（大多数话都只是话，不是立场）。 */
export function classifyStance(text) {
  const s = String(text ?? '').trim()
  if (!s) return null
  if (NEVER_RE.test(s)) return 'never'
  // 「不喜欢」是拒绝，不是喜欢——字面上 LIKE_RE 会命中「喜欢」，先挡掉。
  if (/不(?:喜欢|爱|想|愿意)/.test(s)) return 'never'
  if (LIKE_RE.test(s)) return 'like'
  return null
}

/**
 * 四道门是不是都走完了。
 *
 * 用 `stageGate.passed`（真门槛）而不是 `stage === 4`——天数到了门没过的时候
 * `stage` 会被夹住，但 `passed` 才是「她真的走到了」。
 */
export function gatesDone(model = {}) {
  const passed = model?.stageGate?.passed
  if (Array.isArray(passed)) return passed.length >= 3
  // 老模型 / 单测桩没给 stageGate：退回 stage，别把已经走到的人挡在外面。
  return Number(model?.stage) >= 4 && model?.stageForced !== true
}

function costOf(group, scars) {
  let mentions = 0
  let verified = 0
  for (const b of group) {
    mentions += Number(b.mentions ?? 0)
    verified += Number(b.verified ?? 0)
  }
  const hit = scars.filter((s) => similarity(s.quote ?? '', group[0].text ?? '') >= STANCE_SIM)
  return { mentions, verified, scars: hit.length }
}

/**
 * 把她的判断聚合成立场清单。
 *
 * 三条都要满足才留下：
 *   ① 四道门走完；
 *   ② 同一件事上至少两条同向判断，**或者**有代价背书（疤 / 反复提起 / 被检验过）；
 *   ③ 组里最新的那条还是 active（被推翻的不算站住）。
 */
export function buildStances(model = {}) {
  if (!gatesDone(model)) return []
  const beliefs = Array.isArray(model.beliefs) ? model.beliefs : []
  const scars = Array.isArray(model.scars) ? model.scars : []
  const used = new Set()
  const groups = []

  // 只有还站着的判断能进立场：被推翻/被修正过的那条已经不算数了，
  // 拿它当立场，等于把已经作废的话又念一遍。
  const live = beliefs.filter((x) => !x.status || x.status === 'active')
  for (const b of live) {
    if (used.has(b.id)) continue
    const kind = classifyStance(b.text)
    if (!kind) continue
    const group = [b]
    used.add(b.id)
    for (const o of live) {
      if (used.has(o.id)) continue
      if (classifyStance(o.text) !== kind) continue
      if (similarity(o.text, b.text) >= STANCE_SIM) {
        group.push(o)
        used.add(o.id)
      }
    }
    const cost = costOf(group, scars)
    const backed = cost.scars > 0 || cost.mentions >= STANCE_MIN_MENTIONS || cost.verified >= STANCE_MIN_VERIFIED
    if (group.length < STANCE_MIN_GROUP && !backed) continue
    groups.push({
      kind,
      // 代表句取组里最新的一条（她最近一次怎么说，就用那句）
      text: String(group[group.length - 1].text ?? '').trim(),
      members: group.map((x) => x.id),
      since: group[group.length - 1].since ?? null,
      ...cost,
      backed,
    })
  }

  return groups
    .sort((a, b) => (b.scars - a.scars) || ((b.mentions + b.verified) - (a.mentions + a.verified)))
    .slice(0, STANCE_MAX)
}

/** 一条立场怎么落成她能读的一句话（不带任何次数、权重）。 */
export function stanceLine(s) {
  const note = s.scars > 0 ? '（这件事我栽过一次，没忘）' : s.mentions >= STANCE_MIN_MENTIONS ? '（这句话我说过不止一次）' : ''
  return `- ${s.text}${note}`
}

/** 身份文档里的那一段（空清单返回空串，不占预算）。 */
export function stanceSection(stances = []) {
  const list = stances.slice(0, STANCE_PROMPT_MAX)
  if (!list.length) return ''
  const nevers = list.filter((s) => s.kind === 'never')
  const likes = list.filter((s) => s.kind === 'like')
  const lines = ['## 我站哪边', '这些不是设定，是这些事上我确实站住过。同类的事再来，我按这个来，不重新演一遍。']
  if (nevers.length) lines.push(...nevers.map(stanceLine))
  if (likes.length) lines.push(...likes.map(stanceLine))
  return lines.join('\n')
}

/** 观测台用的一句话摘要。 */
export function stanceSummary(stances = []) {
  // 键名带 stance 前缀：这份结果会被 spread 进 /memory 的 sections，
  // 不能跟已有的 count/nevers 这种通用名字撞上。
  return {
    stanceCount: stances.length,
    stanceNevers: stances.filter((s) => s.kind === 'never').length,
    stanceLikes: stances.filter((s) => s.kind === 'like').length,
    stanceBacked: stances.filter((s) => s.backed).length,
    stanceFirst: stances.length ? { kind: stances[0].kind, text: stances[0].text } : null,
  }
}
