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
  :root{--bg:#16181d;--panel:#1e2129;--line:#2c313c;--fg:#e6e8ee;--dim:#8b93a7;--acc:#7fb4ff;--warn:#ffbe5c;--ok:#63d297}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.65 "Microsoft YaHei",system-ui,sans-serif}
  header{position:sticky;top:0;background:rgba(22,24,29,.94);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:12px 20px;z-index:9}
  h1{font-size:15px;margin:0 0 8px;font-weight:600;letter-spacing:.5px}
  .tabs{display:flex;gap:6px;flex-wrap:wrap}
  .tabs button{background:var(--panel);border:1px solid var(--line);color:var(--dim);padding:5px 12px;border-radius:6px;cursor:pointer;font-size:13px}
  .tabs button.on{color:var(--fg);border-color:var(--acc);background:#1c2634}
  main{padding:18px 20px 60px;max-width:1000px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:12px}
  .row{display:flex;gap:14px;flex-wrap:wrap}
  .kv{min-width:130px}
  .k{color:var(--dim);font-size:12px}
  .v{font-size:18px;font-weight:600}
  .item{border-left:2px solid var(--line);padding:2px 0 2px 12px;margin:10px 0}
  .item .meta{color:var(--dim);font-size:12px;margin-bottom:2px}
  .item.said{border-color:var(--acc)}
  .item.mine{border-color:#7a6cff}
  .item.act{border-color:var(--ok)}
  code{background:#11131a;padding:1px 5px;border-radius:4px;font-size:12px;color:var(--warn)}
  pre{background:#11131a;border:1px solid var(--line);border-radius:6px;padding:8px;overflow:auto;font-size:12px;color:#b9c0d4;margin:6px 0 0}
  .dim{color:var(--dim)}
  .err{color:#ff8f8f}
</style></head><body>
<header>
  <h1>她 · 查看器 <span class="dim" id="sub"></span></h1>
  <div class="tabs" id="tabs"></div>
</header>
<main id="main"><p class="dim">读数据中…</p></main>
<script>
let D = null, tab = 'profile';
const TABS = [['profile','人格数据'],['said','她说的话'],['mine','你说的话'],['acts','她做过的事'],['events','事件流'],['settings','设置']];
const esc = s => String(s??'').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const t = ms => { if(!ms) return ''; const d=new Date(ms); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };

function render(){
  document.getElementById('tabs').innerHTML = TABS.map(([k,n])=>
    '<button data-tab="'+k+'" class="'+(k===tab?'on':'')+'">'+n+'</button>').join('');
  const m = D.model || {};
  const el = document.getElementById('main');
  if(tab==='settings'){ renderSettings(el); return }
  if(tab==='profile'){
    if(m.__error) el.innerHTML = '<p class="err">取模型失败：'+esc(m.__error)+'</p>';
    else {
      const needs = m.needs || {};
      el.innerHTML =
        '<div class="card"><div class="row">'+
          '<div class="kv"><div class="k">第几天</div><div class="v">'+m.day+'</div></div>'+
          '<div class="kv"><div class="k">阶段</div><div class="v">'+m.stage+' · '+esc(m.stageName||'')+'</div></div>'+
          '<div class="kv"><div class="k">判断</div><div class="v">'+(m.beliefs||[]).length+'</div></div>'+
          '<div class="kv"><div class="k">拒绝</div><div class="v">'+
            (m.facts?.refused ?? (m.refusals||[]).length)+
            ((m.facts?.wont??0)>0 ? '<span class="dim" style="font-size:11px"> 口头'+(m.facts.wont)+'</span>' : '')+
          '</div></div>'+
          '<div class="kv"><div class="k">改口</div><div class="v">'+(m.corrected||0)+'</div></div>'+
          '<div class="kv"><div class="k">会话轮数</div><div class="v">'+(D.home.turns??0)+'</div></div>'+
        '</div></div>'+
        '<div class="card"><div class="k">三种需要（还没长出来的就是 0）</div><div class="row" style="margin-top:6px">'+
          '<div class="kv"><div class="k">自主</div><div class="v">'+(needs.autonomy??0)+'</div></div>'+
          '<div class="kv"><div class="k">胜任</div><div class="v">'+(needs.competence??0)+'</div></div>'+
          '<div class="kv"><div class="k">关联</div><div class="v">'+(needs.relatedness??0)+'</div></div>'+
          '<div class="kv"><div class="k">阶段门</div><div class="v" style="font-size:13px">'+
            ((m.stageGate&&m.stageGate.pending)
              ? '待 '+esc(m.stageGate.pending)
              : '全过 '+((m.stageGate&&m.stageGate.passed||[]).length)+'/3')+
          '</div></div>'+
        '<div class="card"><div class="k">她对自己的说法（narrative）</div><div style="margin-top:6px">'+
          esc((m.narrative&&m.narrative.text)||'（还没有）')+'</div></div>'+
        '<div class="card"><div class="k">她的判断（'+ (m.beliefs||[]).length +' 条，只增不改）</div>'+
          (m.beliefs||[]).map((b,i)=>'<div class="item said"><div class="meta">#'+(i+1)+'</div>'+esc(b.text||'')+'</div>').join('')+
        '</div>';
    }
  }
  if(tab==='said'){
    el.innerHTML = (D.spoken.slice().reverse()).map(s=>
      '<div class="item said"><div class="meta">turn '+s.turn+' · '+t(s.at)+'</div>'+esc(s.text).replace(/\n/g,'<br>')+'</div>').join('') || '<p class="dim">这条会话里她还没说过话</p>';
  }
  if(tab==='mine'){
    el.innerHTML = (D.userSaid.slice().reverse()).map(s=>
      '<div class="item mine"><div class="meta">'+t(s.at)+'</div>'+esc(s.text).replace(/\n/g,'<br>')+'</div>').join('') || '<p class="dim">还没有</p>';
  }
  if(tab==='acts'){
    el.innerHTML = '<p class="dim" style="margin-top:0">这是她在当前会话里**实际调用过的工具**（参数与结果都来自会话日志）。</p>'+
      (D.actions.slice().reverse()).map(a=>
      '<div class="item act"><div class="meta">'+t(a.at)+' · turn '+a.turn+'.'+a.step+' · <code>'+esc(a.name)+'</code></div>'+
      '<pre>'+esc(a.args).slice(0,800)+'</pre>'+
      (a.result?'<pre style="color:#8fbf9f">'+esc(a.result).slice(0,600)+'</pre>':'')+'</div>').join('');
  }
  if(tab==='events'){
    el.innerHTML = (D.events.slice().reverse()).map(e=>
      '<div class="item"><div class="meta">'+esc(e.ts||'')+' · '+esc(e.type)+' · day '+e.day+' · '+esc(e.source)+'</div>'+
      esc(String(e.text||'').slice(0,400)).replace(/\n/g,'<br>')+'</div>').join('');
  }
  document.getElementById('sub').textContent = '第'+m.day+'天 · '+D.actions.length+' 次工具调用 · '+D.events.length+' 条事件'
    + (pulledAt ? ' · 更新于 '+new Date(pulledAt).toLocaleTimeString('zh-CN',{hour12:false}) : '')
}


// ---------------- 设置页（2026-11-04）----------------
// 说明：这段跑在模板字符串里，所以不能写美元花括号插值，
// 全部用字符串拼接。schema 从后端 /api/config 拿，这里只管渲染和提交。
let SCHEMA=null, CFG=null, DEFS=null;
const fid = k => 'f_'+k.replace(/[^a-zA-Z0-9]/g,'_');
const getIn = (o,p) => p.split('.').reduce((a,k)=>(a==null?undefined:a[k]),o);
const setIn = (o,p,v) => { const ks=p.split('.'); const last=ks.pop(); let t=o; for(const k of ks){ if(!t[k]) t[k]={}; t=t[k] } t[last]=v };

function fieldHTML(s){
  const cur = getIn(CFG, s.key);
  const dflt = getIn(DEFS, s.key);
  const id = fid(s.key);
  const label = '<div class="k">'+esc(s.label)+(s.danger?' <span style="color:#e07979">· 危险</span>':'')+'</div>';
  const hint = s.hint ? '<div class="dim" style="font-size:11px;margin-top:2px">'+esc(s.hint)+'</div>' : '';
  let inp = '';
  if(s.kind==='bool'){
    inp = '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="'+id+'"'+(cur?' checked':'')+'> <span>'+(cur?'开着':'关着')+'</span></label>';
  } else if(s.kind==='window'){
    const a=(cur&&cur[0])||'', b=(cur&&cur[1])||'';
    inp = '<div style="display:flex;gap:6px;align-items:center">'+
          '<input type="time" id="'+id+'_0" value="'+a+'" style="width:110px">'+
          '<span class="dim">到</span>'+
          '<input type="time" id="'+id+'_1" value="'+b+'" style="width:110px"></div>';
  } else if(s.kind==='list'){
    inp = '<input id="'+id+'" value="'+esc((cur||[]).join('，'))+'" style="width:100%">';
  } else {
    inp = '<input type="number" id="'+id+'" value="'+(cur==null?'':cur)+'"'+
          (s.min!=null?' min="'+s.min+'"':'')+(s.max!=null?' max="'+s.max+'"':'')+
          (s.step!=null?' step="'+s.step+'"':'')+' style="width:110px">';
  }
  const d = (dflt!=null && String(dflt)!==String(cur)) ? ' <span class="dim" style="font-size:11px">默认 '+esc(JSON.stringify(dflt))+'</span>' : '';
  return '<div style="padding:8px 0;border-bottom:1px solid var(--line)">'+label+inp+d+hint+'</div>';
}

async function renderSettings(el){
  el.innerHTML = '<p class="dim">读配置中…</p>';
  try{
    if(!SCHEMA){
      const r = await fetch('/api/config', {cache:'no-store'});
      const d = await r.json();
      SCHEMA = d.schema || []; CFG = d.config || {}; DEFS = d.defaults || {};
    }
  }catch(e){
    el.innerHTML = '<p class="err">读不到配置：'+esc(e.message)+'</p>'; return;
  }
  const groups = [];
  for(const s of SCHEMA) if(!groups.includes(s.group)) groups.push(s.group);
  const openFirst = ['成长节奏','她主动说话'];
  el.innerHTML = groups.map(g=>{
    const rows = SCHEMA.filter(s=>s.group===g).map(fieldHTML).join('');
    return '<details class="card"'+(openFirst.includes(g)?' open':'')+'><summary style="cursor:pointer;font-weight:600">'+esc(g)+
           ' <span class="dim" style="font-weight:400;font-size:12px">'+SCHEMA.filter(s=>s.group===g).length+' 项</span></summary>'+
           '<div style="margin-top:6px">'+rows+'</div></details>';
  }).join('') +
  '<div style="margin:14px 0;display:flex;gap:10px;align-items:center">'+
    '<button id="cfgsave" style="padding:7px 18px">保存</button>'+
    '<span id="cfgtip" class="dim"></span></div>'+
  '<p class="dim" style="font-size:12px">改完立刻写进 config.json。多数项下一分钟就生效；'+
  '「她醒着的时间」「成长天数」这类要等她下一次醒来才对得上。</p>';
  document.getElementById('cfgsave').onclick = saveConfig;
}

async function saveConfig(){
  const tip = document.getElementById('cfgtip');
  const patch = {};
  const dangers = [];
  for(const s of SCHEMA){
    const id = fid(s.key);
    let v;
    if(s.kind==='bool'){
      const cb = document.getElementById(id); if(!cb) continue; v = cb.checked;
    } else if(s.kind==='window'){
      const a = document.getElementById(id+'_0'), b = document.getElementById(id+'_1');
      if(!a||!b) continue; v = [a.value, b.value]; if(!v[0]||!v[1]) continue;
    } else if(s.kind==='list'){
      const inp = document.getElementById(id); if(!inp) continue;
      v = inp.value.split(/[，,]/).map(x=>x.trim()).filter(Boolean);
    } else {
      const inp = document.getElementById(id); if(!inp) continue;
      v = Number(inp.value); if(!Number.isFinite(v)) continue;
    }
    if(s.danger && v !== getIn(DEFS, s.key)) dangers.push(s.label);
    setIn(patch, s.key, v);
  }
  if(dangers.length){
    if(!confirm('这几项改了会明显改变她：'+dangers.join('、')+'\n确定吗？')) return;
  }
  tip.textContent = '保存中…';
  try{
    const r = await fetch('/api/config', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(patch)});
    const d = await r.json();
    if(!d.ok) throw new Error(d.error||'写不进去');
    CFG = d.config;
    tip.textContent = '已保存 · '+new Date().toLocaleTimeString('zh-CN',{hour12:false});
  }catch(e){
    tip.textContent = '没存上：'+e.message;
    tip.className = 'err';
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
