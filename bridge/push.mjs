/**
 * push.mjs —— 把「她主动说的话」推到 QQ（2026-11-02）
 *
 * 为什么需要：她主动搭话（her_say）只落在 DSH 侧栏和账本里，QQ 那边看不到。
 * 于是她开口了、他不在电脑前，就等于没说。
 *
 * 为什么桥去读账本，而不是插件 POST 过来：
 *   1. 账本已经是唯一真相源，而且 her_say 写的时候留了明确标记（见下）；
 *   2. 桥的 config 里本来就有 fishRoot，账本路径现成，不用新增端口/发现/鉴权；
 *   3. 改桥一处即可生效，不用重启 DSH（重启会打断他和她的会话）；
 *   4. offset 落盘，天然幂等——插件重试、桥重连都不会重复刷屏。
 *
 * 怎么认出「她主动说的」：proactive.js 的 her_say 写的是
 *   { type:'utterance', source:'tool', text:'（她主动说）' + 正文 }
 * 紧跟一条 meta `proactive-say:日期:原因`。标记就在正文前缀里，不用猜。
 * 将来陪看接进来，写 `（陪你看）` 前缀即可——加一行表项，逻辑不动。
 *
 * 三条实现约束：
 *   1. **增量读**：按字节 offset 读新增部分，不做全量解析（账本一年能长到几 MB）；
 *   2. **半行不处理**：只吃以 \n 结尾的完整行，剩下的留到下次（append 是原子的，
 *      但读的时刻可能正好撞上写入中间）；
 *   3. **失败不推进 offset**：推不出去就停在那条上，下次重试；超过 maxAgeMs 就丢弃
 *      并跳过——隔夜补发一句"晚上好"读起来像鬼。
 */

import { openSync, closeSync, readSync, statSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * 哪些前缀算「她主动说的话」。
 * 新增一类（比如陪看）就在这里加一行，其余逻辑不用动。
 */
export const PUSH_MARKERS = Object.freeze([
  { tag: '（她主动说）', kind: 'proactive' },
  { tag: '（陪你看）', kind: 'watch' },
  // 2026-11-07（用户）：她回复时分条用 —— `her_say` 的 reply 模式。
  // 桥不再按空行替她切，她调一次就是一条，条数由她自己定。
  { tag: '（她说）', kind: 'say' },
])

/** 单次最多读这么多字节，免得账本暴涨时一次吞进来几十 MB */
const MAX_READ = 4 * 1024 * 1024

/**
 * 一行账本 → 要不要推、推什么。
 *
 * 只认三件事同时成立：utterance / source=tool / 正文带标记前缀。
 * 为什么非要 source=tool：growth_commit 也写 utterance（她记下的判断），
 * 那些是内心活动，不是话说出口——发到 QQ 就是替她开口（fork.7 的教训）。
 *
 * 2026-11-08 新增两类（都要过 state——跨行的配对需要记住上一条 utterance）：
 *   ask    她用 ask_owner 挂的申请卡 → 推到 QQ，他回数字就答（bridge 经
 *          /local/answer 走 answerCard，与 DSH 卡片同一条结算代码）
 *   letter her_leave 的信（utterance + 紧跟的 `letter:` 标记成对出现）→
 *         信的正文在 utterance 里，标记只带 id，所以要靠 state 配对
 *
 * @param {string} line
 * @param {{lastUtterance?:{id:string,text:string,ts:string}}} [state] 跨行配对用
 * @returns {{id:string, kind:string, text:string, ts:string, askId?:string, options?:string[]}|null}
 */
export function parsePushLine(line, state = {}) {
  let ev
  try {
    ev = JSON.parse(line)
  } catch {
    return null
  }
  if (!ev) return null
  // 语音（2026-11-04）：她调 her_voice 时落一条 meta `voice:<音频路径>|<她说的那句>`
  // 用 meta 不用 utterance —— utterance 会进 beliefs，而"她说出声"不是"她判断了什么"。
  // 她的申请卡（2026-11-08）：ask_owner 挂的 ask 直接成卡推 QQ。
  // 选项编号在文案里带出来；他的回复由 bridge 拦下（只认数字），经
  // /local/answer → answerCard 结算——与 DSH 卡片同一条代码，不养第二套。
  if (ev.type === 'ask') {
    const q = String(ev.text ?? '').trim()
    if (!q) return null
    const opts = (Array.isArray(ev.ask?.options) ? ev.ask.options : []).map((o) => String(o).trim()).filter(Boolean)
    const lines = [`（她想问你）${q}`]
    if (opts.length) {
      opts.forEach((o, i) => lines.push(`${i + 1}. ${o}`))
      lines.push('（回数字就答了，比如「1」；想说别的就直接说，她能收到）')
    } else {
      lines.push('（这题没有预设选项——去 7788 查看器「观测台」答她）')
    }
    return { id: String(ev.id ?? ''), kind: 'ask', askId: String(ev.id ?? ''), options: opts, text: lines.join('\n'), ts: String(ev.ts ?? '') }
  }
  if (ev.type === 'meta') {
    const raw = String(ev.text ?? '')
    // 信（2026-11-08）：her_leave 落 utterance + 紧跟的 `letter:<日期>:<id>` 标记。
    // 正文在标记的前一条 utterance 里（state 配对），标记本身只有 id。
    if (raw.startsWith('letter:')) {
      const ref = raw.slice('letter:'.length).split(':').pop()
      const u = state?.lastUtterance
      if (!u || u.id !== ref) return null
      const body = String(u.text ?? '').trim()
      if (!body) return null
      return { id: String(ev.id ?? ''), kind: 'letter', text: `（她留了封信）${body}`, ts: u.ts }
    }
    // 语音 / 表情（2026-11-05）：同一种形状——meta + 文件路径，桥只按 kind 发不同的段。
    const kind = raw.startsWith('voice:') ? 'voice' : raw.startsWith('meme:') ? 'meme' : ''
    if (!kind) return null
    const rest = raw.slice(kind.length + 1)
    const bar = rest.indexOf('|')
    const file = (bar >= 0 ? rest.slice(0, bar) : rest).trim()
    if (!file) return null
    return { id: String(ev.id ?? ''), kind, text: file, ts: String(ev.ts ?? '') }
  }
  if (ev.type !== 'utterance' || ev.source !== 'tool') return null
  const raw = String(ev.text ?? '')
  // her_leave 的信是「utterance 在前、标记在后」：每条 tool utterance 都记下来，
  // 下一条 letter 标记来配对（见上面 meta 分支）。
  state.lastUtterance = { id: String(ev.id ?? ''), text: raw, ts: String(ev.ts ?? '') }
  for (const m of PUSH_MARKERS) {
    if (!raw.startsWith(m.tag)) continue
    const body = raw.slice(m.tag.length).trim()
    if (!body) return null
    return { id: String(ev.id ?? ''), kind: m.kind, text: body, ts: String(ev.ts ?? '') }
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 造一个推送器。start() 之后每 pollMs 看一次账本；tick() 可以直接手动驱动（测试用）。
 *
 * @param {object} o
 *   file      账本路径
 *   statePath offset 落盘位置
 *   pollMs    轮询间隔（默认 1500）
 *   maxAgeMs  超过这么久的没推出去就丢弃（默认 5 分钟）
 *   deliver   (item) => Promise，成功 resolve，失败 throw
 *   log       (...args) => void
 *   now       () => number（测试注入）
 */
export function createPusher({
  file,
  statePath,
  pollMs = 1500,
  maxAgeMs = 5 * 60 * 1000,
  deliver,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  let offset = 0
  let ready = false
  let timer = null
  let busy = false
  // 跨行配对用：letter 标记要找它前面那条 utterance（见 parsePushLine）
  const scan = { lastUtterance: null }
  // 已推到 QQ、还没答的申请卡：askId → { options, at }。
  // 他回数字时 bridge 拿它映射成选项，经 /local/answer 结算后调 resolveAsk 删掉。
  // 进程重启就丢——丢了只是不拦截，他的回复照常递给她，不会错答。
  const pending = new Map()

  const sizeOf = () => {
    try {
      return statSync(file).size
    } catch {
      return -1
    }
  }

  function loadOffset() {
    try {
      const j = JSON.parse(readFileSync(statePath, 'utf8'))
      return Number.isFinite(j?.offset) && j.offset >= 0 ? Number(j.offset) : null
    } catch {
      return null
    }
  }

  function saveOffset() {
    try {
      writeFileSync(statePath, JSON.stringify({ offset, updatedAt: new Date(now()).toISOString() }, null, 2) + '\n')
    } catch (err) {
      log('push: 存 offset 失败（下次可能重复推一条）：', String(err?.message ?? err))
    }
  }

  /**
   * 推一条。失败重试一次。
   * @returns {Promise<'sent'|'drop'|'fail'>} fail 时 offset 停在它前面等下一轮
   */
  async function handle(item) {
    const at = Date.parse(item.ts || '')
    const age = Number.isFinite(at) ? now() - at : 0
    if (age > maxAgeMs) {
      log(`push: 这条已经放了 ${Math.round(age / 60000)} 分钟，不补发：${item.text.slice(0, 30)}`)
      return 'drop'
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await deliver(item)
        log(`push: ${item.kind} 已推出 ${item.text.length} 字`)
        return 'sent'
      } catch (err) {
        log(`push: 第 ${attempt + 1} 次没推出去（${String(err?.message ?? err)}）`)
        if (attempt === 0) await sleep(500)
      }
    }
    return 'fail'
  }

  /**
   * 看一次账本。返回 { pushed, stopped }：pushed = 这轮推了几条，
   * stopped = 是否因为推不出去停在半路（下轮接着来）。
   */
  async function tick() {
    if (busy) return { pushed: 0, stopped: false }
    busy = true
    let pushed = 0
    let stopped = false
    try {
      const size = sizeOf()
      if (size < 0) return { pushed, stopped } // 账本还不存在，等她先写第一行
      if (!ready) {
        // 第一次跑：从当前末尾起算。**不补推历史**——她前 39 条判断不该在开机时刷屏。
        offset = size
        saveOffset()
        ready = true
        log(`push: 第一次跑，从末尾 ${size}B 起算（不补推历史）`)
        return { pushed, stopped }
      }
      if (size === offset) return { pushed, stopped }
      if (size < offset) {
        // 账本被换过/截断了。当新文件从头记，同样不补推。
        log(`push: 账本变小了（${offset} → ${size}B），当新文件重来`)
        offset = size
        saveOffset()
        return { pushed, stopped }
      }

      const len = Math.min(size - offset, MAX_READ)
      const buf = Buffer.allocUnsafe(len)
      const fd = openSync(file, 'r')
      try {
        readSync(fd, buf, 0, len, offset)
      } finally {
        closeSync(fd)
      }

      // 只吃到最后一个换行为止：半行留到下次（UTF-8 边界也按字节算，不解码再回算）
      const lastNl = buf.lastIndexOf(0x0a)
      if (lastNl < 0) return { pushed, stopped }

      // base 必须固定：offset 在循环里会往前挪，拿它算行尾就串位了（第一版栽在这）
      const base = offset
      let start = 0
      for (let i = 0; i <= lastNl; i++) {
        if (buf[i] !== 0x0a) continue
        const lineEnd = base + i + 1
        const line = buf.subarray(start, i).toString('utf8').trim()
        start = i + 1
        if (!line) {
          offset = lineEnd
          continue
        }
        const item = parsePushLine(line, scan)
        if (!item) {
          offset = lineEnd
          continue
        }
        const res = await handle(item)
        if (res === 'fail') {
          stopped = true
          break
        }
        if (res === 'sent') {
          pushed += 1
          // 卡推出去才登记待答：推失败的下轮重推，不提前占位
          if (item.kind === 'ask' && item.askId && (item.options ?? []).length) {
            pending.set(item.askId, { options: item.options, at: Date.parse(item.ts) || now() })
          }
        }
        offset = lineEnd
        saveOffset() // 每处理完一条就落盘：崩了最多重复一条，不会丢一串
      }
      if (!stopped) saveOffset()
      return { pushed, stopped }
    } catch (err) {
      log('push: 这轮出错：', String(err?.message ?? err))
      return { pushed, stopped }
    } finally {
      busy = false
    }
  }

  function start() {
    if (timer) return
    const saved = loadOffset()
    const size = sizeOf()
    if (size >= 0) {
      if (saved === null || saved > size) {
        offset = size
        saveOffset()
        ready = true
        log(`push: 从末尾 ${size}B 起算（不补推历史）`)
      } else {
        offset = saved
        ready = true
        if (offset < size) log(`push: 从 ${offset}B 接着读（落后 ${size - offset}B）`)
        else log(`push: 就位（${offset}B）`)
      }
    }
    timer = setInterval(() => { void tick() }, Math.max(200, Number(pollMs) || 1500))
    timer.unref?.()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  /**
   * 他的一条 QQ 回复是不是在答某张卡。**只认 1–2 位数字**——「可以」这类词
   * 日常对话太常见，文本匹配会错答；数字是卡片上明确教他的答法。
   * 多张卡同时挂着时取最早推的那张（她一天最多问一次，撞上算极小概率）。
   */
  function pendingAskMatch(text) {
    const t = String(text ?? '').trim()
    if (!/^\d{1,2}$/.test(t)) return null
    const n = Number(t)
    for (const [askId, p] of pending) {
      if (now() - p.at > 24 * 3600_000) { pending.delete(askId); continue } // 账本侧 TTL 同步
      if (n >= 1 && n <= p.options.length) return { askId, selected: p.options[n - 1] }
    }
    return null
  }

  /** 结算成功后由 bridge 调：这张卡不用再拦了。 */
  function resolveAsk(askId) {
    pending.delete(String(askId ?? ''))
  }

  return { start, stop, tick, pendingAskMatch, resolveAsk, get offset() { return offset }, get ready() { return ready }, get pendingCount() { return pending.size } }
}
