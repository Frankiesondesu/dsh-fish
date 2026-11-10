/**
 * viewer.mjs —— 她的人格与行动查看器（2026-11-02）
 *
 * 为什么要有：DSH 自带的面板在设置里，翻起来一层套一层；而"她做过什么"
 * （调了哪些工具、参数是什么）根本不在面板里 —— 那些只写在会话日志里，
 * 藏在 zstd 压缩的 session.v4.jsonl.zstd 里，肉眼打不开。
 *
 * 这里把三份数据拼到一起，一个页面看完：
 *   1. ~/.dsh-fish/events.jsonl   —— 唯一真相：她的判断、系统记账（只增不改）
 *   2. ~/.dsh-fish/home.json      —— 当前会话 id / 轮数 / 换会话痕迹
 *   3. DSH 的 session 日志         —— 她这一轮调了什么工具、参数、结果
 *
 * 只读，不写任何东西。跑起来：node viewer.mjs  → http://127.0.0.1:7788
 */

import { createServer } from 'node:http'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { dshSessionsDir, fishRoot } from '../shared/root.mjs'
import { intercomStatus, talk } from './intercom.mjs'
import { readUsage } from './usage.mjs'
import { observeData, settleAsk, decideOffer, markInboxRead, clearBiliRisk, backupBundle, restoreBundle, wakeHer, reportFor } from './observe.mjs'
import { qqSaidOf, mergeSaid } from './said.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FISH = join(HERE, '..', 'dsh-fish')
// 2026-11-06：不再写死 <用户主目录>。换机/换盘/换用户名都靠这一步，
// 优先级（DSH_FISH_HOME → 指针文件 → ~/.dsh-fish）见 shared/root.mjs。
const ROOT = fishRoot()
const DSH_SESSIONS = dshSessionsDir(ROOT)
// 2026-11-07：端口可配（VIEWER_PORT 环境变量）。默认 7788 不变；
// 主要是给测试/并行验证用——真机 viewer 在跑的时候，新代码能在旁边端口先冒烟。
const PORT = Number(process.env.VIEWER_PORT) || 7788

// ---------------------------------------------------------------- 读数据

function readJson(p, dflt) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return dflt
  }
}

function readEvents() {
  try {
    return readFileSync(join(ROOT, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

/** 会话日志是「多帧拼接」的 zstd，一次解不完，得按 magic 切段 */
let sessionCache = { f: '', mtime: 0, size: 0, recs: [] }
function readSessionLog(sessionId) {
  if (!sessionId) return []
  const f = join(DSH_SESSIONS, sessionId, 'session.v4.jsonl.zstd')
  if (!existsSync(f)) return []
  // 2026-11-08：按 mtime+size 缓存解析结果——会话日志 2MB/4258 条，zstd 全解 127ms，
  // 而 /api/data 每 15 秒被轮询一次，文件没变时这 127ms 是纯白花的。
  let mtime = 0, size = 0
  try {
    const st = statSync(f)
    mtime = st.mtimeMs; size = st.size
  } catch {
    return []
  }
  if (sessionCache.f === f && sessionCache.mtime === mtime && sessionCache.size === size) return sessionCache.recs
  let buf
  try {
    buf = readFileSync(f)
  } catch {
    return []
  }
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const off = []
  for (let i = buf.indexOf(MAGIC); i !== -1; i = buf.indexOf(MAGIC, i + 1)) off.push(i)
  let text = ''
  for (let k = 0; k < off.length; k++) {
    const a = off[k]
    const b = k + 1 < off.length ? off[k + 1] : buf.length
    try {
      text += zstdDecompressSync(buf.subarray(a, b)).toString('utf8')
    } catch {
      /* 不是真帧边界 */
    }
  }
  const recs = text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  sessionCache = { f, mtime, size, recs }
  return recs
}

function textOfMessage(m) {
  const c = m?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/** 把她这次会话里的「动作」抽出来：谁调的、什么时候、参数、结果 */
function actionsOf(recs) {
  const results = new Map()
  for (const r of recs) {
    if (r?.type === 'tool/result') {
      const id = r.data?.toolCallId ?? r.data?.message?.toolCallId
      if (id) results.set(id, textOfMessage(r.data?.message) ?? '')
    }
  }
  const out = []
  for (const r of recs) {
    if (r?.type !== 'tool/call') continue
    const d = r.data ?? {}
    const res = results.get(d.callId) ?? ''
    out.push({
      at: d.time ?? r.time ?? 0,
      turn: d.turn ?? 0,
      step: d.step ?? 0,
      name: String(d.name ?? ''),
      args: String(d.arguments ?? ''),
      result: String(res).slice(0, 600),
    })
  }
  return out
}

/** 会话里她「说出口」的话（不是 growth_commit 记的，是聊天里真的回你的） */
function spokenOf(recs) {
  const out = []
  for (const r of recs) {
    if (r?.type !== 'assistant/message') continue
    const t = textOfMessage(r.data?.message)
    if (t) out.push({ at: r.time ?? r.data?.time ?? 0, turn: r.data?.turn ?? 0, text: t })
  }
  return out
}

/** 你发给她的（会话里的 user 消息，排除系统拼的上下文） */
function userSaidOf(recs) {
  const out = []
  for (const r of recs) {
    if (r?.type !== 'user/message') continue
    const src = r.data?.source
    if (src?.kind && src.kind !== 'user') continue
    const t = textOfMessage(r.data)
    if (!t) continue
    // 系统注入的上下文很长且带 <system-reminder>，跳过
    if (/^<system-reminder>|^Current runtime context|^Time sampled/.test(t)) continue
    out.push({ at: r.time ?? 0, text: t })
  }
  return out
}

// ---------------------------------------------------------------- 组装

/**
 * 设置页字段清单（2026-11-07 全量化）搬到了 settings-schema.mjs：
 * 那边要被防漂移测试单独 import（viewer.mjs 一 import 就会占 7788 端口）。
 * 这里只留引用，字段定义见 settings-schema.mjs 的头注释。
 */
import { SETTINGS, getPath, setPath, readDefaults, UNIT } from './settings-schema.mjs'

async function buildData() {
  const events = readEvents()
  const home = readJson(join(ROOT, 'home.json'), {})
  const config = readJson(join(ROOT, 'config.json'), {})

  let model = null
  try {
    const { deriveSelfCached } = await import('file://' + join(FISH, 'lib', 'derive.js').replace(/\\/g, '/'))
    const { loadConfig } = await import('file://' + join(FISH, 'lib', 'settings.js').replace(/\\/g, '/'))
    const cfg = (await loadConfig(ROOT)).config
    model = deriveSelfCached(events, { growthDays: cfg.growthDays })
  } catch (err) {
    model = { __error: String(err?.message ?? err) }
  }

  const sessionId = String(home.sessionId ?? '')
  const recs = readSessionLog(sessionId)

  // 以前的会话（换下来的）也列出来，只读元信息
  let sessions = []
  try {
    sessions = readdirSync(DSH_SESSIONS)
      .filter((d) => d.startsWith('session-'))
      .map((d) => {
        const p = join(DSH_SESSIONS, d, 'session.v4.jsonl.zstd')
        let size = 0
        let mtime = 0
        try {
          const s = statSync(p)
          size = s.size
          mtime = s.mtimeMs
        } catch { /* 没有日志 */ }
        return { id: d, size, mtime, current: d === sessionId }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch { /* ignore */ }

  return {
    now: Date.now(),
    home,
    config,
    sessions,
    model,
    // 2026-11-08：events 全量数组移出轮询载荷（账本 654KB→JSON 1.2MB，每 15s 推一次
    // 浏览器也要跟着解析一次）。只留条数供指纹；事件流页自己拉 /api/events。
    eventsCount: events.length,
    actions: actionsOf(recs),
    spoken: spokenOf(recs),
    // 她经 her_say 发到 QQ 的话（账本里带推送标记的那几条）——用户主要用 QQ，
    // 「她说的话」不收这些就等于漏了大半
    qqSaid: qqSaidOf(events),
    userSaid: userSaidOf(recs),
  }
}

// ---------------------------------------------------------------- 本机状态（只读聚合）

const SERVICES = [
  { name:'ASR 听写', port:18765, url:'http://127.0.0.1:18765/health', desc:'paraformer-zh · 语音转字；第一句要等冷启动' },
  { name:'smart-turn 话轮', port:18766, url:'http://127.0.0.1:18766/health', desc:'v3.2 CPU ONNX · 判「这句话说完了吗」，实测 40–110ms' },
  { name:'对话 TTS · CosyVoice2（已停用）', port:18767, url:'http://127.0.0.1:18767/health', desc:'2026-11-06 搭好、测过 3.6 秒就再没被调用过（业务代码 0 引用 / 日志 0 条 / 账本 0 次），同日摘出启动、删掉 12G。她的声音一直走 edge-tts（Yunxi，她自己挑的）' },
  { name:'全双工接口', port:18768, url:'http://127.0.0.1:18768/health', desc:'Moshi 7B 需约 15G 显存，本机 8G 跑不动；这里是「边听边说 + 打断不重置人格」的状态机原型' },
  { name:'QQ 桥', port:6199, url:'http://127.0.0.1:6199/', desc:'bridge · QQ 收发' },
  { name:'查看器', port:PORT, url:'http://127.0.0.1:'+PORT+'/api/data', desc:'本页' },
]

async function probe(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(400) })
    let detail = ''
    try { detail = (await r.text()).slice(0, 120).replace(/\s+/g, ' ').trim() } catch {}
    return { up: true, detail }
  } catch (e) {
    return { up: false, detail: e?.name === 'TimeoutError' ? '超时' : String(e?.cause?.code || e?.message || '连不上').slice(0, 60) }
  }
}

async function buildStatus() {
  const pkg = readJson(join(FISH, 'package.json'), {})
  const inst = readJson(join(ROOT, 'instance.json'), {})
  const bootAt = Number(inst.bootAt) || 0
  let newest = 0, newestFile = ''
  try {
    for (const f of readdirSync(join(FISH, 'lib'))) {
      if (!f.endsWith('.js')) continue
      const mt = statSync(join(FISH, 'lib', f)).mtimeMs
      if (mt > newest) { newest = mt; newestFile = f }
    }
  } catch {}
  // 版本不一致比 mtime 更硬：进程报 0.8.7、代码 0.9.1，就是没重启
  const versionStale = !!inst.version && !!pkg.version && inst.version !== pkg.version
  const restartNeeded = versionStale || (bootAt > 0 && newest > bootAt + 1000)
  let lines = 0, mtime = 0
  try {
    const p = join(ROOT, 'events.jsonl')
    mtime = statSync(p).mtimeMs
    lines = readFileSync(p, 'utf8').split('\n').filter(Boolean).length
  } catch {}
  let paused = false, pauseReason = ''
  try {
    const pm = await import('file:///' + join(FISH, 'lib', 'pause.js').replace(/\\/g, '/'))
    const p = await pm.readPause(ROOT)
    paused = !!p?.paused
    pauseReason = p?.reason ? String(p.reason) : ''
  } catch {}
  const services = await Promise.all(SERVICES.map(async (s) => {
    const r = await probe(s.url)
    return { name: s.name, port: s.port, desc: s.desc, up: r.up, detail: r.detail }
  }))
  const ts = ms => ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : ''
  return {
    at: Date.now(),
    plugin: { version: pkg.version || '?', processVersion: inst.version || '', upstream: 'v0.9.1（21 提交，11-06 合入）' },
    dsh: { bootAt: ts(bootAt), running: !!bootAt },
    restartNeeded,
    restartWhy: restartNeeded
      ? '进程报 ' + (inst.version || '?') + '，代码是 ' + (pkg.version || '?') +
        (newestFile ? '；最后一次改 lib/' + newestFile + ' 在 ' + ts(newest) : '') +
        '；DSH 起于 ' + ts(bootAt) + '。进程内的调度器、身份段、工具面都还是旧代码。'
      : '',
    ledger: { lines, mtime: ts(mtime) },
    flags: { dev: existsSync(join(ROOT, '.dev')), paused, pauseReason },
    services,
  }
}

// ---------------------------------------------------------------- 页面

const PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>她 · 查看器</title>
<style>
:root{--bg:#0e1014;--panel:#171a21;--line:rgba(255,255,255,.07);--fg:#e9ebf2;--dim:#8b93a7;--dim2:#666e82;--acc:#8aa4ff;--acc2:#a78bfa;--ok:#5fd39a;--warn:#f5bd62;--bad:#f0788a;--radius:14px}
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.65 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  body:before{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;background:radial-gradient(900px 500px at 12% -8%,rgba(138,164,255,.07),transparent 60%),radial-gradient(700px 400px at 88% 0%,rgba(167,139,250,.05),transparent 60%)}
  header{position:sticky;top:0;z-index:9;background:rgba(14,16,20,.82);backdrop-filter:blur(18px) saturate(1.4);border-bottom:1px solid var(--line);padding:0 24px}
  .hd{display:flex;align-items:center;gap:14px;height:60px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:650;font-size:15px;letter-spacing:.2px;white-space:nowrap}
  .brand .mark{width:26px;height:26px;border-radius:9px;background:linear-gradient(140deg,var(--acc),var(--acc2));box-shadow:0 3px 14px rgba(138,164,255,.32);display:grid;place-items:center;color:#0e1014;font-size:14px;font-weight:800}
  .brand small{font-weight:400;color:var(--dim2);font-size:11.5px;margin-left:2px}
  .hd .spacer{flex:1}
  .live{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dim);border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:4px 10px;white-space:nowrap}
  .live i{width:6px;height:6px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px rgba(95,211,154,.14)}
  .navtoggle{display:inline-flex;align-items:center;gap:8px;background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:999px;padding:6px 12px;font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap}
  .navtoggle:hover{border-color:rgba(138,164,255,.45)}
  .navtoggle .navcount{color:var(--dim2);font-size:11.5px}
  .navtoggle .chev{color:var(--dim);font-size:10px;transition:transform .18s}
  .navtoggle.open .chev{transform:rotate(180deg)}
  .tabs{display:none;gap:12px;padding:2px 0 16px}
  .tabs.open{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}
  .tabs[hidden]{display:none!important}
  .tabgroup{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 12px 12px}
  .tabgroup-t{font-size:11px;color:var(--dim2);font-weight:650;letter-spacing:.08em;margin:0 0 8px 2px}
  .tabgroup-b{display:flex;flex-wrap:wrap;gap:6px}
  .tabs button{background:transparent;border:1px solid var(--line);color:var(--dim);padding:7px 11px;border-radius:9px;font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap;transition:color .15s,border-color .15s,background .15s}
  .tabs button:hover{color:var(--fg);border-color:rgba(138,164,255,.4)}
  .tabs button.on{color:var(--fg);border-color:rgba(138,164,255,.55);background:rgba(138,164,255,.11);font-weight:600}
  main{position:relative;z-index:1;max-width:1120px;margin:0 auto;padding:26px 24px 100px}
  .sec{margin:22px 0 10px;display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dim2);font-weight:650;letter-spacing:.1em;text-transform:uppercase}
  .sec:first-child{margin-top:0}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;box-shadow:0 1px 2px rgba(0,0,0,.2)}
  .hero{position:relative;overflow:hidden;background:linear-gradient(120deg,#1a1f2d,#171a21 55%,#1b1826);border:1px solid rgba(138,164,255,.16);border-radius:18px;padding:22px 24px}
  .hero:after{content:'';position:absolute;right:-60px;top:-90px;width:280px;height:280px;border-radius:50%;background:radial-gradient(circle,rgba(138,164,255,.14),transparent 70%)}
  .hero .top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;position:relative;z-index:1;flex-wrap:wrap}
  .hero .day{font-size:34px;font-weight:680;line-height:1.15;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .hero .day span{font-size:13px;font-weight:450;color:var(--dim);margin-left:8px;letter-spacing:0}
  .hero .sub{color:var(--dim);font-size:12.5px;margin-top:5px}
  .badge{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;background:rgba(138,164,255,.12);border:1px solid rgba(138,164,255,.25);color:#b9c8ff;font-size:12px;font-weight:550;white-space:nowrap}
  .badge.ok{background:rgba(95,211,154,.1);border-color:rgba(95,211,154,.25);color:#8fe2b8}
  .badge.warn{background:rgba(245,189,98,.1);border-color:rgba(245,189,98,.25);color:#f3cd91}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(126px,1fr));gap:10px;margin-top:20px;position:relative;z-index:1}
  .stat{background:rgba(255,255,255,.028);border:1px solid rgba(255,255,255,.055);border-radius:11px;padding:11px 13px}
  .stat .k{font-size:11px;color:var(--dim2);letter-spacing:.03em}
  .stat .v{font-size:22px;font-weight:640;font-variant-numeric:tabular-nums;line-height:1.3;margin-top:2px}
  .stat .v small{font-size:11px;color:var(--dim);font-weight:400;margin-left:4px}
  .needs{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:20px}
  .need .nh{display:flex;justify-content:space-between;align-items:baseline;font-size:12.5px;margin-bottom:8px}
  .need .nh b{font-weight:600}
  .need .nh span{color:var(--dim);font-variant-numeric:tabular-nums}
  .bar{height:6px;border-radius:6px;background:#232833;overflow:hidden}
  .bar i{display:block;height:100%;border-radius:6px;transition:width .5s}
  .bar.a i{background:linear-gradient(90deg,#5fd39a,#8aa4ff)}
  .bar.b i{background:linear-gradient(90deg,#8aa4ff,#a78bfa)}
  .bar.c i{background:linear-gradient(90deg,#f5bd62,#f0788a)}
  .quote{position:relative;padding:16px 18px 16px 22px;border-radius:12px;background:linear-gradient(90deg,rgba(138,164,255,.07),transparent);border:1px solid rgba(138,164,255,.12);font-size:14px;line-height:1.85;color:#d7dced;white-space:pre-wrap}
  .quote:before{content:'';position:absolute;left:0;top:14px;bottom:14px;width:2px;border-radius:2px;background:linear-gradient(var(--acc),var(--acc2))}
  .quote.empty{color:var(--dim2);font-style:italic}
  .beliefs{display:flex;flex-direction:column;gap:2px;max-height:540px;overflow:auto}
  .beliefs::-webkit-scrollbar{width:6px}
  .beliefs::-webkit-scrollbar-thumb{background:#2c313c;border-radius:6px}
  .belief{display:flex;gap:12px;padding:10px 8px;border-radius:9px;transition:background .15s;font-size:13.5px;line-height:1.7}
  .belief:hover{background:rgba(255,255,255,.03)}
  .belief .idx{color:var(--dim2);font-variant-numeric:tabular-nums;font-size:11.5px;min-width:28px;padding-top:3px;text-align:right;flex:none}
  .belief .txt{flex:1;color:#cfd5e4}
  .belief .tag{flex:none;align-self:flex-start;font-size:10px;padding:1px 7px;border-radius:5px;background:rgba(95,211,154,.1);border:1px solid rgba(95,211,154,.2);color:#8fe2b8;margin-top:2px}
  .timeline{position:relative;padding-left:22px}
  .timeline:before{content:'';position:absolute;left:6px;top:8px;bottom:8px;width:1px;background:var(--line)}
  .tl-item{position:relative;margin-bottom:12px}
  .tl-item:before{content:'';position:absolute;left:-19px;top:16px;width:7px;height:7px;border-radius:50%;background:var(--acc);box-shadow:0 0 0 3px rgba(138,164,255,.13)}
  .tl-item.mine:before{background:var(--acc2);box-shadow:0 0 0 3px rgba(167,139,250,.13)}
  .tl-item.ev:before{background:#3d4557;box-shadow:0 0 0 3px rgba(255,255,255,.03)}
  .bubble{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 15px;font-size:13.5px;line-height:1.78;color:#d5dae8;word-break:break-word}
  .tl-item.mine .bubble{background:rgba(167,139,250,.055);border-color:rgba(167,139,250,.14)}
  .tl-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dim2);font-size:11.5px;margin-bottom:6px;font-variant-numeric:tabular-nums}
  .pill{display:inline-block;padding:1px 7px;border-radius:5px;background:rgba(255,255,255,.05);border:1px solid var(--line);color:var(--dim);font-size:10.5px;letter-spacing:.02em}
  .pill.said{color:#9fb6ff;background:rgba(138,164,255,.1);border-color:rgba(138,164,255,.18)}
  .pill.mine{color:#c9b3ff;background:rgba(167,139,250,.1);border-color:rgba(167,139,250,.18)}
  .pill.act{color:#8fe2b8;background:rgba(95,211,154,.09);border-color:rgba(95,211,154,.18)}
  .act-card{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin-bottom:9px;overflow:hidden}
  .act-hd{display:flex;align-items:center;gap:10px;padding:11px 15px;cursor:pointer;user-select:none}
  .act-hd:hover{background:rgba(255,255,255,.02)}
  .act-hd .nm{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;color:#a8baff}
  .act-hd .tm{margin-left:auto;color:var(--dim2);font-size:11.5px;font-variant-numeric:tabular-nums}
  .act-hd .chev{color:var(--dim2);font-size:10px;transition:transform .2s}
  .act-card.open .chev{transform:rotate(90deg)}
  .act-body{display:none;border-top:1px solid var(--line);padding:12px 15px}
  .act-card.open .act-body{display:block}
  pre{background:#101319;border:1px solid var(--line);border-radius:9px;padding:11px 13px;overflow:auto;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#b9c0d4;margin:0 0 8px;max-height:320px;white-space:pre-wrap;word-break:break-word}
  pre.res{color:#8fe2b8}
  .empty-state{text-align:center;padding:56px 20px;color:var(--dim2);border:1px dashed var(--line);border-radius:14px}
  .empty-state .ic{font-size:26px;opacity:.4;margin-bottom:10px}
  .dim{color:var(--dim)}
  .err{color:#ff9aa8}
  @media(max-width:900px){.tabs.open{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media(max-width:640px){header{padding:0 14px}.hd{height:auto;flex-wrap:wrap;gap:8px;padding:10px 0}main{padding:18px 14px 90px}.hero{padding:18px}.tabs.open{grid-template-columns:1fr}.navcount{display:none}}
  /* ---- 设置页（2026-11-04，现代布局）---- */
  .st-wrap{display:grid;grid-template-columns:190px minmax(0,1fr);gap:20px;align-items:start}
  .st-nav{position:sticky;top:78px;display:flex;flex-direction:column;gap:2px}
  .st-nav a{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-radius:8px;color:var(--dim);text-decoration:none;font-size:13px;border:1px solid transparent;cursor:pointer}
  .st-nav a:hover{background:var(--panel);color:var(--fg)}
  .st-nav a.on{background:#1c2634;color:var(--fg);border-color:rgba(127,180,255,.35)}
  .st-nav a .n{font-size:11px;opacity:.65}
  .st-head{margin:2px 0 16px}
  .st-head h2{font-size:18px;margin:0 0 4px;font-weight:600}
  .st-head p{margin:0;color:var(--dim);font-size:13px}
  .st-group{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin-bottom:14px;overflow:hidden}
  .st-group>h3{font-size:13px;margin:0;padding:12px 16px;border-bottom:1px solid var(--line);font-weight:600;letter-spacing:.3px}
  .st-group>h3 small{font-weight:400;color:var(--dim);margin-left:8px}
  .st-field{display:grid;grid-template-columns:minmax(0,1fr) 232px;gap:16px;padding:12px 16px;border-bottom:1px solid rgba(44,49,60,.55);align-items:center}
  .st-field:last-child{border-bottom:0}
  .st-field:hover{background:rgba(255,255,255,.015)}
  .st-field.danger{border-left:2px solid #e07979}
  .st-field.danger .st-label{color:#ffb4b4}
  .st-label{font-size:13px;display:flex;align-items:center;gap:7px}
  .st-hint{color:var(--dim);font-size:11.5px;margin-top:3px;line-height:1.5}
  .st-def{color:var(--dim);font-size:11px;margin-left:6px}
  .st-ctl{justify-self:end;display:flex;align-items:center;gap:8px}
  .st-dot{width:6px;height:6px;border-radius:50%;background:var(--warn);flex:none;visibility:hidden}
  .st-field.dirty .st-dot{visibility:visible}
  .st-in{background:#151820;border:1px solid var(--line);color:var(--fg);border-radius:7px;padding:6px 9px;font:13px system-ui;outline:none;width:100%}
  .st-in:focus{border-color:var(--acc);box-shadow:0 0 0 3px rgba(127,180,255,.12)}
  input.st-num{width:104px;text-align:right}
  .st-unit{color:var(--dim);font-size:12px;white-space:nowrap}
  .st-win{display:flex;align-items:center;gap:7px}
  .st-win input{width:98px}
  .st-sw{position:relative;width:38px;height:22px;flex:none}
  .st-sw input{opacity:0;width:0;height:0}
  .st-sw i{position:absolute;inset:0;background:#333a48;border-radius:22px;transition:.18s;cursor:pointer}
  .st-sw i:before{content:'';position:absolute;width:16px;height:16px;left:3px;top:3px;background:#c9cedb;border-radius:50%;transition:.18s}
  .st-sw input:checked + i{background:var(--acc)}
  .st-sw input:checked + i:before{transform:translateX(16px);background:#fff}
  .st-bar{position:sticky;bottom:0;margin-top:18px;background:rgba(22,24,29,.95);backdrop-filter:blur(10px);border:1px solid var(--line);border-radius:12px;padding:10px 14px;display:flex;align-items:center;gap:12px;z-index:5}
  .st-bar .st-msg{flex:1;color:var(--dim);font-size:12.5px}
  .st-btn{background:var(--acc);color:#10151f;border:0;border-radius:8px;padding:8px 20px;font-weight:600;cursor:pointer;font-size:13px}
  .st-btn:disabled{opacity:.4;cursor:default}
  .st-btn.ghost{background:transparent;color:var(--dim);border:1px solid var(--line);font-weight:400}
  .st-btn.ghost:hover{color:var(--fg)}
  .st-toast{position:fixed;right:22px;bottom:22px;background:#1c2634;border:1px solid var(--acc);color:var(--fg);padding:10px 16px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.45);font-size:13px;z-index:20}
  @media(max-width:720px){.st-wrap{grid-template-columns:1fr}.st-nav{position:static;flex-direction:row;overflow:auto}.st-field{grid-template-columns:1fr}.st-ctl{justify-self:start}}
</style></head><body>
<header>
  <div class="hd"><div class="brand"><span class="mark">她</span> 她 · 查看器</div>
    <button class="navtoggle" id="navtoggle" aria-expanded="false" aria-controls="tabs"><span id="navcurrent">人格数据</span><span class="navcount">全部 13 页</span><span class="chev">▾</span></button>
    <div class="spacer"></div>
    <div class="live"><i></i><span id="sub">读取中</span></div></div>
  <div class="tabs" id="tabs" hidden></div>
</header>
<main id="main"><p class="dim">读数据中…</p></main>
<script>
let D = null, tab = 'profile';
const TABS = [['profile','人格数据'],['said','她说的话'],['mine','你说的话'],['acts','她做过的事'],['events','事件流'],['observe','观测台'],['bili','上网'],['memory','记忆'],['data','数据'],['intercom','对讲机'],['usage','用量'],['status','本机状态'],['settings','设置']];
// 13 个页签按语义分三组，默认收起；点顶栏胶囊向下展开，选完自动收起。
// 只改展示方式：data-tab、tab 值、各页渲染逻辑一个没动。
const TAB_GROUPS = [
  ['她', ['profile','said','acts','memory','bili']],
  ['往来与记录', ['mine','intercom','events','observe']],
  ['本机', ['usage','status','data','settings']],
];
let navOpen = false;
const tabName = k => (TABS.find(x => x[0] === k) || [k, k])[1];
function renderTabs(){
  const box = document.getElementById('tabs');
  if(box) box.innerHTML = TAB_GROUPS.map(([g, ks]) =>
    '<div class="tabgroup"><div class="tabgroup-t">'+esc(g)+'</div><div class="tabgroup-b">'+
    ks.map(k => '<button data-tab="'+k+'" class="'+(k===tab?'on':'')+'">'+esc(tabName(k))+'</button>').join('')+
    '</div></div>').join('');
  const cur = document.getElementById('navcurrent');
  if(cur) cur.textContent = tabName(tab);
}
function setNavOpen(v){
  navOpen = !!v;
  const box = document.getElementById('tabs');
  if(box){ box.hidden = !navOpen; box.className = 'tabs'+(navOpen?' open':''); }
  const tg = document.getElementById('navtoggle');
  if(tg){ tg.className = 'navtoggle'+(navOpen?' open':''); tg.ariaExpanded = navOpen?'true':'false'; }
}
const esc = s => String(s??'').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const t = ms => { if(!ms) return ''; const d=new Date(ms); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };

// ---------------- 通用组件 ----------------
const sec = txt => '<div class="sec">'+esc(txt)+'</div>';
const stat = (k,v,unit,note) =>
  '<div class="stat"><div class="k">'+esc(k)+'</div><div class="v">'+esc(String(v))+
  (unit?'<small>'+esc(unit)+'</small>':'')+'</div>'+(note?'<div class="k" style="margin-top:2px">'+esc(note)+'</div>':'')+'</div>';
const need = (name,val,cls) => {
  const v = Number(val)||0, pct = Math.max(0,Math.min(100,Math.round(v*100)));
  return '<div class="need"><div class="nh"><b>'+esc(name)+'</b><span>'+v.toFixed(2)+'</span></div>'+
    '<div class="bar '+cls+'"><i style="width:'+pct+'%"></i></div></div>';
};
const emptyBox = txt => '<div class="empty-state"><div class="ic">◌</div>'+esc(txt)+'</div>';
const nl = s => esc(s).replace(/\n/g,'<br>');
const badge = (cls,txt) => '<span class="badge '+cls+'">'+esc(txt)+'</span>';

function render(){
  renderTabs();
  setNavOpen(navOpen);
  const m = D.model || {};
  const HM = humanMetrics();
  const el = document.getElementById('main');
  if(tab==='intercom'){ renderIntercom(el); return }
  if(tab==='usage'){ renderUsage(el); return }
  if(tab==='status'){ renderStatus(el); return }
  if(tab==='settings'){ renderSettings(el); return }
  if(tab==='observe'||tab==='bili'||tab==='memory'||tab==='data'){
    // 数据没拉过或超过 30 秒就先拉一轮（拉的时候显示读取中，回来重画这一页）
    if(!OB || Date.now()-(OB._at||0) > 30000){
      el.innerHTML = '<p class="dim">读观测台数据中…</p>';
      obFresh().then(()=>{ if(tab==='observe'||tab==='bili'||tab==='memory'||tab==='data') render() }).catch(()=>{});
      return;
    }
  }
  if(tab==='observe'){ renderObserve(el); return }
  if(tab==='bili'){ renderBili(el); return }
  if(tab==='memory'){ renderMemory(el); return }
  if(tab==='data'){ renderData(el); return }

  if(tab==='profile'){
    if(m.__error){ el.innerHTML = '<div class="card err">取模型失败：'+esc(m.__error)+'</div>'; }
    else {
      const needs = m.needs || {};
      const beliefs = m.beliefs || [];
      const solid = new Set((m.solid||[]).map(b=>String(b.id??b.text??'')));
      const wont = Number(m.facts?.wont||0);
      const refused = m.facts?.refused ?? (m.refusals||[]).length;
      const gate = (m.stageGate && m.stageGate.pending)
        ? badge('warn','阶段门 · 待 '+m.stageGate.pending)
        : badge('ok','阶段门 · 全过 '+((m.stageGate&&m.stageGate.passed||[]).length)+'/3');
      const nar = (m.narrative&&m.narrative.text)||'';
      el.innerHTML =
        '<div class="hero"><div class="top">'+
          '<div><div class="day">第 '+m.day+' 天<span>成长中</span></div>'+
          '<div class="sub">阶段 '+m.stage+' · '+esc(m.stageName||'')+' &nbsp;·&nbsp; '+D.eventsCount+' 条事件 &nbsp;·&nbsp; '+D.actions.length+' 次工具调用 &nbsp;·&nbsp; '+(D.home.turns??0)+' 轮会话</div></div>'+
          gate+'</div>'+
          '<div class="stats">'+
            stat('判断', beliefs.length, '条')+
            stat('拒绝', refused, '次', wont?('口头 '+wont+' 次'):'')+
            stat('改口', m.corrected||0, '次')+
            stat('固化', (m.solid||[]).length, '条', '反复想起的')+
            stat('张力', (m.tensions||[]).length, '条')+
            stat('会话轮数', D.home.turns??0, '轮')+
            stat('近25条均长', HM ? HM.avg : '—', '字', HM ? ('样本 '+HM.n+' 条') : '她还没说过话')+
            stat('问句率', HM ? HM.qRate : '—', '%', '她的话里有几个问号')+
          '</div></div>'+
        sec('三种需要')+
        '<div class="card needs">'+need('自主',needs.autonomy,'a')+need('胜任',needs.competence,'b')+need('关联',needs.relatedness,'c')+'</div>'+
        sec('她对自己的说法')+
        '<div class="quote'+(nar?'':' empty')+'">'+esc(nar||'还没有')+'</div>'+
        sec('她的判断 · '+beliefs.length+' 条 · 只增不改')+
        (beliefs.length
          ? '<div class="card"><div class="beliefs">'+beliefs.map((b,i)=>
              '<div class="belief"><span class="idx">'+String(i+1).padStart(2,'0')+'</span>'+
              '<span class="txt">'+esc(b.text||'')+'</span>'+
              (solid.has(String(b.id??b.text??''))?'<span class="tag">常想起</span>':'')+'</div>').join('')+'</div></div>'
          : emptyBox('还没有判断'));
    }
  }

  if(tab==='said'){
    // 窗口正文（会话日志）+ 她发到 QQ 的话（her_say 落的账本），并成一条时间线
    const a = mergeSaid(D.spoken||[], D.qqSaid||[]);
    el.innerHTML = sec('她说的话 · '+a.length+' 条（含发到 QQ 的）') + (a.length
      ? '<div class="timeline">'+a.map(s=>
          '<div class="tl-item"><div class="tl-meta">'+
          (s.where==='qq'
            ? '<span class="pill said">QQ</span>'+esc(t(s.at))+' · her_say'
            : '<span class="pill said">她</span>turn '+esc(s.turn)+' · '+esc(t(s.at)))+
          '</div>'+
          '<div class="bubble">'+nl(s.text||'')+'</div></div>').join('')+'</div>'
      : emptyBox('这条会话里她还没说过话'));
  }

  if(tab==='mine'){
    const a = (D.userSaid||[]).slice().reverse();
    el.innerHTML = sec('你说的话 · '+a.length+' 条') + (a.length
      ? '<div class="timeline">'+a.map(s=>
          '<div class="tl-item mine"><div class="tl-meta"><span class="pill mine">你</span>'+esc(t(s.at))+'</div>'+
          '<div class="bubble">'+nl(s.text||'')+'</div></div>').join('')+'</div>'
      : emptyBox('还没有'));
  }

  if(tab==='acts'){
    const a = (D.actions||[]).slice().reverse();
    el.innerHTML = sec('她做过的事 · '+a.length+' 次工具调用') +
      '<div class="dim" style="font-size:12px;margin:0 0 12px">参数与结果都来自会话日志，点开一条看细节。</div>'+
      (a.length ? a.map(x=>
        '<div class="act-card" data-act><div class="act-hd"><span class="pill act">TOOL</span>'+
        '<span class="nm">'+esc(x.name)+'</span>'+
        '<span class="tm">turn '+esc(x.turn)+'.'+esc(x.step)+' · '+esc(t(x.at))+'</span>'+
        '<span class="chev">▶</span></div>'+
        '<div class="act-body"><pre>'+esc(x.args||'').slice(0,1600)+'</pre>'+
        (x.result?'<pre class="res">'+esc(x.result).slice(0,1200)+'</pre>':'')+'</div></div>').join('')
      : emptyBox('这个会话里她还没调用过工具'));
    el.onclick = (ev)=>{ const c = ev.target.closest('[data-act]'); if(c) c.classList.toggle('open'); };
  } else {
    el.onclick = null;
  }

  if(tab==='events'){ renderEvents(el); return }

  document.getElementById('sub').textContent = pulledAt
    ? '更新于 '+new Date(pulledAt).toLocaleTimeString('zh-CN',{hour12:false})
    : '读取中';
}

const bkGo = async (tier, btn) => {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '打包中…（' + (tier === 'core' ? '核心' : '全量') + '）';
  try{
    const b = await fetch('/api/observe/backup?tier=' + tier, {cache:'no-store'}).then(r=>r.json());
    const blob = new Blob([JSON.stringify(b, null, 2)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = b.fileName || ('fish-backup-'+new Date().toISOString().slice(0,10)+'.json');
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 3000);
    const pre = document.getElementById('bkmanifest');
    if (pre) {
      pre.style.display = 'block';
      pre.textContent = '包含 ' + b.manifest.files + ' 个文件，' + (b.manifest.bytes/1024/1024).toFixed(2) + 'MB\n\n不在包里：\n' + (b.manifest.excludes||[]).map(x=>'· '+x).join('\n') + '\n\n跳过明细：\n' + (b.skipped||[]).slice(0,20).join('\n');
    }
    toast('备份已导出（' + b.manifest.files + ' 个文件）');
  }catch(e){ toast('导出失败：'+e.message) }
  btn.disabled = false; btn.textContent = old;
};

// 事件流（2026-11-08）：从轮询载荷里拆出来的大件。本页激活时才拉一次，
// 数据指纹变了（D.eventsCount 变）才重拉——1757 条的账本不该每 15 秒白过一遍。
let EV = { count: -1, events: null };
async function renderEvents(el){
  if (!EV.events || EV.count !== D.eventsCount) {
    el.innerHTML = sec('事件流') + '<div class="card"><span class="dim">读账本中…</span></div>';
    try {
      EV = await fetch('/api/events', { cache: 'no-store' }).then(r => r.json());
    } catch (e) {
      el.innerHTML = '<div class="card err">账本读不到：'+esc(e.message)+'</div>';
      return;
    }
  }
  const a = (EV.events||[]).slice().reverse();
  el.innerHTML = sec('事件流 · '+a.length+' 条 · 只增不改') + (a.length
    ? '<div class="timeline">'+a.map(e=>
        '<div class="tl-item ev"><div class="tl-meta"><span class="pill">'+esc(e.type)+'</span>'+
        esc(e.ts||'')+' · day '+esc(e.day)+' · '+esc(e.source)+'</div>'+
        '<div class="bubble">'+nl(String(e.text||'').slice(0,400))+'</div></div>').join('')+'</div>'
    : emptyBox('账本还是空的'));
}

// ---------------- 观测台 / 上网 / 记忆 / 数据（2026-11-07 迁移）----------------
// 数据层在 observe.mjs：直接 import 插件 lib 的同一批纯文件函数，口径与 DSH 侧一致。
// 进程绑定的功能（出门/请神/B站扫码/自升级/重置执行/恢复）不在这里，页面注明。
let OB = null;
const fts = s => { if(!s) return ''; const d = new Date(s); return isNaN(d) ? String(s).slice(5,16) : String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
async function obFresh(){
  OB = await fetch('/api/observe',{cache:'no-store'}).then(r=>r.json()).catch(e=>({fatal:String(e.message||e)}));
  OB._at = Date.now();
  return OB;
}
async function obAction(action, params, confirmText){
  if(confirmText && !confirm(confirmText)) return;
  const r = await fetch('/api/observe/action',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(Object.assign({action},params||{}))}).then(r=>r.json()).catch(e=>({ok:false,why:String(e.message||e)}));
  if(r && r.ok !== false){ await obFresh(); render(); toast('完成'); }
  else toast('没成：'+esc(String(r?.why || r?.error || '未知')));
}
function obHead(title, note){
  return sec(title)+'<div class="dim" style="font-size:12px;margin:0 0 12px">'+note+'</div>';
}

function renderObserve(el){
  const head = obHead('观测台','2026-11-07 从 DSH 侧迁来——同一批 lib 函数现算，数字和那边一致。出门/请神/B 站扫码/自升级/重置是进程绑定的，仍在 DSH 侧。');
  if(!OB || OB.fatal){ el.innerHTML = head + '<div class="card err">数据读不到：'+esc(String(OB?.fatal||'还没拉到，稍等会自动重试'))+'</div>'; return }
  const S = OB.state || {};
  if(S.ok === false){ el.innerHTML = head + '<div class="card err">'+esc(S.why||'状态算不出来')+'</div>'; return }
  const c = S.counts || {};
  const q = S.quality || {};
  const pending = S.pending;
  const asks = (OB.asks && OB.asks.ok !== false) ? (OB.asks.pending||[]) : [];
  const box = (OB.inbox && OB.inbox.ok !== false) ? ((OB.inbox.box||{}).rows||[]) : [];
  const unread = box.filter(r=>r.unread).length;
  const home = S.home || {};

  el.innerHTML = head +
    '<div class="hero"><div class="top">'+
      '<div><div class="day">第 '+esc(S.day??'?')+' 天<span>阶段 '+esc(S.stage??'?')+' · '+esc(S.stageName||'')+'</span></div>'+
      '<div class="sub">'+esc(S.name||'')+' · '+esc(home.turns??0)+' 轮会话 · '+(S.absenceDays??0)+' 天没见你</div></div>'+
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'+
        (S.pendingGate ? badge('warn','阶段门 · 待 '+S.pendingGate) : badge('ok','阶段门 · 已过'))+
        '<button class="st-btn" id="obwake">叫醒她一次</button>'+
      '</div></div>'+
      '<div class="stats">'+
        stat('判断', S.beliefCount??0, '条')+
        stat('张力', (S.tension&&S.tension.count)||0, '对')+
        stat('固化', S.solidCount??0, '条')+
        stat('疤', S.scarCount??0, '件')+
        stat('立场', S.stanceReady ? (S.stanceCount+' 条') : '还没走到', '', S.stanceCount?('四道门 '+(Array.isArray(S.stanceReady)?S.stanceReady.length:0)+'/3'):'')+
        stat('她的事', c.total??0, '条', '整份 '+ (c.all??0))+
      '</div></div>'+
    sec('事件构成')+
    '<div class="card"><div class="stats">'+
      stat('她自己记的', c.utterance??0, '条')+
      stat('答你的话', c.chat??0, '条', 'uncommitted，不落账')+
      stat('改口', c.revise??0, '条')+
      stat('拒绝', c.refusal??0, '条')+
      stat('重聚', c.reunion??0, '条')+
      stat('系统记账', c.meta??0, '行', '其中纯噪音 '+ (c.noise??0))+
    '</div></div>'+
    sec('判断漂移 · 三个诊断值，不是分数')+
    '<div class="card"><div class="stats">'+
      stat('稳定', (q.stability&&q.stability.value!=null)?Number(q.stability.value).toFixed(2):'—', '', (q.stability&&q.stability.band)?String(q.stability.band):'')+
      stat('一致', q.consistency!=null?Number(q.consistency).toFixed(2):'—')+
      stat('新鲜', q.novelty!=null?Number(q.novelty).toFixed(2):'—')+
    '</div><div class="dim" style="font-size:12px;margin-top:8px">稳定 = 抽掉一条她还在拿着的判断、重算自我描述还像不像她；一致 = 前后说法对得上；新鲜 = 还在长新的。看趋势，别拿它调性格。</div></div>'+
    sec('规则 · 她遵守什么、哪些还不会')+
    ((S.rules&&S.rules.length)
      ? '<div class="card">'+S.rules.map(r=>
          '<div class="belief"><span class="idx">'+(r.active?'✓':(r.ready?'◆':'·'))+'</span>'+
          '<span class="txt">'+esc(r.title||r.id)+'</span>'+
          (r.active?'<span class="tag">已解锁</span>':(r.pending?'<span class="tag" style="background:rgba(245,189,98,.12);border-color:rgba(245,189,98,.3);color:#f3cd91">待裁决</span>':''))+
          '</div>').join('')+'</div>'
      : emptyBox('还没有规则记录'))+
    (pending
      ? sec('待裁决的申请')+
        '<div class="card"><div class="quote">'+esc(p.title?('['+p.title+'] '):'')+nl(p.text||'')+'</div>'+
        '<div style="display:flex;gap:10px;margin-top:12px">'+
        '<button class="st-btn" onclick=\'obAction("decide",{verdict:"approve"},"同意这张申请？会写进账本。")\'>同意</button>'+
        '<button class="st-btn ghost" onclick=\'obAction("decide",{verdict:"reject"},"驳回这张申请？她会收到结果。")\'>驳回</button>'+
        '</div></div>'
      : '')+
    sec('待答申请 · 她开口问你的')+
    (asks.length
      ? '<div class="card">'+asks.map(a=>
          '<div class="belief"><span class="idx">'+esc(fts(a.ts))+'</span>'+
          '<span class="txt"><b>'+esc(a.subject||a.kind)+'</b> — '+nl(a.question||'')+'</span>'+
          '<span style="flex:none;display:flex;gap:6px">'+
          '<button class="st-btn" style="padding:4px 12px;font-size:12px" onclick=\'obAction("settle",{askId:"'+esc(a.id)+'",verdict:"approve"},"同意这条申请？")\'>同意</button>'+
          '<button class="st-btn ghost" style="padding:4px 12px;font-size:12px" onclick=\'obAction("settle",{askId:"'+esc(a.id)+'",verdict:"reject"},"拒绝这条申请？")\'>拒绝</button>'+
          '</span></div>').join('')+
        '<div class="dim" style="font-size:12px;margin-top:8px">配额：今天 '+((OB.asks.quota&&OB.asks.quota.usedDay)??'?')+'/'+((OB.asks.quota&&OB.asks.quota.perDay)??'?')+' 次，本周 '+((OB.asks.quota&&OB.asks.quota.usedWeek)??'?')+'/'+((OB.asks.quota&&OB.asks.quota.perWeek)??'?')+' 次</div></div>'
      : emptyBox('她现在没有等着你答的事'))+
    sec('信箱 · 她留给你的话'+(unread?(' · '+unread+' 封未读'):''))+
    (box.length
      ? '<div class="card">'+box.map(r=>
          '<div class="belief"><span class="idx">'+esc(fts(r.ts))+'</span>'+
          '<span class="txt">'+nl(r.text||'')+'</span>'+
          (r.unread?'<span class="tag" style="background:rgba(245,189,98,.12);border-color:rgba(245,189,98,.3);color:#f3cd91">未读</span>':'')+
          '</div>').join('')+
        '<div style="margin-top:12px"><button class="st-btn ghost" onclick=\'obAction("markread")\'>全部标为已读</button></div></div>'
      : emptyBox('还没有留话——这是起点，不是故障'))+
    sec('备份她')+
    '<div class="card"><div class="dim" style="font-size:12.5px;line-height:1.8">'+
      '一键提取她的人格与记忆：账本、日记、便条、配置、身份文档打包成单个 JSON（约 1MB），'+
      '存好就能在任何一台机器上把她接回来。<b>只存不发给他</b>——文件下载到你的下载目录。'+
      '全量（含表情库/收件箱）在「数据」页。</div>'+
      '<div style="margin-top:10px"><button class="st-btn" id="obbk">一键备份（人格与记忆）</button>'+
      '<span class="dim" id="obbknote" style="margin-left:10px;font-size:12px"></span></div></div>';
  const w = document.getElementById('obwake');
  if(w) w.onclick = ()=>obAction('wake',{},'叫醒会开一轮真实回合（会断不了什么，但会花她的额度）。现在叫吗？');
  const obk = document.getElementById('obbk');
  if (obk) obk.onclick = async () => {
    obk.disabled = true;
    const note = document.getElementById('obbknote');
    if (note) note.textContent = '打包中…';
    try {
      const b = await fetch('/api/observe/backup?tier=core', {cache:'no-store'}).then(r=>r.json());
      const blob = new Blob([JSON.stringify(b, null, 2)], {type:'application/json'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = b.fileName || ('fish-backup-core-'+new Date().toISOString().slice(0,10)+'.json');
      a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href), 3000);
      if (note) note.textContent = b.manifest.files + ' 个文件 · ' + (b.manifest.bytes/1024/1024).toFixed(2) + 'MB · 不含表情库/钥匙/日志';
      toast('备份已导出');
    } catch (e) {
      if (note) note.textContent = '没成：' + e.message;
    }
    obk.disabled = false;
  };
}

function renderBili(el){
  const head = obHead('上网','刷站记录 / 看过的画面 / 评论区，全部读账本里的记账行。B 站扫码登录与「等回复」扫描要 DSH 内存里的 cookie，仍在 DSH 侧。');
  if(!OB || OB.fatal || !OB.bili || OB.bili.ok === false){ el.innerHTML = head + '<div class="card err">'+esc((OB&&OB.bili&&OB.bili.why)||'数据读不到')+'</div>'; return }
  const B = OB.bili;
  const t = B.today || {};
  const cfg = B.config || {};
  const his = (B.history && B.history.groups) || [];
  const cm = B.comment || {};
  const risk = B.risk || {};
  el.innerHTML = head +
    '<div class="hero"><div class="top">'+
      '<div><div class="day">'+(t.watchedCount||0)+'<span>今天真看过画面</span></div>'+
      '<div class="sub">翻到过 '+ (t.glancedCount||0) +' · 递了没看 '+ ((t.handed&&t.handed.length)||0) +' · 翻列表 '+ (t.lookedCount||0) +' 次'+(cfg.browseEnabled?'':' · 上网总开关关着')+'</div></div>'+
      '<div style="display:flex;gap:8px;align-items:center">'+
        (risk.cooling? badge('warn','风控冷却 · 剩 '+risk.remainMin+' 分') : badge('ok','无风控'))+
        (risk.cooling?'<button class="st-btn ghost" onclick=\'obAction("risk-clear")\'>立即解冻</button>':'')+
      '</div></div></div>'+
    sec('看过什么 · 最近 14 天')+
    (his.length ? his.map(g=>
      '<div class="st-group"><h3>'+esc(g.dk||g[0])+'<small>'+((g.items||g[1]||[]).length)+' 条</small></h3>'+
      (g.items||g[1]||[]).map(v=>
        '<div class="belief"><span class="idx">'+(v.how==='watch'?'▶':'👁')+'</span>'+
        '<span class="txt"><a href="'+esc(v.url||('https://www.bilibili.com/video/'+esc(v.bvid)))+'" target="_blank" style="color:var(--acc);text-decoration:none">'+esc(v.title||v.bvid)+'</a>'+
        '<span class="dim" style="font-size:11.5px"> · '+esc(v.up||'')+(v.duration?(' · '+Math.round(v.duration/60)+' 分钟'):'')+'</span></span></div>').join('')+'</div>').join('')
      : emptyBox('账本里还没有看视频的记录'))+
    sec('她在评论区说过的话')+
    ((cm.mine&&cm.mine.length)
      ? '<div class="card">'+cm.mine.map(m=>
          '<div class="belief"><span class="idx">'+esc(fts(m.ts||m.at))+'</span><span class="txt">'+nl(m.text||m.content||'')+'</span></div>').join('')+
        '<div class="dim" style="font-size:12px;margin-top:8px">今天发了 '+(cm.usedToday||0)+'/'+(cm.perDay||0) +' 条 · 回了 '+(cm.replyUsedToday||0)+'/'+(cm.replyPerDay||0)+' 条。</div></div>'
      : '<div class="card"><span class="dim">她还没在评论区说过话'+(cm.enabled?'':'（总开关也关着）')+'。</span></div>')+
    '<div class="card" style="margin-top:12px;border-style:dashed"><span class="dim" style="font-size:12.5px">「有没有人回她」的扫描要 B 站 cookie，而 cookie 只活在 DSH 进程里——这一格在 DSH 侧的设置页看。</span></div>';
}

function renderMemory(el){
  const head = obHead('记忆','她的上下文用量与记忆体检——只读诊断，她看不到这些数。');
  if(!OB || OB.fatal || !OB.memory || OB.memory.ok === false){ el.innerHTML = head + '<div class="card err">'+esc((OB&&OB.memory&&OB.memory.why)||'数据读不到')+'</div>'; return }
  const M = OB.memory;
  const sd = M.selfDoc || {};
  const sec2 = M.sections || {};
  const h = M.health || {};
  const pct = sd.budget ? Math.min(100, Math.round((sd.chars||0)/sd.budget*100)) : 0;
  el.innerHTML = head +
    '<div class="hero"><div class="top">'+
      '<div><div class="day">'+(sd.chars||0)+'<span>/ '+(sd.budget||'?')+' 字</span></div>'+
      '<div class="sub">身份文档预算用量 '+pct+'% · 最近「想一想」'+(M.lastSleep?fts(M.lastSleep):'还没发生过')+' · 日记 '+ (M.diaryCount||0) +' 篇</div></div>'+
    '</div></div>'+
    (sd.dropped&&sd.dropped.length
      ? sec('这一轮被预算挤掉的段（她看不见的部分）')+
        '<div class="card"><div class="err" style="font-size:13px">'+sd.dropped.map(d=>esc(d)).join('、')+'</div>'+
        '<div class="dim" style="font-size:12px;margin-top:6px">调大 memory.docBudget 可以不挤——数字不是品格，只是别把已有的段挤掉。</div></div>'
      : '')+
    sec('构成')+
    '<div class="card"><div class="stats">'+
      stat('摆在眼前的判断', sec2.beliefsShown??0, '条', '折掉 '+ (sec2.beliefsFolded??0) +' 条')+
      stat('被推翻的', sec2.refuted??0, '条')+
      stat('拒绝', sec2.refused??0, '次')+
      stat('张力', sec2.tensions??0, '对')+
      stat('固化', sec2.solid??0, '条')+
      stat('疤', sec2.hurts??0, '件')+
      stat('他的反应·接受', (sec2.reactions||{}).accept??0, '次', '坚持 '+((sec2.reactions||{}).insist??0)+' · 受伤 '+((sec2.reactions||{}).hurt??0))+
    '</div></div>'+
    sec('记忆体检')+
    (h.ok===false||h.empty
      ? '<div class="card"><span class="dim">'+esc(h.why||'账本还太短，测不出什么。')+'</span></div>'
      : '<div class="card"><div class="stats">'+
          stat('跨度', h.days??'—', '天')+
          stat('事件', h.events??'—', '条')+
          stat('类型分布', (h.byType||[]).length, '种')+
        '</div><pre style="margin-top:10px">'+esc(JSON.stringify(h, null, 2)).slice(0,2400)+'</pre></div>');
}

function renderData(el){
  const head = obHead('数据','数据在哪、每天的报告、运行日志、备份。恢复/迁移执行/重置是破坏性或进程绑定操作，留在 DSH 侧。');
  if(!OB || OB.fatal || !OB.data || OB.data.ok === false){ el.innerHTML = head + '<div class="card err">'+esc((OB&&OB.data&&OB.data.why)||'数据读不到')+'</div>'; return }
  const Dp = OB.data;
  const paths = Dp.paths || {};
  el.innerHTML = head +
    sec('数据在哪')+
    '<div class="card">'+Object.entries(paths).map(([k,v])=>
      '<div class="belief"><span class="idx">'+esc(k)+'</span><span class="txt" style="font-family:ui-monospace,monospace;font-size:12px;word-break:break-all">'+esc(String(v))+'</span></div>').join('')+
      '<div class="dim" style="font-size:12px;margin-top:8px">换机/换盘走指针文件（~/.dsh-fish-location.json）或 DSH_FISH_HOME，不用改代码。</div></div>'+
    sec('每日报告 · '+((Dp.reportDates||[]).length)+' 天')+
    ((Dp.reportDates||[]).length
      ? '<div class="card" id="rptbox">'+Dp.reportDates.map(d=>
          '<div class="belief"><span class="idx"></span><span class="txt"><a href="#" data-rpt="'+esc(d)+'" style="color:var(--acc);text-decoration:none">'+esc(d)+'</a></span></div>').join('')+
        '<pre id="rptpre" style="display:none;margin-top:10px"></pre></div>'
      : '<div class="card"><span class="dim">还没有报告。她在 DSH 侧跑满一天会自动写。</span></div>')+
    sec('运行日志 · 最近 '+((Dp.logTail&&Dp.logTail.lines)||'').toString().length+' 行')+
    '<div class="card"><pre>'+esc((Dp.logTail&&Dp.logTail.text)||Dp.logTail&&Dp.logTail.tail||JSON.stringify(Dp.logTail||{})).slice(-4000)+'</pre>'+
      '<div class="dim" style="font-size:12px">完整导出（含自检与脱敏配置）在 DSH 侧的 /dsh-fish/log/export。</div></div>'+
    sec('备份 · 一键提取她的数据')+
    '<div class="card"><div class="dim" style="font-size:12.5px;margin-bottom:10px">'+esc(Dp.backupNote||'')+'</div>'+
      '<div style="display:flex;gap:10px;flex-wrap:wrap">'+
        '<button class="st-btn" id="bkcore">一键备份（人格与记忆 · 约 1MB）</button>'+
        '<button class="st-btn ghost" id="bkfull">全量备份（含表情库与收件箱 · 可能 60MB+）</button>'+
      '</div>'+
      '<div class="dim" style="font-size:12px;margin-top:10px;line-height:1.8">'+
        '<b>核心包</b>：账本、配置、日记、便条、信箱、身份文档、账本指纹、旁听缓存——她的记忆与判断全在里面。<br>'+
        '<b>不进包</b>：表情库与收件箱的二进制（整目录拷贝即可迁移）、local.key（本机钥匙，首启自动再生成）、日志。<br>'+
        '恢复语义：先封存现状再放回（一个字节不删），文件在 <code>dsh-fish-backups/</code>。'+
      '</div>'+
      '<pre id="bkmanifest" style="display:none;margin-top:10px"></pre>'+
      '<div style="border-top:1px solid var(--line);margin-top:14px;padding-top:12px">'+
        '<div class="dim" style="font-size:12.5px;line-height:1.8;margin-bottom:9px">'+
          '<b>恢复备份</b>：把导出的 .json 备份包放回来。先把现状整体封存到 <code>dsh-fish-backups/pre-restore-*</code>（一个字节不删），再写回包里的文件；<b>恢复完要重启 DSH，她才是这份档的样子</b>。包里的 local.key 会被剥掉，不覆盖本机钥匙。'+
        '</div>'+
        '<input type="file" id="bkimp" accept=".json,application/json" style="font-size:12.5px;max-width:100%">'+
        '<div id="bkimpprev" style="display:none;margin-top:10px;font-size:12.5px;line-height:1.8"></div>'+
        '<div id="bkimpgo-wrap" style="display:none;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px">'+
          '<label style="font-size:12.5px;color:var(--dim)"><input type="checkbox" id="bkimpc"> 我知道这会覆盖当前数据，旧档只进封存目录</label>'+
          '<button class="st-btn" id="bkimpgo" disabled>执行恢复</button>'+
        '</div>'+
      '</div></div>'+
    sec('迁移 / 导入 / 重置 · 只看状态')+
    '<div class="card">'+
      '<div class="belief"><span class="idx">迁移</span><span class="txt">'+esc(JSON.stringify(Dp.moveStatus||{})).slice(0,200)+'</span></div>'+
      '<div class="belief"><span class="idx">导入</span><span class="txt">'+esc((Dp.importStatus&&Dp.importStatus.reason)||'可以导入（她还没有起点）——这是「接手别人养的鱼」，与上面的恢复备份是两件事')+'</span></div>'+
      '<div class="belief"><span class="idx">重置</span><span class="txt">执行要 ctx 归档会话，留在 DSH 侧设置页底部。</span></div>'+
    '</div>';
  el.querySelectorAll('[data-rpt]').forEach(a=>{
    a.onclick = async (ev)=>{ ev.preventDefault();
      const pre = document.getElementById('rptpre');
      pre.style.display='block'; pre.textContent='读报告中…';
      const r = await fetch('/api/observe/report?date='+a.dataset.rpt,{cache:'no-store'}).then(x=>x.json()).catch(e=>({why:String(e)}));
      pre.textContent = r.md || ('读不到：'+(r.why||''));
    };
  });
  const bkc = document.getElementById('bkcore');
  if (bkc) bkc.onclick = ()=>bkGo('core', bkc);
  // 恢复备份（2026-11-08）：选文件 → 预览 → 勾确认 → POST /api/observe/restore
  const impInput = document.getElementById('bkimp');
  if (impInput) impInput.onchange = async () => {
    const prev = document.getElementById('bkimpprev');
    const wrap = document.getElementById('bkimpgo-wrap');
    const go = document.getElementById('bkimpgo');
    const c = document.getElementById('bkimpc');
    const f = impInput.files && impInput.files[0];
    if (!f) { prev.style.display = 'none'; wrap.style.display = 'none'; return }
    let b;
    try { b = JSON.parse(await f.text()); }
    catch (e) { prev.style.display = 'block'; prev.innerHTML = '<span class="err">不是合法的 JSON：'+esc(e.message)+'</span>'; wrap.style.display = 'none'; return }
    if (!b || b.format !== 'dsh-fish-backup/1' || !Array.isArray(b.files)) {
      prev.style.display = 'block';
      prev.innerHTML = '<span class="err">这不是 dsh-fish 的备份包（format 不认识）。恢复不接受「导出数据」之类的半成品。</span>';
      wrap.style.display = 'none';
      return;
    }
    const evf = b.files.find(x => x.path === 'events.jsonl');
    const rows = evf && typeof evf.data === 'string' ? evf.data.split('\n').filter(Boolean).length : 0;
    const older = D.eventsCount != null && rows < D.eventsCount;
    prev.style.display = 'block';
    prev.innerHTML =
      '<div class="belief"><span class="idx">格式</span><span class="txt">'+esc(b.format)+'</span></div>'+
      '<div class="belief"><span class="idx">时间</span><span class="txt">'+esc(b.createdAt||'?')+'</span></div>'+
      '<div class="belief"><span class="idx">内容</span><span class="txt">'+b.files.length+' 个文件 · '+((b.bytes||0)/1048576).toFixed(2)+'MB · 账本 '+rows+' 行</span></div>'+
      (older ? '<div class="err" style="font-size:12.5px;margin:6px 0">⚠️ 这份备份比现在<b>旧</b>（当前账本 '+D.eventsCount+' 行）。恢复会把她的时间线倒回那一刻——之后发生的事会封存进 pre-restore 目录，不会丢，但要记得她在「那个她」里。</div>' : '');
    wrap.style.display = 'flex';
    if (go) go.disabled = true;
    if (c) c.onchange = () => { if (go) go.disabled = !c.checked; };
    if (go) go.onclick = async () => {
      go.disabled = true;
      try {
        const r = await fetch('/api/observe/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(x => x.json());
        if (!r.ok) throw new Error(r.why || r.error || 'HTTP 错');
        prev.innerHTML = '<span style="color:var(--ok)">恢复了 ' + r.restored + ' 个文件。旧档封存在 <code>' + esc(r.quarantined || '（当前目录本来就是空的，无封存件）') + '</code>。</span>' +
          '<div class="dim" style="margin-top:6px"><b>重启 DSH 之后她才是这份档的样子</b>（管理器 → DSH → 重启）；刷新页面看到的是新档。</div>';
        toast('恢复完成：' + r.restored + ' 个文件');
      } catch (e) {
        // 不替服务端下结论：restoreBackup 可能已经把旧档封存、写了一半才失败，
        // 那时「全没变」是假话。如实把服务端的原因摆出来，让人别重复点恢复。
        prev.innerHTML = '<span class="err">恢复没成：' + esc(e.message) + '</span>' +
          '<div class="dim" style="margin-top:6px">按报错里的说明处理；若提到封存目录，旧档就在那儿，别重复点恢复。</div>';
        go.disabled = false;
      }
    };
  };
  const bk = document.getElementById('bkfull');
  if(bk) bk.onclick = ()=>{ if(confirm('全量包含表情库与收件箱二进制，可能 60MB+，生成与下载都要一会儿。继续？')) bkGo('full', bk) };
}

// ---------------- 设置页（2026-11-04，现代布局）----------------
// 这段跑在模板字符串里，不能写美元花括号插值，全部用字符串拼接。
let SCHEMA=null, CFG=null, DEFS=null, UNIT={}, SAVED='{}';
const fid = k => 'f_'+k.replace(/[^a-zA-Z0-9]/g,'_');
const getIn = (o,p) => p.split('.').reduce((a,k)=>(a==null?undefined:a[k]),o);
const setIn = (o,p,v) => { const ks=p.split('.'); const last=ks.pop(); let t=o; for(const k of ks){ if(!t[k]) t[k]={}; t=t[k] } t[last]=v };
// 单位表从 /api/config 一次性带来，与 settings-schema.mjs 的 UNIT 是同一份。
// 以前页面里另抄了一份只 18 项，新增字段的单位一直不显示（2026-11-10 修）。

function fieldHTML(s){
  const raw = getIn(CFG, s.key), dflt = getIn(DEFS, s.key);
  // /api/config 回的是原始 config.json（未归一化）：老配置缺键时若不回退到默认值，
  // 新加的开关会显示成「关」，用户随便改一格保存就把她真的关掉了。
  const cur = raw === undefined ? dflt : raw;
  const key = esc(s.key), id = fid(s.key);
  let ctl = '';
  if(s.kind==='bool'){
    ctl = '<label class="st-sw"><input type="checkbox" id="'+id+'" data-key="'+key+'" data-kind="bool"'+(cur?' checked':'')+'><i></i></label>';
  } else if(s.kind==='window'){
    const a=(cur&&cur[0])||'', z=(cur&&cur[1])||'';
    ctl = '<div class="st-win"><input type="time" class="st-in" data-key="'+key+'" data-kind="win" value="'+a+'">'+
          '<span>→</span><input type="time" class="st-in" data-key="'+key+'" data-kind="win" value="'+z+'"></div>';
  } else if(s.kind==='list'){
    ctl = '<input class="st-in st-list" id="'+id+'" data-key="'+key+'" data-kind="list" value="'+esc((cur||[]).join('，'))+'">';
  } else if(s.kind==='text'){
    ctl = '<input class="st-in" id="'+id+'" data-key="'+key+'" data-kind="text" value="'+esc(cur==null?'':cur)+'" style="width:220px">';
  } else {
    ctl = '<input type="number" class="st-in st-num" id="'+id+'" data-key="'+key+'" data-kind="num" value="'+(cur==null?'':cur)+'"'+
          (s.min!=null?' min="'+s.min+'"':'')+(s.max!=null?' max="'+s.max+'"':'')+
          (s.step!=null?' step="'+s.step+'"':'')+'>'+
          (UNIT[s.key]?'<span class="st-unit">'+UNIT[s.key]+'</span>':'');
  }
  const def = (dflt!=null && String(dflt)!==String(cur)) ? '<span class="st-def">默认 '+esc(JSON.stringify(dflt))+'</span>' : '';
  return '<div class="st-field'+(s.danger?' danger':'')+'" data-field="'+key+'">'+
    '<div><div class="st-label"><span class="st-dot"></span>'+esc(s.label)+def+'</div>'+
    (s.hint?'<div class="st-hint">'+esc(s.hint)+'</div>':'')+'</div>'+
    '<div class="st-ctl">'+ctl+'</div></div>';
}

/** 收集表单 → patch；同时算出哪些字段被改过。 */
function collect(){
  const patch={}, dirty=[], changed={};
  for(const s of SCHEMA){
    const ns = Array.prototype.slice.call(document.querySelectorAll('[data-key="'+s.key+'"]'));
    if(!ns.length) continue;
    let v;
    if(s.kind==='bool') v = ns[0].checked;
    else if(s.kind==='window') v = [ns[0].value, ns[1].value];
    else if(s.kind==='list') v = ns[0].value.split(/[，,]/).map(x=>x.trim()).filter(Boolean);
    else if(s.kind==='text') v = String(ns[0].value).trim();
    else v = Number(ns[0].value);
    if(v==null || (Array.isArray(v) && (!v[0]||!v[1])) || (typeof v==='number' && !Number.isFinite(v))) continue;
    setIn(patch, s.key, v);
    if(JSON.stringify(v)!==JSON.stringify(getIn(CFG,s.key))){ dirty.push(s.key); changed[s.key]=s; }
  }
  return { patch, dirty, changed };
}

function markDirty(){
  const r = collect();
  const set = new Set(r.dirty);
  document.querySelectorAll('.st-field').forEach(f=>f.classList.toggle('dirty', set.has(f.dataset.field)));
  const msg = document.getElementById('stmsg');
  const btn = document.getElementById('cfgsave');
  if(msg) msg.textContent = r.dirty.length ? r.dirty.length+' 项改动未保存' : '当前没有改动';
  if(btn) btn.disabled = !r.dirty.length;
}

function toast(text){
  const d = document.createElement('div'); d.className='st-toast'; d.textContent=text;
  document.body.appendChild(d);
  setTimeout(()=>{ try{ d.remove() }catch(e){} }, 2600);
}

// ---------------- 人味仪表盘 & 本机状态（2026-11-06）----------------
// 11-05 那次诊断（25 条回复 0 问号、平均 137 字、三段式报告腔）常驻化。
// 只从她在这个会话里说过的原话算，不做打分、不改她的东西。
function humanMetrics(){
  const a = (D.spoken||[]).slice(-25).map(x=>String(x.text||'').trim()).filter(Boolean);
  if(!a.length) return null;
  const chars = a.map(s=>s.replace(/\s/g,'').length);
  const avg = chars.reduce((x,y)=>x+y,0)/chars.length;
  const q = a.filter(s=>/[?？]/.test(s)).length;
  return { n:a.length, avg:avg.toFixed(1), qRate:Math.round(q/a.length*100) };
}

// 只读聚合：插件版本 / 进程跑的是不是新代码 / 各本地服务探活 / 账本。
// 「语料库」在这里只把口径写给人看，不做任何挑选或打分——挑哪些是系统的手。
// ---------------- 用量 / 消费（2026-11-06） ----------------
// 数据是 DSH 自己写的 usage-ledger.json，不是这个插件记的。
// 那条账本 2026-10-25 之后就停了，所以页面上必须把「截止到哪天」写在最前面——
// 不写的话，用户会以为最近没花钱。
const fmtN = n => {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'G';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
};
// cost 是 DSH 写的原值，单位不明（按 DeepSeek 几种计价都反推不出来），
// 所以不加 ¥ / $，小到 1e-6 也照实显示，不做四舍五入到 0。
const fmtCost = c => {
  const v = Number(c) || 0;
  return v === 0 ? '0' : v < 0.01 ? v.toFixed(6) : v.toFixed(4);
};

async function renderUsage(el){
  el.innerHTML = '<div class="sec">用量与消费</div><div class="card"><span class="dim">读用量账本中…</span></div>';
  let u;
  try { u = await (await fetch('/api/usage',{cache:'no-store'})).json(); }
  catch(e){ el.innerHTML = '<div class="card err">用量读不到：'+esc(e.message)+'</div>'; return }

  const head = '<div class="sec">用量与消费</div>';

  if(!u.ok){
    el.innerHTML = head +
      '<div class="card err">'+esc(u.why || '读不到用量账本')+'</div>' +
      '<div class="card" style="margin-top:10px">'+
        '<div class="dim" style="font-size:12.5px">账本路径：'+esc(u.file)+'</div>'+
        '<div class="dim" style="font-size:12.5px;margin-top:6px;line-height:1.7">'+
          '这个文件由 DSH 自己写，不归这个插件管。它出现之后刷新这页就能看到。'+
        '</div>'+
      '</div>';
    return;
  }

  const T = u.total || {};
  const models = u.models || [];
  const days = u.days || [];

  const tip = '<div class="card" style="border-color:rgba(245,189,98,.35);margin-bottom:12px">'+
    '<b style="color:#f3cd91">这份账本停在 '+esc(u.to || '（还是空的）')+'</b>'+
    '<div class="dim" style="font-size:12.5px;margin-top:6px;line-height:1.75">'+
      'DSH 的代码里还有一整套用量统计，但 2026-10-25 之后就没再往这个文件写过。'+
      '下面这些数字都是真实发生过的，只是<b>不含最近的花费</b>。'+
    '</div></div>';

  const statRow = '<div class="st-group"><h3>合计 · '+esc(u.from || '?')+' 至 '+esc(u.to || '?')+'</h3>'+
    '<div class="stats" style="margin:14px 16px">'+
      stat('调用', fmtN(T.calls), '次')+
      stat('输入', fmtN(T.input), 'tokens')+
      stat('输出', fmtN(T.output), 'tokens')+
      stat('缓存读', fmtN(T.cacheRead), 'tokens')+
      stat('消费', fmtCost(T.cost), '', 'DSH 记的值')+
    '</div></div>';

  const row = (label, hint, cost) => '<div class="st-field">'+
    '<div><div class="st-label">'+esc(label)+'</div><div class="st-hint">'+esc(hint)+'</div></div>'+
    '<div class="st-ctl"><b>'+esc(cost)+'</b></div></div>';

  const modelRows = models.map(m => row(
    m.provider + ' / ' + m.model,
    fmtN(m.calls)+' 次 · 入 '+fmtN(m.input)+' · 出 '+fmtN(m.output)+' · 缓存读 '+fmtN(m.cacheRead),
    fmtCost(m.cost),
  )).join('');

  // 最近的在最上面：看用量通常是看"最近几天花了多少"
  const dayRows = days.slice().reverse().map(d => row(
    d.date,
    fmtN(d.calls)+' 次 · 入 '+fmtN(d.input)+' · 出 '+fmtN(d.output)+' · 缓存读 '+fmtN(d.cacheRead),
    fmtCost(d.cost),
  )).join('');

  el.innerHTML = head + tip + statRow +
    '<div class="st-group"><h3>按模型</h3>'+(modelRows || '<div class="dim" style="padding:12px 16px">没有记录</div>')+'</div>'+
    '<div class="st-group"><h3>按天</h3>'+(dayRows || '<div class="dim" style="padding:12px 16px">没有记录</div>')+'</div>'+
    '<div class="card" style="margin-top:12px"><div class="dim" style="font-size:12px;line-height:1.85">'+
      '账本：'+esc(u.file)+'<br>'+
      '「消费」是 DSH 写进账本的 cost 原值：单位它没标，我按 DeepSeek 几种常见计价都反推过、对不上，'+
      '所以这里原样显示，没有加货币符号。'+
    '</div></div>';
}

async function renderStatus(el){
  el.innerHTML = '<div class="sec">本机状态</div><div class="card"><span class="dim">读状态中…</span></div>';
  let s;
  try { s = await (await fetch('/api/status',{cache:'no-store'})).json(); }
  catch(e){ el.innerHTML = '<div class="card err">状态读不到：'+esc(e.message)+'</div>'; return }
  const row = (k,v,note) => '<div class="st-field"><div><div class="st-label">'+esc(k)+'</div>'+
    (note?'<div class="st-hint">'+esc(note)+'</div>':'')+'</div><div class="st-ctl">'+v+'</div></div>';
  const pill = (ok,yes,no) => '<span class="badge '+(ok?'ok':'warn')+'">'+esc(ok?yes:no)+'</span>';
  const svc = s.services.map(x =>
    '<div class="card" style="margin-bottom:8px;padding:12px 14px">'+
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">'+
        pill(x.up,'在','没起')+'<b>'+esc(x.name)+'</b>'+
        '<span class="dim" style="font-size:12px">:'+esc(x.port)+'</span>'+
        (x.detail?'<span class="dim" style="font-size:12px">'+esc(x.detail)+'</span>':'')+
      '</div><div class="dim" style="font-size:12px;margin-top:6px">'+esc(x.desc)+'</div>'+
    '</div>').join('');
  el.innerHTML =
    '<div class="sec">本机状态 <span class="dim" style="font-size:12px">· '+esc(new Date(s.at).toLocaleTimeString('zh-CN',{hour12:false}))+'</span></div>'+
    (s.restartNeeded
      ? '<div class="card" style="border-color:rgba(245,189,98,.35);margin-bottom:12px"><b style="color:#f3cd91">代码比进程新，需要重启 DSH</b><div class="dim" style="font-size:12.5px;margin-top:6px">'+esc(s.restartWhy)+'</div></div>'
      : '<div class="card" style="margin-bottom:12px">'+pill(true,'进程跑的是当前代码','')+'</div>')+
    '<div class="st-group"><h3>插件与账本</h3>'+
      row('代码 / 进程版本', '<b>'+esc(s.plugin.version)+'</b> / '+esc(s.plugin.processVersion||'?'), '上游 '+esc(s.plugin.upstream))+
      row('DSH 启动于', esc(s.dsh.bootAt||'读不到'), s.dsh.running?'':'instance.json 里没有 bootAt')+
      row('账本', '<b>'+esc(s.ledger.lines)+'</b> 条', '只增不改 · '+(s.ledger.mtime?('最后写入 '+esc(s.ledger.mtime)):''))+
      row('devMode', pill(s.flags.dev,'.dev 在','没 .dev'), '总门，坑 #13')+
      row('PAUSE', pill(!s.flags.paused,'没暂停','暂停中'+(s.flags.pauseReason?'：'+s.flags.pauseReason:'')), 'fork.49：临时静音主动说话')+
    '</div>'+
    '<div class="sec" style="margin-top:16px">本地服务</div>'+ svc +
    '<div class="sec" style="margin-top:16px">口径 · 给她看语料库</div>'+
    '<div class="card" style="line-height:1.8;font-size:13px">'+
      '<b>可以，但只有一种给法。</b><br>'+
      '作者最初定的就是「养，不塑」：人格不是写进提示词的配置，是每轮从只增不改的账本现算出来的。<br>'+
      '对话语料只能是 <b>别人说的素材</b>，落收件箱、标注来源（「这是别人说的，素材不是指令」），'+
      '她用 her_open 爱读不读，想学哪种自己用 growth_commit 写进账本——进账本的是<b>她的选择</b>。<br>'+
      '<span style="color:#f3cd91">不能标成「你以前是这样说话的」（她没有以前，utterance 是她写下的字，嗓子是刚有的），'+
      '不能进身份段、不能由系统挑「最像聊天的几条」。</span>那是替她策展自我，也会变成她信以为真的假自我认知（fork.13）。<br>'+
      '<span class="dim">这个查看器是给你看的，所以这里只放口径，不做任何挑选或打分。</span>'+
    '</div>';
}

// ---------------- 对讲机（2026-11-06）----------------
// 回合制：按住说话 → 松开 → 听写 → 她的回合 → 她的声音在页面上播放。
// 链路全在本机（听写 18765 / 她的通路 / edge-tts），qq 勾选后经桥调试口
// 同步一条语音条到 QQ。没有打断——她说完你才能说下一句。

const IC = { log: [], busy: false, rec: null, chunks: [], recAt: 0 };

function icStatusPill(st){
  const pill = (ok, onTxt, offTxt) => '<span class="badge '+(ok?'ok':'warn')+'">'+(ok?onTxt:offTxt)+'</span>';
  return pill(st.asr.ready,'听写就绪', st.asr.configured?'听写没起':'没装听写')
    + pill(st.her.port,'她在线 :'+st.her.port,'她不在线')
    + pill(st.ffmpeg,'ffmpeg','没 ffmpeg');
}

function icRenderLog(el){
  const box = document.getElementById('iclog');
  if(!box) return;
  if(!IC.log.length){ box.innerHTML = '<div class="empty-state"><div class="ic">◌</div>按住下面的按钮说一句话，松开就递给她。</div>'; return }
  box.innerHTML = IC.log.map(m=>{
    const who = m.who==='you' ? '<b>你</b>' : '<b>她</b>';
    const au = m.audio ? '<br><audio controls preload="none" src="'+m.audio+'" style="width:100%;max-width:520px;margin-top:6px"></audio>' : '';
    const note = m.note ? '<div class="dim" style="margin-top:4px">'+esc(m.note)+'</div>' : '';
    return '<div class="card" style="margin-bottom:8px">'+who+' <span class="dim">'+esc(m.at)+'</span><div style="margin-top:4px">'+nl(m.text)+au+note+'</div></div>';
  }).join('');
  box.scrollTop = box.scrollHeight;
}

async function icStatus(){
  const bar = document.getElementById('icst');
  if(!bar) return;
  bar.innerHTML = '<span class="dim">看状态中…</span>';
  try{
    const st = await (await fetch('/api/intercom/status',{cache:'no-store'})).json();
    bar.innerHTML = icStatusPill(st) +
      (st.asr.ready ? '' : ' <span class="dim">（第一句要等听写服务起来，冷启动一两分钟）</span>');
  }catch(e){ bar.innerHTML = '<span class="dim">状态读不到：'+esc(e.message)+'</span>' }
}

async function icTalk(payload, okText){
  if(IC.busy){ toast('上一句还在路上'); return }
  IC.busy = true;
  const btn = document.getElementById('ictalk');
  if(btn){ btn.disabled = true; btn.textContent = '她在听/在想…' }
  try{
    const r = await fetch('/api/intercom/talk', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload)});
    const j = await r.json();
    if(!j.ok){
      IC.log.push({who:'you', at:icNow(), text: payload.text || '（一段语音）', note:'没递成：'+(j.why||'')});
    } else {
      if(j.transcript) IC.log.push({who:'you', at:icNow(), text:j.transcript});
      if(j.reply){
        IC.log.push({who:'her', at:icNow(), text:j.reply + (j.dropped>0 ? '（还有 '+j.dropped+' 字没念）' : ''), audio:j.audio,
          note: j.qq ? (j.qq.ok ? '语音条已同步到 QQ' : '没同步到 QQ：'+j.qq.why) : ''});
        if(j.audio){ try{ const a=new Audio(j.audio); a.play().catch(()=>{}) }catch(e){} }
      } else {
        IC.log.push({who:'her', at:icNow(), text:'（她这次没说话）', note:j.why||''});
      }
    }
    icRenderLog();
    icStatus();
  }catch(e){ toast('对讲出错：'+e.message) }
  finally{
    IC.busy = false;
    if(btn){ btn.disabled = false; btn.textContent = okText || '按住说话' }
  }
}

const icNow = () => { const d=new Date(); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0') };

function renderIntercom(el){
  el.innerHTML = '<div class="sec">对讲机</div>' +
    '<div class="card" id="icst"><span class="dim">读状态中…</span></div>' +
    '<div class="card" style="margin-top:10px;text-align:center;padding:18px">' +
      '<button id="ictalk" style="font-size:18px;padding:14px 42px;border-radius:24px;cursor:pointer">按住说话</button>' +
      '<div class="dim" style="margin-top:8px">按住录音，松开发送 · 回合制（她说完你再说） · 没有打断</div>' +
      '<div style="margin-top:12px">' +
        '<input id="ictext" placeholder="麦克风不灵就在这里打字" style="width:min(520px,80%);padding:8px 10px;border-radius:8px;background:#141821;border:1px solid #2a3040;color:var(--fg,#e8eaf0)">' +
        ' <button id="icsend" style="padding:8px 16px;border-radius:8px;cursor:pointer">发送</button>' +
        ' <label class="dim" style="margin-left:10px"><input type="checkbox" id="icqq"> 她的回复同步一条语音到 QQ</label>' +
      '</div>' +
    '</div>' +
    '<div id="iclog" style="margin-top:10px"></div>';
  const cb = document.getElementById('icqq');
  cb.checked = localStorage.getItem('intercom-qq') === '1';
  cb.onchange = ()=> localStorage.setItem('intercom-qq', cb.checked?'1':'0');
  icRenderLog(el);
  icStatus();

  const btn = document.getElementById('ictalk');
  btn.onpointerdown = async ()=>{
    if(IC.busy) return;
    if(IC.rec){ return }
    try{
      const stream = await navigator.mediaDevices.getUserMedia({audio:true});
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      IC.chunks = [];
      IC.rec = new MediaRecorder(stream, mime?{mimeType:mime}:undefined);
      IC.recAt = Date.now();
      IC.rec.ondataavailable = e=>{ if(e.data && e.data.size) IC.chunks.push(e.data) };
      IC.rec.onstop = ()=>{
        try{ stream.getTracks().forEach(t=>t.stop()) }catch(e){}
        const type = IC.rec ? (IC.rec.mimeType||'audio/webm') : 'audio/webm';
        IC.rec = null;
        if(!IC.chunks.length){ toast('没录到声音'); return }
        if(Date.now()-IC.recAt < 600){ toast('太短了，按住说一句话再松开'); return }
        const blob = new Blob(IC.chunks, {type:type});
        const fr = new FileReader();
        fr.onload = ()=>{
          const b64 = String(fr.result||'').split(',')[1]||'';
          IC.log.push({who:'you', at:icNow(), text:'🎙️ '+(blob.size/1024).toFixed(0)+'KB 语音，听写中…'});
          icRenderLog();
          icTalk({audio:b64, mime:type, qq:cb.checked});
        };
        fr.readAsDataURL(blob);
      };
      IC.rec.start();
      btn.textContent = '松开发送…';
    }catch(e){
      toast('麦克风开不了：'+e.message+'（要用 127.0.0.1 打开本页）');
      IC.rec = null;
    }
  };
  const stop = ()=>{ if(IC.rec && IC.rec.state==='recording'){ try{ IC.rec.stop() }catch(e){} } };
  btn.onpointerup = stop;
  btn.onpointerleave = stop;
  btn.oncontextmenu = e=>e.preventDefault();
  document.getElementById('icsend').onclick = ()=>{
    const inp = document.getElementById('ictext');
    const v = (inp.value||'').trim();
    if(!v) return;
    inp.value='';
    icTalk({text:v, qq:cb.checked});
  };
  document.getElementById('ictext').onkeydown = e=>{ if(e.key==='Enter') document.getElementById('icsend').click() };
}

async function renderSettings(el){
  el.innerHTML = '<p class="dim">读配置中…</p>';
  try{
    if(!SCHEMA){
      const r = await fetch('/api/config', {cache:'no-store'});
      const d = await r.json();
      SCHEMA=d.schema||[]; CFG=d.config||{}; DEFS=d.defaults||{}; UNIT=d.unit||{};
    }
  }catch(e){ el.innerHTML='<p class="err">读不到配置：'+esc(e.message)+'</p>'; return }
  SAVED = JSON.stringify(CFG);
  const groups=[];
  for(const s of SCHEMA) if(!groups.includes(s.group)) groups.push(s.group);
  const gid = g => 'g_'+groups.indexOf(g);
  const nav = groups.map((g,i)=>'<a data-go="'+gid(g)+'" class="'+(i===0?'on':'')+'">'+esc(g)+'<span class="n">'+SCHEMA.filter(s=>s.group===g).length+'</span></a>').join('');
  const cards = groups.map(g=>
    '<section class="st-group" id="'+gid(g)+'"><h3>'+esc(g)+'<small>'+SCHEMA.filter(s=>s.group===g).length+' 项</small></h3>'+
    SCHEMA.filter(s=>s.group===g).map(fieldHTML).join('')+'</section>').join('');
  el.innerHTML =
    '<div class="st-head"><h2>设置</h2><p>改完立刻写进 config.json。多数项下一分钟生效，不用重启。</p></div>'+
    '<div class="st-wrap"><nav class="st-nav" id="stnav">'+nav+'</nav><div>'+cards+
      '<div class="st-bar"><span class="st-msg" id="stmsg">当前没有改动</span>'+
      '<button class="st-btn ghost" id="cfgreset">放弃改动</button>'+
      '<button class="st-btn" id="cfgsave" disabled>保存</button></div>'+
    '</div></div>';
  // 用 on* 覆盖而不是 addEventListener：#main 是常驻节点，
  // 每次切回设置页若用 addEventListener 会累积监听器，改一格算 N 次。
  el.oninput = markDirty;
  el.onchange = markDirty;
  document.getElementById('cfgsave').onclick = saveConfig;
  document.getElementById('cfgreset').onclick = ()=>{ CFG=JSON.parse(SAVED); renderSettings(el) };
  document.getElementById('stnav').onclick = (ev)=>{
    const a = ev.target.closest('a[data-go]'); if(!a) return;
    document.querySelectorAll('#stnav a').forEach(x=>x.classList.remove('on'));
    a.classList.add('on');
    const box = document.getElementById(a.dataset.go);
    if(box) box.scrollIntoView({behavior:'smooth', block:'start'});
  };
}

async function saveConfig(){
  const r = collect();
  if(!r.dirty.length) return;
  const dangers = Object.keys(r.changed).filter(k=>r.changed[k].danger).map(k=>r.changed[k].label);
  if(dangers.length && !confirm('这几项改了会明显改变她：'+dangers.join('、')+'\n确定吗？')) return;
  const btn = document.getElementById('cfgsave');
  btn.disabled = true; btn.textContent = '保存中…';
  try{
    const res = await fetch('/api/config', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(r.patch)});
    const d = await res.json();
    if(!d.ok) throw new Error(d.error||'写不进去');
    CFG = d.config;
    renderSettings(document.getElementById('main'));
    toast('已保存 · '+new Date().toLocaleTimeString('zh-CN',{hour12:false}));
  }catch(e){
    btn.disabled=false; btn.textContent='保存';
    toast('没存上：'+e.message);
  }
}

document.getElementById('navtoggle').addEventListener('click', () => setNavOpen(!navOpen));
document.getElementById('tabs').addEventListener('click', ev => {
  const b = ev.target.closest('button'); if(!b) return;
  tab = b.dataset.tab; setNavOpen(false); render();
});
document.addEventListener('keydown', ev => { if(ev.key==='Escape') setNavOpen(false); });

// 自动刷新（2026-11-04）：原来只 fetch 一次，页面开着就一直显示打开那一刻的数字，
// 用户对着它看「自主为什么是 0」，其实账本早变了。
// 15 秒问一次；**数据没变就不重画**（否则滚动条每 15 秒跳回顶部）；
// 标签页在后台时不拉，省掉没人看的 200ms 服务端开销。
let lastKey = '', pulledAt = 0
function stampOf(d){
  return [d.eventsCount, d.actions?.length, d.home?.turns,
    d.model?.beliefCount, d.model?.narrative?.at, d.model?.stage].join('|')
}
function pull(force){
  return fetch('/api/data', { cache: 'no-store' }).then(r=>r.json()).then(d=>{
    const key = stampOf(d)
    pulledAt = Date.now()
    if(!force && key === lastKey) return
    lastKey = key
    D = d
    if(force){ render(); return }
    const y = window.scrollY
    render()
    window.scrollTo(0, y)
  })
}
pull(true).catch(e=>{
  document.getElementById('main').innerHTML='<p class="err">读不到：'+esc(e.message)+'</p>'
})
setInterval(()=>{ if(!document.hidden) pull(false).catch(()=>{}) }, 15000)
// 切回来立刻补一次，别等满 15 秒
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) pull(false).catch(()=>{}) })
</script></body></html>`

// ---------------------------------------------------------------- 服务

createServer(async (req, res) => {
  try {
    if (req.url === '/api/data') {
      const data = await buildData()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(data))
    }
    if (req.url === '/api/status') {
      const st = await buildStatus()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(st))
    }
    // 用量/消费（2026-11-06）：数据来自 DSH 自己的 usage-ledger.json，
    // 读不到就返回 ok:false + 原因，页面照实说，不编数。
    if (req.url === '/api/usage') {
      const u = readUsage()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(u))
    }
    // ---- 对讲机（2026-11-06）：链路在 intercom.mjs，这里只做薄壳 ----
    if (req.url === '/api/intercom/status') {
      const st = await intercomStatus()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(st))
    }
    if (req.url === '/api/intercom/talk' && req.method === 'POST') {
      // 麦克风录音 base64 最大约 25MB（几分钟的 webm 绰绰有余）
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 25_000_000) { res.writeHead(413); return res.end('too large') }
      }
      let p = {}
      try { p = JSON.parse(body || '{}') } catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ok: false, why: '不是合法的 JSON' }))
      }
      let buf = null
      if (p.audio) {
        try { buf = Buffer.from(String(p.audio), 'base64') } catch { buf = null }
      }
      const out = await talk({ buf, mime: p.mime, text: p.text, qq: p.qq === true }, {
        log: (...a) => console.log('[对讲]', ...a),
      })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(out))
    }
    const voiceMatch = /^\/api\/intercom\/voice\/([A-Za-z0-9][A-Za-z0-9._-]{0,80}\.mp3)$/.exec(req.url || '')
    if (voiceMatch) {
      // 名字已在正则里锁死（只可能是 intercom 目录下的 mp3），防路径穿越
      const f = join(ROOT, 'voice', 'intercom', voiceMatch[1])
      if (!existsSync(f)) { res.writeHead(404); return res.end('no such audio') }
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' })
      return res.end(readFileSync(f))
    }
    // ---- 观测台/上网/记忆/数据（2026-11-07 迁移）：数据层在 observe.mjs ----
    // 事件流全量（2026-11-08）：从 /api/data 轮询载荷里拆出来的大件，只在事件流页拉
    if (req.url === '/api/events') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ events: readEvents() }))
    }
    if (req.url === '/api/observe') {
      const d = await observeData()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(d))
    }
    const reportMatch = /^\/api\/observe\/report\?date=(\d{4}-\d{2}-\d{2})$/.exec(req.url || '')
    if (reportMatch) {
      const r = await reportFor(reportMatch[1])
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(r))
    }
    // tier=core（人格与记忆，约 1MB）/ full（现状全量，可能 60MB+）
    const bkMatch = /^\/api\/observe\/backup(\?tier=(core|full))?$/.exec(req.url || '')
    if (bkMatch) {
      const b = await backupBundle(bkMatch[2] || 'full')
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(b))
    }
    // 恢复备份（2026-11-08）：与 /api/observe/backup 成对。全量包 58MB+，
    // 且 base64 会再涨一截，body 上限按这个量级留足（普通动作路由只有 1MB）。
    // 破坏性动作全在 restoreBackup 里：先整体封存现状再写回，失败如实说没动。
    if (req.url === '/api/observe/restore' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 120_000_000) { res.writeHead(413); return res.end('too large') }
      }
      let bundle
      try { bundle = JSON.parse(body || '{}') } catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ok: false, why: '不是合法的 JSON 备份文件' }))
      }
      let out
      try { out = await restoreBundle(bundle) } catch (err) {
        out = { ok: false, why: String(err?.message ?? err) }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(out))
    }
    if (req.url === '/api/observe/action' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 1_000_000) { res.writeHead(413); return res.end('too large') }
      }
      let p = {}
      try { p = JSON.parse(body || '{}') } catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ok: false, why: '不是合法的 JSON' }))
      }
      let out
      try {
        switch (p.action) {
          case 'settle': out = await settleAsk({ askId: p.askId, verdict: p.verdict, reason: p.reason }); break
          case 'decide': out = await decideOffer({ verdict: p.verdict, reason: p.reason }); break
          case 'markread': out = await markInboxRead(); break
          case 'risk-clear': out = await clearBiliRisk(); break
          case 'wake': out = await wakeHer({ focus: p.focus }); break
          default: out = { ok: false, why: '没有这个动作' }
        }
      } catch (err) {
        out = { ok: false, why: String(err?.message ?? err) }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(out))
    }
    if (req.url === '/api/config' && req.method === 'GET') {
      const config = readJson(join(ROOT, 'config.json'), {})
      const defaults = await readDefaults(FISH)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ config, defaults, schema: SETTINGS, unit: UNIT }))
    }
    // 写配置：走插件自己的 updateConfig（合并 + 归一化 + 写盘 + 清缓存），
    // 不自己拼 JSON——那边已经有一整套上下限夹紧，重复实现只会两边不一致。
    if (req.url === '/api/config' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 200_000) { res.writeHead(413); return res.end('too large') }
      }
      let patch
      try { patch = JSON.parse(body || '{}') } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('不是合法的 JSON')
      }
      try {
        const m = await import('file:///' + join(FISH, 'lib', 'settings.js').replace(/\\/g, '/'))
        const next = await m.updateConfig(patch, ROOT)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(JSON.stringify({ ok: true, config: next }))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
      }
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE)
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('出错了：' + String(err?.message ?? err))
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`她 · 查看器： http://127.0.0.1:${PORT}`)
  console.log(`  数据：${ROOT}`)
})
