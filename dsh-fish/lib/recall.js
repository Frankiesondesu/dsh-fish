/**
 * recall.js —— 让她能翻自己的过去：her_recall 工具
 *
 * 为什么要有这个（2026-10-23）：
 *   在此之前她只看得见「最近八条判断」。她其实**不记得任何具体的"那天"**。
 *   结果是两个坏处：① 她想说"我记得有一次"时只能编；② 越往后她越容易活成
 *   一张当前快照，而不是一个有过往的人。
 *
 * 设计上的硬约束（沿用 B §6 的思路）：
 *   - **只读**。它翻不出、也改不了任何东西。
 *   - **只翻她自己的事件流**，不碰配置、不碰状态文件。她翻不到自己的参数，
 *     因为参数从来就不在事件流里。
 *   - **输出封顶**：一次最多几条、每条截断。翻不到就是翻不到，不给她一整个
 *     事件流——那等于把「回忆」变成「读档」。
 *   - 返回里只有时间、类型、她自己写下的那几句。**条文后面带一个 id**：
 *     2026-10-27（0.5.8）起，她要写「我改口 / 我对自己有个说法」时必须用 refs
 *     指向具体某一条，而 refs 是要被查存在性的。没有 id，这条规则就只是逼她编。
 *     id 不是状态、不是参数——它只是「这句话在账上是第几行」。
 *
 * 2026-10-30（用户 m00112 批准 A）改了四处，都是**排序与入口**，没有动存储：
 *   1. 默认翻了全部时间。原来默认 30 天——一个月前的自己，她翻不到，
 *      这跟「事件流不能删」是矛盾的：记着，却看不见。
 *   2. 条数 5 → 8。太少时她一次只能看见最字面的几条，翻不完一个话题。
 *   3. 显著性加权：derive 里已经算好的 solid（反复提过/被检验过的判断）
 *      以及被 revise/test/answer 引用过的条目，排在同样字面命中的前面。
 *      原来「最重要」和「刚好提到这个字」同分，只按时间新旧排——等于没有排序。
 *   4. `kind` 可以只看一类（比如只听他说过的话）。不加这个参数就是全部。
 */

import { toJsonSchema } from './toolschema.js'
import { rootDir, readEvents } from './store.js'
import { deriveSelf } from './derive.js'

import { defineTool } from './tool.js'

/** 一次最多给几条 */
export const RECALL_LIMIT = 8
/** 每条最多多少字 */
export const RECALL_SNIPPET = 200
/**
 * brief 档每条最多多少字（2026-11-02，用户 m00335 第二条）。
 *
 * 想解决的事：8 条 × 200 字最坏 1600 字，一次「有没有这回事」的试探性翻找
 * 也要付这个价。而多数时候她只需要知道**有没有、是哪几条**，细节可以再翻一次。
 * 所以加一个只看开头的档位：40 字够认出是哪件事，不够就当没翻到。
 */
export const RECALL_BRIEF_SNIPPET = 40
/** 默认往回翻多少天；0 = 全部 */
export const RECALL_DAYS = 0

/** 参与排序加权的类型：这些事件引用了某一条，说明那条被检验/修正/回答过 */
const REF_TYPES = new Set(['test', 'answer', 'revise'])

/** 不参与回忆的类型：这些不是「她经历的事」 */
const SKIP_TYPES = new Set(['meta'])

/**
 * fork.10（2026-11-02）：但 meta 里有一部分**正是她经历的事**。
 *
 * 原来一律跳过，于是她能翻到的只有"我当时怎么想的"，翻不到"我看过什么"。
 * 她问"上次那个视频"，账本里明明有标题，却一条都搜不出来。
 * 只放带内容的那几种；`seen:` / `fired:` / `sched:` 这些是记账噪音，继续跳过。
 */
const META_KEEP = Object.freeze(['watched:', 'saw:', 'browse:', 'talk:'])

/**
 * 换词兜底用的近义表（fork.10）。
 *
 * 为什么要它：`her_recall` 是字面匹配，她换个说法就翻不到。
 * 真机上她记得"皮影"，问"变戏法"就全落空。真正的语义检索要上向量模型，
 * 这一步只做最小的补偿：几个她日常会用到的近义组，加上下面的字面重合兜底。
 * 表要短——每加一组都可能带来误召回，宁可少而准。
 */
const SYNONYMS = Object.freeze([
  ['视频', '片子', '短片', 'bv'],
  ['弹幕', '评论', '留言'],
  ['名字', '称呼', '叫什么'],
  ['屋子', '房间', '家'],
  ['看', '瞧', '瞅'],
  ['好笑', '逗', '笑死', '好玩'],
  ['难过', '难受', '委屈', '不是滋味'],
  ['生气', '恼', '火大', '气'],
])

const SYN_MAP = (() => {
  const m = new Map()
  for (const group of SYNONYMS) {
    for (const w of group) {
      const cur = m.get(w) ?? new Set()
      for (const v of group) if (v !== w) cur.add(v)
      m.set(w, cur)
    }
  }
  return m
})()

/** 虚字不进字面兜底：它们哪儿都有，算进来等于把一切判成相关 */
const STOP_CHARS = new Set('的了是我你他她它在有和就都也不很吗呢吧啊呀么这那个些什么'.split(''))

const DAY_MS = 86_400_000

/**
 * 把查询切成可匹配的片段。
 * 中文没有空格，整串匹配会全落空——所以补上二字切片。
 */
export function tokensOf(query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return []
  const out = new Set()
  for (const part of q.split(/[\s,，。、;；:：!！?？"'“”‘’()（）\[\]【】]+/)) {
    const p = part.trim()
    if (!p) continue
    out.add(p)
    // 中文二字切片：只有 >=3 字才切，避免把两字词切成一堆单字
    if (p.length >= 3 && /[\u4e00-\u9fa5]/.test(p)) {
      for (let i = 0; i + 2 <= p.length; i++) out.add(p.slice(i, i + 2))
    }
  }
  // 近义扩展（fork.10）：她自己换了个说法，也让她能翻到
  for (const t of [...out]) {
    const syn = SYN_MAP.get(t)
    if (syn) for (const s of syn) out.add(s)
  }
  return [...out]
}

/**
 * 字面重合兜底（fork.10）。整词一个都没命中时，看汉字覆盖度。
 *
 * 只给很小的分（每字 0.3，最多 1.5）：
 * 它的作用是把"勉强相关"的排到后面，绝不盖过真正命中的那几条。
 */
export function looseScore(text, query) {
  const lower = String(text ?? '').toLowerCase()
  const chars = []
  for (const ch of String(query ?? '')) {
    if (/[\u4e00-\u9fa5]/.test(ch) && !STOP_CHARS.has(ch)) chars.push(ch)
  }
  if (chars.length < 3) return 0
  let hit = 0
  for (const c of chars) if (lower.includes(c)) hit++
  if (hit / chars.length < 0.6) return 0
  return Math.min(1.5, hit * 0.3)
}

/**
 * 每条事件被引用了几次（只数 test / answer / revise 的 refs）。
 * 这是「被检验过」的直接证据，不经过任何打分。
 */
export function refCounts(events = []) {
  const m = new Map()
  for (const ev of events ?? []) {
    if (!ev || !REF_TYPES.has(ev.type)) continue
    for (const r of Array.isArray(ev.refs) ? ev.refs : []) {
      m.set(String(r), (m.get(String(r)) ?? 0) + 1)
    }
  }
  return m
}

/**
 * 固化的那几条（derive 的 solid）。失败就当没有，绝不让检索翻不动。
 * 事件流越长算得越久，按「条数 + 最后一条 id」缓存一次。
 */
let solidCache = { key: '', ids: new Set() }
export function solidIdsOf(events = [], growthDays = 30) {
  const last = events.length ? String(events[events.length - 1]?.id ?? '') : ''
  // growthDays 也进 key：同一串事件在不同成长周期下算出的 solid 可能不同
  const key = `${growthDays}:${events.length}:${last}`
  if (solidCache.key === key) return solidCache.ids
  try {
    const m = deriveSelf(events, { growthDays })
    const ids = new Set((m.solid ?? []).map((b) => String(b.id)))
    solidCache = { key, ids }
    return ids
  } catch {
    return new Set()
  }
}

/**
 * 在事件流里找。纯函数（除了 solidIdsOf 的缓存），永不抛。
 *
 * @param {object[]} events
 * @param {string} query
 * @param {{days?:number, limit?:number, now?:number, kind?:string, solidIds?:Set<string>|string[], weigh?:boolean}} o
 *   days: 0 或不传 = 全部；kind: 只看某一类；weigh: false = 不加显著性权重（测试/排查用）
 * @returns {{rows:{id:string,date:string,type:string,text:string,ago:number}[]}}
 */
export function searchEvents(events, query, o = {}) {
  const toks = tokensOf(query)
  if (!toks.length) return { rows: [] }
  const now = Number(o.now ?? Date.now())
  const daysRaw = o.days === undefined || o.days === null ? RECALL_DAYS : Number(o.days)
  const days = Number.isFinite(daysRaw) ? daysRaw : RECALL_DAYS
  const limit = Math.max(1, Math.min(20, Number(o.limit ?? RECALL_LIMIT)))
  const since = days > 0 ? now - days * DAY_MS : -Infinity
  const kind = String(o.kind ?? '').trim()
  const weigh = o.weigh !== false
  // brief：只看开头。截断放在这里而不是渲染时，是为了让 renderRecall 之外的
  // 调用方（比如以后要做界面预览）也拿到同一份短文本，口径只有一个。
  const snippet = Math.max(8, Number(o.snippet ?? RECALL_SNIPPET))
  const solid = o.solidIds instanceof Set
    ? o.solidIds
    : new Set(Array.isArray(o.solidIds) ? o.solidIds.map(String) : [])
  const refs = weigh ? refCounts(events) : new Map()

  // ---- 先过一遍筛，把候选挑出来（后面算稀有度要用整批当分母） ----
  const cand = []
  for (const ev of events ?? []) {
    if (!ev) continue
    if (SKIP_TYPES.has(ev.type)) {
      // meta 只放「她经历的事」那几种，`seen:` 之类的记账不进回忆
      const raw = String(ev.text ?? '')
      if (!META_KEEP.some((p) => raw.startsWith(p))) continue
    }
    if (kind && String(ev.type) !== kind) continue
    const text = String(ev.text ?? '').trim()
    if (!text) continue
    const ts = Date.parse(ev.ts)
    if (!Number.isFinite(ts) || ts < since) continue
    cand.push({ ev, text, ts, lower: text.toLowerCase() })
  }

  /**
   * fork.11（2026-11-02）：按**词的稀有度**给分，而不是按"命中了几段"。
   *
   * 原来每个命中的片段都加分，于是「视频」「记得」这种到处都有的词，
   * 和一个只有两三条记录里才出现的词（「皮影」）功劳一样大——
   * 真正能把旧事捞出来的那个词，反而被稀释了。
   * idf 高的词更有信息量，这一条是那份 B 站笔记里「召回 43%→91%」的做法。
   */
  const N = Math.max(1, cand.length)
  const idf = new Map()
  for (const t of toks) {
    let df = 0
    for (const c of cand) if (c.lower.includes(t)) df++
    if (df > 0) idf.set(t, Math.log((N + 1) / (df + 1)) + 1)
  }

  const scored = []
  for (const { ev, text, ts, lower } of cand) {
    let score = 0
    for (const t of toks) {
      if (!lower.includes(t)) continue
      const w = idf.get(t) ?? 1
      // 长片段更值钱：两字切片打折，整词按自己的稀有度全额
      score += w * (t.length >= 3 ? 1.5 : 1)
    }
    // 一个整词都没对上时，再试字面重合（fork.10）——换了个说法也能翻到
    if (score <= 0) score = looseScore(text, query)
    if (score <= 0) continue

    // ---- 遗忘（fork.11）：越久越难想起，但**不删除**，翻得到 ----
    // 半衰期按"这条有多重要"分开：被检验过的 180 天，被引用过的 90 天，
    // 她经历的事 45 天，普通判断 30 天。衰减到 0.35 就到底，不会归零。
    const ageDays = Math.max(0, (now - ts) / DAY_MS)
    const cited = (refs.get(String(ev.id)) ?? 0) > 0
    const half = solid.has(String(ev.id))
      ? 180
      : cited
        ? 90
        : ev.type === 'meta'
          ? 45
          : Math.max(1, Number(o.halfLifeDays ?? 30))
    const decay = 0.35 + 0.65 * Math.pow(0.5, ageDays / half)

    let rank = score * decay
    if (weigh) {
      if (solid.has(String(ev.id))) rank += 3
      rank += Math.min(3, refs.get(String(ev.id)) ?? 0)
    }
    scored.push({ rank, score, ts, ev, text })
  }

  scored.sort((a, b) => b.rank - a.rank || b.ts - a.ts)
  const rows = scored.slice(0, limit).map(({ ts, ev, text }) => ({
    id: String(ev.id ?? ''),
    date: new Date(ts).toISOString().slice(0, 10),
    ago: Math.max(0, Math.floor((now - ts) / DAY_MS)),
    type: String(ev.type ?? ''),
    text: text.length > snippet ? text.slice(0, snippet - 1) + '…' : text,
  }))
  return { rows }
}

/** 渲染成她能读的一段（不是 JSON） */
/**
 * 把一条记录转成她读得懂的一句（fork.10）。
 *
 * `saw:` / `watched:` / `browse:` 是系统记账，原文长得像配置项。
 * 她翻旧账时不该看见 `saw:BV1xx 《…》` 这种，得说成人话。
 */
function displayOf(r) {
  const text = String(r.text ?? '')
  if (r.type === 'heard') return `他说：${text}`
  if (r.type !== 'meta') return text

  if (text.startsWith('saw:')) return `你看过：${text.slice(4).trim()}`
  if (text.startsWith('browse:')) return `那天翻到的：${text.slice(7).trim()}`
  if (text.startsWith('talk:')) {
    // talk:2026-11-02 他说「…」／我答「…」 —— 后半句已经是人话了，去掉日期前缀即可
    return text.replace(/^talk:\S*\s*/, '')
  }
  if (text.startsWith('watched:')) {
    const m = text.match(/^watched:\S*\s*(\S+)?\s*(\{[\s\S]*)$/)
    if (m?.[2]) {
      try {
        const j = JSON.parse(m[2])
        const t = String(j?.title ?? '').trim()
        const up = String(j?.up ?? '').trim()
        if (t) return `你看了画面：《${t}》${up ? ' ' + up : ''}`
      } catch { /* 被 200 字截断的 JSON，退回原文 */ }
    }
    return `你看了画面：${text.slice(8).trim()}`
  }
  return text
}

export function renderRecall(rows, o = {}) {
  if (!rows?.length) return '你翻了，没翻到。'
  const brief = Boolean(o.brief)
  const lines = [brief ? '有这些（只报了开头，要看全的再说一次）：' : '你翻到的：']
  for (const r of rows) {
    // id 用小括号挂在最后：她要 revise / narration 时原样抄进来。
    // 没写 id 的老调用方（测试里的手写 fixture）就不显示括号，别凭空造一个。
    const mark = r.id ? `（${r.id}）` : ''
    const ago = Number.isFinite(r.ago) && r.ago > 0 ? `（${r.ago} 天前）` : ''
    // 先翻成人话（fork.10 的 displayOf，含 heard 的「他说：」），再按 brief 档截头——
    // 截的是翻好之后的正文，别让她看到截了一半的记账原文。
    let body = displayOf(r)
    if (brief && body.length > RECALL_BRIEF_SNIPPET) body = body.slice(0, RECALL_BRIEF_SNIPPET - 1) + '…'
    lines.push(`- ${r.date}${ago}｜${body}${mark}`)
  }
  return lines.join('\n')
}

/**
 * 注册 her_recall 工具。
 * 返回值刻意不含条数、不含"还有 N 条"——那会变成"再翻一次"的诱惑。
 */
export function registerRecall(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: 'her_recall',
      description:
        '翻你自己过去记下的事。想提"以前有一次"的时候先用它翻一翻，翻到了再说；翻不到就别编。默认翻全部时间，不只是最近。',
      parameters: toJsonSchema({
        query: { type: 'string', required: true, description: '你想找的是什么，几个词就够。' },
        days: { type: 'number', required: false, description: `只想翻最近多少天就传几天；不传（或传 0）就是全部。` },
        kind: { type: 'string', required: false, description: '只看某一类，比如 utterance（自己说的）、diary（日记）、heard（你听过的话）、voice（读到的别人的话）。不传就是全部。' },
        brief: { type: 'boolean', required: false, description: '只想先知道有没有、是哪几条，就传 true：每条只报开头几十个字，省地方。要看全的再翻一次（不传 brief）。' },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            found: { type: 'boolean' },
            text: { type: 'string' },
          },
          required: ['found', 'text'],
        },
        render: (_args, out) => [{ type: 'text', text: out.text }],
      },
      async execute(args) {
        try {
          const brief = Boolean(args?.brief)
          const { events } = await readEvents(root)
          const solidIds = solidIdsOf(events, Number(deps.growthDays ?? 30))
          const { rows } = searchEvents(events, args?.query, {
            days: args?.days,
            kind: args?.kind,
            solidIds,
            // 截断放在 searchEvents 里：这样 rows 本身就是短的，
            // 渲染层不必再按栏位切一刀（两处口径会打架）。
            snippet: brief ? RECALL_BRIEF_SNIPPET : RECALL_SNIPPET,
          })
          return { found: rows.length > 0, text: renderRecall(rows, { brief }) }
        } catch {
          // 翻不动就说翻不动，不要装作记得
          return { found: false, text: '你翻了，没翻到。' }
        }
      },
    }),
  )
}
