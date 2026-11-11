/**
 * formula.js —— her_formula：把一段「文字 + $公式$」排成一页 PNG（2026-11-09）
 *
 * 她要的原话（11-08 ask_owner）：「能不能给我一样能把算式排成图片的东西」。
 * 11-08 先给了白板画笔（her_draw），她用了两天给出的评价是「讲数学题用画图还是难用」——
 * 逐笔构图适合示意图，不适合成段的推导。所以另起一个工具：
 * her_draw 收坐标，her_formula 收**一段稿子**。
 *
 * 引擎：Edge 无头 + MathJax（tex-svg.js 放在 lib/assets/mathjax/，Apache-2.0）。
 *   · 不用 npm 依赖：这个插件「零运行时依赖」是底线（装插件只 link，不跑 npm i）。
 *   · 不用 MiKTeX：200MB+ 安装要人盯着，而她要的多是高中/大一数学，MathJax 完全够。
 *   · 不调在线 API：题目不该发到第三方服务器去。
 *
 * 两趟：① `--dump-dom` 量页面多高（页面脚本把尺寸写进 title）→ ② 按精确尺寸截图。
 * 一趟只能给固定画布，要么四周大白边、要么内容被裁；多花 ~1.3 秒换尺寸正确，值。
 * 固定 `--user-data-dir` 能把每次冷启动从 5 秒压到 1.5 秒（实测 3 次 1.4–1.7s）。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { toJsonSchema } from './toolschema.js'
import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'
import { rootDir } from './store.js'
import { logLine } from './log.js'
import { slashed } from './posix.js'
import { colorOf } from './draw.js'
import { browserPath, browserArgs } from './browser.js'

const runFile = promisify(execFile)

const LIMITS = Object.freeze({
  contentMax: 4000,     // 一段稿子的字数上限（400 字的板书能写两道题）
  sizeMin: 10,
  sizeMax: 48,
  widthMin: 320,
  widthMax: 1600,
  heightMax: 3200,      // 超过就截断并如实告诉她拆两张
  scale: 2,             // 2 倍图：QQ 里放大看才不糊
})

/** MathJax 只有一个文件，随插件走（lib 已在 package.json 的 files 白名单里）。 */
function mathjaxPath() {
  return join(dirname(fileURLToPath(import.meta.url)), 'assets', 'mathjax', 'tex-svg.js')
}

export { browserPath }

/** 浏览器 profile 放她屋里，别每次都冷启动。 */
function profileDir(root) {
  const dir = join(root, 'cache', 'formula-browser')
  mkdirSync(dir, { recursive: true })
  return dir
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * 把一段稿子切成 HTML：`$$…$$` / `$…$` 原样留给 MathJax，其余当文字。
 *
 * 三个要点：
 *   · 文字段的换行变 `<br>`，**公式段不换**——不然 `$$\begin{aligned}…\end{aligned}$$`
 *     写成多行时，中间会被塞进 `<br>`，整段公式散架（第一版就这么踩的）；
 *   · **独占一行的 `$$` 两侧那个换行要吃掉**：MathJax 的块级公式自带上下留白，
 *     再叠一层 `<br>` 就会空出一大块（第一版实测：「求根公式：」和公式之间空了半屏）；
 *   · 全段都做 HTML 转义。MathJax 是从 DOM 的 textContent 读公式的，转义过它照样读得对。
 */
export function buildHtmlBody(content) {
  const src = String(content ?? '').replace(/\r\n/g, '\n')

  // 先切段（文字 / 行内 / 块级），再做边界处理，最后统一转义拼回去
  const parts = []
  const re = /(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$|(?<!\\)\$[^$\n]*?(?<!\\)\$/g
  let last = 0
  for (const m of src.matchAll(re)) {
    if (m.index > last) parts.push({ t: 'text', v: src.slice(last, m.index) })
    parts.push({ t: m[0].startsWith('$$') ? 'display' : 'inline', v: m[0] })
    last = m.index + m[0].length
  }
  if (last < src.length) parts.push({ t: 'text', v: src.slice(last) })

  for (let i = 0; i < parts.length; i++) {
    if (parts[i].t !== 'display') continue
    const prev = parts[i - 1]
    const next = parts[i + 1]
    // 只吃紧邻的那一个换行；她自己空了一行，那行空行留着（那是她的排版意图）
    if (prev?.t === 'text') prev.v = prev.v.replace(/\n[ \t]*$/, '')
    if (next?.t === 'text') next.v = next.v.replace(/^[ \t]*\n/, '')
  }

  const text = (s) => esc(s).replace(/\n/g, '<br>').replace(/\\\$/g, '$')
  return parts.map((p) => (p.t === 'text' ? text(p.v) : esc(p.v))).join('')
}

/** 校验参数。返回 {ok, plan|why}：plan 已经夹紧、可以直接喂给渲染。 */
export function planFormula(args = {}) {
  const content = String(args?.content ?? '').replace(/\r\n/g, '\n').trim()
  if (!content) return { ok: false, why: '内容是空的。把要排的文字和 $公式$ 一起写进来。' }
  if (content.length > LIMITS.contentMax) {
    return { ok: false, why: `这段稿子有 ${content.length} 字，一页最多 ${LIMITS.contentMax} 字——拆成两页。` }
  }
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  return {
    ok: true,
    plan: {
      content,
      size: clamp(num(args?.size, 30), LIMITS.sizeMin, LIMITS.sizeMax),
      width: clamp(num(args?.width, 900), LIMITS.widthMin, LIMITS.widthMax),
      color: colorOf(args?.color, '#1a1a1a'),
    },
  }
}

/** 生成那一页 HTML。pad 是四周留白（CSS px）。 */
export function buildHtml(plan, { mathjax = mathjaxPath(), pad = 28 } = {}) {
  const src = pathToFileURL(mathjax).href
  return `<!doctype html><meta charset="utf-8">
<style>
html,body{margin:0;padding:0;background:#fff;overflow:hidden}
#p{padding:${pad}px;font-size:${plan.size}px;line-height:1.75;color:${plan.color};
   font-family:"Noto Sans CJK SC","Noto Sans CJK","Microsoft YaHei","Segoe UI",sans-serif;width:${plan.width}px;box-sizing:border-box;word-break:break-word}
</style>
<script>
window.MathJax = {
  tex: { inlineMath: [['$','$']], displayMath: [['$$','$$']], packages: { '[+]': ['ams','textmacros'] } },
  svg: { fontCache: 'none' },
  startup: {
    pageReady: function () {
      return MathJax.startup.defaultPageReady().then(function () {
        var r = document.getElementById('p').getBoundingClientRect();
        document.title = Math.ceil(r.width) + 'x' + Math.ceil(r.height);
      });
    }
  }
};
</script>
<script src="${src}"></script>
<div id="p">${buildHtmlBody(plan.content)}</div>
`
}

/**
 * 真渲染：量一次、截一次。返回 {ok:true, w, h, truncated} 或抛错（带人话原因）。
 */
export async function renderFormula(plan, outPath, { root, log = () => {} } = {}) {
  const exe = browserPath()
  if (!exe) throw new Error('这台机器上没有 Edge / Chrome / Chromium，公式排不出来。装一个 chromium，或设 FISH_DRAW_BROWSER。')
  const mj = mathjaxPath()
  if (!existsSync(mj)) throw new Error('MathJax 那个文件没跟着插件装进来（lib/assets/mathjax/tex-svg.js）。')

  const dir = mkdtempSync(join(tmpdir(), 'fish-formula-'))
  const htmlPath = join(dir, 'page.html')
  try {
    writeFileSync(htmlPath, buildHtml(plan), 'utf8')
    const url = pathToFileURL(htmlPath).href
    const profile = profileDir(root ?? homedir())

    // ① 量：让页面把尺寸写进 title，再从 DOM 里读回来
    const dom = await runFile(exe, [...browserArgs(profile), '--virtual-time-budget=8000', '--dump-dom', url], {
      windowsHide: true,
      timeout: 45_000,
      maxBuffer: 32 * 1024 * 1024,
    }).then((r) => r.stdout).catch((err) => String(err?.stdout ?? ''))

    const m = /<title>\s*(\d{3,5})x(\d{2,5})\s*<\/title>/i.exec(dom)
    if (!m) {
      throw new Error('量不出这一页多高（页面里没拿到尺寸）。多半是 MathJax 没加载起来，或者公式写错了。')
    }
    const w = Number(m[1])
    let h = Number(m[2])
    const truncated = h > LIMITS.heightMax
    if (truncated) h = LIMITS.heightMax

    // ② 截：按精确尺寸来，一点白边都不留
    await runFile(exe, [
      ...browserArgs(profile),
      '--virtual-time-budget=8000',
      `--force-device-scale-factor=${LIMITS.scale}`,
      `--window-size=${w},${h}`,
      `--screenshot=${outPath}`,
      url,
    ], { windowsHide: true, timeout: 45_000 })

    if (!existsSync(outPath)) throw new Error('截完了但没找到 PNG。')
    log(`formula: ${w}x${h} → ${basename(outPath)}`)
    return { ok: true, w, h, truncated }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录删不掉就算了 */ }
  }
}

/** 输出：media/formula/formula-<日期>-<序号>.png（media/ 下，桥才发得出去）。 */
function outPathFor(root) {
  const dir = join(root, 'media', 'formula')
  mkdirSync(dir, { recursive: true })
  const dk = new Date().toISOString().slice(0, 10)
  let n = 1
  try {
    n = readdirSync(dir).filter((f) => f.startsWith(`formula-${dk}-`) && f.endsWith('.png')).length + 1
  } catch { /* 目录刚建，从 1 起 */ }
  return join(dir, `formula-${dk}-${String(n).padStart(2, '0')}.png`)
}

/** 草稿预览图：media/board/f-<稿 id>-r<修订号>.png（与 her_draw 的板子同目录，前缀区分）。 */
function previewPath(root, id, rev) {
  const dir = join(root, 'media', 'board')
  mkdirSync(dir, { recursive: true })
  return join(dir, `f-${id}-r${rev}.png`)
}

function cleanPreviews(root, id, keepRev) {
  const dir = join(root, 'media', 'board')
  const prefix = `f-${id}-r`
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(prefix) || !f.endsWith('.png')) continue
      if (keepRev >= 0 && f === `${prefix}${keepRev}.png`) continue
      try { rmSync(join(dir, f), { force: true }) } catch { /* 删不掉就算了 */ }
    }
  } catch { /* 目录还没有 */ }
}

/**
 * 按**空行**切段（连续非空行算一段）。`$$…$$` 内部即使有空行也不切——
 * 多行 `aligned` 里空一行不该被拆成两段。
 */
export function splitBlocks(content) {
  const src = String(content ?? '').replace(/\r\n/g, '\n').trim()
  if (!src) return []
  const out = []
  let cur = []
  let inDisplay = false
  const flush = () => {
    const t = cur.join('\n').trim()
    if (t) out.push(t)
    cur = []
  }
  for (const line of src.split('\n')) {
    if (!inDisplay && !line.trim()) { flush(); continue }
    cur.push(line)
    const bare = line.replace(/\\\$/g, '')
    if (((bare.match(/\$\$/g) || []).length % 2) === 1) inDisplay = !inDisplay
  }
  flush()
  return out
}

/** 草稿回执：每段一行（id + 字数 + 开头），让她知道「改 p3」指哪一段。 */
export function formatBlockReport(blocks, { maxLines = 12, head = 46 } = {}) {
  const lines = []
  for (const b of blocks.slice(0, maxLines)) {
    const t = String(b.text ?? '').replace(/\s+/g, ' ').trim()
    lines.push(`${b.id} ${t.length} 字：${t.slice(0, head)}${t.length > head ? '…' : ''}`)
  }
  if (blocks.length > maxLines) lines.push(`…还有 ${blocks.length - maxLines} 段没列`)
  return lines.join('\n')
}

export function registerFormula(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const log = deps.log ?? (() => {})

  // 草稿：与 her_draw 的画板同一条定案（2026-11-10）——进程内 Map、不落盘、不记账、重启即丢。
  const drafts = new Map()
  let draftSeq = 0
  const DRAFT_MAX = 8

  const fail = (why) => ({ ok: false, path: '', note: why })
  const draftHint = () => (drafts.size ? `现在有：${[...drafts.keys()].join('、')}` : '现在一份都没有')

  function normOpts(args) {
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
    return {
      size: clamp(num(args?.size, 30), LIMITS.sizeMin, LIMITS.sizeMax),
      width: clamp(num(args?.width, 900), LIMITS.widthMin, LIMITS.widthMax),
      color: colorOf(args?.color, '#1a1a1a'),
    }
  }

  function addBlocks(d, texts) {
    return texts.map((t) => ({ id: 'p' + (++d.seq), text: t }))
  }

  function createDraft(args) {
    if (drafts.size >= DRAFT_MAX) {
      return fail(`同时最多 ${DRAFT_MAX} 份草稿，先 export 一份（或 discard）再开新的。${draftHint()}。`)
    }
    draftSeq += 1
    const id = `d${draftSeq}`
    const d = { id, blocks: [], seq: 0, rev: 0, ...normOpts(args) }
    d.blocks = addBlocks(d, splitBlocks(args?.content))
    const total = d.blocks.map((b) => b.text).join('\n\n')
    if (total.length > LIMITS.contentMax) {
      return fail(`这段稿子有 ${total.length} 字，一页最多 ${LIMITS.contentMax} 字——拆成两页。`)
    }
    drafts.set(id, d)
    return {
      ok: true,
      path: '',
      note: [
        `草稿 ${id} 建好了${d.blocks.length ? `，切了 ${d.blocks.length} 段` : '（空的）'}。`,
        d.blocks.length ? formatBlockReport(d.blocks) : '用 add 把文字/公式写进来；一段就是空行分开的一块。',
        'edit 按段 id 改指定的一段；remove 按 id 删；export 才出成品并删掉这份草稿。',
        '⚠ 改一段会让后面整体重排（流式排版），预览看起来整页变了是正常的。',
        '⚠ 草稿只在这次运行里活着，进程重启就没了。',
      ].filter(Boolean).join('\n'),
    }
  }

  async function renderDraft(d, blocks) {
    const content = blocks.map((b) => b.text).join('\n\n')
    if (!content.trim()) return { ok: false, why: '草稿是空的，先 add 或 edit 写点东西。' }
    const plan = planFormula({ content, size: d.size, width: d.width, color: d.color })
    if (!plan.ok) return { ok: false, why: plan.why }
    const rev = d.rev + 1
    const out = previewPath(root, d.id, rev)
    const r = await renderFormula(plan.plan, out, { root, log })
    cleanPreviews(root, d.id, rev)
    return { ok: true, report: r, out, rev }
  }

  function okDraft(d, r, what) {
    return {
      ok: true,
      path: r.out,
      note: [
        `${what}。草稿 ${d.id} 现在 ${d.blocks.length} 段。`,
        `预览（临时图，不是成品，这个路径别拿去发）：${slashed(r.out)}`,
        `排版 ${r.report.w}×${r.report.h}，出图 ${r.report.w * LIMITS.scale}×${r.report.h * LIMITS.scale}。`,
        formatBlockReport(d.blocks),
        '哪里不对就 edit 指定段 id（或 remove 掉重加）；export 才出成品并删掉草稿。',
        '改一段会让后面整体重排，预览整页变了是正常的。',
        '草稿只在这次运行里活着，进程重启就没了。',
      ].filter(Boolean).join('\n'),
    }
  }

  async function addToDraft(d, args) {
    const texts = splitBlocks(args?.content)
    if (!texts.length) return fail('add 要把文字/公式放在 content 里；一段就是空行分开的一块。')
    const added = addBlocks(d, texts)
    const candidate = [...d.blocks, ...added]
    const total = candidate.map((b) => b.text).join('\n\n')
    if (total.length > LIMITS.contentMax) {
      return fail(`加上去以后有 ${total.length} 字，一页最多 ${LIMITS.contentMax} 字——拆成两份草稿。`)
    }
    const r = await renderDraft(d, candidate)
    if (!r.ok) return fail(r.why)
    d.blocks = candidate
    d.rev = r.rev
    return okDraft(d, r, `加了 ${added.length} 段：${added.map((x) => x.id).join('、')}`)
  }

  async function editDraft(d, args) {
    const pid = String(args?.block ?? '').trim()
    const text = String(args?.text ?? '').trim()
    if (!pid) return fail('edit 要指定 block（段 id，比如 p2）。')
    if (!text) return fail('edit 要把这一段的新内容放在 text 里。')
    const idx = d.blocks.findIndex((b) => b.id === pid)
    if (idx === -1) return fail(`草稿里没有 ${pid} 这一段。现有：${d.blocks.map((b) => b.id).join('、')}`)
    const candidate = d.blocks.map((b) => ({ ...b }))
    candidate[idx] = { ...candidate[idx], text }
    const total = candidate.map((b) => b.text).join('\n\n')
    if (total.length > LIMITS.contentMax) return fail(`改完有 ${total.length} 字，一页最多 ${LIMITS.contentMax} 字。`)
    const r = await renderDraft(d, candidate)
    if (!r.ok) return fail(r.why)
    d.blocks = candidate
    d.rev = r.rev
    return okDraft(d, r, `改了 ${pid}`)
  }

  async function removeFromDraft(d, args) {
    const pid = String(args?.block ?? '').trim()
    if (!pid) return fail('remove 要指定 block（段 id）。')
    const candidate = d.blocks.filter((b) => b.id !== pid)
    if (candidate.length === d.blocks.length) return fail(`草稿里没有 ${pid} 这一段。现有：${d.blocks.map((b) => b.id).join('、')}`)
    if (!candidate.length) {
      d.blocks = []
      d.rev += 1
      cleanPreviews(root, d.id, -1)
      return { ok: true, path: '', note: `删掉了 ${pid}。草稿 ${d.id} 现在空了（还能继续 add）。` }
    }
    const r = await renderDraft(d, candidate)
    if (!r.ok) return fail(r.why)
    d.blocks = candidate
    d.rev = r.rev
    return okDraft(d, r, `删掉了 ${pid}`)
  }

  async function exportDraft(d) {
    const content = d.blocks.map((b) => b.text).join('\n\n')
    if (!content.trim()) return fail('草稿是空的，没有可导出的东西。')
    const plan = planFormula({ content, size: d.size, width: d.width, color: d.color })
    if (!plan.ok) return fail(plan.why)
    const out = outPathFor(root)
    const r = await renderFormula(plan.plan, out, { root, log })
    // 导出成功才删稿：渲染失败就留着，她还能接着改。
    drafts.delete(d.id)
    cleanPreviews(root, d.id, -1)
    const shown = slashed(out)
    return {
      ok: true,
      path: out,
      note: [
        `导出好了，存在 ${shown}。没有发给他。`,
        `排版 ${r.w}×${r.h}，出图 ${r.w * LIMITS.scale}×${r.h * LIMITS.scale}（${LIMITS.scale} 倍）。`,
        r.truncated ? `⚠ 内容超过 ${LIMITS.heightMax} 高，下面被截断了——拆成两张。` : '',
        `草稿 ${d.id} 已经删了，不能再改；想再调就重新 create 一份。`,
        `想发就把它写成 ![推导](${shown}) 放进 her_say，桥会把 media/ 下的图单独发成一条 QQ 图片消息。`,
      ].filter(Boolean).join('\n'),
    }
  }

  function discardDraft(d) {
    drafts.delete(d.id)
    cleanPreviews(root, d.id, -1)
    return { ok: true, path: '', note: `草稿 ${d.id} 丢了（没导出，什么图都没留下）。` }
  }

  async function runDraftAction(action, args) {
    if (action === 'create') return createDraft(args)
    const id = String(args?.draft ?? '').trim()
    const d = drafts.get(id)
    if (!d) {
      return fail(`没有 ${id || '（空 id）'} 这份草稿。草稿只在这次运行里活着，进程重启就没了——重新 create 一份。${draftHint()}。`)
    }
    if (action === 'add') return addToDraft(d, args)
    if (action === 'edit') return editDraft(d, args)
    if (action === 'remove') return removeFromDraft(d, args)
    if (action === 'export') return exportDraft(d)
    if (action === 'discard') return discardDraft(d)
    return fail(`不认识的 action=${action}。能用：create / add / edit / remove / export / discard；不带 action 就是一次排一整页。`)
  }

  ctx.tools.register(
    defineTool({
      name: 'her_formula',
      description: [
        '把一段「文字 + $公式$」排成一页图：中文照排，公式用 LaTeX。讲题、写推导用它。',
        '两种用法：① 直接给 content，一次排成一整页成品；② 先 create 一份草稿，用 add 加段、edit 按段 id 改指定的一段、remove 按 id 删，每次改动自动出一张临时预览给你 read_image 看，最后 export 才出成品。',
        '画好了存成 PNG（只存，不会发给他）。示意图、圈重点那种别用它，用 her_draw。',
        '⚠ 草稿只在这次运行里活着（重启就没了）；预览图不是成品，别拿预览路径去发；export 成功后草稿立刻删除；改一段会让后面整体重排，预览整页变了是正常的。',
      ].join(''),
      parameters: toJsonSchema({
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'add', 'edit', 'remove', 'export', 'discard'],
            description:
              '草稿动作。不带 action = 一次排一整页成品（老用法，仍可用）。' +
              'create 建一份草稿（返回 draft）；add 加段；edit 按段 id 改指定段；remove 按段 id 删；' +
              'export 出成品并立刻删掉草稿；discard 直接丢掉草稿。',
          },
          draft: { type: 'string', description: '草稿 id（create 返回的，如 d1）。add/edit/remove/export/discard 必填。' },
          content: {
            type: 'string',
            description:
              '稿子内容。行内公式写 $...$，独占一行的公式写 $$...$$；其余当普通文字，换行就是换行。' +
              '多行推导可以写成 $$\\begin{aligned}…\\end{aligned}$$（换行不打断公式）。' +
              '草稿模式下：create/add 时按**空行**自动切段；一段就是空行分开的一块。' +
              `中文直接写，公式里要中文用 \\text{…}。最多 ${LIMITS.contentMax} 字。`,
          },
          block: { type: 'string', description: 'edit/remove 指定的段 id（如 p2）。段 id 在 create/add 的回执里。' },
          text: { type: 'string', description: 'edit 时这一段的新内容（整段替换）。' },
          size: { type: 'integer', description: '字号（10–48，默认 30）' },
          width: { type: 'integer', description: '排版宽度 CSS 像素（320–1600，默认 900）；超宽自动换行' },
          color: { type: 'string', description: '字色：颜色中文名或 #RRGGBB（默认黑）' },
        },
        required: [],
      }),
      output: {
        schema: toJsonSchema({
          type: 'object',
          properties: { ok: { type: 'boolean' }, path: { type: 'string' }, note: { type: 'string' } },
          required: ['ok', 'note'],
        }),
        render: (_args, out) => [{ type: 'text', text: out.ok ? '[排好了]' : `[没排成：${out.note}]` }],
      },
      async execute(args = {}, exec) {
        const who = guardWrite(deps.tenant, exec, 'her_formula')
        if (!who.ok) return { ok: false, path: '', note: who.note || '这一页没排成。' }
        const action = String(args?.action ?? '').trim()
        if (action) {
          try {
            return await runDraftAction(action, args)
          } catch (err) {
            const why = String(err?.message ?? err).split('\n')[0].slice(0, 200)
            logLine('warn', ['her_formula：', why], root)
            return { ok: false, path: '', note: `这一页没排成：${why}` }
          }
        }
        const plan = planFormula(args)
        if (!plan.ok) {
          logLine('warn', ['her_formula：没排成', plan.why], root)
          return fail(plan.why)
        }
        const out = outPathFor(root)
        try {
          const r = await renderFormula(plan.plan, out, { root, log })
          const shown = slashed(out)
          const note = [
            `排好了，存在 ${shown}。没有发给他。`,
            // 报实际像素：她要知道这张图多大，说 CSS 尺寸（760×583）而真图是 1520×1166 就是没说实话
            `排版 ${r.w}×${r.h}，出图 ${r.w * LIMITS.scale}×${r.h * LIMITS.scale}（${LIMITS.scale} 倍，放大看也不糊）。`,
            r.truncated
              ? `⚠ 内容超过 ${LIMITS.heightMax} 高，下面被截断了——拆成两张排。`
              : '',
            `想发就把它写成 ![推导](${shown}) 放进 her_say，桥会把 media/ 下的图单独发成一条 QQ 图片消息。`,
          ].filter(Boolean).join('\n')
          return { ok: true, path: out, note }
        } catch (err) {
          // 不吞真因（her_draw 那边在这踩过）：把原因原样给她和我看
          const why = String(err?.message ?? err).split('\n')[0].slice(0, 200)
          logLine('warn', ['her_formula：', why], root)
          return { ok: false, path: '', note: `这一页没排成：${why}` }
        }
      },
    }),
  )
  log('formula: her_formula registered')
}
