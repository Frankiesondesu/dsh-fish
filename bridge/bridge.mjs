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
 *
 * 2026-11-06：他发来的所有附件（图 / 视频 / 文档 / 未知格式）统一按「文件模式」
 * 处理，见 attachment.mjs —— 存本地、只报事实、她自己判断，不再按段类型分流。
 */

import { WebSocketServer } from 'ws'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync, mkdirSync,
  copyFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
// 2026-11-06：fishRoot 的默认值不再写死成 <用户主目录>。优先级见 shared/root.mjs
// （DSH_FISH_HOME → ~/.dsh-fish-location.json → ~/.dsh-fish）。
import { fishRoot as resolveFishRoot } from '../shared/root.mjs'
import { dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPusher } from './push.mjs'
import { batchWait } from './batch-wait.mjs'
import { classifySegments, displayName, ensureExt } from './attachment.mjs'
import { readAsrConfig, ensureServer, transcribe } from './asr.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 本机听写配置（~/.dsh/asr.json）。没有就是 null——这台机器没装听写。 */
const ASR_CFG = readAsrConfig()
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
  // 2026-11-07（用户）：**不再替她按空行拆**。她写的一段原样发一条，中间的空行就是空行；
  // 想分几条就自己调 her_say（reply 模式），一次一条——条数由她定，不由工具定。
  // 只剩一个技术性硬切：超过 chunkChars 还是得分段发，否则 QQ 收不下。
  splitReplies: false,
  // 同一人连发几条时，等这么久再合并成一次递话（0 = 不合批，一条一轮）
  mergeMs: 1500,
  // 带图的消息压这么久，等一句补充说明接上来（真机上 5~10 秒很常见）
  imageHoldMs: 10000,
  // 11-06：视频动辄几百 MB，原来 32MB 会把绝大多数视频挡在门外。
  // 单位字节，默认 512MB；超大文件若 OneBot 给的是本机路径，直接复制不进内存。
  fileMaxBytes: 512 * 1024 * 1024,
  // 2026-11-06：默认值不再写死 <用户主目录>。config.json 里的 fishRoot
  // 仍然优先；只有在没配的时候才走 shared/root.mjs 那套（环境变量 → 指针 → ~/.dsh-fish）。
  fishRoot: resolveFishRoot(),
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

/**
 * 把「他回的选项数字」送到插件的 /local/answer 结算（2026-11-08）。
 * 走 answerCard——与 DSH 卡片完全同一条代码；插件负责校验（已答过/没有这张卡
 * 都会如实说）。端口发现与 fishSay 共用，端口变了同样清缓存重试一次。
 */
async function localAnswer(hit) {
  const key = fishKey()
  for (let attempt = 0; attempt < 2; attempt++) {
    const port = cachedPort || (await discoverPort())
    if (!port) return { ok: false, why: '没找到 dsh-fish 的通路' }
    cachedPort = port
    try {
      const r = await fetch(`http://127.0.0.1:${port}/dsh-fish/local/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fish-key': key },
        // answerCard 的卡回答形状：selected 是数组（DSH 卡片原样提交的就是它）
        body: JSON.stringify({ id: `ask:${hit.askId}`, selected: [hit.selected] }),
        signal: AbortSignal.timeout(8000),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) return { ok: false, why: j?.error ?? `HTTP ${r.status}` }
      return j
    } catch (err) {
      cachedPort = 0
      if (attempt === 1) return { ok: false, why: String(err?.message ?? err) }
    }
  }
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

/**
 * OneBot 消息段 → 纯文本 + 统一附件（2026-11-06）。
 *
 * 分类搬到 attachment.mjs：按**数据形态**认附件，不按段类型白名单。
 * 图 / 视频 / 文档 / 以后冒出来的新格式一律进 files，走同一条「文件模式」。
 * 这里只补一个 raw_message 兜底（少数实现不给 message 数组）。
 */
function readMessage(ev) {
  const r = classifySegments(ev.message, ev.self_id)
  const text = !Array.isArray(ev.message) && typeof ev.raw_message === 'string' && !r.text
    ? ev.raw_message.trim()
    : r.text
  const { atMe, images, files, forwards, audios } = r
  return { text, atMe, images, files, forwards, audios }
}

/**
 * ⚠️ 下面这一组「旧图片直传通路」（MULTI_IMAGE_MAX / FFMPEG / isGif / gifFrames /
 * sheetFromGif / loadImage）2026-11-06 起**已停用**：用户定了所有附件统一走文件模式，
 * flush 里不再调用它们。留着是为了万一要回退「单张直传」能少翻一次 git，不是漏删。
 * 真要删的时候记得一并清掉 tmpdir / execFileSync 这些 import。
 * IMAGE_MAX_BYTES 是例外：出站（她回话夹图）还在用，保留。
 */
/** 她的通路收图上限是 6MB（media.js 的 MAX_IMAGE_BYTES），超了直接不发 */
const IMAGE_MAX_BYTES = 6 * 1024 * 1024

/** 连发多张时，一次最多给她记几张的路径（再多，那一轮的话就全是路径了）。 */
const MULTI_IMAGE_MAX = 6

/** 她读图一次只能看一帧；动图（表情包）就把几帧拼成一张给她看 */
const FFMPEG = String(process.env.DSH_FISH_FFMPEG ?? '').trim()
  || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe') : '')
  || 'ffmpeg'

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

// 11-06：视频动辄几百 MB，原来的 32MB 会把绝大多数视频挡在门外。
// 可从 config.json 的 fileMaxBytes 调；超大文件若 OneBot 给的是本机路径，
// 走 copyFileSync 不进内存（见 attachFromValue）。
const FILE_MAX_BYTES = Number(cfg.fileMaxBytes) || 512 * 1024 * 1024
/** 一轮话里最多列几个路径；超出的照样全部落盘，只是不把路径全列出来 */
const FILE_NOTE_MAX = 10

/** 超过上限就不收，留一行日志（按字节数判，本机路径也能先判再复制） */
function withinSize(n) {
  if (!Number.isFinite(n) || n <= 0) return false
  if (n <= FILE_MAX_BYTES) return true
  log(`文件太大（${(n / 1048576).toFixed(1)}MB > ${Math.round(FILE_MAX_BYTES / 1048576)}MB），不收`)
  return false
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

// ---------------------------------------------------------------- 统一附件（2026-11-06）
//
// 视频这类大文件不该在内存里绕一圈：OneBot 的 get_file 经常直接给**本机绝对路径**，
// 这时 copy 过去就行，别 readFileSync 再 writeFileSync（几百 MB 白占一份内存）。
// 所以取值结果分两种：{ buf }（url / base64，只能进内存）或 { srcPath }（直接复制）。

/** 本机路径 → 可以直接复制的源文件；不是路径 / 不存在 / 超限 → null */
function localSource(v) {
  if (typeof v !== 'string' || !v || !isAbsolute(v)) return null
  try {
    const st = statSync(v)
    if (!st.isFile() || !withinSize(st.size)) return null
    return v
  } catch {
    return null
  }
}

/** 一个「可能装着文件」的值 → { buf } / { srcPath } / null */
async function attachFromValue(v) {
  if (typeof v !== 'string' || !v) return null
  const p = localSource(v)
  if (p) return { srcPath: p }
  const inline = inlineBuffer(v)
  if (inline) return withinSize(inline.length) ? { buf: inline } : null
  if (v.startsWith('http://') || v.startsWith('https://')) {
    const buf = await readFromUrl(v)
    return buf && withinSize(buf.length) ? { buf } : null
  }
  return null
}

/** OneBot 各种取文件接口的应答：`{ file }` / `{ url }` / `{ file_path }` 都可能 */
async function attachFromPayload(data) {
  for (const key of ['file', 'url', 'file_path', 'path']) {
    try {
      const got = await attachFromValue(data?.[key])
      if (got) return got
    } catch {
      /* 换下一个字段 */
    }
  }
  return null
}

/** 只读前 12 字节做魔数判断，大文件不进内存 */
function sniffHead(p) {
  try {
    const fd = openSync(p, 'r')
    const b = Buffer.alloc(12)
    const n = readSync(fd, b, 0, 12, 0)
    closeSync(fd)
    return b.subarray(0, n)
  } catch {
    return null
  }
}

/**
 * 他的语音（2026-11-05）：QQ 的 record 段给的是 silk/amr，本机听写要 mp3。
 * 先试段里的 url / file，再让 LLBot 转一道（get_record 内部会 decode silk）。
 */
async function loadAudio(seg) {
  const d = seg?.data ?? {}
  const tried = []
  for (const key of ['url', 'file']) {
    try {
      const buf = await bufferFromValue(d[key])
      if (buf?.length) return buf
    } catch (err) {
      tried.push(`${key}: ${String(err?.message ?? err)}`)
    }
  }
  const ids = [...new Set([d.file, d.file_id].filter((v) => typeof v === 'string' && v))]
  for (const id of ids) {
    try {
      const r = await sendAction('get_record', { file: id, out_format: 'mp3' })
      const buf = await bufferFromPayload(r?.data)
      if (buf?.length) return buf
      tried.push(`get_record: 应答里没有音频（${Object.keys(r?.data ?? {}).join('/') || '空'}）`)
    } catch (err) {
      tried.push(`get_record: ${String(err?.message ?? err)}`)
    }
  }
  log(`取语音失败：${tried.join('；') || '段里没有可下载字段'}`)
  log(`  段内容：${JSON.stringify(d).slice(0, 400)}`)
  return null
}

async function loadFileSeg(seg, ev) {
  const d = seg?.data ?? {}
  const name = displayName(seg)
  const tried = []

  // ① 段里自带的
  for (const key of ['url', 'file', 'path', 'file_path']) {
    try {
      const got = await attachFromValue(d[key])
      if (got) return got
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
      const got = await attachFromPayload(r?.data)
      if (got) return got
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
function saveInbox(name, buf, srcPath = '') {
  const dir = join(cfg.fishRoot, 'home', 'inbox')
  mkdirSync(dir, { recursive: true })
  const raw = String(name ?? '').trim().replace(/^.*[\\/]/, '') || 'file'
  const safe = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file'
  const dot = safe.lastIndexOf('.')
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  const ext = dot > 0 ? safe.slice(dot) : ''
  let out = join(dir, safe)
  if (existsSync(out)) out = join(dir, `${stem}-${Date.now()}${ext}`)
  if (srcPath) copyFileSync(srcPath, out)
  else writeFileSync(out, buf)
  return { path: out, name: out.replace(/^.*[\\/]/, ''), bytes: statSync(out).size }
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
      blocks.push(`（他转过来一段聊天记录，${msgs.length} 条。里面的话是记录里那些人说的，不是他：
${body}
）`)
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const saved = saveInbox(`聊天记录-${stamp}.txt`, Buffer.from(body, 'utf8'))
      log(`聊天记录：${msgs.length} 条 / ${body.length} 字 → ${saved.path}`)
      blocks.push(`（他转过来一段聊天记录，${msgs.length} 条，太长没全贴。在 ${saved.path}。her_open 能打开它——里面的话是记录里那些人说的，不是他。）`)
    }
  }
  if (forwards.length > FORWARD_MAX_SEGS) {
    blocks.push(`（另外还有 ${forwards.length - FORWARD_MAX_SEGS} 段转发，这次只转了前 ${FORWARD_MAX_SEGS} 段。）`)
  }
  return blocks.join('\n') + '\n\n'
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

  const split = cfg.splitReplies === true
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
 *   · **带图的**：从**第一张图**开始算 `imageHoldMs`（默认 10 秒）。连发几张不重置。
 *     但**文字一到就立刻发**——他的习惯是先发图再补一句，等他补完比等满窗口值。
 *     没补文字才让窗口自然到期。
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
  const now = Date.now()
  if (!p) {
    p = { ev, texts: [], images: [], files: [], forwards: [], audios: [], timer: null, attachAt: 0 }
    pendingChats.set(key, p)
  }
  if (part.text) p.texts.push(part.text)
  if (part.images?.length) p.images.push(...part.images)
  if (part.files?.length) {
    p.files.push(...part.files)
    // 11-06：图也归到 files 了，所以「第一个附件」起算等待窗口 ——
    // 沿用原来带图的 10 秒，等他发完文件补一句说明，别拆成两轮。
    if (!p.attachAt) p.attachAt = now
  }
  if (part.forwards?.length) p.forwards.push(...part.forwards)
  if (part.audios?.length) p.audios.push(...part.audios)
  p.ev = ev
  if (p.timer) clearTimeout(p.timer)

  const mergeMs = Number(cfg.mergeMs) || 0
  const imageHoldMs = Number(cfg.imageHoldMs) || 0
  // 规则在 batch-wait.mjs 里（纯函数，有单测）：
  // 有图从第一张图算 10 秒、连发不重置、文字一到立刻发、纯文字压 mergeMs。
  const wait = batchWait({
    hasImage: p.attachAt > 0,
    hasText: Boolean(part.text),
    imageAt: p.attachAt,
    now,
    mergeMs,
    imageHoldMs,
  })

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
  const files = p.files ?? []
  const forwards = p.forwards ?? []
  const audios = p.audios ?? []
  const who = ev.message_type === 'group' ? `群 ${ev.group_id} / ${ev.user_id}` : `私聊 ${ev.user_id}`
  const only = files.length ? '（只发了文件）' : forwards.length ? '（只转了聊天记录）' : audios.length ? '（只发了语音）' : '（空消息）'
  log(`${who}: ${text.slice(0, 80) || only}${files.length ? ` [附件 ${files.length}]` : ''}${forwards.length ? ` [转发 ${forwards.length}]` : ''}${audios.length ? ` [语音 ${audios.length}]` : ''}${p.texts.length > 1 ? `（合批 ${p.texts.length} 句）` : ''}`)

  return enqueue(async () => {
    const t0 = Date.now()
    // 2026-11-06 用户定：不再按格式分流。图片、视频、文档一律走下面的「文件模式」——
    // 存本地、只报事实、她自己判断；不直传、不抽帧、不替她挑哪张。
    // 他的语音（2026-11-05）：她没有耳朵，这里替她把话听成字。
    // **转不出来就说转不出来**——不许猜，也不许把"嗯"编成一句话。
    let voiceNote = ''
    if (audios.length) {
      const lines = []
      for (const seg of audios.slice(0, 2)) {
        const buf = await loadAudio(seg)
        if (!buf) { lines.push('（他发来一条语音，没取到音频。）'); continue }
        const ready = await ensureServer(ASR_CFG, { log })
        if (!ready.ok) { lines.push(`（他发来一条语音，我这边听不了：${ready.why}）`); continue }
        const tr = await transcribe(buf, ASR_CFG, { log })
        if (tr.ok) {
          log(`语音 ${(buf.length / 1024).toFixed(0)}KB → ${tr.text.length} 字`)
          lines.push(`（他发来一条语音，说的是：「${tr.text}」）`)
        } else {
          log(`语音没听清：${tr.why}`)
          lines.push(`（他发来一条语音，我这边没听清：${tr.why}）`)
        }
      }
      if (audios.length > 2) lines.push(`（另外还有 ${audios.length - 2} 条语音，这次没转。）`)
      voiceNote = lines.join('\n') + '\n\n'
    }
    // 合并转发的聊天记录（2026-11-05）：段里只有一个 id，得拿它去换正文。
    // 短的直接贴给她，长的落盘给路径——她自己会调 her_open。
    const fwdNote = await forwardNote(forwards)
    // 文件（2026-11-06 用户定）：他发来的所有附件，不论格式类型，一律落盘到收件箱，
    // 只把事实（名字 / 大小 / 路径）告诉她，看不看、怎么处理由她自己判断。
    // **不承诺「能打开」**：her_open 对图片会指 read_image、对视频这类二进制会如实说
    // 「我读不出来」；替她承诺就是对她说假话（fork.13）。
    let fileNote = ''
    if (files.length) {
      const lines = []
      let savedCount = 0
      for (const seg of files) {
        const nm = displayName(seg)
        const got = await loadFileSeg(seg, ev)
        if (!got) {
          lines.push(`（他递过来一个文件「${nm}」，没到你手上——QQ 没给下载地址，或者链接已经过期。）`)
          continue
        }
        const head = got.buf ?? sniffHead(got.srcPath)
        const saved = saveInbox(ensureExt(nm, head, seg?._kind), got.buf, got.srcPath)
        savedCount++
        log(`收到文件：${saved.name} ${(saved.bytes / 1024).toFixed(0)}KB → ${saved.path}`)
        if (savedCount <= FILE_NOTE_MAX) {
          lines.push(`（他递过来一个文件，搁在你手边：${saved.name}，${(saved.bytes / 1024).toFixed(0)}KB。在 ${saved.path}。看不看、怎么处理，你自己定。）`)
        }
      }
      if (savedCount > FILE_NOTE_MAX) {
        lines.push(`（另外还有 ${savedCount - FILE_NOTE_MAX} 个文件也存进收件箱了，路径没全列，免得这一轮话全是路径。）`)
      }
      fileNote = lines.join('\n') + '\n\n'
    }
    // 2026-11-07（用户定案）：QQ 来的消息要标来源。以前投进会话的正文不带任何
    // 「来自 QQ」的字样，她分不清这句话是他在手机上发的、还是他在 DSH 窗口里说的——
    // 而统一后「要不要发回 QQ」由她自己调 her_say 决定，不知道来源就没法决定。
    // 这行标注她的提示词里写着（PROACTIVE_BRIEF），两边是一对。
    const qqNote = '（这条消息从 QQ 发来）\n\n'
    const r = await fishSay(qqNote + fwdNote + fileNote + voiceNote + text)
    const ms = Date.now() - t0
    if (!r?.ok) {
      log(`没送到（${ms}ms）：${r?.note ?? '未知'}`)
      // 她明确说"没说话"也回一句，让人知道话进去了但没答
      if (r?.note && r.note !== '她这次没说话。') {
        await reply(ev, `（这句没递进去：${r.note}）`)
      }
      return
    }
    // 2026-11-07（用户定案）：不再替她转接。以前这里取她说出口的正文自动发回 QQ；
    // 现在她的回话统一走 her_say（写账本 → push 扫到 → 发 QQ），发不发、发几条由她定。
    // 等待（fishSay 里的 turn 等待）保留——他的下一句要排在这一轮之后，顺序不能乱。
    if (r.spoken || r.herReply) {
      log(`她在窗口里说了 ${String(r.spoken || r.herReply).length} 字，没转接——到不到 QQ 看她调不调 her_say（${ms}ms）`)
    } else {
      log(`她没说话（${ms}ms）`)
    }
  })
}

/** 收到一条 QQ 消息：先过滤，再丢进合批窗口 */
async function onMessage(ev) {
  // 2026-11-02：进门先记一行。以前被过滤掉的分支（群消息、空内容）**一声不响**，
  // 出问题时只能看到"桥没反应"，分不清是消息没到、还是到了被规则挡了。
  const who = ev.message_type === 'group' ? `群 ${ev.group_id} / ${ev.user_id}` : `私聊 ${ev.user_id}`
  const brief = readMessage(ev)
  log(`收到消息 [${ev.message_type}] ${who} self=${ev.self_id} 文字${brief.text.length}字 附件${brief.files.length}${brief.forwards?.length ? ` 转发${brief.forwards.length}` : ''}`)

  if (String(ev.user_id) === String(ev.self_id)) return // 自己发的
  if (!allowed(ev.user_id)) {
    log(`陌生人 ${ev.user_id} 说话，没转（不在 ownerIds 里）`)
    return
  }
  const { text, atMe, images, files, forwards = [], audios = [] } = brief
  // 2026-11-08：她在账本里挂了卡（ask_owner / 规则申请）且已推到 QQ 时，
  // 他回一个选项数字（如「1」）就等于作答——经 /local/answer 走与 DSH 卡片
  // 同一条结算（answerCard），不再让她问一天没人答。只认 1–2 位数字的精确
  // 命中；说别的照常递给她——**宁可漏答，不可错答**。
  if (text && text.length <= 2) {
    const hit = pusher.pendingAskMatch(text)
    if (hit) {
      const r = await localAnswer(hit)
      if (r?.ok) {
        pusher.resolveAsk(hit.askId)
        log(`卡已代答：${hit.askId} → 「${hit.selected}」`)
        await reply(ev, `已答「${hit.selected}」，她知道了。`, { strict: true })
        return
      }
      log(`代答没成（${r?.why ?? '未知'}），这条照常递给她`)
    }
  }
  if (ev.message_type === 'group' && !(cfg.allowGroup && atMe)) {
    log('群消息，但没 @ 她 / 没开 allowGroup，跳过')
    return
  }
  // 只发图不写字也是合法的（他自己也常这么干）；只发文件、只转聊天记录同样合法
  if (!text && !images.length && !files.length && !forwards.length && !audios.length) {
    log('这条既没文字也没图（表情/戳一戳之类），跳过')
    return
  }
  schedule(ev, { text, images, files, forwards, audios })
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
      // 表情（2026-11-05）：item.text 是图片文件的绝对路径。
      // 用 base64 而不是 file:// 或绝对路径——不同 OneBot 实现对本地路径的支持不一致，
      // base64 在哪都能走。表情包一般几百 KB，转完远在 ws 消息上限内。
      if (item.kind === 'meme') {
        try {
          const buf = readFileSync(item.text)
          await sendAction('send_private_msg', {
            user_id: uid,
            message: [{ type: 'image', data: { file: `base64://${buf.toString('base64')}` } }],
          })
          log(`发了表情：${item.text.replace(/^.*[\\/]/, '')}（${(buf.length / 1024).toFixed(0)}KB）`)
        } catch (err) {
          log(`表情没发出去（${item.text}）：${String(err?.message ?? err)}`)
        }
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
    const url = String(u.searchParams.get('url') || '')
    const name = String(u.searchParams.get('name') || '')
    // 11-06：调试口也能造 video / 未知格式段（带 url / name），真机验证用
    const data = type === 'text' ? { text } : { file, ...(url ? { url } : {}), ...(name ? { name } : {}) }
    const seg = { type, data }
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
        // onMessage 现在是 async（代答要 await /local/answer）：拒绝不能逃出这个 try
        Promise.resolve(onMessage(ev)).catch((err) => log('处理消息出错：', String(err?.message ?? err)))
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
