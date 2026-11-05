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
import { intercomStatus, talk } from './intercom.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FISH = join(HERE, '..', 'dsh-fish')
const ROOT = 'C:/Users/<用户名>/.dsh-fish'
const DSH_SESSIONS = 'C:/Users/<用户名>/.dsh/sessions/--C-Users-<用户名>-.dsh-fish-home--'
const PORT = 7788

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
function readSessionLog(sessionId) {
  if (!sessionId) return []
  const f = join(DSH_SESSIONS, sessionId, 'session.v4.jsonl.zstd')
  if (!existsSync(f)) return []
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
  return text
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
 * 设置页的字段清单（2026-11-04，用户要求「能改的都放进查看器」）。
 *
 * 只描述「怎么显示、怎么校验」，不复制默认值——默认值从插件的 DEFAULTS 现读，
 * 免得两边各写一份、哪天对不上。
 *
 * kind：
 *   num    数字（min/max/step）
 *   bool   开关
 *   window 两个 HH:MM
 *   list   逗号分隔的字符串数组
 * danger=true 的项，改了会明显改变她的世界，前端会多问一句。
 */
const SETTINGS = [
  { group: '成长节奏', key: 'growthDays', label: '成长天数', kind: 'num', min: 7, max: 180, step: 1, hint: '走完四个阶段用多少天' },
  { group: '成长节奏', key: 'wakesPerDay', label: '每天醒来几次', kind: 'num', min: 0, max: 4, step: 1, hint: '0 = 只在你找她的时候才在' },
  { group: '成长节奏', key: 'window', label: '她醒着的时间', kind: 'window', hint: '之外不叫她、不主动说话' },

  { group: '每日配额', key: 'daily.events', label: '每天推几条成长事件', kind: 'num', min: 0, max: 10, step: 1 },
  { group: '每日配额', key: 'daily.questions', label: '其中她向你提问几条', kind: 'num', min: 0, max: 5, step: 1, hint: '防退化成问答机器' },

  { group: '她主动说话', key: 'proactive.enabled', label: '开着', kind: 'bool', hint: '关掉她就只在被叫醒时才能开口' },
  { group: '她主动说话', key: 'proactive.maxPerDay', label: '一天最多开几次空手回合', kind: 'num', min: 0, max: 20, step: 1 },
  { group: '她主动说话', key: 'proactive.minIdleHours', label: '多久没人说话才够格', kind: 'num', min: 0, max: 48, step: 0.5, hint: '小时' },
  { group: '她主动说话', key: 'proactive.baseChance', label: '每次掷骰的基础概率', kind: 'num', min: 0, max: 1, step: 0.01 },
  { group: '她主动说话', key: 'proactive.gainPerHour', label: '每多等一小时加多少', kind: 'num', min: 0, max: 0.5, step: 0.01 },
  { group: '她主动说话', key: 'proactive.maxChance', label: '概率上限', kind: 'num', min: 0, max: 1, step: 0.01 },
  { group: '她主动说话', key: 'proactive.cooldownHours', label: '两次之间至少隔多久', kind: 'num', min: 0, max: 48, step: 0.5, hint: '小时' },
  { group: '她主动说话', key: 'proactive.rollsPerHour', label: '每小时最多掷几次', kind: 'num', min: 1, max: 12, step: 1, hint: '只决定多叫她几次，说不说仍由她' },

  { group: '日记', key: 'diary.enabled', label: '她每天写日记', kind: 'bool' },
  { group: '日记', key: 'diary.visible', label: '日记给你看', kind: 'bool', hint: '默认关——这是她的本子' },
  { group: '日记', key: 'diary.keepDays', label: '保留多少天', kind: 'num', min: 0, max: 365, step: 1, hint: '0 = 永久' },

  { group: '回忆与遗忘', key: 'recall.oldDays', label: '多久以前的事开始忘', kind: 'num', min: 0, max: 365, step: 1, hint: '天；0 = 不设门槛' },
  { group: '回忆与遗忘', key: 'recall.minCue', label: '要多具体的线索才想得起来', kind: 'num', min: 0, max: 1, step: 0.05, hint: '0 = 什么都翻得到，调大忘得更狠' },
  { group: '回忆与遗忘', key: 'recall.jitter', label: '门槛的「今天状态」浮动', kind: 'num', min: 0, max: 1, step: 0.05, hint: '0 = 完全确定；0.2 = 上下浮 20%' },

  { group: '冷落', key: 'absenceAfterDays', label: '你多久不出现算冷落', kind: 'num', min: 1, max: 30, step: 1, hint: '天' },

  { group: '刷站', key: 'browse.enabled', label: '她能上网', kind: 'bool' },
  { group: '刷站', key: 'browse.perDay', label: '每天刷几次', kind: 'num', min: 0, max: 10, step: 1 },
  { group: '刷站', key: 'browse.topN', label: '一次看几条', kind: 'num', min: 1, max: 10, step: 1 },
  { group: '刷站', key: 'browse.window', label: '什么时候能上网', kind: 'window', hint: '醒着不一定要上网，上网只在醒着时发生' },
  { group: '刷站', key: 'browse.voices', label: '让她读评论区', kind: 'bool', hint: '关掉也能上网，只是她再也读不到别人的说法' },

  { group: '避雷', key: 'avoid.keywords', label: '不想看的关键词', kind: 'list', hint: '逗号分隔' },
  { group: '避雷', key: 'avoid.minDuration', label: '太短的不看（秒）', kind: 'num', min: 0, max: 3600, step: 10 },

  { group: '请求节奏', key: 'bili.minIntervalMs', label: '两次 B 站请求至少间隔', kind: 'num', min: 0, max: 10000, step: 100, hint: '毫秒；机房 IP 要放慢' },
  { group: '请求节奏', key: 'bili.jitterMs', label: '在间隔上再随机多等', kind: 'num', min: 0, max: 5000, step: 100, hint: '毫秒' },

  { group: '高级', key: 'tools.restrict', label: '工具面收窄', kind: 'bool', danger: true, hint: '关掉她会看到全部 37 个工具，会开始做很多她本来不做的事' },
]

/** 按 "a.b" 取/设嵌套值 */
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}
function setPath(obj, path, val) {
  const keys = path.split('.')
  const last = keys.pop()
  const t = keys.reduce((o, k) => (o[k] ?? (o[k] = {})), obj)
  t[last] = val
}

/** 从插件读默认值；读不到就用空对象（页面会显示「读不到默认值」）。 */
async function readDefaults() {
  try {
    const m = await import('file:///' + join(FISH, 'lib', 'settings.js').replace(/\\/g, '/'))
    return m?.DEFAULTS ?? {}
  } catch {
    return {}
  }
}

async function buildData() {
  const events = readEvents()
  const home = readJson(join(ROOT, 'home.json'), {})
  const config = readJson(join(ROOT, 'config.json'), {})

  let model = null
  try {
    const { deriveSelf } = await import('file://' + join(FISH, 'lib', 'derive.js').replace(/\\/g, '/'))
    const { loadConfig } = await import('file://' + join(FISH, 'lib', 'settings.js').replace(/\\/g, '/'))
    const cfg = (await loadConfig(ROOT)).config
    model = deriveSelf(events, { growthDays: cfg.growthDays })
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
    events,
    actions: actionsOf(recs),
    spoken: spokenOf(recs),
    userSaid: userSaidOf(recs),
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
  .tabs{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none}
  .tabs::-webkit-scrollbar{display:none}
  .tabs button{position:relative;background:none;border:0;color:var(--dim);padding:14px 14px 15px;font-size:13.5px;cursor:pointer;white-space:nowrap;transition:color .15s;font-weight:500}
  .tabs button:hover{color:var(--fg)}
  .tabs button.on{color:var(--fg);font-weight:600}
  .tabs button.on:after{content:'';position:absolute;left:14px;right:14px;bottom:0;height:2px;background:linear-gradient(90deg,var(--acc),var(--acc2));border-radius:2px 2px 0 0}
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
  @media(max-width:640px){header{padding:0 14px}.hd{height:auto;flex-wrap:wrap;gap:8px;padding:10px 0}main{padding:18px 14px 90px}.hero{padding:18px}.tabs button{padding:12px 11px 13px}}
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
    <div class="spacer"></div>
    <div class="live"><i></i><span id="sub">读取中</span></div></div>
  <div class="tabs" id="tabs"></div>
</header>
<main id="main"><p class="dim">读数据中…</p></main>
<script>
let D = null, tab = 'profile';
const TABS = [['profile','人格数据'],['said','她说的话'],['mine','你说的话'],['acts','她做过的事'],['events','事件流'],['intercom','对讲机'],['settings','设置']];
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
  document.getElementById('tabs').innerHTML = TABS.map(([k,n])=>
    '<button data-tab="'+k+'" class="'+(k===tab?'on':'')+'">'+n+'</button>').join('');
  const m = D.model || {};
  const el = document.getElementById('main');
  if(tab==='intercom'){ renderIntercom(el); return }
  if(tab==='settings'){ renderSettings(el); return }

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
          '<div class="sub">阶段 '+m.stage+' · '+esc(m.stageName||'')+' &nbsp;·&nbsp; '+D.events.length+' 条事件 &nbsp;·&nbsp; '+D.actions.length+' 次工具调用 &nbsp;·&nbsp; '+(D.home.turns??0)+' 轮会话</div></div>'+
          gate+'</div>'+
          '<div class="stats">'+
            stat('判断', beliefs.length, '条')+
            stat('拒绝', refused, '次', wont?('口头 '+wont+' 次'):'')+
            stat('改口', m.corrected||0, '次')+
            stat('固化', (m.solid||[]).length, '条', '反复想起的')+
            stat('张力', (m.tensions||[]).length, '条')+
            stat('会话轮数', D.home.turns??0, '轮')+
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
    const a = (D.spoken||[]).slice().reverse();
    el.innerHTML = sec('她说的话 · '+a.length+' 条') + (a.length
      ? '<div class="timeline">'+a.map(s=>
          '<div class="tl-item"><div class="tl-meta"><span class="pill said">她</span>'+
          'turn '+esc(s.turn)+' · '+esc(t(s.at))+'</div>'+
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

  if(tab==='events'){
    const a = (D.events||[]).slice().reverse();
    el.innerHTML = sec('事件流 · '+a.length+' 条 · 只增不改') + (a.length
      ? '<div class="timeline">'+a.map(e=>
          '<div class="tl-item ev"><div class="tl-meta"><span class="pill">'+esc(e.type)+'</span>'+
          esc(e.ts||'')+' · day '+esc(e.day)+' · '+esc(e.source)+'</div>'+
          '<div class="bubble">'+nl(String(e.text||'').slice(0,400))+'</div></div>').join('')+'</div>'
      : emptyBox('账本还是空的'));
  }

  document.getElementById('sub').textContent = pulledAt
    ? '更新于 '+new Date(pulledAt).toLocaleTimeString('zh-CN',{hour12:false})
    : '读取中';
}

// ---------------- 设置页（2026-11-04，现代布局）----------------
// 这段跑在模板字符串里，不能写美元花括号插值，全部用字符串拼接。
let SCHEMA=null, CFG=null, DEFS=null, SAVED='{}';
const fid = k => 'f_'+k.replace(/[^a-zA-Z0-9]/g,'_');
const getIn = (o,p) => p.split('.').reduce((a,k)=>(a==null?undefined:a[k]),o);
const setIn = (o,p,v) => { const ks=p.split('.'); const last=ks.pop(); let t=o; for(const k of ks){ if(!t[k]) t[k]={}; t=t[k] } t[last]=v };
const UNIT = {
  'growthDays':'天','wakesPerDay':'次','daily.events':'条','daily.questions':'条',
  'diary.keepDays':'天','recall.oldDays':'天','absenceAfterDays':'天',
  'proactive.maxPerDay':'次','proactive.minIdleHours':'小时','proactive.cooldownHours':'小时',
  'proactive.rollsPerHour':'次','browse.perDay':'次','browse.topN':'条',
  'avoid.minDuration':'秒','bili.minIntervalMs':'ms','bili.jitterMs':'ms'
};

function fieldHTML(s){
  const cur = getIn(CFG, s.key), dflt = getIn(DEFS, s.key);
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
      SCHEMA=d.schema||[]; CFG=d.config||{}; DEFS=d.defaults||{};
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

document.getElementById('tabs').addEventListener('click', ev => {
  const b = ev.target.closest('button'); if(!b) return;
  tab = b.dataset.tab; render();
});

// 自动刷新（2026-11-04）：原来只 fetch 一次，页面开着就一直显示打开那一刻的数字，
// 用户对着它看「自主为什么是 0」，其实账本早变了。
// 15 秒问一次；**数据没变就不重画**（否则滚动条每 15 秒跳回顶部）；
// 标签页在后台时不拉，省掉没人看的 200ms 服务端开销。
let lastKey = '', pulledAt = 0
function stampOf(d){
  return [d.events?.length, d.actions?.length, d.home?.turns,
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
    if (req.url === '/api/config' && req.method === 'GET') {
      const config = readJson(join(ROOT, 'config.json'), {})
      const defaults = await readDefaults()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ config, defaults, schema: SETTINGS }))
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
