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

/** OneBot 消息段 → 纯文本 + 图 + 文件；顺便告诉调用方有没有 @ 到自己 */
function readMessage(ev) {
  const segs = Array.isArray(ev.message) ? ev.message : []
  let text = ''
  let atMe = false
  const images = []
  const files = []
  const forwards = []
  for (const s of segs) {
    if (s?.type === 'text') text += String(s.data?.text ?? '')
    else if (s?.type === 'at') {
      if (String(s.data?.qq) === String(ev.self_id)) atMe = true
    } else if (s?.type === 'image' || s?.type === 'mface') {
      // 表情包 / 图片 / 商城表情：都当成一张图递给她看
      images.push(s)
    } else if (s?.type === 'file') {
      // 2026-11-05：他发文件时，落到她的收件箱，路径交给她自己决定要不要开
      files.push(s)
    } else if (s?.type === 'forward' || s?.type === 'node') {
      // 2026-11-05：合并转发的聊天记录。段里通常**只有一个 id**，内容要拿它去换
      // （跟 file 段同一个坑：消息里不放正文，只放一个句柄）。
      forwards.push(s)
    }
    // face（QQ 小黄脸）是字体符号，没有可下载的图像，跳过
  }
  // mface 有时没有 url，只有一句 summary（「[动画表情]」），拿它当文字兜底
  if (!text && images.length) {
    const sum = images.map((s) => String(s?.data?.summary ?? '')).filter(Boolean).join(' ')
    if (sum) text = sum
  }
  if (!segs.length && typeof ev.raw_message === 'string') text = ev.raw_message
  return { text: text.trim(), atMe, images, files, forwards }
}

/** 她的通路收图上限是 6MB（media.js 的 MAX_IMAGE_BYTES），超了直接不发 */
const IMAGE_MAX_BYTES = 6 * 1024 * 1024

/** 一次最多拼几张：再多，每张都会被缩到看不清字。 */
const STACK_MAX = 4
/** 拼图统一宽度：720 够看清聊天截图里的字，又不至于让文件顶到上限。 */
const STACK_WIDTH = 720

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

// ---------------------------------------------------------------- 文件（2026-11-05）
//
// QQ **不会**把文件的下载直链放进消息里。私聊文件的 `file` 段通常只有
// `{ file: '日历-课表.ics', file_id: '...' , file_size }`，真正的地址要拿
// file_id 去调 OneBot 的 get_file / get_private_file_url 才换得出来。
//
// 第一版只认 `url` 和绝对路径的 `file`，所以两条都空 → 她那边显示
// 「我没拿到——链接可能过期了」（11-05 06:45 真机）。这一版按下面的顺序试：
//   ① 段里自带 url / base64 / 本机绝对路径（少数实现会给）
//   ② get_file(file_id)          —— LLOneBot / NapCat 都支持，返回 base64:// 或路径
//   ③ get_private_file_url / get_group_file_url —— 只给一条 http 链接
// 全都不行时把段里到底有什么写进日志（值截断），下次一眼能看出该加哪个字段。

const FILE_MAX_BYTES = 32 * 1024 * 1024

/** 超过上限就不收（她那边也存不住），返回 null 并留一行日志 */
function withinLimit(buf) {
  if (!buf) return null
  if (buf.length <= FILE_MAX_BYTES) return buf
  log(`文件太大（${(buf.length / 1048576).toFixed(1)}MB > 32MB），不转`)
  return null
}

/** `base64://…` 或 `data:…;base64,…` 解成 Buffer；不是这种形式返回 null */
function inlineBuffer(v) {
  const s = String(v ?? '')
  let b64 = null
  if (s.startsWith('base64://')) b64 = s.slice(9)
  else if (s.startsWith('data:')) {
    const i = s.indexOf(',')
    if (i > 0 && /;base64/i.test(s.slice(0, i))) b64 = s.slice(i + 1)
  }
  if (!b64) return null
  try {
    const buf = Buffer.from(b64, 'base64')
    return buf.length ? buf : null
  } catch {
    return null
  }
}

async function readFromUrl(u) {
  const r = await fetch(u, { signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  return buf.length ? buf : null
}

async function readFromPath(f) {
  const buf = readFileSync(f)
  return buf.length ? buf : null
}

/** 一个「可能装着文件」的值：base64 / http / 本机路径，逐个当 */
async function bufferFromValue(v) {
  if (typeof v !== 'string' || !v) return null
  const inline = inlineBuffer(v)
  if (inline) return inline
  if (/^https?:\/\//i.test(v)) return readFromUrl(v)
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(v)) return readFromPath(v)
  return null
}

/** OneBot 各种取文件接口的应答：`{ file }` / `{ url }` / `{ file_path }` 都可能 */
async function bufferFromPayload(data) {
  for (const key of ['file', 'url', 'file_path', 'path']) {
    try {
      const buf = await bufferFromValue(data?.[key])
      if (buf) return buf
    } catch {
      /* 换下一个字段 */
    }
  }
  return null
}

async function loadFileSeg(seg, ev) {
  const d = seg?.data ?? {}
  const name = String(d.name ?? d.file ?? '文件')
  const tried = []

  // ① 段里自带的
  for (const key of ['url', 'file', 'path']) {
    try {
      const buf = withinLimit(await bufferFromValue(d[key]))
      if (buf) return buf
    } catch (err) {
      tried.push(`${key}: ${String(err?.message ?? err)}`)
    }
  }

  // ②③ 拿 file_id 去换。`file` 在有些实现里就是 file_id，一起当候选
  const ids = [...new Set([d.file_id, d.file].filter((v) => typeof v === 'string' && v && !/^(?:[A-Za-z]:[\\/]|\/)/.test(v)))]
  const calls = []
  for (const id of ids) calls.push(['get_file', { file_id: id }])
  if (ev?.message_type === 'group' && ev.group_id) {
    for (const id of ids) calls.push(['get_group_file_url', { group_id: ev.group_id, file_id: id }])
  } else if (ev?.user_id) {
    for (const id of ids) calls.push(['get_private_file_url', { user_id: ev.user_id, file_id: id }])
  }
  for (const [action, params] of calls) {
    try {
      const r = await sendAction(action, params)
      const buf = withinLimit(await bufferFromPayload(r?.data))
      if (buf) return buf
      const keys = Object.keys(r?.data ?? {})
      tried.push(`${action}: 应答里没有可下载的东西（${keys.join('/') || '空'}）`)
    } catch (err) {
      tried.push(`${action}: ${String(err?.message ?? err)}`)
    }
  }

  // 全都不行：把段里到底有什么写进日志，下次一眼能看出该补哪个字段
  log(`取文件失败（${name}）：${tried.join('；') || '段里没有任何可下载字段'}`)
  log(`  段内容：${JSON.stringify(d).slice(0, 500)}`)
  return null
}

/** 落到她的收件箱（`<fishRoot>/home/inbox/`），返回路径与展示名 */
function saveInbox(name, buf) {
  const dir = join(cfg.fishRoot, 'home', 'inbox')
  mkdirSync(dir, { recursive: true })
  const raw = String(name ?? '').trim().replace(/^.*[\\/]/, '') || 'file'
  const safe = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file'
  const dot = safe.lastIndexOf('.')
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  const ext = dot > 0 ? safe.slice(dot) : ''
  let out = join(dir, safe)
  if (existsSync(out)) out = join(dir, `${stem}-${Date.now()}${ext}`)
  writeFileSync(out, buf)
  return { path: out, name: out.replace(/^.*[\\/]/, ''), bytes: buf.length }
}


/**
 * 合并转发的聊天记录（2026-11-05）。
 *
 * QQ 的「聊天记录」卡片在 OneBot 里是 `{type:'forward', data:{id}}`——
 * **只有一个 id，正文不在消息里**，要拿它调 get_forward_msg 才拿得到。
 * 跟 file 段的 file_id 是同一个坑：消息里放的永远是句柄，不是内容。
 *
 * 渲染成 `昵称：内容` 的纯文本；图片/语音/嵌套转发写成 [图片] 这类记号——
 * 她需要知道"那儿还有别的东西"，而不是以为那句话只有半截。
 *
 * 超过 FORWARD_INLINE_MAX 就落盘给她路径：一百条的群聊记录塞进一轮对话
 * 会把这一轮的上下文吃光，而她自己有 her_open，读不读由她定。
 */
const FORWARD_INLINE_MAX = 3000
/** 一次最多处理几段转发（他偶尔会连着转好几个）。 */
const FORWARD_MAX_SEGS = 2

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out = []
  for (const s of content) {
    const t = s?.type
    if (t === 'text') out.push(String(s.data?.text ?? ''))
    else if (t === 'image' || t === 'mface') out.push('[图片]')
    else if (t === 'record') out.push('[语音]')
    else if (t === 'video') out.push('[视频]')
    else if (t === 'file') out.push(`[文件${s.data?.name ? ` ${s.data.name}` : ''}]`)
    else if (t === 'forward' || t === 'node') out.push('[又一层转发]')
    else if (t === 'at') out.push(`@${s.data?.qq ?? ''}`)
    // face（小黄脸）是字体符号，写成 [表情] 反而更吵
  }
  return out.join('')
}

async function loadForward(seg) {
  // 少数实现会把内容直接塞进段里（data.content / data.message），先看这个
  const inline = seg?.data?.content ?? seg?.data?.message
  if (Array.isArray(inline)) return inline
  const id = String(seg?.data?.id ?? '').trim()
  if (!id) return null
  try {
    const r = await sendAction('get_forward_msg', { id })
    const msgs = r?.data?.messages ?? r?.data?.message
    if (Array.isArray(msgs)) return msgs
    const keys = Object.keys(r?.data ?? {})
    log(`取聊天记录失败：应答里没有 messages（${keys.join('/') || '空'}）`)
  } catch (err) {
    log(`取聊天记录失败（${id}）：${String(err?.message ?? err)}`)
  }
  return null
}

async function forwardNote(forwards) {
  if (!forwards?.length) return ''
  const blocks = []
  for (const seg of forwards.slice(0, FORWARD_MAX_SEGS)) {
    const msgs = await loadForward(seg)
    if (!msgs) {
      blocks.push('（他转发了一段聊天记录，我这边没取到——QQ 没给内容。）')
      continue
    }
    const lines = []
    for (const m of msgs) {
      const who = String(m?.sender?.card || m?.sender?.nickname || m?.sender?.user_id || '某人')
      const t = contentText(m?.content ?? m?.message).replace(/\s+/g, ' ').trim()
      if (t) lines.push(`${who}：${t}`)
    }
    const body = lines.join('\n')
    if (!body) {
      blocks.push(`（他转发了一段聊天记录，${msgs.length} 条，都是表情/图片这类。）`)
      continue
    }
    if (body.length <= FORWARD_INLINE_MAX) {
      log(`聊天记录：${msgs.length} 条 / ${body.length} 字，直接递给她`)
      blocks.push(`（他转发了一段聊天记录，${msgs.length} 条：\n${body}\n）`)
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const saved = saveInbox(`聊天记录-${stamp}.txt`, Buffer.from(body, 'utf8'))
      log(`聊天记录：${msgs.length} 条 / ${body.length} 字 → ${saved.path}`)
      blocks.push(`（他转发了一段聊天记录，${msgs.length} 条，太长没全贴。存在 ${saved.path}。想看得调 her_open。）`)
    }
  }
  if (forwards.length > FORWARD_MAX_SEGS) {
    blocks.push(`（另外还有 ${forwards.length - FORWARD_MAX_SEGS} 段转发，这次只转了前 ${FORWARD_MAX_SEGS} 段。）`)
  }
  return blocks.join('\n') + '\n\n'
}

/**
 * 把多张图竖着拼成一张（2026-11-05）。
 *
 * 为什么拼、不分两轮：她的通路一轮只收一张图。分两轮递，她会回两次话，
 * 中间还可能插进别的——「你看这两张」这种话就断了。拼成一张她能一次看到、
 * 能对比，而且插件那边一个字都不用改。
 *
 * 用 ffmpeg 的 vstack：各自缩到同一宽度（-2 保证偶数）、统一 rgb24，再竖着摞。
 * 输出 jpg 不用 png：聊天截图拼起来动辄两三千像素高，png 会顶到 6MB 上限。
 *
 * 任何一步失败都返回 null，调用方退回「只发第一张」并说清还有几张没看到。
 */
function stackImages(bufs, { width = STACK_WIDTH } = {}) {
  if (!Array.isArray(bufs) || bufs.length < 2) return null
  const tag = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const files = []
  const outp = join(tmpdir(), `fish-stack-${tag}.jpg`)
  try {
    for (let i = 0; i < bufs.length; i++) {
      const f = join(tmpdir(), `fish-stack-${tag}-${i}.img`)
      writeFileSync(f, bufs[i])
      files.push(f)
    }
    const args = ['-hide_banner', '-loglevel', 'error', '-y']
    for (const f of files) args.push('-i', f)
    const chains = files.map((_, i) =>
      `[${i}:v]scale=${width}:-2,setsar=1,format=rgb24[v${i}]`)
    const stack = files.map((_, i) => `[v${i}]`).join('') + `vstack=inputs=${files.length}[out]`
    args.push('-filter_complex', [...chains, stack].join(';'), '-map', '[out]', '-q:v', '3', '-frames:v', '1', outp)
    execFileSync(FFMPEG, args, { timeout: 30_000, windowsHide: true })
    const out = readFileSync(outp)
    if (!out.length) return null
    if (out.length > IMAGE_MAX_BYTES) {
      log(`多图拼接：拼完 ${(out.length / 1024 / 1024).toFixed(1)}MB，超过 ${IMAGE_MAX_BYTES / 1024 / 1024}MB 上限`)
      return null
    }
    return out
  } catch (err) {
    log('多图拼接失败：', String(err?.message ?? err).slice(0, 160))
    return null
  } finally {
    for (const f of files) { try { unlinkSync(f) } catch { /* ignore */ } }
    try { unlinkSync(outp) } catch { /* ignore */ }
  }
}

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
    p = { ev, texts: [], images: [], files: [], forwards: [], timer: null }
    pendingChats.set(key, p)
  }
  if (part.text) p.texts.push(part.text)
  if (part.images?.length) p.images.push(...part.images)
  if (part.files?.length) p.files.push(...part.files)
  if (part.forwards?.length) p.forwards.push(...part.forwards)
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
  const files = p.files ?? []
  const forwards = p.forwards ?? []
  const who = ev.message_type === 'group' ? `群 ${ev.group_id} / ${ev.user_id}` : `私聊 ${ev.user_id}`
  const only = files.length ? '（只发了文件）' : forwards.length ? '（只转了聊天记录）' : '（只发了图）'
  log(`${who}: ${text.slice(0, 80) || only}${images.length ? ` [图 ${images.length}]` : ''}${files.length ? ` [文件 ${files.length}]` : ''}${forwards.length ? ` [转发 ${forwards.length}]` : ''}${p.texts.length > 1 || images.length > 1 ? `（合批 ${p.texts.length} 句 / ${images.length} 图）` : ''}`)

  return enqueue(async () => {
    const t0 = Date.now()
    // 她的通路一轮只收一张图（插件侧 /local/say 的 image 是单数）。
    // 连发多张时**拼成一张**递过去：她能一次看到、能对比，也不用分两轮
    // 打断对话。拼不动就退回第一张，并在话里说清"还有几张没看到"。
    let image = ''
    let imgNote = ''
    if (images.length) {
      const bufs = []
      for (const seg of images.slice(0, STACK_MAX)) {
        const b = await loadImage(seg)
        if (b) bufs.push(b)
      }
      let buf = bufs[0] ?? null
      if (bufs.length > 1) {
        const stacked = stackImages(bufs)
        if (stacked) {
          log(`多图拼接：${bufs.length} 张 → ${(stacked.length / 1024).toFixed(0)}KB`)
          buf = stacked
          imgNote = `（他一次发来 ${bufs.length} 张图，拼成一张：从上往下第 1 到第 ${bufs.length} 张。）\n`
        } else {
          imgNote = `（他一次发来 ${bufs.length} 张图，我这边只递过来第一张。）\n`
        }
      }
      // 动图（表情包多半是）抽几帧拼一张 —— 她一次只能看一帧，看第一帧等于没看懂那个表情。
      // 单帧 GIF 不拼：那样只会得到一张八格全黑的图。多图时不走这条路（已经拼过了）。
      if (buf && bufs.length === 1 && isGif(buf)) {
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
      if (images.length > bufs.length) {
        imgNote += `（另外还有 ${images.length - bufs.length} 张，这次没带。）\n`
      }
      if (images.length > 1) log(`他一次发了 ${images.length} 张图，拼 ${bufs.length} 张 → ${image ? '一张' : '没递成'}`)
    }
    // 合并转发的聊天记录（2026-11-05）：段里只有一个 id，得拿它去换正文。
    // 短的直接贴给她，长的落盘给路径——她自己会调 her_open。
    const fwdNote = await forwardNote(forwards)
    // 文件（2026-11-05）：落到她的收件箱，只把路径和大小告诉她——
    // 能不能读、要不要读，由她调 her_open 自己试，我们不替她判断。
    let fileNote = ''
    if (files.length) {
      const lines = []
      for (const seg of files.slice(0, 3)) {
        const nm = String(seg?.data?.name ?? seg?.data?.file ?? '文件')
        const buf = await loadFileSeg(seg, ev)
        if (!buf) {
          lines.push(`（他发来一个文件「${nm}」，我这边没取到——QQ 没给下载地址，或者链接已经过期。）`)
          continue
        }
        const saved = saveInbox(nm, buf)
        log(`收到文件：${saved.name} ${(saved.bytes / 1024).toFixed(0)}KB → ${saved.path}`)
        lines.push(`（他发来一个文件：${saved.name}，${(saved.bytes / 1024).toFixed(0)}KB。存在 ${saved.path}。想看就调 her_open。）`)
      }
      if (files.length > 3) lines.push(`（另外还有 ${files.length - 3} 个文件，这次只转了前 3 个。）`)
      fileNote = lines.join('\n') + '\n\n'
    }
    const r = await fishSay(imgNote + fwdNote + fileNote + text, image)
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
  log(`收到消息 [${ev.message_type}] ${who} self=${ev.self_id} 文字${brief.text.length}字 图${brief.images.length}${brief.forwards?.length ? ` 转发${brief.forwards.length}` : ''}`)

  if (String(ev.user_id) === String(ev.self_id)) return // 自己发的
  if (!allowed(ev.user_id)) {
    log(`陌生人 ${ev.user_id} 说话，没转（不在 ownerIds 里）`)
    return
  }
  const { text, atMe, images, files, forwards = [] } = brief
  if (ev.message_type === 'group' && !(cfg.allowGroup && atMe)) {
    log('群消息，但没 @ 她 / 没开 allowGroup，跳过')
    return
  }
  // 只发图不写字也是合法的（他自己也常这么干）；只发文件、只转聊天记录同样合法
  if (!text && !images.length && !files.length && !forwards.length) {
    log('这条既没文字也没图（表情/戳一戳之类），跳过')
    return
  }
  schedule(ev, { text, images, files, forwards })
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
