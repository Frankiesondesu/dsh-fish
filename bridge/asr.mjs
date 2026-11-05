/**
 * asr.mjs —— 把他的语音听成字（2026-11-05）
 *
 * 她没有耳朵：QQ 语音消息在桥这里被当成空消息直接丢掉
 * （`readMessage` 只认 text / at / image / mface / file / forward）。
 * 他能看、能发文件、能发表情，唯独说一句语音，她那边什么都没有。
 *
 * 用哪套听写：**用户自己那套本地服务**（`~/.dsh/asr.json` → 127.0.0.1:18765，
 * funasr paraformer-zh，OpenAI 兼容的 `/v1/audio/transcriptions`）。
 * 不引云端 API——语音内容不该出这台机器，这是这条链路唯一不能让步的地方。
 *
 * 那个服务是**按需启停**的（idleMs 15 分钟就退），所以这里要：
 *   探活（400ms）→ 不在线就按 manage.start 拉起来 → 等 /health 就绪
 * 首次加载模型十几秒到一分钟，期间日志要说清在等什么，别让人以为卡死。
 *
 * 边界：
 *   · 转不出来就说转不出来（"我这边听不了"），不许猜、不许把"嗯"编成一句话
 *   · 只转写，不改写——她拿到的必须是他说的话，不是摘要
 */

import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

/** 探活用多久。太短会把"正在加载"误判成"没开"。 */
const HEALTH_TIMEOUT_MS = 800
/** 首次加载模型很慢（实测 paraformer + VAD + 标点三件套要 60 秒以上），
 *  但也不能无限等——超过这个数就降级，让她说"听不了"。 */
const MAX_WAIT_MS = 180_000
/** 单条转写的上限（一条 QQ 语音一般不到 60 秒）。 */
const TRANSCRIBE_TIMEOUT_MS = 90_000

/** 读 ~/.dsh/asr.json。读不到就 null——没有配置不是错误，是"这台机器没装听写"。 */
export function readAsrConfig(home = process.env.USERPROFILE ?? '') {
  const p = join(home, '.dsh', 'asr.json')
  try {
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const baseUrl = String(j?.baseUrl ?? '').replace(/\/+$/, '')
    if (!baseUrl) return null
    return {
      baseUrl,
      key: String(j?.key ?? ''),
      model: String(j?.model ?? 'paraformer-zh'),
      language: String(j?.language ?? 'zh'),
      manage: j?.manage ?? null,
      path: p,
    }
  } catch {
    return null
  }
}

/** `/health` 通了没有。返回 true/false，永不抛。 */
export async function ping(baseUrl, { timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const url = String(baseUrl ?? '').replace(/\/v1\/?$/, '')
  if (!url) return false
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const r = await fetch(`${url}/health`, { signal: ac.signal })
      if (!r.ok) return false
      // 2026-11-05 实测：这个服务在**加载模型期间也回 200**，
      // 只有 status 字段能区分「起来了」和「起来了但还不能听」。
      // 不认这个字段，就会在 loading 时说"就绪"，然后第一句转写又等一分钟。
      const j = await r.json().catch(() => null)
      const st = String(j?.status ?? '').toLowerCase()
      if (st === 'loading' || st === 'error') return false
      return true
    } finally {
      clearTimeout(t)
    }
  } catch {
    return false
  }
}

/**
 * 确保服务在线：不在就按 asr.json 的 manage.start 拉起来，然后等 /health。
 * @returns {{ok:boolean, started:boolean, waitedMs:number, why:string}}
 */
export async function ensureServer(cfg, { log = () => {}, waitMs = MAX_WAIT_MS, now = () => Date.now() } = {}) {
  if (!cfg) return { ok: false, started: false, waitedMs: 0, why: '这台机器没有 asr.json（没装听写）' }
  if (await ping(cfg.baseUrl)) return { ok: true, started: false, waitedMs: 0, why: '' }

  const cmd = cfg.manage?.start
  if (!Array.isArray(cmd) || !cmd.length) {
    return { ok: false, started: false, waitedMs: 0, why: '听写服务没开，asr.json 里也没写启动命令' }
  }
  const [exe, ...args] = cmd
  if (!existsSync(exe)) {
    return { ok: false, started: false, waitedMs: 0, why: `听写服务没开，启动命令里的 ${exe} 也不存在` }
  }

  log(`听写服务没开，正在拉起（首次要加载模型，可能要几十秒）`)
  try {
    const p = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: join(exe, '..', '..') })
    p.unref()
  } catch (err) {
    return { ok: false, started: false, waitedMs: 0, why: `拉不起来：${String(err?.message ?? err)}` }
  }

  const t0 = now()
  while (now() - t0 < waitMs) {
    await new Promise((r) => setTimeout(r, 1200))
    if (await ping(cfg.baseUrl)) {
      const waited = now() - t0
      log(`听写服务就绪（等了 ${(waited / 1000).toFixed(0)} 秒）`)
      return { ok: true, started: true, waitedMs: waited, why: '' }
    }
  }
  return {
    ok: false, started: true, waitedMs: now() - t0,
    why: `听写服务 ${Math.round(waitMs / 1000)} 秒还没起来（看 ~/.dsh/asr-server/server.log）`,
  }
}

/**
 * 把一段音频转成文字。
 * @returns {{ok:boolean, text:string, why:string}}
 */
export async function transcribe(buf, cfg, { log = () => {}, timeoutMs = TRANSCRIBE_TIMEOUT_MS } = {}) {
  if (!cfg) return { ok: false, text: '', why: '没有听写配置' }
  if (!buf?.length) return { ok: false, text: '', why: '音频是空的' }
  try {
    const form = new FormData()
    form.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'voice.mp3')
    form.append('model', cfg.model)
    form.append('language', cfg.language)
    form.append('response_format', 'json')
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    let r
    try {
      r = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: cfg.key ? { authorization: `Bearer ${cfg.key}` } : {},
        body: form,
        signal: ac.signal,
      })
    } finally {
      clearTimeout(t)
    }
    const j = await r.json().catch(() => null)
    if (!r.ok) {
      return { ok: false, text: '', why: `听写服务回了 ${r.status}：${String(j?.error ?? '').slice(0, 120)}` }
    }
    const text = String(j?.text ?? '').trim()
    if (!text) return { ok: false, text: '', why: '听写回来是空的（可能全程没说话）' }
    log(`听出来了：${text.length} 字`)
    return { ok: true, text, why: '' }
  } catch (err) {
    const why = err?.name === 'AbortError' ? `听写超时（${Math.round(timeoutMs / 1000)} 秒）` : String(err?.message ?? err)
    return { ok: false, text: '', why }
  }
}
