/**
 * intercom.mjs —— 对讲机：本机网页里跟她说话（2026-11-06）
 *
 * 为什么有这个：QQ 原生语音/视频通话在 OneBot 协议层就不存在
 * （napcat-plugin-qq-call-bridge 骨架都搭好了也「暂不能用」——公开插件 API
 * 拿不到电话层）。能落地的中间路线是把「他发语音条、她回语音条」这个
 * 已经跑通的慢速双工连续化：网页麦克风 → 现有 ASR → 她的回合 → 现有 TTS。
 *
 * 链路（全部复用现成组件，不引新依赖）：
 *   麦克风(MediaRecorder) → ffmpeg 转 mp3 → 本机听写（../bridge/asr.mjs，
 *   funasr 18765，不出机器）→ POST /dsh-fish/local/say（与桥同一条路）
 *   → 她的回复 → edge-tts 合成（音色与插件 her_voice 一致，fork.46 她挑的云希）
 *   → 网页播放（可选：经桥调试口同步一条语音到 QQ）
 *
 * 边界：
 *   · 回合制对讲，不是流式双工——没有打断（barge-in）。她说完你才能说。
 *   · 听不出来就如实说（asr.mjs 的规矩：不许猜，不许把"嗯"编成一句话）。
 *   · 语音文件落在 voice/intercom/（子目录——fork.52 的 sweep 不进子目录，
 *     自己清，只留最近 N 个）。
 *   · localhost 免 HTTPS，麦克风在 127.0.0.1 上直接可用；手机不行（另议）。
 */

import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { readAsrConfig, ensureServer, transcribe, ping as asrPing } from '../bridge/asr.mjs'
import { fishRoot, workbuddyPythons } from '../shared/root.mjs'

const run = promisify(execFile)

// 2026-11-06：不再写死 <用户主目录>。优先级见 shared/root.mjs。
const ROOT = fishRoot()
const KEY_FILE = join(ROOT, 'local.key')
const AUDIO_DIR = join(ROOT, 'voice', 'intercom')

// 她的声音。与 dsh-fish/lib/voice.js 的三行保持一致（fork.46 十条音色她挑的）。
const VOICE = 'zh-CN-YunxiNeural'
const RATE = '-14%'
const PITCH = '-8Hz'

/** 她这一轮最多等多久（与桥的 sayTimeoutMs 同值）。 */
const SAY_TIMEOUT_MS = 300_000
/** 念出来的上限：太长她自己也嫌长，超出截断并明说。 */
const SPEAK_MAX_CHARS = 500
/** 本地留多少条对讲录音。 */
const KEEP_FILES = 40
/** 桥调试口（bridge.mjs 同款默认值，FISH_BRIDGE_DEBUG_PORT 可改）。 */
const QQ_DEBUG_PORT = Number(process.env.FISH_BRIDGE_DEBUG_PORT || 6198)

// ---------------------------------------------------------------- 纯函数（可单测）

/** 她这一轮的话从 say 的返回里怎么取：说出口的优先，没开口才拿 growth_commit 兜底。 */
export function pickReply(j) {
  if (!j || typeof j !== 'object') return ''
  return String(j.spoken || j.herReply || '').trim()
}

/** 按句切成 2–4 段并发合成（fork.51 的同一套，拷自 dsh-fish/lib/voice.js）。 */
export function splitForSpeech(text, { maxParts = 4, minChars = 8 } = {}) {
  const s = String(text ?? '').trim()
  if (!s) return []
  const raw = s.match(/[^。！？!?；;\n]+[。！？!?；;\n]*/g) ?? [s]
  const parts = []
  for (const seg of raw) {
    const t = seg.trim()
    if (!t) continue
    const prev = parts[parts.length - 1]
    if (prev !== undefined && (t.length < minChars || prev.length < minChars)) {
      parts[parts.length - 1] = prev + t
    } else {
      parts.push(t)
    }
  }
  while (parts.length > maxParts) {
    const last = parts.pop()
    parts[parts.length - 1] += last
  }
  return parts
}

/** 浏览器录的 webm/ogg 要不要先转成 mp3 再喂听写（服务实测吃 mp3 最稳）。 */
export function needsConvert(mime) {
  const m = String(mime ?? '').toLowerCase()
  return !(m.includes('mpeg') || m.includes('mp3') || m.includes('wav') || m.includes('x-wav'))
}

/** 语音文件名只认这一种形状，别的都是坏的（防路径穿越）。 */
export function safeAudioName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.mp3$/.test(String(name ?? '')) ? String(name) : ''
}

/** 太长的话截到能念的长度，超出部分明说没念。 */
export function clampForSpeech(text, max = SPEAK_MAX_CHARS) {
  const s = String(text ?? '').trim()
  if (s.length <= max) return { text: s, dropped: 0 }
  const cut = s.slice(0, max)
  // 别把最后一个词切一半：退到最近的句末标点
  const m = cut.match(/^(.*[。！？!?；;])/s)
  const final = m ? m[1] : cut
  return { text: final, dropped: s.length - final.length }
}

// ---------------------------------------------------------------- 她的通路（同 bridge.mjs 的发现逻辑，拷贝自那里）
// 2026-11-07：observe.mjs（观测台的叫醒按钮）也用这一套——导出复用，
// 不再拷第三份（坑 #17：同一件事不被写两遍）。

export function fishKey() {
  try {
    return readFileSync(KEY_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

function listeningPorts() {
  const ports = new Set()
  let out = ''
  try {
    out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true })
  } catch {
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

let cachedPort = 0

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

export async function discoverHer() {
  const key = fishKey()
  if (!key) return 0
  if (cachedPort && (await probe(cachedPort, key))) return cachedPort
  cachedPort = 0
  const hits = await Promise.all(listeningPorts().map((p) => probe(p, key)))
  const found = hits.find(Boolean) || 0
  if (found) cachedPort = found
  return found
}

async function sayToHer(text, { log = () => {} } = {}) {
  const port = await discoverHer()
  if (!port) return { ok: false, reply: '', why: '没找到她的通路（DSH 开着吗？改过代码要重启 DSH）' }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), SAY_TIMEOUT_MS)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/dsh-fish/local/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fish-key': fishKey() },
      body: JSON.stringify({ text }),
      signal: ac.signal,
    })
    const j = await r.json().catch(() => null)
    if (!r.ok) return { ok: false, reply: '', why: String(j?.error ?? `HTTP ${r.status}`) }
    if (!j?.ok) return { ok: false, reply: '', why: String(j?.note ?? '递进去了但没有回音') }
    const reply = pickReply(j)
    log(`她回了 ${reply.length} 字（等了 ${Math.round((j.waitedMs ?? 0) / 1000)}s）`)
    return { ok: true, reply, why: reply ? '' : String(j.note ?? '她这次没说话') }
  } catch (err) {
    cachedPort = 0
    const why = err?.name === 'AbortError' ? `她这一轮太久（${Math.round(SAY_TIMEOUT_MS / 1000)} 秒上限）` : String(err?.message ?? err)
    return { ok: false, reply: '', why }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- 声音

function pythonExe() {
  // 与 dsh-fish/lib/voice.js 同一套候选：装了 edge_tts 的那个 Python 优先
  const fallback = process.platform === 'win32' ? 'python' : 'python3'
  const cands = [
    process.env.FISH_PYTHON,
    // 2026-11-06：原来写死 .../versions/3.13.12/python.exe，WorkBuddy 一升级就失效。
    // workbuddyPythons() 扫目录、版本降序，换机也不会指到不存在的路径。
    ...workbuddyPythons(),
    fallback,
  ].filter(Boolean)
  for (const p of cands) {
    if (!/[\\/]/.test(p) || existsSync(p)) return p
  }
  return fallback
}

function ffmpegBin() {
  return process.env.DSH_FISH_FFMPEG || 'ffmpeg'
}

let ffmpegOk = null
async function ffmpegWorks() {
  if (ffmpegOk !== null) return ffmpegOk
  try {
    await run(ffmpegBin(), ['-version'], { timeout: 5000, windowsHide: true })
    ffmpegOk = true
  } catch {
    ffmpegOk = false
  }
  return ffmpegOk
}

async function ttsOne(text, file) {
  await run(
    pythonExe(),
    ['-m', 'edge_tts', '--voice', VOICE, `--rate=${RATE}`, `--pitch=${PITCH}`, '--text', text, '--write-media', file],
    { timeout: 90_000, windowsHide: true },
  )
}

/** 把分片按顺序拼回一条 mp3（concat demuxer + copy，拷自 lib/voice.js 同款做法）。 */
async function concatMp3(dir, names, outName) {
  const listName = `list-${Date.now()}.txt`
  writeFileSync(join(dir, listName), names.map((n) => `file '${n}'`).join('\n'), 'utf8')
  try {
    await run(ffmpegBin(), ['-y', '-f', 'concat', '-safe', '0', '-i', listName, '-c', 'copy', outName], {
      cwd: dir,
      timeout: 30_000,
      windowsHide: true,
    })
  } finally {
    try { unlinkSync(join(dir, listName)) } catch { /* ignore */ }
  }
}

/** 浏览器录音转 mp3 单声道 16k（听写服务最稳的形状）。失败退回原始字节。 */
async function toMp3(buf, mime) {
  if (!needsConvert(mime)) return { buf, why: '' }
  if (!(await ffmpegWorks())) return { buf, why: '没装 ffmpeg，原始格式直接喂听写（可能听不了）' }
  try {
    mkdirSync(AUDIO_DIR, { recursive: true })
    const stamp = Date.now()
    const inFile = join(AUDIO_DIR, `tmp-${stamp}.in`)
    const outFile = join(AUDIO_DIR, `tmp-${stamp}.mp3`)
    writeFileSync(inFile, buf)
    try {
      await run(ffmpegBin(), ['-y', '-i', inFile, '-ac', '1', '-ar', '16000', '-b:a', '64k', outFile], {
        timeout: 60_000,
        windowsHide: true,
      })
      const out = readFileSync(outFile)
      return { buf: out, why: '' }
    } finally {
      try { unlinkSync(inFile) } catch { /* ignore */ }
      try { unlinkSync(outFile) } catch { /* ignore */ }
    }
  } catch (err) {
    return { buf, why: `转码失败（${String(err?.message ?? err).slice(0, 60)}），原始格式直接喂` }
  }
}

async function ttsReply(text, { log = () => {} } = {}) {
  const clamped = clampForSpeech(text)
  mkdirSync(AUDIO_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outName = `ic-${stamp}.mp3`
  const outFile = join(AUDIO_DIR, outName)
  const parts = splitForSpeech(clamped.text)
  let made = false
  if (parts.length > 1 && (await ffmpegWorks())) {
    const names = parts.map((_, i) => `ic-${stamp}-${i}.mp3`)
    try {
      await Promise.all(parts.map((p, i) => ttsOne(p, join(AUDIO_DIR, names[i]))))
      await concatMp3(AUDIO_DIR, names, outName)
      made = existsSync(outFile) && statSync(outFile).size > 0
    } catch { /* 退回整段 */ }
    for (const n of names) {
      try { unlinkSync(join(AUDIO_DIR, n)) } catch { /* ignore */ }
    }
  }
  if (!made) {
    try {
      await ttsOne(clamped.text, outFile)
      made = existsSync(outFile) && statSync(outFile).size > 0
    } catch (err) {
      return { ok: false, name: '', why: `声音没做出来：${String(err?.stderr ?? err?.message ?? err).slice(0, 100)}` }
    }
  }
  log(`合成 ${outName}（${parts.length > 1 ? parts.length + ' 段并发' : '整段'}）`)
  return { ok: true, name: outName, dropped: clamped.dropped, why: '' }
}

// ---------------------------------------------------------------- QQ 同步（尽力而为）

async function qqSendVoice(name, { log = () => {} } = {}) {
  const file = join(AUDIO_DIR, name)
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 20_000)
    try {
      const r = await fetch(`http://127.0.0.1:${QQ_DEBUG_PORT}/debug/send?type=record&file=${encodeURIComponent(file)}`)
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.ok) return { ok: false, why: String(j?.error ?? `HTTP ${r.status}`) }
      log(`语音条已同步到 QQ`)
      return { ok: true, why: '' }
    } finally {
      clearTimeout(t)
    }
  } catch (err) {
    return { ok: false, why: `调试口没通（${String(err?.message ?? err).slice(0, 60)}）` }
  }
}

// ---------------------------------------------------------------- 清理

function sweepOld(keep = KEEP_FILES) {
  try {
    const files = readdirSync(AUDIO_DIR)
      .filter((n) => n.endsWith('.mp3') && !n.startsWith('tmp-'))
      .map((n) => {
        try { return { n, m: statSync(join(AUDIO_DIR, n)).mtimeMs } } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => b.m - a.m)
    for (const f of files.slice(keep)) {
      try { unlinkSync(join(AUDIO_DIR, f.n)) } catch { /* ignore */ }
    }
  } catch { /* 目录还没建就算了 */ }
}

// ---------------------------------------------------------------- 对外两件事

/** 状态页用：听写在不在、她的通路在不在、ffmpeg 在不在。永不抛。 */
export async function intercomStatus() {
  const asrCfg = readAsrConfig()
  const asrReady = asrCfg ? await asrPing(asrCfg.baseUrl) : false
  const key = fishKey()
  const port = key ? await discoverHer() : 0
  return {
    asr: { configured: Boolean(asrCfg), ready: asrReady },
    her: { key: Boolean(key), port },
    ffmpeg: await ffmpegWorks(),
    busy: false,
  }
}

/**
 * 一句话走完全程：听（可选）→ 说给她 → 说回来。
 * @param {{buf?:Buffer, mime?:string, text?:string, qq?:boolean}} p
 */
export async function talk(p, { log = () => {} } = {}) {
  const buf = Buffer.isBuffer(p?.buf) ? p.buf : null
  let said = String(p?.text ?? '').trim()

  // 1. 听（给了 text 就跳过）
  if (!said) {
    const asrCfg = readAsrConfig()
    if (!asrCfg) return { ok: false, stage: 'listen', why: '这台机器没有 asr.json（没装听写），用输入框打字也行' }
    if (!buf?.length) return { ok: false, stage: 'listen', why: '没有收到声音' }
    log('对讲：收到', buf.length, '字节音频，确保听写服务在线…')
    const ensure = await ensureServer(asrCfg, { log })
    if (!ensure.ok) return { ok: false, stage: 'listen', why: ensure.why }
    const conv = await toMp3(buf, p?.mime)
    if (conv.why) log(conv.why)
    const tr = await transcribe(conv.buf, asrCfg, { log })
    if (!tr.ok) return { ok: false, stage: 'listen', why: tr.why }
    said = tr.text
  }

  // 2. 说给她（与桥同一条 /local/say：这一句就是他本人在说话）
  log(`对讲：递给她——「${said.slice(0, 40)}${said.length > 40 ? '…' : ''}」`)
  const sent = await sayToHer(said, { log })
  if (!sent.ok) return { ok: false, stage: 'send', transcript: said, why: sent.why }

  // 3. 说回来
  if (!sent.reply) return { ok: true, stage: 'reply', transcript: said, reply: '', audio: '', why: sent.why || '她这次没说话' }
  const tts = await ttsReply(sent.reply, { log })
  if (!tts.ok) return { ok: true, stage: 'tts', transcript: said, reply: sent.reply, audio: '', why: tts.why }

  // 4. 同步到 QQ（可选，失败不影响网页播放）
  let qq = { ok: false, why: '没开同步' }
  if (p?.qq) qq = await qqSendVoice(tts.name, { log })
  if (tts.dropped > 0) log(`回复太长，念了前 ${SPEAK_MAX_CHARS} 字，还有 ${tts.dropped} 字没念（文字在页面上全的）`)

  sweepOld()
  return {
    ok: true,
    stage: 'done',
    transcript: said,
    reply: sent.reply,
    audio: '/api/intercom/voice/' + tts.name,
    dropped: tts.dropped,
    qq,
  }
}
