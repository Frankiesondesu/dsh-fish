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
 *
 * 2026-11-08（用户 m00187）又改了三处，仍然只动排序、不碰存储：
 *   5. idf 加权：到处都是的词（事情 / 说过）不再跟罕见的词一样值分。
 *   6. 字面量整串比：`0.9.3` / `snapshot.json` 不再被切成碎片到处误撞。
 *   7. 新旧折算：字面命中相同时，昨天的先于三个月前的；判断类永不折。
 */

import { toJsonSchema } from './toolschema.js'
import { rootDir, readEvents } from './store.js'
import { deriveSelfCached, deriveSelf } from './derive.js'
import { normalizeScene, localDaysAgo } from './schema.js'
import { dateKey } from './settings.js'
import { anchorOf } from './anchor.js'
import { parseWatchedLine, parseLookLine } from './whatseen.js'
import { fillOwner } from './pronoun.js'

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

/**
 * 可及性门槛（fork.36，2026-11-04）——「想得起来」和「东西还在」是两件事。
 *
 * 在这之前，decay 只乘在 rank 上参与排序，**没有门槛**：只要关键词命中，
 * 一条两年前的旧事照样会被返回。于是她的「遗忘」是假的——她不是想不起来，
 * 是从来没出现过「取不出来」的情况。她自己抓到了这一点（11-04 08:21）：
 * 「被压掉的那五十六条，我不记得……我想翻也翻不回来。」
 *
 * 人的遗忘不是内容消失，是**线索不够就调不出来**，而且不可控。所以这里
 * 不动账本（只增不改是铁律），只在检索这一层加一道闸：
 *
 *   线索够不够 = 命中词里最稀的那个有多稀（归一化的 idf，0 = 到处都有，1 = 独一份）
 *   记不记得住 = decay
 *   两者相乘低于 minCue，就是「想不起来」——账本里它还在，只是这次没调出来
 *
 * 门槛只对「早期」生效（oldDays 天以前）。这不是宽容，是事实：
 * 她第 3 天，账本里最老的字也只有 3 天，凭什么忘。要谈遗忘，得先有"以前"。
 *
 * ⚠️ 为什么不用绝对分数当门槛：idf 的量级跟账本条数走（N=31 时上限 4.7，
 * N=536 时 7.3）。拿一个绝对数当门槛，要么在小账本里全挡、要么在大账本里全放。
 * 归一化之后才跟规模无关。
 */
export const RECALL_OLD_DAYS = 30
/**
 * 线索要多具体才想得起来——**压到底的时候**的要求（decay 到 0.35 时）。
 * 刚过 oldDays 时要求会低得多，随 decay 线性升高：
 *
 *   needCue = minCue * (1 - decay) / (1 - DECAY_FLOOR)
 *
 * 实测（2026-11-04 的真实账本，模拟整本推到 400 天后）：
 *   「视频」cue=0.377 → 想不起来；「皮影」cue=0.51 → 想得起来。
 *   同一句「视频」在 30~60 天时还翻得到，大约 80 天以后开始淡出。
 */
export const RECALL_MIN_CUE = 0.45

/**
 * 「今天状态」的抖动（fork.37，2026-11-04）。
 *
 * fork.36 之后她「想不起来」还是确定的：同一个词、同一天，问一百次答案一样。
 * 人的回忆不是这样——话到嘴边，今天出得来，明天可能就卡住。
 *
 * 但不能每次调用都掷骰子：那会让她以为工具坏了，出了问题也没法复现。
 * 所以用**北京时间的日序号 + 事件 id** 哈希出 0~1：
 *   - 同一天、同一条事件 → 永远是同一个数（稳定、可复现、可测）
 *   - 换一天 → 边缘那一批换一批
 *
 * 抖动只乘在**门槛**上，所以：
 *   确定想得起来的（线索很具体）→ r 怎么变都过
 *   确定想不起来的（线索是泛词）→ r 怎么变都过不去
 *   只有卡在门槛附近的那批 → 今天行、明天不行
 *
 * 0 = 关掉（退回 fork.36 的确定性行为）。
 */
export const RECALL_JITTER = 0.2

/**
 * 确定性伪随机：FNV-1a 哈希后归一到 [0,1)。
 * 不用 Math.random —— 同一天问两次必须给出同一个答案。
 */
function hash01(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 1000003) / 1000003
}

/** 记忆强度的下限：衰减到底也留这么多，永远不归零（fork.11 定的） */
const DECAY_FLOOR = 0.35

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
 * 工具使用经验也放行（上游 0.9.3，2026-11-07）：`use:` 记的是「这件事我是
 * 怎么做成的」——正好是她翻旧事时最缺的一种。两条放行口径并存：
 * 经历类的 meta（META_KEEP）与工具账（use:），其余 meta 仍是系统账不进回忆。
 */
export const USE_PREFIX = 'use:'
const isUseLine = (ev) => String(ev?.text ?? '').startsWith(USE_PREFIX)

/**
 * 第二类放行的 meta：她看过什么（2026-11-09 0.9.7 T3；2026-11-12 issue #133）。
 *
 * 三种记账，口径以 `lib/whatseen.js` 为准：
 *   `watched:<日期> <bvid> {json}`  —— 真抽了帧、看过画面（唯一凭证）
 *   `look:<日期> <bvid> {json}`     —— 点开过（有标题，没画面）
 *   `looked:<bvid> <标题>`          —— 在列表里看见过 / 点开过
 *
 * 原来只放行**带标题的** `looked:`。结果是 issue #133 报的那个洞：翻得到
 * 「看过标题」，翻不到「看过画面」——而后者才是她自己的经历；`look:` 与
 * 没带标题的老 `looked:`（0.9.7 前）也一起被跳过了。
 *
 * 安静刷写的 `browsed:` 仍然不放行：那一趟她没看见，是系统账。
 */
export const LOOKED_LINE = /^looked:(\S+)(?:\s+([\s\S]+))?$/
const LOOK_GENERIC = /^look:(\S+)(?:\s+([\s\S]+))?$/

/** 同一天同一条视频最多摆一行：留分量最重的那个（issue #133 的 5）。 */
const SEEN_WEIGHT = { watched: 3, look: 2, looked: 1 }

const titleOf = (info) => (info && typeof info.title === 'string' ? info.title.trim() : '')

// JSON 被截断时退回按字段抠标题：brief 档只有 40 字，`look:` 后面那整段
// 早不是一个合法对象了，但「点开的是哪条」还得读得出来（issue #133）。
const TITLE_JSON = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/
function titleFromText(text, info) {
  const title = titleOf(info)
  if (title) return title
  const m = TITLE_JSON.exec(String(text ?? ''))
  if (!m) return ''
  try {
    return JSON.parse(`"${m[1]}"`).trim()
  } catch {
    return m[1].trim()
  }
}

/** 这条「看过什么」翻成人话。三种路子要分得开，别把点开说成看过画面。 */
function seenLabel({ kind, bvid, title }) {
  const tail = title ? `：《${title}》` : `（${bvid}，当时没记下标题）`
  if (kind === 'watched') return `你那天看过画面${tail}`
  if (kind === 'look') return `你那天点开过${tail}`
  return `你那天看过${tail}`
}

/**
 * 把一条 meta 认成「她看过什么」的记录；不是就返回 null。
 * 老形状（`look:BV…`、`watched:<日期> BV…` 没带 JSON）也要认——记忆不能因为
 * 当时没记标题就凭空少一条。
 */
export function seenOf(ev) {
  if (ev?.type !== 'meta') return null
  const text = String(ev?.text ?? '').trim()
  const w = parseWatchedLine(text)
  if (w) return { kind: 'watched', dk: w.dk, bvid: w.bvid, title: titleFromText(text, w.info) }
  const k = parseLookLine(text)
  if (k) return { kind: 'look', dk: k.dk, bvid: k.bvid, title: titleFromText(text, k.info) }
  const l = LOOKED_LINE.exec(text)
  if (l) return { kind: 'looked', dk: '', bvid: l[1], title: String(l[2] ?? '').trim() }
  // v0.8.0–0.8.7 的 look: 没带日期：`look:BV…`
  const g = LOOK_GENERIC.exec(text)
  if (g) return { kind: 'look', dk: '', bvid: g[1], title: '' }
  return null
}

const isSeenLine = (ev) => Boolean(seenOf(ev))

/**
 * 素材索引（1.0.0，用户 m05089）：mat:bili:<bvid> {t,d,q:[{b,x}]}。
 * 只认能读出至少一句原话的行——读不出话的索引对她没有意义。
 */
export const MAT_LINE = /^mat:bili:(\S+)\s+(\{[\s\S]*\}$)/
function matOf(ev) {
  if (ev?.type !== 'meta') return null
  const m = MAT_LINE.exec(String(ev?.text ?? '').trim())
  if (!m) return null
  try {
    const payload = JSON.parse(m[2])
    const quotes = Array.isArray(payload?.q) ? payload.q : []
    const first = quotes.find((q) => String(q?.x ?? '').trim())
    if (!first) return null
    return {
      bvid: m[1],
      title: String(payload?.t ?? '').trim(),
      date: String(payload?.d ?? '').trim(),
      quote: String(first.x).trim(),
      by: String(first.b ?? '').trim(),
    }
  } catch {
    return null
  }
}
const isMatLine = (ev) => Boolean(matOf(ev))

/** 2026-11-13 → 11 月 13 日；不是这个形状就原样返回。 */
function mmdd(dk) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dk)
  return m ? `${Number(m[2])} 月 ${Number(m[3])} 日` : dk
}

/** 这条事件进不进回忆。 */
const usable = (ev) =>
  Boolean(ev) &&
  (!SKIP_TYPES.has(ev.type) ||
    META_KEEP.some((p) => String(ev?.text ?? '').startsWith(p)) ||
    isUseLine(ev) ||
    isSeenLine(ev) ||
    isMatLine(ev))

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
 * 这条只是「在对话里说过」，还是她自己认领写下的。
 *
 * `turns.js` 的 `settle()` 会把一轮里她说的话补写成 `utterance` 并打
 * `flags:['uncommitted']`，注释写的是「只留证，不当信念」。它跟
 * `growth_commit` 里认领下来的话在事件流里长得差不多，她翻旧事时
 * 分不出哪个是自己认真写下的（2026-11-04 群反馈第二条、第三条）。
 */
const chatOnly = (ev) => Array.isArray(ev?.flags) && ev.flags.includes('uncommitted')

/** 事件时刻 → 本地 HH:MM（与 report.js / inbox.js 同一口径） */
function localClock(ts) {
  // 调用方传进来的是已经 parse 过的毫秒数（searchEvents 里的 `ts`），
  // 也可能有手写 fixture 直接给 ISO 串——两种都认。
  const n = typeof ts === 'number' ? ts : Date.parse(String(ts ?? ''))
  if (!Number.isFinite(n)) return ''
  const d = new Date(n)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 按 UTF-16 截时别把 emoji 切成半个：写进文件就是乱码。
const clip = (text, n) => (text.length > n ? text.slice(0, n - 1).replace(/[\uD800-\uDBFF]$/, '') + '…' : text)

// 一条一行：正文里的换行会把行尾的 id 挤到下一行，也会把缩进的关系行拆开。
const oneLine = (text) => text.replace(/\s+/g, ' ').trim()

/** `use:<工具> ok|fail <一句话>`——见 lib/use.js */
const USE_LINE = /^use:(\S+)\s+(ok|fail)\s*(.*)$/

/** 不是她自己写下的，要说清来路 */
function labelled(type, text, scene = '') {
  // heard 是旁听来的：明确写成「他说」，别让她误以为是自己说的。
  // 2026-11-08（用户 m00394）：群聊里他本人的那句也记，但要读得出来是在哪儿说的——
  // 不标的话，她翻到会以为那是只对她一个人说的。
  if (type === 'heard') {
    return normalizeScene(scene) === 'group' ? `{T}在群里说：${text}` : `{T}说：${text}`
  }
  // voice、answer 同理：一句是读到的陌生人的话，一句是别人回她的。
  if (type === 'voice') return `读到别人说：${text}`
  if (type === 'answer') return `回复：${text}`
  // 工具使用经验（2026-11-07，用户 m00882）：账里存的是机器写法，
  // 读出来得是一句人话——「用过 her_note，记下了：…」。
  if (type === 'meta') {
    // issue #133：三种记账翻出来都要读得成人话，而且「看过画面」和「只点开过」
    // 必须分得开——原来只有带标题的 looked: 有这一行，watched: 那条唯一凭证
    // 反而翻不到，她只好把「看过标题」说成「看过」。
    // 素材索引（1.0.0，用户 m05089）：她看过的那几句原话。
    const mat = matOf({ type, text })
    if (mat) {
      const when = mat.date ? `在 ${mmdd(mat.date)}` : '那天'
      const of = mat.title ? `《${mat.title}》` : '一条视频'
      return `你${when}看过${of}，里面有一句：「${mat.quote}」`
    }
    const seen = seenOf({ type, text })
    if (seen) return seenLabel(seen)
    const m = USE_LINE.exec(text)
    if (m) {
      const [, tool, head, said] = m
      // issue #133 的 C：划掉便条那行账现在带着原话（lib/note.js 的 closeNote），
      // 翻出来别写成「用过 her_note，已划掉：…」，那是操作记录的口吻；
      // 她那天是做完了一件事。
      if (tool === 'her_note' && head === 'ok' && said.startsWith('已划掉：')) {
        return `你那天做完：${said.slice('已划掉：'.length)}`
      }
      return head === 'fail' ? `用过 ${tool}，没成：${said}` : `用过 ${tool}，${said}`
    }
  }
  return text
}

/** 她说了但没认领。标在最后，所以要等截断之后再加，不然句子一长标记就被截掉了。 */
const CHAT_MARK = '｜聊天里说的'

/**
 * 把查询切成可匹配的片段。
 * 中文没有空格，整串匹配会全落空——所以补上二字切片。
 */
export function tokensOf(query, o = {}) {
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
  // fork.36：只要她自己说的那些词，不要近义扩展。
  // 可及性门槛判断的是「她给的线索够不够具体」——系统替她联想到的
  // 「片子/短片/bv」不能算她的线索，否则一个泛词也能被扩展出的稀有词救活。
  if (o.expand === false) return [...out]
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
 * 字面量：版本号、文件名、命令、路径、工具名（2026-11-08，用户 m00187 第 2 条）。
 *
 * 为什么单拎出来：中文二字切片会把「0.9.3的坑」切成 `0.` / `.9` / `9.` / `.3` /
 * `3的` / `的坑` 六片，把 `snapshot.json` 切成 snapshot / json。碎片到处误撞，
 * 真正记着这件事的那条反而只拿两分，被一堆不相干的条目挤到八条以外。
 * 所以先把这些「不该被切开的东西」整串抽出来，按整串比。
 */
const LITERAL_RE = /[A-Za-z0-9][A-Za-z0-9_.\-/:#]{1,}/g

export function literalsOf(text) {
  const out = new Set()
  for (const m of String(text ?? '').matchAll(LITERAL_RE)) {
    const w = m[0]
    // 纯数字不算：年份、条数、「第 3 条」到处都是，当字面量只会误伤。
    if (/^\d+$/.test(w)) continue
    // 普通英文单词不算（ok / deepseek）：它们靠整词与二字切片就够，
    // 只有带数字或分隔符的才真有「不能切开」的价值。
    if (!/[0-9._\-/:#]/.test(w)) continue
    out.add(w.toLowerCase())
  }
  return [...out]
}

/** 整串命中一个字面量值多少分：压得过一个两字切片，压不过「她问的那件事整句都在里面」。 */
export const LITERAL_BONUS = 3
/** 查询里带着字面量却一个都没对上时的折算：多半不是这一条。 */
export const LITERAL_MISS = 0.3

/** 把字面量从查询里抠掉，剩下的再切二字——免得碎片再进候选池。 */
function stripLiterals(text, lits) {
  let s = String(text ?? '')
  for (const l of lits) {
    const safe = l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    s = s.replace(new RegExp(safe, 'gi'), ' ')
  }
  return s
}

/**
 * 一个词的分量（2026-11-08，用户 m00187 第 1 条）。
 *
 * 原来「长片段算长度、两字切片算 1」，于是「事情」「说过」这种几乎每条都有的词
 * 和「疤」一样值 1 分。并列时按时间倒序排——最后赢的永远是最新的那条，
 * 三个月的真话被昨天的闲话挤掉。
 *
 * idf 的做法：越少条目里出现的词越值钱。取值压到 [0.6, 1.0]：
 * 常见词打六折，罕见词不打折。地板不再压低——压到 0.4 会把整条的分一起
 * 缩掉，显著性那 +4 就变相变重，把「她问的那件事整句都在里面」盖过去了。
 */
export const IDF_FLOOR = 0.6
export const IDF_CEIL = 1.0

function idfWeight(df, n) {
  if (!(n > 1)) return 1
  const raw = Math.log(1 + n / (1 + Math.max(0, df))) / Math.log(1 + n)
  const v = IDF_FLOOR + (IDF_CEIL - IDF_FLOOR) * raw
  return Math.min(IDF_CEIL, Math.max(IDF_FLOOR, v))
}

/**
 * 旧事该折多少（2026-11-08，用户 m00187 第 3 条）。
 *
 * 她要的是「昨天做的和三个月前说的，在字面命中相同时，昨天先」——
 * 不是「旧事消失」。所以有地板 0.55：再旧也留一半多，八条里挤得进去。
 *
 * 半衰期分两档：工具账、旁听、别人的话（meta / heard / voice）是快消品，45 天；
 * 她自己的话、日记、叙事、梦是长存的，180 天。
 * 检验、改口、拒绝、答话永不折——那几类记的是判断本身，不该因为旧了就让位。
 */
export const FRESH_FLOOR = 0.55
export const HALF_LIFE_FAST_MS = 45 * DAY_MS
export const HALF_LIFE_SLOW_MS = 180 * DAY_MS

const NEVER_FADE = new Set(['test', 'revise', 'refusal', 'answer'])

export function halfLifeOf(ev) {
  const t = String(ev?.type ?? '')
  return t === 'meta' || t === 'heard' || t === 'voice' ? HALF_LIFE_FAST_MS : HALF_LIFE_SLOW_MS
}

export function freshnessOf(ev, { now = Date.now(), ts, solid } = {}) {
  const at = Number.isFinite(ts) ? ts : Date.parse(String(ev?.ts ?? ''))
  if (!Number.isFinite(at)) return 1
  if (NEVER_FADE.has(String(ev?.type ?? ''))) return 1
  // 固化过的那几条是她的判断，不随时间让位（它另有 +3，这里不重复加）。
  if (solid?.has?.(String(ev?.id))) return 1
  const age = Math.max(0, now - at)
  return FRESH_FLOOR + (1 - FRESH_FLOOR) * Math.exp(-age / halfLifeOf(ev))
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
 * 每条事件最近一次被哪条 revise 改过。
 *
 * 为什么要有（2026-11-04，issue #23）：`refCounts` 把 revise 的 refs 也数成
 * 「被检验过」，于是**被推翻的那句反而加权排到第一**——她翻到自己早就推翻的话，
 * 只能当它还算数，因为结果里 revise 和它改掉的那句毫无关系。
 */
function latestRevisions(events = []) {
  const m = new Map()
  for (const ev of events ?? []) {
    if (ev?.type !== 'revise') continue
    for (const r of Array.isArray(ev.refs) ? ev.refs : []) {
      if (String(r) === String(ev.id)) continue
      const prev = m.get(String(r))
      if (!prev || !(Date.parse(ev.ts) < Date.parse(prev.ts))) m.set(String(r), ev)
    }
  }
  return m
}

/**
 * 顺着改口走到她最后的说法。那句后来也可能被改过，
 * 而她没法按 id 再翻一次，只给一跳等于把「当它还算数」往后挪了一步。
 * 走到「确认」就停：确认不是改口，再走下去会把她认下的那句说成改了。
 */
function lastSaying(ev, revisions, rowId) {
  const seen = new Set([String(rowId), String(ev.id)])
  let cur = ev
  for (;;) {
    const next = revisions.get(String(cur.id))
    if (!next || next.verdict === 'confirmed' || seen.has(String(next.id))) return cur
    seen.add(String(next.id))
    cur = next
  }
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
    const m = deriveSelfCached(events, { growthDays })
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
 * @param {string} query 找什么。空 = 按时间摆最近的（`o.days` 决定窗口）
 * @param {{days?:number, limit?:number, now?:number, kind?:string, solidIds?:Set<string>|string[], weigh?:boolean}} o
 *   days: 0 或不传 = 全部；kind: 只看某一类；weigh: false = 不加显著性权重（测试/排查用）
 * @returns {{rows:{id:string,date:string,type:string,text:string,ago:number}[], total:number, truncated:boolean, timeline:boolean}}
 *   total/truncated：这次一共命中几条、摆出来的够不够（issue #133 的 B）。
 *   timeline：true = 这次没给关键词，按时间翻的。
 */
export function searchEvents(events, query, o = {}) {
  const lits = literalsOf(query)
  // 字面量先抠掉再切二字：不然 `0.9.3` 的碎片照样进候选池（上游 m00187）。
  const toks = tokensOf(stripLiterals(query, lits))
  // 一个字都没给 = 按时间翻（2026-11-12，用户 m00497）：空 query 走时间线，不加分、不挑。
  // fork 原来直接返回空，改成 timeline 后由下面的分支处理。
  const timeline = !toks.length && !lits.length
  // fork.36：可及性门槛只认她自己给的词，不认近义扩展出来的（见 tokensOf）。
  const rawSet = new Set(tokensOf(stripLiterals(query, lits), { expand: false }))
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
  const revisions = latestRevisions(events)
  // fork.36：门槛的两个系数。传了就用传的（配置/测试），没传用默认。
  const num = (v, d) => (v === undefined || v === null || !Number.isFinite(Number(v)) ? d : Number(v))
  const oldDays = num(o.oldDays, RECALL_OLD_DAYS)
  const minCue = num(o.minCue, RECALL_MIN_CUE)
  // fork.37：今天的"状态"。同一天内固定，跨天换一批——见 RECALL_JITTER。
  const jitterAmt = Math.max(0, num(o.jitter, RECALL_JITTER))
  const dayKey = Math.floor((now + 8 * 3600e3) / DAY_MS) // 北京时间日序号
  const jitterOf = (id) => {
    if (!jitterAmt) return 1
    return 1 + jitterAmt * (2 * hash01(`${dayKey}:${id}`) - 1)
  }

  // 先把候选筛出来。同一份候选既用来算 df 又用来打分——两个口径必须一致，
  // 否则 idf 是拿另一批事件算出来的，词的分量就成了猜的。
  const cand = []
  for (const ev of events ?? []) {
    if (!usable(ev)) continue
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
  // fork.36：同一份 df 顺手算出「归一化区分度」——
  // 0 = 这词每条都有（"视频"），1 = 只在这一条里出现（"皮影"）。
  // 它才是"这条线索有多具体"。门槛认这个，不认 idf 的绝对值（那个跟账本规模走）。
  const nidf = new Map()
  const logN = Math.log(N + 1) || 1
  for (const t of toks) {
    let df = 0
    for (const c of cand) if (c.lower.includes(t)) df++
    if (df > 0) {
      const rare = Math.log((N + 1) / (df + 1))
      idf.set(t, rare + 1)
      nidf.set(t, rare / logN)
    }
  }

  const scored = []
  // 时间线不打分：分数只在「她给了一个词」的时候才有意义。空 query 时下面这段
  // 整个跳过，候选按时间从近到远摆。
  if (timeline) {
    for (const { ev, text, ts } of cand) scored.push({ rank: 0, score: 0, ts, ev, text })
  }
  if (!timeline) for (const { ev, text, ts, lower } of cand) {
    let score = 0
    let cue = 0
    for (const t of toks) {
      if (!lower.includes(t)) continue
      const w = idf.get(t) ?? 1
      // 长片段更值钱：两字切片打折，整词按自己的稀有度全额
      score += w * (t.length >= 3 ? 1.5 : 1)
      if (rawSet.has(t)) {
        const n = nidf.get(t) ?? 0
        if (n > cue) cue = n
      }
    }

    // 字面量按整串比，不切碎片（上游 m00187）：0.9.3 这类标识符整串命中才给分。
    let litHits = 0
    for (const l of lits) {
      if (!lower.includes(l)) continue
      litHits++
      score += LITERAL_BONUS
    }
    // 一个整词都没对上时，再试字面重合（fork.10）——换了个说法也能翻到
    if (score <= 0) score = looseScore(text, query)
    if (score <= 0) continue
    // 她问的那句带着版本号 / 文件名，却一个都没对上——多半不是这一条。
    if (lits.length && litHits === 0) score *= LITERAL_MISS

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
    const decay = DECAY_FLOOR + (1 - DECAY_FLOOR) * Math.pow(0.5, ageDays / half)
    // fork.36：越老越需要具体的线索。刚过 oldDays 时要求低（几乎不挡），
    // 压到底时要求最高（= minCue）。这样"淡出"是连续的，不是到点一刀切。
    // fork.37：再乘一个今天的"状态"——只有门槛附近的那批会随日子变。

    let rank = score * decay
    if (weigh) {
      // 2026-11-04（群反馈第三条）：认领过的话排在自己的聊天原话前面。
      // 幅度取 +4：要压得过「只靠 solid 的认领（+3）」，又不能压过字面命中差得多的。
      // 聊天原话不给这一分，它靠字面命中自己争。
      if (!chatOnly(ev)) rank += 4
      if (solid.has(String(ev.id))) rank += 3
      // issue #23：她已经推翻的话不算「被检验过」，不管之前被引用过几次。
      // 原来 refCounts 把 revise 的 refs 也数进去，于是被推翻的旧话反而排到第一——
      // 她翻到自己早就不要的说法，只能当它还算数。
      if (revisions.get(String(ev.id))?.verdict !== 'refuted') rank += Math.min(3, refs.get(String(ev.id)) ?? 0)
    }
    // fork.36：可及性门槛。线索不够就是**想不起来**，不是"没有这条"——
    // 账本里它还在，只是她这次没把它调出来。人也是这样。
    // 只对「早期」生效：账本才三天，最老的字也就三天，凭什么忘。
    if (ageDays > oldDays) {
      const needCue = minCue * (1 - decay) / (1 - DECAY_FLOOR) * jitterOf(ev.id)
      if (cue < needCue) continue
    }
    scored.push({ rank, score, ts, ev, text })
  }

  // 时间线按时间；关键词按相关度，同分才看新旧。
  if (timeline) scored.sort((a, b) => b.ts - a.ts)
  else scored.sort((a, b) => b.rank - a.rank || b.ts - a.ts)

  // issue #133 的 5：同一条视频会落两三行（looked: 没日期 / look: / watched:）。
  // 全摆出来是同一条占三个名额，还让她以为那天看了三条。按 bvid 只留分量最重的
  // 那个；同分量（重复记账）只留排序靠前的第一条。
  const best = new Map()
  for (const s of scored) {
    const info = seenOf(s.ev)
    if (!info) continue
    const key = info.bvid
    const w = SEEN_WEIGHT[info.kind] ?? 0
    if (w > (best.get(key) ?? 0)) best.set(key, w)
  }
  const kept = []
  const taken = new Set()
  for (const s of scored) {
    const info = seenOf(s.ev)
    if (info) {
      const key = info.bvid
      if (taken.has(key) || (SEEN_WEIGHT[info.kind] ?? 0) < best.get(key)) continue
      taken.add(key)
    }
    kept.push(s)
  }

  // 改口关系不受 days、kind 影响：被改的那句在时间窗外，也照样引出来。
  const byId = new Map()
  if (revisions.size) {
    for (const ev of events ?? []) if (usable(ev)) byId.set(String(ev.id), ev)
  }
  const said = (ev, verdict) => ({
    id: String(ev.id ?? ''),
    verdict: verdict ?? null,
    // 引用也要说清来路：不然别人的话引出来就像她自己说过的。字数只算原话，来路另算。
    text: labelled(String(ev.type ?? ''), clip(oneLine(String(ev.text ?? '')), RECALL_BRIEF_SNIPPET), ev.scene) + (chatOnly(ev) ? CHAT_MARK : ''),
  })
  const rows = kept.slice(0, limit).map(({ ts, ev, text }) => {
    const seen = seenOf(ev)
    const next = revisions.get(String(ev.id))
    const last = next && lastSaying(next, revisions, ev.id)
    const earlier = ev.type === 'revise'
      ? (Array.isArray(ev.refs) ? ev.refs : []).filter((r) => String(r) !== String(ev.id)).map((r) => byId.get(String(r))).find(Boolean)
      : null
    return {
      id: String(ev.id ?? ''),
      // 2026-11-03（issue #19）：原来取 UTC 日期。她翻「那天」翻到的是隔天的日期，
      // 跟自己日记里的日期对不上。dateKey 走本地钟，与 settings 同一口径。
      date: dateKey(new Date(ts)),
      // 2026-11-04（群反馈第二条）：同一天里说过两句话，光有日期她分不清先后，
      // 更分不清哪句是后来改的口。这里补上本地时分（与报告、日记同一套口径）。
      clock: localClock(ts),
      // 按本地日历日数：同一行里的 date 走本地钟，括号里的天数要跟它对得上。
      ago: localDaysAgo(ts, now),
      type: String(ev.type ?? ''),
      // 场次（2026-11-08，用户 m00394）：群聊里他说的那句要在渲染时读得出来。
      scene: String(ev.scene ?? ''),
      // 她动手之前说的那句话（2026-11-07，用户 m00493 的 ⑤）。
      // 只对工具账算：别的行本身就是话，不需要来路。
      anchor: String(ev.type) === 'meta' ? anchorOf(events, ev.sessionId, ts) : '',
      // 聊天里随口说的，跟她自己认领写下的话分开标。heard 已经有「他说：」的先例，
      // 这边沿用同一套：能标出来源就标出来源，别让她把别人/随口当成自己写下的。
      chatOnly: chatOnly(ev),
      // 改口关系：refs 指向被改的那几条，verdict 说明是推翻还是修正。
      verdict: String(ev.verdict ?? ''),
      refs: Array.isArray(ev.refs) ? ev.refs.map(String) : [],
      // issue #23：关系单独成行，并带上对方原话开头。
      // her_recall 不能按 id 查——只给 id 她翻不到，等于还得猜。
      ...(last ? { later: said(last, last === next ? next.verdict : null) } : {}),
      ...(earlier ? { earlier: said(earlier, ev.verdict) } : {}),
      // issue #133：seen 行先翻成人话再截断。`look:`/`watched:` 后面挂着整段
      // JSON，先截再翻会把标题连 JSON 一起截坏，brief 档里只剩一个 BV 号。
      text: fillOwner(clip(oneLine(seen ? seenLabel(seen) : text), snippet)),
    }
  })
  return { rows, total: kept.length, truncated: kept.length > rows.length, timeline }
}

/**
 * 把一条记录转成她读得懂的一句（fork.10）。
 *
 * `saw:` / `watched:` / `browse:` 是系统记账，原文长得像配置项。
 * 她翻旧账时不该看见 `saw:BV1xx 《…》` 这种，得说成人话。
 * （0.8.8 的 labelled 只管 heard/voice/answer 的来源标注，不管这几种记账原文；
 * 所以两套并存：先 displayOf 翻记账，再 labelled 标来源。）
 */
function displayOf(r) {
  const text = String(r.text ?? '')
  // heard 的来源标注走 labelled：群里他本人那句要读成「他在群里说」（上游 #51/#96），
  // 在这儿写死「他说：」会把群聊和私聊混成一种。
  if (r.type === 'heard') return labelled('heard', text, r.scene)
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

/**
 * 改口关系，每条一行，缩进挂在那条下面：
 * 第一行的最后一个括号始终是这条自己的 id（身份文档就是这么教她抄 id 的）。
 * 先写它改了谁，再写它后来被谁改，正好是时间顺序。brief 档不引对方的话。
 */
function relationLines(r, brief) {
  const out = []
  if (r.earlier) {
    const { verdict, text, id } = r.earlier
    const word = verdict === 'refuted' ? '这句推翻的是' : verdict === 'confirmed' ? '这句确认的是' : '这句改的是'
    out.push(`  ${word}${brief ? '' : `：${text}`}（${id}）`)
  }
  if (r.later) {
    const { verdict, text, id } = r.later
    const word = verdict === 'refuted' ? '后来你推翻了这句' : verdict === 'confirmed' ? '后来你又确认过这句' : '后来你改过这句'
    out.push(`  ${word}${brief ? '' : `${verdict === 'confirmed' ? '：' : '，改说：'}${text}`}（${id}）`)
  }
  return out
}

/**
 * 渲染成她能读的一段（不是 JSON）
 *
 * 2026-11-04（群反馈第二条、第三条）改了三处展示口径：
 *   1. 时间到分钟。原来只有日期，同一天里说过两句矛盾的话，她分不清先后。
 *   2. 改口关系写出来。revise 一直带着 verdict 与 refs，但从来没往外拿过，
 *      于是「我改口了」在回忆里跟普通的一句长得一样（日报里反而一直印着）。
 *   3. 聊天里随口说的标出来。不是不许看，是要让她知道自己当时不是在记东西。
 */
export function renderRecall(rows, o = {}) {
  if (!rows?.length) return '你翻了，没翻到。'
  const brief = Boolean(o.brief)
  // 时间线和她给了词的翻找要分开说：前者是「最近这些」，后者才是「你翻到的」。
  // 混用会让她以为没给关键词也能命中什么。
  const head = brief
    ? '有这些（只报了开头，要看全的再说一次）：'
    : (o.timeline ? '最近这些（从近到远摆的）：' : '你翻到的：')
  const lines = [head]
  for (const r of rows) {
    // id 用小括号挂在最后：她要 revise / narration 时原样抄进来。
    // 没写 id 的老调用方（测试里的手写 fixture）就不显示括号，别凭空造一个。
    const mark = r.id ? `（${r.id}）` : ''
    const ago = Number.isFinite(r.ago) && r.ago > 0 ? `（${r.ago} 天前）` : ''
    const at = r.clock ? `${r.date} ${r.clock}` : r.date
    // 先翻成人话（fork.10 的 displayOf：heard 的「他说：」+ 记账原文的翻译），再按 brief 档截头——
    // 截的是翻好之后的正文，别让她看到截了一半的记账原文。
    let body = displayOf(r)
    // 来源标注（heard / voice / answer / meta）在翻译之后补上；scene 进 labelled（上游 #51）。
    if (r.type === 'voice' || r.type === 'answer' || r.type === 'meta') body = labelled(r.type, body, r.scene)
    if (brief) body = clip(body, RECALL_BRIEF_SNIPPET)
    // 当时那句话跟在后面：认得出「那次是为了什么」，就不必再猜。
    if (r.anchor) body += `——当时你在说「${r.anchor}」`
    if (r.chatOnly) body += CHAT_MARK
    // 改口关系：有对方原话就另起缩进行；手写 fixture 没有 earlier 数据时
    // 退回旧的一行式说明，别让这层信息静默消失。
    if (r.type === 'revise' && !r.earlier && !r.later) {
      // brief 档不再整体截断这段，所以 id 只报第一个，别让一条变长。
      const refs = Array.isArray(r.refs) ? r.refs : []
      const to = (brief ? refs.slice(0, 1) : refs).join(',')
      const how = r.verdict === 'refuted' ? '推翻了' : r.verdict === 'refined' ? '修正了' : r.verdict === 'confirmed' ? '仍然成立' : '改口'
      body += to ? `（${how} ${to}，那是更早说的）` : `（${how}，那是更早说的）`
    }
    lines.push(`- ${at}${ago}｜${body}${mark}`, ...relationLines(r, brief))
  }
  // issue #133 的 B：这里只摆了 top-k，原来什么都不说，于是「没翻到 / 只翻到这几条」
  // 被她读成「没有这回事」，还会被复述出去。不报条数（报数字等于催她再翻一次），
  // 只说清这不是全集，以及下结论时该怎么用。
  if (o.truncated) {
    lines.push(o.timeline
      ? '（这不是全部，只摆了最近的几条。要判断「没有」「没做过」「没看过」时，别把这份当成全集。）'
      : '（这不是全部，只摆了最相关的几条。要判断「没有」「没做过」「没看过」时，别把这份当成全集。）')
  }
  return fillOwner(lines.join('\n'))
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
        '翻你自己过去记下的事。想提"以前有一次"的时候先用它翻一翻，翻到了再说；翻不到就别编。默认翻全部时间，不只是最近。不记得关键词、只想按时间看看最近发生过什么，就只给 days、不给 query。',
      parameters: toJsonSchema({
        query: { type: 'string', required: false, description: '你想找的是什么，几个词就够。不记得关键词、只想按时间看最近的，就不传它。' },
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
          const { rows, total, truncated, timeline } = searchEvents(events, args?.query, {
            days: args?.days,
            kind: args?.kind,
            solidIds,
            // fork.36：可及性门槛的两个旋钮（settings.recall）。不传就是默认值。
            oldDays: deps.reach?.oldDays,
            minCue: deps.reach?.minCue,
            // fork.37：今天的"状态"浮动幅度
            jitter: deps.reach?.jitter,
            // 截断放在 searchEvents 里：这样 rows 本身就是短的，
            // 渲染层不必再按栏位切一刀（两处口径会打架）。
            snippet: brief ? RECALL_BRIEF_SNIPPET : RECALL_SNIPPET,
          })
          return { found: rows.length > 0, text: renderRecall(rows, { brief, total, truncated, timeline }) }
        } catch {
          // 翻不动就说翻不动，不要装作记得
          return { found: false, text: '你翻了，没翻到。' }
        }
      },
    }),
  )
}
