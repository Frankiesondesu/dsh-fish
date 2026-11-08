/**
 * draw.js —— her_draw：一张她说了算的画布（2026-11-08，她的 ask_owner 申请，用户拍板「可以」）
 *
 * 为什么不是「算式排版器」：用户明确要的是「让她像人类一样绘图」——构图决定权在她，
 * 渲染器只是执行她每一笔的手。所以工具收的是绘图指令（画布 + 线/矩形/圆/箭头/文字），
 * 不是一段待排版的文字。讲题（排算式）退化成「在白板上写字」的一个动作。
 *
 * 引擎：PowerShell + System.Drawing（Windows 自带，零安装）。选它而不是 Pillow/resvg：
 *   零依赖、烟测已过（中文/上标/对齐都正）。两个已知坑都在铁律里：
 *   ① PS 5.1 读无 BOM 的 UTF-8 脚本当 GBK——脚本必须带 BOM；
 *   ② 中文绝不走命令行——渲染参数走 UTF-8 job 文件（node 写、PS 读），命令行只有 ASCII 路径。
 *
 * 出口（用户定案）：**只存不发**。PNG 落 media/draw/，回执如实告诉她「没有发给他」，
 * 并把完整路径与现成的发图写法给她（her_say 里写 ![说明](路径)，桥会单独发一张图）。
 * 发不发她自己定；不写推送标记。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { toJsonSchema } from './toolschema.js'
import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'
import { rootDir } from './store.js'
import { logLine } from './log.js'
import { slashed } from './posix.js'

const runFile = promisify(execFile)

/** 画布与元素的硬上限。防她一次画一张 10000×10000 的图把 GDI 拖死。 */
const LIMITS = Object.freeze({
  canvasMax: 1024,
  canvasMin: 120,
  itemsMax: 120,
  textMax: 60,          // 单个 text 元素的字数
  textSizeMax: 400,     // 所有 text 元素合计字数上限（约一屏板书，与说明书一致）
})

/** 调色板：她写中文名，映射成 hex。也直接收 #RRGGBB。 */
const PALETTE = Object.freeze({
  黑: '#1a1a1a', 灰: '#8a8a8a', 浅灰: '#c8c8c8', 白: '#ffffff',
  红: '#d94040', 蓝: '#3d6fe0', 绿: '#3a9e5f', 橙: '#e88a2d',
  黄: '#e3c23c', 紫: '#8a5fd1', 粉: '#e07a9a', 棕: '#8a6240',
})

function colorOf(raw, fallback) {
  const s = String(raw ?? '').trim()
  if (!s) return fallback
  if (PALETTE[s]) return PALETTE[s]
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s
  return fallback // 不是颜色就退回默认——别为颜色报错中断整张画
}

/** 校验并夹紧一张画的全部参数。返回 {ok, job|why}：job 是喂给 PS 的干净指令。 */
export function planDrawing(args = {}) {
  const canvas = args?.canvas ?? {}
  const w = Math.max(LIMITS.canvasMin, Math.min(LIMITS.canvasMax, Number(canvas.w) || 480))
  const h = Math.max(LIMITS.canvasMin, Math.min(LIMITS.canvasMax, Number(canvas.h) || 360))
  const items = Array.isArray(args?.items) ? args.items.slice(0, LIMITS.itemsMax) : []
  if (!items.length) return { ok: false, why: '画布上什么都没有。至少画一样东西。' }

  const job = { w, h, bg: colorOf(canvas.bg, '#ffffff'), items: [] }
  let textBudget = LIMITS.textSizeMax

  for (const it of items) {
    const type = String(it?.type ?? '')
    const num = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Number(v) : dflt)
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
    const color = colorOf(it?.color, '#1a1a1a')
    const width = clamp(num(it?.width, 2), 1, 8)
    switch (type) {
      case 'text': {
        const text = String(it?.text ?? '').trim()
        if (!text) continue
        if (text.length > LIMITS.textMax) return { ok: false, why: `这一行有 ${text.length} 字，单个文本最多 ${LIMITS.textMax} 字——拆成两行写。` }
        textBudget -= text.length
        if (textBudget < 0) return { ok: false, why: `字太多了一屏写不下（合计上限 ${LIMITS.textSizeMax} 字）。分开画几张。` }
        job.items.push({ t: 'text', x: clamp(num(it.x, 16), 0, w), y: clamp(num(it.y, 16), 0, h), text, size: clamp(num(it.size, 16), 10, 48), color, bold: it?.bold === true })
        break
      }
      case 'line':
        job.items.push({ t: 'line', x1: clamp(num(it.x1), 0, w), y1: clamp(num(it.y1), 0, h), x2: clamp(num(it.x2), 0, w), y2: clamp(num(it.y2), 0, h), color, width })
        break
      case 'arrow':
        job.items.push({ t: 'arrow', x1: clamp(num(it.x1), 0, w), y1: clamp(num(it.y1), 0, h), x2: clamp(num(it.x2), 0, w), y2: clamp(num(it.y2), 0, h), color, width })
        break
      case 'rect':
        job.items.push({ t: 'rect', x: clamp(num(it.x), 0, w), y: clamp(num(it.y), 0, h), w: clamp(num(it.w, 40), 1, w), h: clamp(num(it.h, 24), 1, h), color, fill: colorOf(it?.fill, ''), width })
        break
      case 'circle':
        job.items.push({ t: 'circle', cx: clamp(num(it.cx), 0, w), cy: clamp(num(it.cy), 0, h), r: clamp(num(it.r, 20), 1, Math.max(w, h)), color, fill: colorOf(it?.fill, '') })
        break
      default:
        return { ok: false, why: `不认识 ${JSON.stringify(String(it?.type ?? '')).slice(0, 20)} 这种笔。能用的：text / line / arrow / rect / circle。` }
    }
  }
  return { ok: true, job }
}

/**
 * 通用渲染脚本（写到临时目录执行，带 BOM）。读 job JSON、按元素画、存 PNG。
 * 全部中文都活在 job 文件里（UTF-8），命令行只传 ASCII 路径。
 */
const PS_SCRIPT = `param([string]$JobPath)
Add-Type -AssemblyName System.Drawing
$job = Get-Content -Path $JobPath -Encoding UTF8 -Raw | ConvertFrom-Json
$bmp = New-Object System.Drawing.Bitmap([int]$job.w, [int]$job.h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$ErrorActionPreference = 'Stop'  # 非终止错误也当场炸：不然 exit 0 却没画出来，查无可查
$g.Clear([System.Drawing.ColorTranslator]::FromHtml($job.bg))
$font = New-Object System.Drawing.Font('Microsoft YaHei', 14)
foreach ($it in $job.items) {
  $c = [System.Drawing.ColorTranslator]::FromHtml($(if ($it.color) { $it.color } else { '#1a1a1a' }))
  $pen = New-Object System.Drawing.Pen($c, [float]($(if ($it.width) { $it.width } else { 2 })))
  switch ($it.t) {
    'text' {
      $style = $(if ($it.bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular })
      $f = New-Object System.Drawing.Font('Microsoft YaHei', [float]$it.size, $style)
      $g.DrawString($it.text, $f, (New-Object System.Drawing.SolidBrush($c)), [float]$it.x, [float]$it.y)
      $f.Dispose()
    }
    'line' { $g.DrawLine($pen, [float]$it.x1, [float]$it.y1, [float]$it.x2, [float]$it.y2) }
    'arrow' {
      $g.DrawLine($pen, [float]$it.x1, [float]$it.y1, [float]$it.x2, [float]$it.y2)
      $a = [Math]::Atan2($it.y2 - $it.y1, $it.x2 - $it.x1)
      $head = 10
      $tip = New-Object System.Drawing.PointF([float]$it.x2, [float]$it.y2)
      $p1 = New-Object System.Drawing.PointF([float]($it.x2 - $head * [Math]::Cos($a - 0.45)), [float]($it.y2 - $head * [Math]::Sin($a - 0.45)))
      $p2 = New-Object System.Drawing.PointF([float]($it.x2 - $head * [Math]::Cos($a + 0.45)), [float]($it.y2 - $head * [Math]::Sin($a + 0.45)))
      $g.FillPolygon((New-Object System.Drawing.SolidBrush($c)), [System.Drawing.PointF[]]@($tip, $p1, $p2))
    }
    'rect' {
      if ($it.fill) { $g.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($it.fill))), [float]$it.x, [float]$it.y, [float]$it.w, [float]$it.h) }
      $g.DrawRectangle($pen, [float]$it.x, [float]$it.y, [float]$it.w, [float]$it.h)
    }
    'circle' {
      if ($it.fill) { $g.FillEllipse((New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($it.fill))), [float]($it.cx - $it.r), [float]($it.cy - $it.r), [float](2 * $it.r), [float](2 * $it.r)) }
      $g.DrawEllipse($pen, [float]($it.cx - $it.r), [float]($it.cy - $it.r), [float](2 * $it.r), [float](2 * $it.r))
    }
  }
  $pen.Dispose()
}
$g.Dispose()
$bmp.Save($job.out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
`

/** 真正调 PS 渲染。outdir/outPath 由调用方定；job 文件在临时目录，用完即删。 */
async function renderJob(job, outPath, log) {
  const dir = mkdtempSync(join(tmpdir(), 'fish-draw-'))
  const jobPath = join(dir, 'job.json')
  const psPath = join(dir, 'draw.ps1')
  try {
    // job/脚本都写 UTF-8 BOM：PS 5.1 只认这个（无 BOM 会被当 GBK，中文全毁——11-08 烟测踩过）
    writeFileSync(jobPath, '\uFEFF' + JSON.stringify({ ...job, out: outPath }), { encoding: 'utf8' })
    writeFileSync(psPath, '\uFEFF' + PS_SCRIPT, { encoding: 'utf8' })
    await runFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath, '-JobPath', jobPath], {
      windowsHide: true,
      timeout: 20_000,
    })
    if (!existsSync(outPath)) throw new Error('渲染完了但没找到 PNG')
    return true
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录删不掉就算了 */ }
  }
}

/** 输出文件名：draw-<日期>-<当天序号>.png，落在 media/draw/ 下。 */
function outPathFor(root) {
  // 落在 media/ 下是有意的：桥的 readLocalImage 只放行 media/（含子目录），
  // her_meme 的收藏也认这个目录。所以「只存不发」之后，她想发是有现成路的。
  const dir = join(root, 'media', 'draw')
  mkdirSync(dir, { recursive: true })
  const dk = new Date().toISOString().slice(0, 10)
  let n = 1
  try {
    n = readdirSync(dir).filter((f) => f.startsWith(`draw-${dk}-`) && f.endsWith('.png')).length + 1
  } catch { /* 目录刚建，从 1 起 */ }
  return { dir, out: join(dir, `draw-${dk}-${String(n).padStart(2, '0')}.png`) }
}

export function registerDraw(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const log = deps.log ?? (() => {})

  ctx.tools.register(
    defineTool({
      name: 'her_draw',
      description: [
        '在一张白板上画画：线条、矩形、圆、箭头、写字，位置大小颜色都由你定。',
        '画好了存成 PNG（只存，不会发给他）。讲题排算式、画示意图、画流程、圈重点都用它。',
        '画得直不直、好不好看是你的手艺——它是白板，不是画师。',
      ].join(''),
      parameters: toJsonSchema({
        type: 'object',
        properties: {
          canvas: {
            type: 'object',
            properties: {
              w: { type: 'integer', description: '画布宽（120–1024，默认 480）' },
              h: { type: 'integer', description: '画布高（120–1024，默认 360）' },
              bg: { type: 'string', description: '底色：颜色中文名或 #RRGGBB（默认白）' },
            },
            description: '画布。不给就用默认 480×360 白底。',
          },
          items: {
            type: 'array',
            maxItems: LIMITS.itemsMax,
            items: { type: 'object' },
            description:
              '要画的元素，从上到下叠。text=写字（x,y,text,size,color,bold）；line/arrow=线/箭头（x1,y1,x2,y2,color,width）；' +
              'rect=矩形（x,y,w,h,color,fill）；circle=圆（cx,cy,r,color,fill）。' +
              '颜色用中文名（黑/灰/红/蓝/绿/橙/黄/紫/粉/棕/浅灰/白）或 #RRGGBB。',
          },
        },
        required: ['items'],
      }),
      output: {
        schema: toJsonSchema({
          type: 'object',
          properties: { ok: { type: 'boolean' }, path: { type: 'string' }, note: { type: 'string' } },
          required: ['ok', 'note'],
        }),
        render: (_args, out) => [{ type: 'text', text: out.ok ? '[画好了]' : `[没画成：${out.note}]` }],
      },
      async execute(args = {}, exec) {
        const who = guardWrite(deps.tenant, exec, 'her_draw')
        if (!who.ok) return { ok: false, path: '', note: who.note || '这张没画成。' }
        try {
          const plan = planDrawing(args)
          if (!plan.ok) {
            logLine('warn', ['her_draw：没画成', plan.why], root)
            return { ok: false, path: '', note: plan.why }
          }
          const { out } = outPathFor(root)
          await renderJob(plan.job, out, log)
          logLine('info', [`her_draw：画了一张 ${plan.job.w}×${plan.job.h}，${plan.job.items.length} 笔 → ${basename(out)}`], root)
          // 只存不发（用户定案）：回执如实说没发，并把完整路径给她——
          // 只写「media/draw/」她拿不到可抄的路径，就会以为只能绕表情库（11-08 她真卡在这）。
          const shown = slashed(out)
          return {
            ok: true,
            path: out,
            note: `画好了，存在 ${shown}。没有发给他。想发就把它写成 ![白板](${shown}) 放进 her_say，桥会把 media/ 下的图单独发成一条 QQ 图片消息。`,
          }
        } catch (err) {
          logLine('warn', ['her_draw：', String(err?.message ?? err)], root)
          return { ok: false, path: '', note: '这次没画成。' }
        }
      },
    }),
  )
  log('draw: her_draw registered')
}
