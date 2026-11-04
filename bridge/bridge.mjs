/**
 * bridge.mjs —— 把 QQ 消息接进她的本地通路（2026-11-01）
 *
 * 链路：
 *   QQ ←→ LuckyLillia(PMHQ + LLOneBot)  --OneBot 11 / ws-reverse-->  本文件
 *   本文件  --POST /dsh-fish/local/say-->  dsh-fish  --sc.prompt-->  她
 *
 * 为什么走 ws-reverse：LLOneBot 主动连出来，我们不用在 LL 那边开任何入站端口，
 * 也不用轮询；同一条连接既能收事件，也能发 action（send_private_msg 等）。
 * LL 那边只需把 ob11 的 ws-reverse url 指向这里。
 *
 * 为什么不用 dsh-im-gateway 的官方机器人通道：官方机器人在私聊/群里有各种限制，
 * 而且这条线要的是"像个人号一样说话"。代价是第三方协议有风控风险，自己权衡。
 *
 * 端口发现：DSH 桌面版每次重启端口都会变，所以不写死。先用 netstat 列出本机
 * 监听端口，再挨个打 /dsh-fish/local/ping（带密钥）认出真正的那个，缓存起来；
 * 调用失败就重新认一次。
 */

import { WebSocketServer } from 'ws'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPusher } from './push.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(HERE, 'config.json')
const LOG_PATH = join(HERE, 'bridge.log')

// ---------------------------------------------------------------- 配置

const DEFAULTS = {
  wsHost: '127.0.0.1',
  wsPort: 6199,
  wsPath: '/ws',
  accessToken: '',
  // 只让这些 QQ 号跟她说话；留空 = 谁私聊都转（个人号不推荐，容易被陌生人带着跑）
  ownerIds: [],
  allowGroup: false,
  // 她回的太长的按这个长度切段发（QQ 单条上限约 4500，留余量）
  chunkChars: 1500,
  // 同一人连发几条时，等这么久再合并成一次递话（0 = 不合批，一条一轮）
  mergeMs: 1500,
  // 带图的消息压这么久，等一句补充说明接上来（真机上 5~10 秒很常见）
  imageHoldMs: 8000,
  fishRoot: 'C:/Users/<用户名>/.dsh-fish',
  fishPort: 0, // 0 = 自动发现
  // fork.23（2026-11-02）：她看视频现在要下整条片子，一条消息两条链接就是 80 秒起。
  // 150 秒会把"还在看"判成"没说话"，于是 QQ 收不到她的回话。
  sayTimeoutMs: 300000,
  // 她主动说的话（her_say）推到 QQ：桥盯账本增量，见 push.mjs
  push: true,
  pushPollMs: 1500,
  // 2026-11-04：5 分钟太短。她 18:00 主动说的那句，桥 18:06 才连上 QQ，
  // 只差一分钟就被判“放了太久，不补发”——她那边看到“说出去了”，用户那边什么都没有。
  // 这类“正是断线期间说的话”恰恰最该补，所以放宽到 30 分钟。
  pushMaxAgeMs: 1800000,
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n')
    log(`没有 config.json，已按默认值生成：${CONFIG_PATH}`)
    return { ...DEFAULTS }
  }
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) }
  } catch (err) {
    log(`config.json 坏了（${err.message}），先用默认值跑`)
    return { ...DEFAULTS }
  }
}

// ---------------------------------------------------------------- 日志

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`
  console.log(line)
  try {
    appendFileSync(LOG_PATH, line + '\n')
  } catch { /* 日志写不下去不该影响转发 */ }
}

// ---------------------------------------------------------------- 找她的通路

const cfg = loadConfig()
const KEY_FILE = join(cfg.fishRoot, 'local.key')

function fishKey() {
  try {
    return readFileSync(KEY_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

/** 本机所有 LISTENING 的端口（TCP） */
function listeningPorts() {
  const ports = new Set()
  let out = ''
  try {
    out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true })
  } catch (err) {
    log('netstat 跑不动：', err.message)
    return []
  }
  for (const raw of out.split('\n')) {
    const m = raw.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+\d+$/i)
    if (!m) continue
    const addr = m[1]
    if (!/^(127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\]|\[::ffff:127\.0\.0\.1\])$/.test(addr)) continue
    ports.add(Number(m[2]))
  }
  return [...ports].filter((p) => p > 0 && p < 65536)
}

let cachedPort = Number(cfg.fishPort) || 0

async function probe(port, key) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 400)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/dsh-fish/local/ping`, {
      headers: { 'x-fish-key': key },
      signal: ac.signal,
    })
    if (!r.ok) return null
    const j = await r.json().catch(() => null)
    return j?.ok ? port : null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function discoverPort() {
  const key = fishKey()
  if (!key) {
    log(`读不到密钥：${KEY_FILE}（DSH 里 dsh-fish 跑过一次才会有）`)
    return 0
  }
  const ports = listeningPorts()
  // 先试缓存的那个，再并发扫其余
  if (cachedPort) {
    const ok = await probe(cachedPort, key)
    if (ok) return ok
    log(`缓存的端口 ${cachedPort} 不通了，重新找`)
    cachedPort = 0
  }
  const hits = await Promise.all(ports.map((p) => probe(p, key)))
  const found = hits.find(Boolean) || 0
  if (found) log(`认出她的通路：127.0.0.1:${found}`)
  return found
}

async function fishSay(text, image = '') {
  const key = fishKey()
  for (let attempt = 0; attempt < 2; attempt++) {
    const port = cachedPort || (await discoverPort())
    if (!port) return { ok: false, note: '没找到 dsh-fish 的通路' }
    cachedPort = port
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), cfg.sayTimeoutMs)
    try {
      const r = await fetch(`http://127.0.0.1:${port}/dsh-fish/local/say`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fish-key': key },
        body: JSON.stringify(image ? { text, image } : { text }),
        signal: ac.signal,
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) return { ok: false, note: j?.error ?? `HTTP ${r.status}` }
      return j
    } catch (err) {
      // 端口变了（DSH 重启）最常见：清掉缓存重来一次
      cachedPort = 0
      if (attempt === 1) return { ok: false, note: String(err?.message ?? err) }
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, note: '没送到' }
}

// ---------------------------------------------------------------- OneBot 侧

let socket = null
let seq = 0
const pendingActions = new Map()

function sendAction(action, params = {}) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== 1) return reject(new Error('OneBot 没连着'))
    const echo = `b${++seq}`
    pendingActions.set(echo, { resolve, reject })
    socket.send(JSON.stringify({ action, params, echo }))
    setTimeout(() => {
      if (pendingActions.has(echo)) {
        pendingActions.delete(echo)
        reject(new Error(`${action} 超时`))
      }
    }, 20000)
  })
}

/** OneBot 消息段 → 纯文本 + 图；顺便告诉调用方有没有 @ 到自己 */
function readMessage(ev) {
  const segs = Array.isArray(ev.message) ? ev.message : []
  let text = ''
  let atMe = false
  const images = []
  for (const s of segs) {
    if (s?.type === 'text') text += String(s.data?.text ?? '')
    else if (s?.type === 'at') {
      if (String(s.data?.qq) === String(ev.self_id)) atMe = true
    } else if (s?.type === 'image' || s?.type === 'mface') {
      // 表情包 / 图片 / 商城表情：都当成一张图递给她看
      images.push(s)
    }
    // face（QQ 小黄脸）是字体符号，没有可下载的图像，跳过
  }
  // mface 有时没有 url，只有一句 summary（「[动画表情]」），拿它当文字兜底
  if (!text && images.length) {
    const sum = images.map((s) => String(s?.data?.summary ?? '')).filter(Boolean).join(' ')
    if (sum) text = sum
  }
  if (!segs.length && typeof ev.raw_message === 'string') text = ev.raw_message
  return { text: text.trim(), atMe, images }
}

/** 她的通路收图上限是 6MB（media.js 的 MAX_IMAGE_BYTES），超了直接不发 */
const IMAGE_MAX_BYTES = 6 * 1024 * 1024

/** 她读图一次只能看一帧；动图（表情包）就把几帧拼成一张给她看 */
const FFMPEG = String(process.env.DSH_FISH_FFMPEG ?? '').trim()
  || 'C:\\Users\\<用户名>\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe'

function isGif(buf) {
  return buf?.length > 6 && buf.subarray(0, 3).toString('latin1') === 'GIF'
}

/** 同目录的 ffprobe；没有就返回空串 */
const FFPROBE = FFMPEG ? FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1') : ''

/**
 * GIF 到底动不动（有几帧）。
 *
 * 为什么要先问：QQ 里很多"表情包"其实是**单帧 GIF**（只是扩展名是 gif）。
 * 对单帧图拼 3x3 只会得到一张八格全黑的图，白花 token 还看不清。
 * 问不到就当动图处理（宁可多拼一次）。
 */
function gifFrames(buf) {
  if (!FFPROBE || !existsSync(FFPROBE)) return 0
  const tag = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const inp = join(tmpdir(), `fish-probe-${tag}.gif`)
  try {
    writeFileSync(inp, buf)
    const out = execFileSync(
      FFPROBE,
      ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', inp],
      { timeout: 15000, windowsHide: true, encoding: 'utf8' },
    )
    const n = Number(String(out).trim().replace(/\D/g, ''))
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  } finally {
    try { unlinkSync(inp) } catch { /* ignore */ }
  }
}

/**
 * 把动图抽几帧拼成一张 PNG。
 *
 * 为什么要试多组参数：`tile` 必须凑满整格才出图，而 GIF 长短差得远——
 * 3x3 要 9 帧、2x2 要 4 帧。短表情包（0.3 秒）给 fps=8 都未必够，
 * 所以从密到疏逐个试，第一个出图的就用。全都失败就用原图（至少是第一帧）。
 */
function sheetFromGif(buf) {
  const tag = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const inp = join(tmpdir(), `fish-gif-${tag}.gif`)
  const outp = join(tmpdir(), `fish-sheet-${tag}.png`)
  try {
    writeFileSync(inp, buf)
    for (const [fps, tile] of [[8, '3x3'], [6, '3x2'], [4, '2x2'], [3, '2x2'], [2, '1x2']]) {
      try { if (existsSync(outp)) unlinkSync(outp) } catch { /* ignore */ }
      try {
        execFileSync(
          FFMPEG,
          ['-hide_banner', '-loglevel', 'error', '-y', '-i', inp,
            '-vf', `fps=${fps},scale=280:-1,tile=${tile}:padding=4:margin=4`,
            '-frames:v', '1', outp],
          { timeout: 20000, windowsHide: true },
        )
      } catch { /* 这组参数没出图，换下一组 */ }
      try {
        const out = readFileSync(outp)
        if (out.length) return out
      } catch { /* 还没出图 */ }
    }
    return null
  } catch (err) {
    log('动图拼帧失败：', String(err?.message ?? err))
    return null
  } finally {
    try { unlinkSync(inp) } catch { /* ignore */ }
    try { unlinkSync(outp) } catch { /* ignore */ }
  }
}


/**
 * 把 OneBot 的图片段变成 Buffer。
 *
 * 优先 `url`（QQ 图床，匿名可取），退回本地 `file`（绝对路径才有意义，
 * 大多数情况那是服务器上的文件名，不是本机路径）。
 * 取不到就返回 null —— 退化成"她只知道你发了张图"，不因为一张图把整句话丢了。
 */
async function loadImage(seg) {
  const d = seg?.data ?? {}
  const tries = []
  if (typeof d.url === 'string' && /^https?:\/\//i.test(d.url)) tries.push({ kind: 'url', v: d.url })
  if (typeof d.file === 'string' && /^(?:[A-Za-z]:[\\/]|\/)/.test(d.file)) tries.push({ kind: 'file', v: d.file })

  for (const c of tries) {
    try {
      let buf
      if (c.kind === 'url') {
        const r = await fetch(c.v, { signal: AbortSignal.timeout(15000) })
        if (!r.ok) continue
        buf = Buffer.from(await r.arrayBuffer())
      } else {
        buf = readFileSync(c.v)
      }
      if (!buf?.length) continue
      if (buf.length > IMAGE_MAX_BYTES) {
        log(`图太大（${(buf.length / 1048576).toFixed(1)}MB > 6MB），不发`)
        continue
      }
      return buf
    } catch (err) {
      log('取图失败：', String(err?.message ?? err))
    }
  }
  return null
}

function allowed(senderId) {
  const list = (cfg.ownerIds ?? []).map(String).filter(Boolean)
  if (!list.length) return true // 没配白名单 = 谁来都转
  return list.includes(String(senderId))
}

/** 她说的话太长就切段发，尽量在换行/句号处断 */
function* chunks(text, size) {
  let rest = String(text ?? '').trim()
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size * 0.5) cut = rest.lastIndexOf('。', size)
    if (cut < size * 0.5) cut = size
    yield rest.slice(0, cut + 1).trim()
    rest = rest.slice(cut + 1).trim()
  }
  if (rest) yield rest
}

/**
 * 她回话里如果夹了图片，把图找出来单独发。
 *
 * 为什么需要：她拿到抽帧图之后会把路径写成 Markdown（`![某段视频的画面](C:/...png)`）——
 * 那是给界面看的写法。桥如果照字面发出去，QQ 里就是一串带路径的文字。
 *
 * 只认**她自己数据目录下的 media/**：她现在没有读文件的能力，这个范围收窄不挡她做事，
 * 但万一以后加了工具，也不至于变成"让她把本机任意文件贴进聊天"的口子。
 */
const IMG_MD = /!\[[^\]]*\]\(([^)\s]+)\)/g

function splitImages(text) {
  const paths = []
  const cleaned = String(text ?? '')
    .replace(IMG_MD, (_m, p) => {
      paths.push(String(p).trim())
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text: cleaned, paths }
}

const MEDIA_DIR = join(cfg.fishRoot, 'media').replace(/\\/g, '/').toLowerCase()

/** 读一张她本地生成的图；不在 media/ 下、不存在、太大，一律不发 */
function readLocalImage(p) {
  let path = String(p ?? '').replace(/\\/g, '/')
  if (!path) return null
  // 允许相对写法（media/xxx.png）
  if (!/^[A-Za-z]:\//.test(path)) path = join(cfg.fishRoot, path).replace(/\\/g, '/')
  if (!path.toLowerCase().startsWith(MEDIA_DIR)) {
    log(`她想发的图不在 media/ 下，跳过：${path}`)
    return null
  }
  try {
    const buf = readFileSync(path)
    if (!buf.length) return null
    if (buf.length > IMAGE_MAX_BYTES) {
      log(`她想发的图太大（${(buf.length / 1048576).toFixed(1)}MB），跳过`)
      return null
    }
    return buf
  } catch (err) {
    log('读她想发的图失败：', String(err?.message ?? err))
    return null
  }
}

/**
 * 把她的一段回复拆成几条消息发。
 *
 * 为什么：她的回复天然是分段的（一段一个念头），但 QQ 里收到的是一整块——
 * 她自己都看出来了（"一次递出去就是一块，断不成好几条消息"），用户反馈像 AI 。
 * 真人聊天是一句一条。所以按空行切段，逐条发，中间隔一点。
 *
 * 太短的段（"行。"）不单独占一条，并到上一段去，免得变成刷屏。
 */
function splitForChat(text, maxChars, maxParts) {
  const paras = String(text ?? '')
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean)

  const parts = []
  for (const p of paras) {
    if (p.length <= maxChars) {
      parts.push(p)
      continue
    }
    for (const c of chunks(p, maxChars)) parts.push(c)
  }

  // 太短的并到上一条
  const merged = []
  for (const p of parts) {
    if (merged.length && p.length < 12) merged[merged.length - 1] += '\n' + p
    else merged.push(p)
  }
  // 超过上限时把尾部的并回上一条，**不能直接截断**——截断就是吞她的话
  while (merged.length > maxParts) {
    const last = merged.pop()
    merged[merged.length - 1] += '\n' + last
  }
  return merged
}

/**
 * 发一条（或几条）话给他。
 *
 * strict：失败要抛出去。她回话时用不着（发不出去记一行日志就完了，不能因为
 * QQ 抽风让整轮对话失败）；但**主动推送必须严格**——推不出去却当推成功了，
 * 那句话就永远消失，连重试的机会都没有。
 */
async function reply(ev, text, { strict = false } = {}) {
  const { text: clean, paths } = splitImages(text)

  const split = cfg.splitReplies !== false
  const maxChars = Number(cfg.chunkChars) || 1500
  const maxParts = Number(cfg.maxParts) || 6
  const parts = split ? splitForChat(clean, maxChars, maxParts) : [...chunks(clean, maxChars)]

  for (let i = 0; i < parts.length; i++) {
    // 分条时不再加 (i/n) 序号——那是"长文分页"的记号，聊天里看着更机器
    const body = split ? parts[i] : `${parts[i]}\n\n（${i + 1}/${parts.length}）`
    try {
      if (ev.message_type === 'group') {
        await sendAction('send_group_msg', { group_id: ev.group_id, message: body })
      } else {
        await sendAction('send_private_msg', { user_id: ev.user_id, message: body })
      }
    } catch (err) {
      log('回消息失败：', err.message)
      if (strict) throw err
    }
    // 条与条之间留一点，像人在打字；最后一条不用等
    if (split && i < parts.length - 1) await new Promise((r) => setTimeout(r, Number(cfg.splitDelayMs) || 600))
  }

  // 图单独发。一次一张，因为 OneBot 的图片消息段一封就是一张，
  // 混在文字里发反而容易在客户端显示成附件列表。
  for (const p of paths) {
    const buf = readLocalImage(p)
    if (!buf) continue
    try {
      const seg = { type: 'image', data: { file: 'base64://' + buf.toString('base64') } }
      if (ev.message_type === 'group') {
        await sendAction('send_group_msg', { group_id: ev.group_id, message: [seg] })
      } else {
        await sendAction('send_private_msg', { user_id: ev.user_id, message: [seg] })
      }
      log(`发了一张图给他：${p}（${(buf.length / 1024).toFixed(0)}KB）`)
    } catch (err) {
      log('发图失败：', String(err?.message ?? err))
    }
  }
}

// 一次只递一句：她那边是一轮一轮跑的，挤进去只会互相打断
let queue = Promise.resolve()
function enqueue(task) {
  queue = queue.then(task).catch((err) => log('队列出错：', String(err?.message ?? err)))
  return queue
}

/**
 * 同 enqueue，但**把失败抛给调用方**。
 *
 * 为什么要两套：enqueue 的 catch 是为了让队列不断，代价是把错误吞了。
 * 推送那边必须知道"到底发出去没有"——吞掉错误就等于把那句话弄丢。
 */
function enqueueStrict(task) {
  const run = queue.then(task)
  queue = run.catch((err) => log('队列出错：', String(err?.message ?? err)))
  return run
}

/**
 * 合批（2026-11-02）：同一个人连着发的几条消息，合成一次递给她。
 *
 * 为什么：QQ 里"发张图 + 紧跟着一句解释"是两条独立消息，各带一个事件。
 * 原来一条一轮，于是出现过这种对话——
 *   图单独成一轮 → 她答"我看到了这张图"
 *   文字单独成一轮 → 她答"我手上只有你那句话，没有那张图"
 * 她没记错，是这两句真的被拆进了两轮。
 *
 * 两档等待，按内容区别对待：
 *   · **带图的**：压 `imageHoldMs`（默认 8 秒）。真机上"发图 → 补一句"通常隔 5~10 秒，
 *     压太短合不上，压太长每条都慢。带图的慢一点可以接受——她本来就要花时间看图。
 *   · **纯文字**：只压 `mergeMs`（默认 1.5 秒），够粘住连发的几行，不至于让对话变迟钝。
 *   · 如果图上已经压着一批、文字随后到了：立刻合并发出，不再等第二档。
 *
 * `mergeMs: 0` 且 `imageHoldMs: 0` 可以关掉合批，回到一条一轮。
 */
const pendingChats = new Map()

function chatKey(ev) {
  return `${ev.message_type}:${ev.group_id ?? ''}:${ev.user_id}`
}

function schedule(ev, part) {
  const key = chatKey(ev)
  let p = pendingChats.get(key)
  const hadPending = Boolean(p)
  if (!p) {
    p = { ev, texts: [], images: [], timer: null }
    pendingChats.set(key, p)
  }
  if (part.text) p.texts.push(part.text)
  if (part.images?.length) p.images.push(...part.images)
  p.ev = ev
  if (p.timer) clearTimeout(p.timer)

  const mergeMs = Number(cfg.mergeMs) || 0
  const imageHoldMs = Number(cfg.imageHoldMs) || 0
  // 图还没等到文字 → 继续等；文字接上了压着的图 → 立刻发；其余按自己的档等
  const wait = part.images?.length ? imageHoldMs : hadPending && p.images.length ? 0 : mergeMs

  if (wait <= 0) {
    pendingChats.delete(key)
    void flush(p)
    return
  }
  p.timer = setTimeout(() => {
    pendingChats.delete(key)
    void flush(p)
  }, wait)
}

async function flush(p) {
  const ev = p.ev
  const text = p.texts.join('\n').trim()
  const images = p.images
  const who = ev.message_type === 'group' ? `群 ${ev.group_id} / ${ev.user_id}` : `私聊 ${ev.user_id}`
  log(`${who}: ${text.slice(0, 80) || '（只发了图）'}${images.length ? ` [图 ${images.length}]` : ''}${p.texts.length > 1 || images.length > 1 ? `（合批 ${p.texts.length} 句 / ${images.length} 图）` : ''}`)

  return enqueue(async () => {
    const t0 = Date.now()
    // 一次只带一张：她的通路一轮只收一个 image。连发多张先看第一张，其余留个记号。
    let image = ''
    if (images.length) {
      let buf = await loadImage(images[0])
      // 动图（表情包多半是）抽几帧拼一张 —— 她一次只能看一帧，看第一帧等于没看懂那个表情。
      // 单帧 GIF 不拼：那样只会得到一张八格全黑的图。
      if (buf && isGif(buf)) {
        const frames = gifFrames(buf)
        if (frames > 1 || frames === 0) {
          const sheet = sheetFromGif(buf)
          if (sheet) {
            log(`动图拼帧：${frames || '?'} 帧 · ${(buf.length / 1024).toFixed(0)}KB → ${(sheet.length / 1024).toFixed(0)}KB`)
            buf = sheet
          }
        } else {
          log('这张 GIF 只有一帧，按静态图发')
        }
      }
      if (buf) image = buf.toString('base64')
      if (images.length > 1) log(`他一次发了 ${images.length} 张图，这一轮只看第一张`)
    }
    const r = await fishSay(text, image)
    const ms = Date.now() - t0
    if (!r?.ok) {
      log(`没送到（${ms}ms）：${r?.note ?? '未知'}`)
      // 她明确说"没说话"也回一句，让人知道话进去了但没答
      if (r?.note && r.note !== '她这次没说话。') {
        await reply(ev, `（这句没递进去：${r.note}）`)
      }
      return
    }
    // 只发她会话里**说出口**的那句（spoken）。
    // herReply 在老版本里是她"说出口的 + 记下的判断"拼起来的，把后者发到 QQ 会
    // 像是她在回复里夹了一段第三人称的自我分析；接口给了 spoken 就优先用它。
    const said = String(r.spoken || r.herReply || '').trim()
    if (!said) {
      log(`她没说话（${ms}ms）`)
      return
    }
    log(`她回了 ${said.length} 字（${ms}ms）`)
    await reply(ev, said)
  })
}

/** 收到一条 QQ 消息：先过滤，再丢进合批窗口 */
function onMessage(ev) {
  // 2026-11-02：进门先记一行。以前被过滤掉的分支（群消息、空内容）**一声不响**，
  // 出问题时只能看到"桥没反应"，分不清是消息没到、还是到了被规则挡了。
  const who = ev.message_type === 'group' ? `群 ${ev.group_id} / ${ev.user_id}` : `私聊 ${ev.user_id}`
  const brief = readMessage(ev)
  log(`收到消息 [${ev.message_type}] ${who} self=${ev.self_id} 文字${brief.text.length}字 图${brief.images.length}`)

  if (String(ev.user_id) === String(ev.self_id)) return // 自己发的
  if (!allowed(ev.user_id)) {
    log(`陌生人 ${ev.user_id} 说话，没转（不在 ownerIds 里）`)
    return
  }
  const { text, atMe, images } = brief
  if (ev.message_type === 'group' && !(cfg.allowGroup && atMe)) {
    log('群消息，但没 @ 她 / 没开 allowGroup，跳过')
    return
  }
  // 只发图不写字也是合法的（他自己也常这么干）
  if (!text && !images.length) {
    log('这条既没文字也没图（表情/戳一戳之类），跳过')
    return
  }
  schedule(ev, { text, images })
}

// ---------------------------------------------------------------- 她的主动话 → QQ

const PUSH_STATE = join(HERE, 'push-state.json')

/**
 * 把一条主动的话推给他的 QQ。
 *
 * 走 enqueueStrict 而不是 enqueue：一是要和她回话共用**同一条发送队列**
 * （两条消息在 QQ 里交错，读起来像她同时说两件事），二是推送必须知道成败——
 * 失败要留在 offset 前面等下一轮重试。
 */
function pushDeliver(item) {
  const ids = (cfg.ownerIds ?? []).map(String).filter(Boolean)
  if (!ids.length) return Promise.reject(new Error('ownerIds 是空的，不知道推给谁'))
  return enqueueStrict(async () => {
    for (const uid of ids) {
      // 语音（2026-11-04）：item.text 这时是音频文件的绝对路径。
      // 段类型用 record —— LLBot 内部会 encodeSilk，给它 mp3 就行（实测 17:59 之前那条“叮”就是这条链路）。
      if (item.kind === 'voice') {
        await sendAction('send_private_msg', {
          user_id: uid,
          message: [{ type: 'record', data: { file: item.text } }],
        })
        log(`发了语音：${item.text}`)
        continue
      }
      await reply({ message_type: 'private', user_id: uid }, item.text, { strict: true })
    }
  })
}

const pusher = createPusher({
  file: join(cfg.fishRoot, 'events.jsonl'),
  statePath: PUSH_STATE,
  pollMs: Number(cfg.pushPollMs) || 1500,
  maxAgeMs: Number(cfg.pushMaxAgeMs) || 1800000,
  deliver: pushDeliver,
  log,
})

// ---------------------------------------------------------------- WebSocket 服务

const wss = new WebSocketServer({ host: cfg.wsHost, port: cfg.wsPort, path: cfg.wsPath })

/**
 * 调试口（2026-11-04）：只为验证「LLBot 能不能发某种消息」。
 *
 * 为什么要有：桥是 ws 服务端、LLBot 主动连进来，外面没有别的口子能发 action。
 * 每试一个新消息类型（语音、视频、文件）都得改代码重启，太慢；而这类问题
 * 只能靠「真发一条看 QQ 收到什么」才能确定。
 *
 * 三条自我约束：
 *   1. 只监听 127.0.0.1，外部网络够不到
 *   2. 只能发给 ownerIds 里的第一个人，发不了别人
 *   3. 只做 send_private_msg，不收消息、不改配置、不碰账本
 * 不要就设 FISH_BRIDGE_DEBUG=0 关掉。
 */
if (process.env.FISH_BRIDGE_DEBUG !== '0') {
  const dbgPort = Number(process.env.FISH_BRIDGE_DEBUG_PORT || 6198)
  const dbg = createServer(async (req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1')
    if (u.pathname !== '/debug/send') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('只有 /debug/send')
    }
    const to = Number(u.searchParams.get('to') || (cfg.ownerIds ?? [])[0] || 0)
    if (!(cfg.ownerIds ?? []).map(Number).includes(to)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('只发给 ownerIds 里的人')
    }
    const type = String(u.searchParams.get('type') || 'text')
    const file = String(u.searchParams.get('file') || '')
    const text = String(u.searchParams.get('text') || '')
    const seg = type === 'text' ? { type: 'text', data: { text } } : { type, data: { file } }
    try {
      const r = await sendAction('send_private_msg', { user_id: to, message: [seg] })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, sent: seg, result: r }))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
    }
  })
  dbg.on('error', (e) => log('调试口没开起来：', e.message))
  dbg.listen(dbgPort, '127.0.0.1', () => log(`调试口：http://127.0.0.1:${dbgPort}/debug/send`))
}

wss.on('listening', () => {
  log(`等 LLOneBot 连进来：ws://${cfg.wsHost}:${cfg.wsPort}${cfg.wsPath}`)
  if (!(cfg.ownerIds ?? []).length) log('⚠️ ownerIds 是空的 —— 任何私聊都会被转给她')
  discoverPort().then((p) => {
    if (p) log(`她这会儿在 127.0.0.1:${p}`)
    else log('暂时没找到她（DSH 没开？），收到 QQ 消息时会再找')
  })
  // 她主动说的话（her_say）从这个口子出去
  if (cfg.push !== false) {
    pusher.start()
    log(`主动推送已开：盯 ${join(cfg.fishRoot, 'events.jsonl')}，每 ${Number(cfg.pushPollMs) || 1500}ms 看一次`)
  } else {
    log('主动推送关掉了（config.push = false）')
  }
})

wss.on('error', (err) => {
  log('WebSocket 服务出错：', err.message)
  if (err?.code === 'EADDRINUSE') log(`端口 ${cfg.wsPort} 被占了 —— 是不是 ohwhale 那套还在跑？`)
})

wss.on('connection', (ws, req) => {
  // 简单鉴权：LLOneBot 支持在 URL 上带 access_token
  const token = cfg.accessToken
  if (token) {
    const u = new URL(req.url, 'http://x')
    const got = u.searchParams.get('access_token') ?? ''
    if (got !== token) {
      log('有人连进来但 token 不对，断开')
      ws.close()
      return
    }
  }
  socket = ws
  log('LLOneBot 连上了')

  ws.on('message', (raw) => {
    let ev
    try {
      ev = JSON.parse(raw.toString())
    } catch {
      return
    }
    // action 的应答
    if (ev?.echo && pendingActions.has(ev.echo)) {
      const p = pendingActions.get(ev.echo)
      pendingActions.delete(ev.echo)
      if (ev.status === 'ok' || ev.retcode === 0) p.resolve(ev)
      else p.reject(new Error(ev.message ?? `retcode ${ev.retcode}`))
      return
    }
    if (ev?.post_type === 'meta_event') {
      if (ev.meta_event_type === 'lifecycle') log(`LLOneBot 生命周期：${ev.sub_type}`)
      return
    }
    if (ev?.post_type === 'message') {
      try {
        onMessage(ev)
      } catch (err) {
        log('处理消息出错：', String(err?.message ?? err))
      }
      return
    }
    // 别的上报（notice / request / 未知识别）以前一声不响地丢掉，
    // 排查时看不出"到底有没有东西进来"
    if (ev?.post_type) log(`收到上报但没处理：post_type=${ev.post_type}${ev.notice_type ? ` notice=${ev.notice_type}` : ''}${ev.request_type ? ` request=${ev.request_type}` : ''}`)
  })

  ws.on('close', () => {
    if (socket === ws) socket = null
    log('LLOneBot 断开了')
  })
  ws.on('error', (err) => log('连接出错：', err.message))
})

// 收到 Ctrl+C 时收摊
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('收工')
    try { pusher.stop() } catch { /* ignore */ }
    try { wss.close() } catch { /* ignore */ }
    process.exit(0)
  })
}
