/**
 * asr.js —— 接用户的 dsh-video-storyboard 外挂（fork.16，2026-11-02）
 *
 * 起因：字幕轨不是每条视频都有。没有字幕时，把音频送**用户自己的分镜插件**
 * （dsh-video-storyboard，装在 ~/.dsh/profiles/desktop/node_modules/，用户自己改过）
 * 的本地 ASR 服务转文字。插件自带全套生命周期，这里只做桥接：
 *
 *   ensureAsr()   自启（按 ~/.dsh/asr.json 的 manage.start，venv python + server.py）
 *                 服务已在线就不动它（owned=false）
 *   /health 轮询  等模型就绪（懒加载约 50s + CUDA 预热约 15s；waitMs 默认 180s）
 *   transcribe()  按块转写：start/end 是绝对时间，返回的 segments 时间戳已经加好偏移
 *   stopViaHttp() 看完优雅关停——**只关我们自己拉起来的**（isOwned()），别人的不动
 *
 * 三条安全线：总预算（默认 90 秒）到了用手头已有的；任何失败返回 []；
 * 服务/插件不存在也返回 []。这是可选外挂，绝不是必需品。
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

/** 一块多长（秒）。用户实测 240 秒会 CUDA OOM，55 是他跑通的值。 */
export const ASR_CHUNK_SECONDS = 55

/** asr.json 的默认位置；vs 插件自己也读这一份 */
export function asrJsonPath(p) {
  return String(p ?? join(homedir(), '.dsh', 'asr.json'))
}

export function readAsrJson(p) {
  try {
    return JSON.parse(readFileSync(asrJsonPath(p), 'utf8'))
  } catch {
    return null
  }
}

/** 动态加载 vs 插件的两个模块；不存在返回 null（缓存，别每次都 import） */
let vsCache = null
export async function loadVs(vsPath) {
  const base = String(vsPath ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-video-storyboard', 'src')).replace(/\/+$/, '')
  if (vsCache?.path === base) return vsCache.mods
  let mods = null
  try {
    const lifecycle = await import(pathToFileURL(join(base, 'asr-lifecycle.js')).href)
    const asr = await import(pathToFileURL(join(base, 'asr.js')).href)
    if (lifecycle?.ensureAsr && asr?.transcribe) mods = { lifecycle, asr }
  } catch {
    mods = null
  }
  vsCache = { path: base, mods }
  return mods
}

/** 下载音频流到临时目录；调用方负责删目录。失败返回 null。 */
export async function downloadAudio(audioUrl, { cookie, timeoutMs = 60000 } = {}) {
  if (!audioUrl) return null
  try {
    const r = await fetch(audioUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: 'https://www.bilibili.com/',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    if (!buf.length) return null
    const dir = mkdtempSync(join(tmpdir(), 'fish-asr-'))
    const file = join(dir, 'a.m4a')
    writeFileSync(file, buf)
    return { dir, file }
  } catch {
    return null
  }
}

/** /health 轮询到 status === 'ready'（模型懒加载 + CUDA 预热都要等） */
async function waitModelReady(base, healthPath, waitMs) {
  const url = `${base}${healthPath.startsWith('/') ? healthPath : `/${healthPath}`}`
  const deadline = Date.now() + Math.max(5000, Number(waitMs) || 180000)
  while (Date.now() < deadline) {
    try {
      const j = await fetch(url, { signal: AbortSignal.timeout(2500) }).then((r) => r.json()).catch(() => null)
      if (j?.status === 'ready') return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

/**
 * 音频文件 → vs 外挂转写 → 带时间码的台词行 [{t, text}]。
 *
 * @param {object} o
 *   audioFile   已下载的音频文件路径（downloadAudio 的 file）
 *   duration    音频秒数（playurl 的 duration；没有就只转第一块）
 *   vsPath      vs 插件 src 目录（默认自动找 profiles/desktop）
 *   asrJsonPath asr.json 位置（默认 ~/.dsh/asr.json；测试可传别的）
 *   chunkSec    每块秒数（默认 55）
 *   budgetMs    转写总预算（默认 90000）
 *   waitMs      等模型就绪的上限（默认取 asr.json 的 manage.waitMs，再默认 180000）
 *   hotwords    热词（可选；不传用 vs 自己的默认）
 * @returns {Promise<Array<{t:number,text:string}>>} 失败一律 []
 */
export async function transcribeViaVs(o = {}) {
  const audioFile = String(o.audioFile ?? '')
  if (!audioFile) return []
  const mods = await loadVs(o.vsPath)
  if (!mods) return []
  const cfg = o.asrJson ?? readAsrJson(o.asrJsonPath)
  if (!cfg?.baseUrl) return []

  const { lifecycle, asr } = mods
  let owned = false
  try {
    const up = await lifecycle.ensureAsr({ baseUrl: cfg.baseUrl, config: cfg, log: () => {} })
    owned = Boolean(up?.owned) || (typeof lifecycle.isOwned === 'function' ? Boolean(lifecycle.isOwned()) : false)
  } catch {
    return []
  }

  const base = String(cfg.baseUrl).replace(/\/v1\/?$/, '')
  const healthPath = String(cfg?.manage?.healthPath ?? '/health')
  const ready = await waitModelReady(base, healthPath, o.waitMs ?? cfg?.manage?.waitMs)
  if (!ready) {
    if (owned) {
      try {
        await lifecycle.stopViaHttp(cfg.baseUrl)
      } catch {
        /* ignore */
      }
    }
    return []
  }

  // 时长：调用方给了就用；没给且给了 ffprobe 就自己探；都没有 → 只转第一块
  let duration = Number(o.duration) || 0
  if (!(duration > 0) && o.ffprobe && audioFile) {
    try {
      const out = execFileProbe(o.ffprobe, audioFile)
      duration = out
    } catch {
      duration = 0
    }
  }

  const chunkSec = Math.max(5, Number(o.chunkSec) || ASR_CHUNK_SECONDS)
  const budget = Math.max(15000, Number(o.budgetMs) || 90000)
  const t0 = Date.now()
  const lines = []
  let sawAny = false
  for (let start = 0; ; start += chunkSec) {
    if (Date.now() - t0 > budget) break
    const end = duration > 0 ? Math.min(start + chunkSec, duration) : start + chunkSec
    if (duration > 0 && start >= duration) break
    let res = null
    try {
      res = await asr.transcribe({ input: audioFile, start, end, ...(o.hotwords ? { hotwords: o.hotwords } : {}) })
    } catch {
      break
    }
    const segs = res?.segments ?? []
    for (const s of segs) {
      if (s.text) lines.push({ t: Number(s.from) || start, text: String(s.text) })
    }
    if (segs.length) sawAny = true
    // duration 未知时：连续两块空 → 当作到头了
    if (!(duration > 0)) {
      if (!segs.length) {
        if (sawAny || start > 0) break
      } else sawAny = true
    }
  }

  // 看完就关——但只关我们自己拉起来的那一份
  if (owned) {
    try {
      await lifecycle.stopViaHttp(cfg.baseUrl)
    } catch {
      /* ignore */
    }
  }

  lines.sort((a, b) => a.t - b.t)
  return lines
}

function execFileProbe(ffprobe, file) {
  const out = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  })
  return parseFloat(String(out).trim()) || 0
}
