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

/** 找 Edge（找不到就退 Chrome）。返回 exe 路径或空串。 */
export function browserPath(env = process.env) {
  const cands = [
    env.FISH_DRAW_BROWSER,
    env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean)
  return cands.find((p) => { try { return existsSync(p) } catch { return false } }) ?? ''
}

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
   font-family:"Microsoft YaHei","Segoe UI",sans-serif;width:${plan.width}px;box-sizing:border-box;word-break:break-word}
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

/** 浏览器公共参数：无头、不弹窗、不联网、复用一个 profile。 */
function baseArgs(profile) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    `--user-data-dir=${profile}`,
  ]
}

/**
 * 真渲染：量一次、截一次。返回 {ok:true, w, h, truncated} 或抛错（带人话原因）。
 */
export async function renderFormula(plan, outPath, { root, log = () => {} } = {}) {
  const exe = browserPath()
  if (!exe) throw new Error('这台机器上没有 Edge 也没有 Chrome，公式排不出来。')
  const mj = mathjaxPath()
  if (!existsSync(mj)) throw new Error('MathJax 那个文件没跟着插件装进来（lib/assets/mathjax/tex-svg.js）。')

  const dir = mkdtempSync(join(tmpdir(), 'fish-formula-'))
  const htmlPath = join(dir, 'page.html')
  try {
    writeFileSync(htmlPath, buildHtml(plan), 'utf8')
    const url = pathToFileURL(htmlPath).href
    const profile = profileDir(root ?? homedir())

    // ① 量：让页面把尺寸写进 title，再从 DOM 里读回来
    const dom = await runFile(exe, [...baseArgs(profile), '--virtual-time-budget=8000', '--dump-dom', url], {
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
      ...baseArgs(profile),
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

export function registerFormula(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const log = deps.log ?? (() => {})

  ctx.tools.register(
    defineTool({
      name: 'her_formula',
      description: [
        '把一段「文字 + $公式$」排成一页图：中文照排，公式用 LaTeX。讲题、写推导用它。',
        '画好了存成 PNG（只存，不会发给他）。示意图、圈重点那种别用它，用 her_draw。',
        '约 3 秒一张，一次把整段写进来，别一行一行调。',
      ].join(''),
      parameters: toJsonSchema({
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description:
              '整段稿子。行内公式写 $...$，独占一行的公式写 $$...$$；其余当普通文字，换行就是换行。' +
              '多行推导可以写成 $$\\begin{aligned}…\\end{aligned}$$（换行不打断公式）。' +
              `中文直接写，公式里要中文用 \\text{…}。最多 ${LIMITS.contentMax} 字。`,
          },
          size: { type: 'integer', description: '字号（10–48，默认 30）' },
          width: { type: 'integer', description: '排版宽度 CSS 像素（320–1600，默认 900）；超宽自动换行' },
          color: { type: 'string', description: '字色：颜色中文名或 #RRGGBB（默认黑）' },
        },
        required: ['content'],
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
        const plan = planFormula(args)
        if (!plan.ok) {
          logLine('warn', ['her_formula：没排成', plan.why], root)
          return { ok: false, path: '', note: plan.why }
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
