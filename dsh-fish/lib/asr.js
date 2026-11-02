/**
 * asr.js —— 本地听写外挂（fork.14，2026-11-02）
 *
 * 字幕轨不是每条视频都有。没有字幕、但用户机器上跑着本地 ASR 服务时，
 * 把音频下下来、切块、送过去听写——她就"听见"了。这条链路：
 *
 *   playurl 的音频流 → 下载到临时目录 → ffmpeg 切 55 秒块（stdout 管道，不落盘）
 *     → POST {asrUrl}/v1/audio/transcriptions（OpenAI 兼容，带 hotword）
 *     → segments[{start,end,text}] → 按块起点补偏移 → [{t, text}]
 *
 * 三条安全线：
 *   ① 服务不在线（健康检查 3 秒）→ 直接返回空，安静跳过——它本来就是可选外挂；
 *   ② 总预算（默认 90 秒）到了就用手头已有的句子——宁可少听，不拖死这一轮；
 *   ③ 任何失败都返回 []，绝不连累画面。
 *
 * 为什么分 55 秒：再长会 CUDA OOM（用户实测，240 秒就炸）。这里沿用他的参数。
 * 为什么音频下到临时目录再切：远端 seek 不可靠（分段的 dash 流常常不支持 range）。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** 一块多长（秒）。用户实测 240 秒会 CUDA OOM，55 是他跑通的值。 */
export const ASR_CHUNK_SECONDS = 55

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** 服务在不在线。不在就整个外挂安静退场。 */
export async function asrHealthy(base, timeoutMs = 3000) {
  const b = String(base ?? '').trim().replace(/\/+$/, '')
  if (!b) return false
  try {
    const r = await fetch(`${b}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) })
    return r.ok
  } catch {
    return false
  }
}

/**
 * 音频 → 本地 ASR → 带时间码的台词行 [{t, text}]。
 *
 * @param {object} o
 *   asrUrl      本地服务地址（如 http://127.0.0.1:18765）
 *   audioUrl    音频流地址（playurl 的 dash audio）
 *   cookie      登录态（下载音频用；不给通常也行）
 *   ffmpeg/ffprobe  可执行文件路径（都给才跑）
 *   budgetMs    总预算（默认 90000）；到了就用手头已有的
 *   hotword     热词（可选，提高专有名词识别率）
 * @returns {Promise<Array<{t:number,text:string}>>} 失败一律 []
 */
export async function transcribeViaLocalAsr(o = {}) {
  const base = String(o.asrUrl ?? '').trim().replace(/\/+$/, '')
  const audioUrl = String(o.audioUrl ?? '')
  const ffmpeg = String(o.ffmpeg ?? '')
  const ffprobe = String(o.ffprobe ?? '')
  if (!base || !audioUrl || !ffmpeg || !ffprobe) return []
  if (!(await asrHealthy(base))) return []

  const dir = mkdtempSync(join(tmpdir(), 'fish-asr-'))
  try {
    // ① 下载音频（音频流比画面小得多，16 分钟 ≈ 10~40MB）
    const r = await fetch(audioUrl, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', ...(o.cookie ? { Cookie: o.cookie } : {}) },
      signal: AbortSignal.timeout(60000),
    })
    if (!r.ok) return []
    const buf = Buffer.from(await r.arrayBuffer())
    if (!buf.length) return []
    const m4a = join(dir, 'a.m4a')
    writeFileSync(m4a, buf)

    // ② 时长
    let total = 0
    try {
      const out = execFileSync(
        ffprobe,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', m4a],
        { encoding: 'utf8', timeout: 15000, windowsHide: true },
      )
      total = parseFloat(String(out).trim()) || 0
    } catch {
      return []
    }
    if (!(total > 0)) return []

    // ③ 切块听写（ffmpeg stdout → FormData，不落盘）
    const t0 = Date.now()
    const budget = Math.max(15000, Number(o.budgetMs ?? 90000))
    const lines = []
    for (let start = 0; start < total; start += ASR_CHUNK_SECONDS) {
      if (Date.now() - t0 > budget) break
      const len = Math.min(ASR_CHUNK_SECONDS, total - start)
      let wav
      try {
        wav = execFileSync(
          ffmpeg,
          ['-v', 'error', '-ss', String(start), '-t', String(len), '-i', m4a, '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'],
          { timeout: 30000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        )
      } catch {
        continue // 这块转不出来就跳过
      }
      try {
        const fd = new FormData()
        fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav')
        if (o.hotword) fd.append('hotword', String(o.hotword))
        const rr = await fetch(`${base}/v1/audio/transcriptions`, {
          method: 'POST',
          body: fd,
          signal: AbortSignal.timeout(60000),
        })
        if (!rr.ok) continue
        const j = await rr.json().catch(() => null)
        for (const s of j?.segments ?? []) {
          const text = String(s.text ?? '').trim()
          if (text) lines.push({ t: Number((start + (Number(s.start) || 0)).toFixed(1)), text })
        }
      } catch {
        continue
      }
    }
    return lines
  } catch {
    return []
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}
