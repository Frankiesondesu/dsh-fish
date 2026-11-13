/**
 * webchat.mjs —— 自建网页对话通道（2026-11-12；同日补全：询问卡/图片/视频/定位/插话）
 *
 * 链路（调研与拍板：research/web-channel/README.md）：
 *   浏览器 ←HTTP+WS→ 本文件 --POST /dsh-fish/local/say|steer|answer--> dsh-fish → 她
 *   她（her_say/ask_owner/her_leave/her_voice）→ 账本 → push.mjs（复用桥的骨架）→ WS → 浏览器
 *
 * 与桥平级的第二个网关：不碰 bridge.mjs、不碰 QQ 那条线；QQ 通道死了这里照跑。
 * 口径：
 *   · 来源必须为真（fork.13）：网页来的话带「（这条消息从网页发来）」标注（仿 QQ_NOTE）。
 *   · 广播式路由（2026-11-12 用户拍板）：她的话同时出现在 QQ 和网页，不做会话隔离。
 *   · 桥不转接正文，这里也不转：/local/say 响应里的窗口正文原样忽略（2026-11-07 口径）。
 *   · 他发的文件一律落收件箱 <fishRoot>/home/inbox/，只报事实（名字/大小/路径），
 *     不承诺"能打开"（2026-11-06 口径，与桥 attachment 一致，fork.13）。
 *   · 申请卡（ask）结算走 /local/answer → answerCard，与 DSH 卡片同一条代码。
 * 鉴权（同查看器 7788 口径）：本机免密；非本机要 config 的 password。
 * /media 文件服务另要 auth-ok 时发的 token——她的图/音视频是私事，不能裸奔。
 */

import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync,
  statSync, createReadStream, createWriteStream, realpathSync, unlinkSync } from 'node:fs'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { fishRoot as resolveFishRoot } from '../shared/root.mjs'
import { createPusher, parsePushLine } from '../bridge/push.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 与 /local/say 同一套来源标注（QQ 版在 bridge/steer.mjs，不养第二份 QQ 真相） */
export const WEB_NOTE = '（这条消息从网页发来）\n\n'

// ---------------------------------------------------------------- 配置

const DEFAULTS = {
  port: 6210,
  host: '127.0.0.1',
  password: '',
  fishPort: 0,
  fishRoot: resolveFishRoot(),
  sayTimeoutMs: 300000,
  steerTimeoutMs: 10000,
  pollMs: 1500,
  maxAgeMs: 5 * 60 * 1000,
  historyLines: 200,
  // 上传上限，与桥的 fileMaxBytes 同量级（视频动辄几百 MB）
  fileMaxBytes: 512 * 1024 * 1024,
}

export function loadConfig(path = defaultConfigPath()) {
  let file = { ...DEFAULTS }
  if (existsSync(path)) {
    try {
      file = { ...DEFAULTS, ...JSON.parse(readFileSync(path, 'utf8')) }
    } catch {
      // 配置坏了先用默认值跑，别把整个通道拖死
    }
  } else {
    try {
      writeFileSync(path, JSON.stringify(DEFAULTS, null, 2) + '\n')
    } catch { /* 只读环境里生成失败就裸跑默认值 */ }
  }
  return file
}

function defaultConfigPath() {
  return process.env.WEBCHAT_CONFIG_PATH || join(HERE, 'config.json')
}

// ---------------------------------------------------------------- 纯函数（可测）

/** 本机连接免密：127.x / ::1 / IPv6 映射的 127.x 都算本机 */
export function isLoopback(addr = '') {
  const a = String(addr).replace(/^::ffff:/i, '')
  return a === '::1' || a.startsWith('127.')
}

/** 鉴权判定（纯函数）：本机免密放行；非本机要设了密码且发对（查看器口径） */
export function authAllowed(local, provided, cfgPassword) {
  if (local) return true
  return Boolean(cfgPassword) && provided === cfgPassword
}

/**
 * push 条目 → 浏览器消息。push.mjs 已把账本行解析成五种条目
 * （say/proactive/watch/ask/letter/voice/meme），这里只做网页侧的呈现转换：
 *   ask：正文里拆出问题本体（去掉（她想问你）前缀与 QQ 用的"回数字"提示行），选项走按钮
 *   voice/meme：text 就是文件路径，转成 /media 地址
 */
export function presentItem(item) {
  if (!item) return null
  if (item.kind === 'ask') {
    const lines = String(item.text ?? '').split('\n')
    const first = (lines[0] ?? '').replace(/^（她想问你）/, '').trim()
    // 问题本体可能换行；只剔掉 push 层附加的选项编号行与「回数字」提示，原话一行不删
    const rest = lines.slice(1).filter(
      (l) => !/^\d+\.\s/.test(l) && !/^（回数字|^（这题没有预设选项/.test(l),
    )
    const question = [first, ...rest].join('\n').trim()
    return { type: 'ask', kind: 'ask', askId: item.askId, options: item.options ?? [], question, ts: item.ts }
  }
  if (item.kind === 'voice' || item.kind === 'meme') {
    return { type: 'media', kind: item.kind, path: String(item.text ?? ''), ts: item.ts }
  }
  if (item.kind === 'letter') {
    return { type: 'say', kind: 'letter', text: String(item.text ?? '').replace(/^（她留了封信）/, '').trimStart(), ts: item.ts }
  }
  return { type: 'say', kind: item.kind, text: String(item.text ?? ''), ts: item.ts }
}

/** 文件事实话术——与 bridge.mjs 的收件箱 note 同一字据（fork.13：只报事实，不承诺能打开） */
export function fileNoteFor(saved) {
  // 与桥同一口径：0 字节就是 0KB，别四舍五入成 1KB（那是替她编事实）
  const kb = (Number(saved.bytes) || 0) / 1024
  return `（他递过来一个文件，搁在你手边：${saved.name}，${kb.toFixed(0)}KB。在 ${saved.path}。看不看、怎么处理，你自己定。）\n\n`
}

/** 上传文件名的净化，与 bridge.mjs saveInbox 同一条规矩 */
export function safeName(name = '') {
  const raw = String(name ?? '').trim().replace(/^.*[\\/]/, '') || 'file'
  return raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file'
}

// ---------------------------------------------------------------- 日志

function makeLog(logPath) {
  return (...a) => {
    const line = `[${new Date().toISOString()}] ${a.join(' ')}`
    console.log(line)
    try { appendFileSync(logPath, line + '\n') } catch { /* 日志写不动不影响转发 */ }
  }
}

// ---------------------------------------------------------------- 找她的通路（照抄 bridge.mjs 的做法）

function listeningPorts(log) {
  const ports = new Set()
  let out = ''
  // Windows 先试；Linux（手机容器）退一种写法。都失败就空——config 里写死 fishPort 可绕过。
  for (const args of [['-ano', '-p', 'TCP'], ['-tln']]) {
    try {
      out = execFileSync('netstat', args, { encoding: 'utf8', windowsHide: true })
      break
    } catch { /* 下一种 */ }
  }
  if (!out) {
    log('netstat 跑不动：端口发现不可用，只能靠 config 里写死的 fishPort')
    return []
  }
  for (const raw of out.split('\n')) {
    const line = raw.trim()
    const win = line.match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+\d+$/i)
    if (win) {
      if (/^(127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\]|\[::ffff:127\.0\.0\.1\])$/i.test(win[1])) {
        ports.add(Number(win[2]))
      }
      continue
    }
    const lnx = line.match(/^tcp(?:6)?\s+\d+\s+\d+\s+(\S+):(\d+)\s+\S+\s+LISTEN/i)
    if (lnx) ports.add(Number(lnx[2]))
  }
  return [...ports].filter((p) => p > 0 && p < 65536)
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
}

// ---------------------------------------------------------------- 主程序

export async function main() {
  const CONFIG_PATH = defaultConfigPath()
  const cfg = loadConfig(CONFIG_PATH)
  const LOG_PATH = join(dirname(CONFIG_PATH), 'webchat.log')
  const log = makeLog(LOG_PATH)
  const KEY_FILE = join(cfg.fishRoot, 'local.key')
  const LEDGER = join(cfg.fishRoot, 'events.jsonl')
  const STATE_PATH = join(dirname(CONFIG_PATH), 'push-state-web.json')
  const INBOX = join(cfg.fishRoot, 'home', 'inbox')

  let cachedPort = Number(cfg.fishPort) || 0
  let sayInFlight = 0
  const mediaTokens = new Set()
  const pendingAsks = new Map() // askId → { options, at }
  const uploads = new Map() // uploadId → saved（等前端把正文补上一起递）

  function fishKey() {
    try { return readFileSync(KEY_FILE, 'utf8').trim() } catch { return '' }
  }

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
    if (cachedPort) {
      const ok = await probe(cachedPort, key)
      if (ok) return ok
      log(`缓存的端口 ${cachedPort} 不通了，重新找`)
      cachedPort = 0
    }
    const hits = await Promise.all(listeningPorts(log).map((p) => probe(p, key)))
    const found = hits.find(Boolean) || 0
    if (found) log(`找到 dsh-fish 的通路：:${found}`)
    return found
  }

  /** 她的通路 POST 公共段：端口发现 + 密钥 + 端口变了重试一次 */
  async function fishPost(pathname, body, timeoutMs) {
    const key = fishKey()
    for (let attempt = 0; attempt < 2; attempt++) {
      const port = cachedPort || (await discoverPort())
      if (!port) return { ok: false, note: '没找到 dsh-fish 的通路' }
      cachedPort = port
      try {
        const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-fish-key': key },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) return { ok: false, note: j?.error ?? j?.note ?? `HTTP ${r.status}` }
        return j
      } catch (err) {
        cachedPort = 0
        if (attempt === 1) return { ok: false, note: String(err?.message ?? err) }
      }
    }
    return { ok: false, note: '没送到' }
  }

  /** 递话。响应里的窗口正文按口径忽略，只取 ok/note（2026-11-07 口径）。 */
  async function fishSay(text, image = '') {
    const body = image ? { text, image } : { text }
    const r = await fishPost('/dsh-fish/local/say', body, cfg.sayTimeoutMs)
    return { ok: Boolean(r?.ok), note: String(r?.note ?? '') }
  }

  /** 插话：她这一轮还在跑时，后到的纯文字塞进同一回合（10 秒超时，失败如实说） */
  async function fishSteer(text) {
    return fishPost('/dsh-fish/local/steer', { text }, cfg.steerTimeoutMs)
  }

  /** 申请卡结算：与 DSH 卡片同一条 answerCard 代码 */
  async function fishAnswer(askId, selected) {
    return fishPost('/dsh-fish/local/answer', { id: `ask:${askId}`, selected: [selected] }, 8000)
  }

  // ---------------------------------------------------------------- 历史

  function historyItems() {
    let raw = ''
    try { raw = readFileSync(LEDGER, 'utf8') } catch { return [] }
    const lines = raw.split('\n').filter(Boolean).slice(-Math.max(1, cfg.historyLines))
    const scan = {}
    const out = []
    for (const line of lines) {
      const item = parsePushLine(line, scan)
      const m = presentItem(item)
      if (m) out.push(m)
    }
    return out
  }

  // ---------------------------------------------------------------- 收件箱上传

  function saveInboxStream(name, req) {
    return new Promise((resolve, reject) => {
      mkdirSync(INBOX, { recursive: true })
      const safe = safeName(name)
      const dot = safe.lastIndexOf('.')
      const stem = dot > 0 ? safe.slice(0, dot) : safe
      const ext = dot > 0 ? safe.slice(dot) : ''
      let out = join(INBOX, safe)
      if (existsSync(out)) out = join(INBOX, `${stem}-${Date.now()}${ext}`)
      const ws2 = createWriteStream(out)
      let bytes = 0
      let over = false
      req.on('data', (c) => {
        bytes += c.length
        if (bytes > cfg.fileMaxBytes) {
          over = true
          req.destroy()
          ws2.destroy()
          try { unlinkSync(out) } catch { /* 半成品清不掉也别盖住主错误 */ }
          reject(new Error(`文件超过上限（${Math.round(cfg.fileMaxBytes / 1024 / 1024)}MB）`))
        }
      })
      req.pipe(ws2)
      ws2.on('finish', () => {
        if (over) return
        try {
          resolve({ path: out, name: out.replace(/^.*[\\/]/, ''), bytes: statSync(out).size })
        } catch (err) { reject(err) }
      })
      ws2.on('error', reject)
      req.on('error', reject)
    })
  }

  // ---------------------------------------------------------------- HTTP：/media 与 /upload

  let realRoot = ''
  try { realRoot = realpathSync(cfg.fishRoot).toLowerCase() } catch { realRoot = '' }

  function tokenOk(url) {
    return mediaTokens.has(new URL(url, 'http://x').searchParams.get('token') ?? '')
  }

  function sendFile(req, res, p) {
    let st
    try { st = statSync(p) } catch { res.writeHead(404); return res.end('not found') }
    if (!st.isFile()) { res.writeHead(404); return res.end('not found') }
    const type = MIME[extname(p).toLowerCase()] ?? 'application/octet-stream'
    const size = st.size
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
    let start = 0
    let end = size - 1
    let partial = false
    if (range && (range[1] !== '' || range[2] !== '')) {
      partial = true
      if (range[1] === '') { start = size - Number(range[2]); end = size - 1 }
      else { start = Number(range[1]); end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1) }
      if (!Number.isFinite(start) || start < 0 || start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` })
        return res.end()
      }
    }
    const head = {
      'content-type': type,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
    }
    if (partial) head['content-range'] = `bytes ${start}-${end}/${size}`
    res.writeHead(partial ? 206 : 200, head)
    const stream = createReadStream(p, { start, end })
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }

  // ---------------------------------------------------------------- WS

  const clients = new Set()

  function broadcast(msg) {
    const data = JSON.stringify(msg)
    for (const ws of clients) {
      try { ws.send(data) } catch { clients.delete(ws) }
    }
  }

  // 出站：她的话 → 所有连着的浏览器。没人连也算送达（广播式）——
  // 错过的那句由历史回放兜底，不必让推送层停在半路重试。
  const pusher = createPusher({
    file: LEDGER,
    statePath: STATE_PATH,
    pollMs: cfg.pollMs,
    maxAgeMs: cfg.maxAgeMs,
    deliver: async (item) => {
      const m = presentItem(item)
      if (!m) return
      if (m.type === 'ask' && m.askId && (m.options ?? []).length) {
        pendingAsks.set(m.askId, { options: m.options, at: Date.parse(item.ts) || Date.now() })
      }
      broadcast(m)
    },
    log,
  })

  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const pathname = u.pathname

    if (pathname === '/media') {
      if (!tokenOk(u)) { res.writeHead(401); return res.end('token 不对') }
      const p = u.searchParams.get('path') ?? ''
      let real = ''
      try { real = realpathSync(p).toLowerCase() } catch { res.writeHead(404); return res.end('not found') }
      if (!realRoot || !real.startsWith(realRoot + '\\') && !real.startsWith(realRoot + '/')) {
        res.writeHead(403)
        return res.end('只能看数据目录里的文件')
      }
      return sendFile(req, res, real)
    }

    if (pathname === '/upload' && req.method === 'POST') {
      if (!tokenOk(u)) { res.writeHead(401); return res.end('token 不对') }
      const len = Number(req.headers['content-length'] ?? 0)
      if (len > cfg.fileMaxBytes) { res.writeHead(413); return res.end('文件超过上限') }
      // 文件名只走 safeName 净化；后缀用浏览器给的 File.name，没有也不猜（她自己判断）
      saveInboxStream(safeName(u.searchParams.get('name') ?? ''), req)
        .then((saved) => {
          const uploadId = randomUUID()
          uploads.set(uploadId, saved)
          if (uploads.size > 50) uploads.delete(uploads.keys().next().value)
          log(`收到上传：${saved.name} ${(saved.bytes / 1024).toFixed(0)}KB → ${saved.path}`)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, uploadId, name: saved.name, bytes: saved.bytes }))
        })
        .catch((err) => {
          log('上传失败：', String(err?.message ?? err))
          if (!res.headersSent) res.writeHead(400)
          res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
        })
      return
    }

    const STATIC = {
      '/': ['index.html', 'text/html; charset=utf-8'],
      '/index.html': ['index.html', 'text/html; charset=utf-8'],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
      '/style.css': ['style.css', 'text/css; charset=utf-8'],
    }
    const hit = STATIC[pathname]
    if (req.method !== 'GET' || !hit) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('not found')
    }
    try {
      const body = readFileSync(join(HERE, 'static', hit[0]))
      res.writeHead(200, { 'content-type': hit[1] })
      res.end(body)
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('static file missing')
    }
  })

  // 递话串行化：一次一句，插话判定靠 sayInFlight
  let chain = Promise.resolve()

  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws, req) => {
    let authed = false
    let token = ''
    clients.add(ws)
    // token 跟着这条连接走：断了就作废，别让 /media 的凭据永久留在内存里
    ws.on('close', () => { clients.delete(ws); if (token) mediaTokens.delete(token) })
    ws.on('error', () => { clients.delete(ws); if (token) mediaTokens.delete(token) })
    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(String(data)) } catch { return }
      if (!authed) {
        if (msg?.type !== 'auth') return
        if (!authAllowed(isLoopback(req.socket.remoteAddress), msg.password, cfg.password)) {
          ws.send(JSON.stringify({ type: 'auth-fail', note: '要密码（config.json 的 password），或从本机连' }))
          return
        }
        authed = true
        token = randomUUID()
        mediaTokens.add(token)
        ws.send(JSON.stringify({ type: 'auth-ok', token, history: historyItems() }))
        return
      }
      if (msg?.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }))

      if (msg?.type === 'chat') {
        const text = String(msg.text ?? '').trim()
        const image = typeof msg.image === 'string' && msg.image.startsWith('data:') ? msg.image : ''
        const saved = msg.uploadId ? uploads.get(String(msg.uploadId)) : null
        if (saved) uploads.delete(String(msg.uploadId)) // 附件一次性，别让同一个 uploadId 重复递话
        if (msg.uploadId && !saved) {
          return ws.send(JSON.stringify({ type: 'sent', ok: false, note: '附件没找到（可能过期），请重传' }))
        }
        if (!text && !image && !saved) return
        const pureText = !image && !saved
        let body = WEB_NOTE + (saved ? fileNoteFor(saved) : '') + text
        chain = chain.then(async () => {
          let r
          if (pureText && sayInFlight > 0) {
            // 插话：她这轮还没跑完。失败如实退回排队重发（fork.13：绝不假装插进去了）
            r = await fishSteer(body)
            if (!r?.ok) r = await fishSay(body)
            else r = { ok: true, note: String(r?.note ?? '插进去了') }
          } else {
            sayInFlight++
            try {
              r = await fishSay(body, image)
            } finally {
              sayInFlight--
            }
          }
          try { ws.send(JSON.stringify({ type: 'sent', ok: Boolean(r?.ok), note: String(r?.note ?? '') })) } catch { /* 断了就算了 */ }
        }).catch(() => {})
        return
      }

      if (msg?.type === 'answer') {
        const askId = String(msg.askId ?? '')
        const selected = String(msg.selected ?? '')
        const card = pendingAsks.get(askId)
        if (!card || !card.options.includes(selected)) {
          return ws.send(JSON.stringify({ type: 'answer-result', ok: false, note: '这张卡不在手边了（可能已答或过期）' }))
        }
        void fishAnswer(askId, selected).then((r) => {
          if (r?.ok) {
            pendingAsks.delete(askId)
            broadcast({ type: 'answer-result', ok: true, askId, selected })
          } else {
            ws.send(JSON.stringify({ type: 'answer-result', ok: false, note: String(r?.note ?? r?.why ?? '没答成') }))
          }
        })
        return
      }
    })
  })

  server.listen(cfg.port, cfg.host, () => {
    log(`webchat 就绪：http://${cfg.host}:${cfg.port}（本机免密；密码${cfg.password ? '已设' : '未设，非本机连不上'}）`)
    if (!cfg.password) log('要局域网访问：config.json 里设 password + host 改 0.0.0.0')
  })

  pusher.start()
  return { server, wss, pusher, cfg }
}

// 只有直接运行才起服务；被测试 import 时保持无副作用
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
