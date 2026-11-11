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
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { browserPath, browserArgs } from './browser.js'
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
  fracDepthMax: 3,      // 分数线最多套几层（2026-11-08 加）
})

/** 调色板：她写中文名，映射成 hex。也直接收 #RRGGBB。 */
const PALETTE = Object.freeze({
  黑: '#1a1a1a', 灰: '#8a8a8a', 浅灰: '#c8c8c8', 白: '#ffffff',
  红: '#d94040', 蓝: '#3d6fe0', 绿: '#3a9e5f', 橙: '#e88a2d',
  黄: '#e3c23c', 紫: '#8a5fd1', 粉: '#e07a9a', 棕: '#8a6240',
})

/** 颜色名 → hex。也直接收 #RRGGBB。formula.js 复用同一张表（别养两份调色板）。 */
export function colorOf(raw, fallback) {
  const s = String(raw ?? '').trim()
  if (!s) return fallback
  if (PALETTE[s]) return PALETTE[s]
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s
  return fallback // 不是颜色就退回默认——别为颜色报错中断整张画
}

const clampNum = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Number(v) : dflt)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** 校验并夹紧一张画的全部参数。返回 {ok, job|why}：job 是喂给 PS 的干净指令。 */
export function planDrawing(args = {}) {
  const canvas = args?.canvas ?? {}
  const w = Math.max(LIMITS.canvasMin, Math.min(LIMITS.canvasMax, Number(canvas.w) || 480))
  const h = Math.max(LIMITS.canvasMin, Math.min(LIMITS.canvasMax, Number(canvas.h) || 360))
  const items = Array.isArray(args?.items) ? args.items.slice(0, LIMITS.itemsMax) : []
  if (!items.length) return { ok: false, why: '画布上什么都没有。至少画一样东西。' }

  const job = { w, h, bg: colorOf(canvas.bg, '#ffffff'), items: [] }
  let textBudget = LIMITS.textSizeMax

  // ---- 分数线（2026-11-08 加，回应她「排不了嵌套的分数」）----
  // 分子/分母可以是：字符串 / {text,size} / 另一个 frac（最多套 3 层）。
  // 只收文本与分数，不收任意图形——它仍是「一笔」，不是排版引擎。
  const takeText = (text, size) => {
    const t = String(text ?? '').trim()
    if (!t) return { ok: false, why: '分数线的分子或分母是空的。' }
    if (t.length > LIMITS.textMax) {
      return { ok: false, why: `分数里这一行有 ${t.length} 字，单个文本最多 ${LIMITS.textMax} 字。` }
    }
    textBudget -= t.length
    if (textBudget < 0) return { ok: false, why: `字太多了一屏写不下（合计上限 ${LIMITS.textSizeMax} 字）。分开画几张。` }
    return { ok: true, node: { t: 'text', text: t, size: clamp(size, 10, 48), bold: false } }
  }

  const normFrac = (src, inherited, depth) => {
    if (depth > LIMITS.fracDepthMax) {
      return { ok: false, why: `分数线最多套 ${LIMITS.fracDepthMax} 层，再深就拆成几步画。` }
    }
    const size = clamp(clampNum(src?.size, inherited), 10, 48)
    const n = normPart(src?.num, size, depth)
    if (!n.ok) return n
    const d = normPart(src?.den, size, depth)
    if (!d.ok) return d
    return { ok: true, node: { t: 'frac', size, num: n.node, den: d.node } }
  }

  function normPart(raw, size, depth) {
    const looksFrac = raw && typeof raw === 'object' && String(raw.type ?? '') === 'frac'
    if (looksFrac) return normFrac(raw, size, depth + 1)
    const text = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? raw.text : '')
    const own = raw && typeof raw === 'object' && raw.size !== undefined ? clampNum(raw.size, size) : size
    return takeText(text, own)
  }

  for (const it of items) {
    const type = String(it?.type ?? '')
    const color = colorOf(it?.color, '#1a1a1a')
    const width = clamp(clampNum(it?.width, 2), 1, 8)
    switch (type) {
      case 'text': {
        const text = String(it?.text ?? '').trim()
        if (!text) continue
        if (text.length > LIMITS.textMax) return { ok: false, why: `这一行有 ${text.length} 字，单个文本最多 ${LIMITS.textMax} 字——拆成两行写。` }
        textBudget -= text.length
        if (textBudget < 0) return { ok: false, why: `字太多了一屏写不下（合计上限 ${LIMITS.textSizeMax} 字）。分开画几张。` }
        job.items.push({ t: 'text', x: clamp(clampNum(it.x, 16), 0, w), y: clamp(clampNum(it.y, 16), 0, h), text, size: clamp(clampNum(it.size, 16), 10, 48), color, bold: it?.bold === true })
        break
      }
      case 'frac': {
        const f = normFrac(it, 20, 1)
        if (!f.ok) return f
        job.items.push({
          ...f.node,
          x: clamp(clampNum(it.x, 16), 0, w),
          y: clamp(clampNum(it.y, 16), 0, h),
          color,
          width,
        })
        break
      }
      case 'line':
        job.items.push({ t: 'line', x1: clamp(clampNum(it.x1), 0, w), y1: clamp(clampNum(it.y1), 0, h), x2: clamp(clampNum(it.x2), 0, w), y2: clamp(clampNum(it.y2), 0, h), color, width })
        break
      case 'arrow':
        job.items.push({ t: 'arrow', x1: clamp(clampNum(it.x1), 0, w), y1: clamp(clampNum(it.y1), 0, h), x2: clamp(clampNum(it.x2), 0, w), y2: clamp(clampNum(it.y2), 0, h), color, width })
        break
      case 'rect':
        job.items.push({ t: 'rect', x: clamp(clampNum(it.x), 0, w), y: clamp(clampNum(it.y), 0, h), w: clamp(clampNum(it.w, 40), 1, w), h: clamp(clampNum(it.h, 24), 1, h), color, fill: colorOf(it?.fill, ''), width })
        break
      case 'circle':
        job.items.push({ t: 'circle', cx: clamp(clampNum(it.cx), 0, w), cy: clamp(clampNum(it.cy), 0, h), r: clamp(clampNum(it.r, 20), 1, Math.max(w, h)), color, fill: colorOf(it?.fill, '') })
        break
      default:
        return { ok: false, why: `不认识 ${JSON.stringify(String(it?.type ?? '')).slice(0, 20)} 这种笔。能用的：text / frac / line / arrow / rect / circle。` }
    }
  }
  return { ok: true, job }
}

/**
 * 通用渲染脚本（写到临时目录执行，带 BOM）。读 job JSON、按元素画、存 PNG。
 * 全部中文都活在 job 文件里（UTF-8），命令行只传 ASCII 路径。
 *
 * 2026-11-08 加了两件事（真机反馈：字容易对不齐，嵌套的分数线也没法手算）：
 *   ① 画完把每个元素的**实测包围盒**写进 report JSON —— 她看不见 GDI 量出来多大，
 *      只给路径就只能靠试；
 *   ② 分数线由脚本自己量宽居中（含嵌套），不再让她手算上下两行该放哪。
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

# 紧贴字形的度量与绘制。默认 StringFormat 会算上行距（16 号量出 31 高，字形其实只有 ~21），
# 分数线会被撑得离分子很远——2026-11-08 实拍发现的。量也用它、画也用它，回执里的框才和画一致。
$sf = [System.Drawing.StringFormat]::GenericTypographic

function Get-DrawFont([double]$px, [bool]$bold) {
  $style = [System.Drawing.FontStyle]::Regular
  if ($bold) { $style = [System.Drawing.FontStyle]::Bold }
  return New-Object System.Drawing.Font('Microsoft YaHei', [float]$px, $style)
}

# 量一个节点（文本或分数）占多大。分数：两行宽度取大者 + 左右留白，高度叠三层。
function Measure-Node($node) {
  if ($node.t -eq 'text') {
    $f = Get-DrawFont ([double]$node.size) ([bool]$node.bold)
    $s = $g.MeasureString([string]$node.text, $f, (New-Object System.Drawing.PointF(0, 0)), $sf)
    $f.Dispose()
    return @{ w = [double]$s.Width; h = [double]$s.Height }
  }
  $a = Measure-Node $node.num
  $b = Measure-Node $node.den
  # 含嵌套时左右留白给足：外层分数线必须明显比里层的宽，否则三条线一样长，看不出谁套谁。
  # ⚠️ 这段几何在 Draw-Node 里必须一模一样，改一处就要改另一处。
  $pad = [double]$node.size * 0.20
  if (($node.num.t -eq 'frac') -or ($node.den.t -eq 'frac')) { $pad = [double]$node.size * 0.55 }
  $gap = [double]$node.size * 0.22
  $barT = [Math]::Max(1.0, [double]$node.size * 0.06)
  $bw = [Math]::Max([double]$a.w, [double]$b.w) + 2 * $pad
  return @{ w = $bw; h = [double]$a.h + $gap + $barT + $gap + [double]$b.h }
}

# 画一个节点，返回它占的尺寸。分数：分子分母各自居中，中间一条线。
function Draw-Node($node, [double]$left, [double]$top, $color) {
  if ($node.t -eq 'text') {
    $f = Get-DrawFont ([double]$node.size) $false
    $g.DrawString([string]$node.text, $f, (New-Object System.Drawing.SolidBrush($color)), [float]$left, [float]$top, $sf)
    $f.Dispose()
    return (Measure-Node $node)
  }
  $a = Measure-Node $node.num
  $b = Measure-Node $node.den
  # 与 Measure-Node 里的几何必须完全一致（见那处注释）
  $pad = [double]$node.size * 0.20
  if (($node.num.t -eq 'frac') -or ($node.den.t -eq 'frac')) { $pad = [double]$node.size * 0.55 }
  $gap = [double]$node.size * 0.22
  $barT = [Math]::Max(1.0, [double]$node.size * 0.06)
  $bw = [Math]::Max([double]$a.w, [double]$b.w) + 2 * $pad
  $nx = $left + ($bw - [double]$a.w) / 2
  Draw-Node $node.num $nx $top $color | Out-Null
  $by = $top + [double]$a.h + $gap
  $bp = New-Object System.Drawing.Pen($color, [float]$barT)
  $g.DrawLine($bp, [float]$left, [float]$by, [float]($left + $bw), [float]$by)
  $bp.Dispose()
  $dx = $left + ($bw - [double]$b.w) / 2
  $dy = $by + $barT + $gap
  Draw-Node $node.den $dx $dy $color | Out-Null
  return @{ w = $bw; h = [double]$a.h + $gap + $barT + $gap + [double]$b.h }
}

$report = @()
$idx = 0
foreach ($it in $job.items) {
  $idx = $idx + 1
  $c = [System.Drawing.ColorTranslator]::FromHtml($(if ($it.color) { $it.color } else { '#1a1a1a' }))
  $pen = New-Object System.Drawing.Pen($c, [float]($(if ($it.width) { $it.width } else { 2 })))
  $bx = 0.0
  $by = 0.0
  $bw = 0.0
  $bh = 0.0
  switch ($it.t) {
    'text' {
      $style = [System.Drawing.FontStyle]::Regular
      if ($it.bold) { $style = [System.Drawing.FontStyle]::Bold }
      $f = New-Object System.Drawing.Font('Microsoft YaHei', [float]$it.size, $style)
      $g.DrawString($it.text, $f, (New-Object System.Drawing.SolidBrush($c)), [float]$it.x, [float]$it.y, $sf)
      $f.Dispose()
      $sz = Measure-Node @{ t = 'text'; text = $it.text; size = $it.size; bold = $it.bold }
      $bx = [double]$it.x; $by = [double]$it.y; $bw = [double]$sz.w; $bh = [double]$sz.h
    }
    'frac' {
      $sz = Draw-Node $it ([double]$it.x) ([double]$it.y) $c
      $bx = [double]$it.x; $by = [double]$it.y; $bw = [double]$sz.w; $bh = [double]$sz.h
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
  if ($it.t -eq 'line' -or $it.t -eq 'arrow') {
    $bx = [Math]::Min([double]$it.x1, [double]$it.x2)
    $by = [Math]::Min([double]$it.y1, [double]$it.y2)
    $bw = [Math]::Abs([double]$it.x2 - [double]$it.x1)
    $bh = [Math]::Abs([double]$it.y2 - [double]$it.y1)
  } elseif ($it.t -eq 'rect') {
    $bx = [double]$it.x; $by = [double]$it.y; $bw = [double]$it.w; $bh = [double]$it.h
  } elseif ($it.t -eq 'circle') {
    $bx = [double]$it.cx - [double]$it.r; $by = [double]$it.cy - [double]$it.r
    $bw = 2 * [double]$it.r; $bh = 2 * [double]$it.r
  }
  $report += @{
    i = $idx; t = [string]$it.t
    x = [Math]::Round($bx, 1); y = [Math]::Round($by, 1)
    w = [Math]::Round($bw, 1); h = [Math]::Round($bh, 1)
  }
}

$g.Dispose()
$bmp.Save($job.out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

# 测量回执：整体外接框 + 出界的笔。她按这个对齐，不用再靠「画三回」试。
if ($job.report) {
  $minX = 0.0; $minY = 0.0; $maxX = 0.0; $maxY = 0.0; $first = $true
  $clipped = @()
  foreach ($r in $report) {
    if ($first) { $minX = $r.x; $minY = $r.y; $maxX = $r.x + $r.w; $maxY = $r.y + $r.h; $first = $false }
    if ($r.x -lt $minX) { $minX = $r.x }
    if ($r.y -lt $minY) { $minY = $r.y }
    if (($r.x + $r.w) -gt $maxX) { $maxX = $r.x + $r.w }
    if (($r.y + $r.h) -gt $maxY) { $maxY = $r.y + $r.h }
    if ((($r.x + $r.w) -gt ([double]$job.w + 0.5)) -or (($r.y + $r.h) -gt ([double]$job.h + 0.5))) {
      $clipped += $r.i
    }
  }
  $res = @{
    canvas = @{ w = [int]$job.w; h = [int]$job.h }
    items = @($report)
    bbox = @{ x1 = [Math]::Round($minX, 1); y1 = [Math]::Round($minY, 1); x2 = [Math]::Round($maxX, 1); y2 = [Math]::Round($maxY, 1) }
    clipped = @($clipped)
  }
  $json = $res | ConvertTo-Json -Depth 6 -Compress
  [System.IO.File]::WriteAllText($job.report, $json, (New-Object System.Text.UTF8Encoding($false)))
}
`

/**
 * Linux/无 GDI 的渲染通路（2026-11-11）：把同一份 job 画进 canvas，再用
 * canvas.toDataURL() 交回 PNG。测量也在页面里做，回执与 GDI 版同形。
 * 不 import 任何依赖；浏览器只由 browser.js 找。
 */
const DRAW_BROWSER_JS = String.raw`
(function () {
  var job = JSON.parse(document.getElementById('job').textContent);
  var c = document.getElementById('c');
  var ctx = c.getContext('2d');
  var R = function (v) { return Math.round(Number(v) * 10) / 10; };
  function fontOf(px, bold) {
    return (bold ? 'bold ' : '') + px + 'px "Noto Sans CJK SC","Noto Sans CJK","Microsoft YaHei","Segoe UI",sans-serif';
  }
  function measure(node) {
    if (node.t === 'text') {
      ctx.font = fontOf(node.size, node.bold);
      var m = ctx.measureText(String(node.text));
      var asc = Number.isFinite(m.actualBoundingBoxAscent) ? m.actualBoundingBoxAscent : node.size * 0.8;
      var desc = Number.isFinite(m.actualBoundingBoxDescent) ? m.actualBoundingBoxDescent : node.size * 0.2;
      return { w: m.width, h: Math.max(1, asc + desc) };
    }
    var a = measure(node.num);
    var b = measure(node.den);
    var pad = node.size * 0.20;
    if (node.num.t === 'frac' || node.den.t === 'frac') pad = node.size * 0.55;
    var gap = node.size * 0.22;
    var barT = Math.max(1, node.size * 0.06);
    var bw = Math.max(a.w, b.w) + 2 * pad;
    return { w: bw, h: a.h + gap + barT + gap + b.h };
  }
  function drawNode(node, left, top, color) {
    if (node.t === 'text') {
      ctx.fillStyle = color;
      ctx.font = fontOf(node.size, node.bold);
      ctx.textBaseline = 'top';
      ctx.fillText(String(node.text), left, top);
      return measure(node);
    }
    var a = measure(node.num);
    var b = measure(node.den);
    var pad = node.size * 0.20;
    if (node.num.t === 'frac' || node.den.t === 'frac') pad = node.size * 0.55;
    var gap = node.size * 0.22;
    var barT = Math.max(1, node.size * 0.06);
    var bw = Math.max(a.w, b.w) + 2 * pad;
    drawNode(node.num, left + (bw - a.w) / 2, top, color);
    var by = top + a.h + gap;
    ctx.strokeStyle = color;
    ctx.lineWidth = barT;
    ctx.beginPath();
    ctx.moveTo(left, by);
    ctx.lineTo(left + bw, by);
    ctx.stroke();
    drawNode(node.den, left + (bw - b.w) / 2, by + barT + gap, color);
    return { w: bw, h: a.h + gap + barT + gap + b.h };
  }
  function render() {
    ctx.fillStyle = job.bg || '#ffffff';
    ctx.fillRect(0, 0, job.w, job.h);
    var report = [];
    var idx = 0;
    for (var n = 0; n < job.items.length; n++) {
      var it = job.items[n];
      idx++;
      var color = it.color || '#1a1a1a';
      var bx = 0, by = 0, bw = 0, bh = 0;
      if (it.t === 'text') {
        var sz = drawNode({ t: 'text', text: it.text, size: it.size, bold: it.bold }, it.x, it.y, color);
        bx = it.x; by = it.y; bw = sz.w; bh = sz.h;
      } else if (it.t === 'frac') {
        var fs = drawNode(it, it.x, it.y, color);
        bx = it.x; by = it.y; bw = fs.w; bh = fs.h;
      } else if (it.t === 'line' || it.t === 'arrow') {
        ctx.strokeStyle = color;
        ctx.lineWidth = it.width || 2;
        ctx.beginPath();
        ctx.moveTo(it.x1, it.y1);
        ctx.lineTo(it.x2, it.y2);
        ctx.stroke();
        if (it.t === 'arrow') {
          var ang = Math.atan2(it.y2 - it.y1, it.x2 - it.x1);
          var head = 10;
          var p1x = it.x2 - head * Math.cos(ang - 0.45);
          var p1y = it.y2 - head * Math.sin(ang - 0.45);
          var p2x = it.x2 - head * Math.cos(ang + 0.45);
          var p2y = it.y2 - head * Math.sin(ang + 0.45);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(it.x2, it.y2);
          ctx.lineTo(p1x, p1y);
          ctx.lineTo(p2x, p2y);
          ctx.closePath();
          ctx.fill();
        }
        bx = Math.min(it.x1, it.x2); by = Math.min(it.y1, it.y2);
        bw = Math.abs(it.x2 - it.x1); bh = Math.abs(it.y2 - it.y1);
      } else if (it.t === 'rect') {
        if (it.fill) { ctx.fillStyle = it.fill; ctx.fillRect(it.x, it.y, it.w, it.h); }
        ctx.strokeStyle = color;
        ctx.lineWidth = it.width || 2;
        ctx.strokeRect(it.x, it.y, it.w, it.h);
        bx = it.x; by = it.y; bw = it.w; bh = it.h;
      } else if (it.t === 'circle') {
        ctx.beginPath();
        ctx.arc(it.cx, it.cy, it.r, 0, Math.PI * 2);
        if (it.fill) { ctx.fillStyle = it.fill; ctx.fill(); }
        ctx.strokeStyle = color;
        ctx.lineWidth = it.width || 2;
        ctx.stroke();
        bx = it.cx - it.r; by = it.cy - it.r; bw = 2 * it.r; bh = 2 * it.r;
      }
      report.push({ i: idx, t: it.t, x: R(bx), y: R(by), w: R(bw), h: R(bh) });
    }
    var minX = 0, minY = 0, maxX = 0, maxY = 0, first = true;
    var clipped = [];
    for (var k = 0; k < report.length; k++) {
      var r = report[k];
      if (first) { minX = r.x; minY = r.y; maxX = r.x + r.w; maxY = r.y + r.h; first = false; }
      minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
      if ((r.x + r.w) > job.w + 0.5 || (r.y + r.h) > job.h + 0.5) clipped.push(r.i);
    }
    var out = {
      report: {
        canvas: { w: job.w, h: job.h },
        items: report,
        bbox: { x1: R(minX), y1: R(minY), x2: R(maxX), y2: R(maxY) },
        clipped: clipped
      },
      png: c.toDataURL('image/png')
    };
    document.getElementById('out').textContent = JSON.stringify(out);
  }
  var ready = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
  ready.then(render).catch(function (e) {
    document.getElementById('out').textContent = JSON.stringify({ error: String(e && e.message || e) });
  });
})();
`

/** 生成无头浏览器要跑的那一页。job 里的 text 可能含 </script>，JSON 里的 `<` 必须转义。 */
export function buildDrawHtml(job) {
  const json = JSON.stringify(job).replace(/</g, '\\u003c')
  return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:${job.bg}}canvas{display:block}</style>
<canvas id="c" width="${job.w}" height="${job.h}"></canvas>
<pre id="out" style="display:none"></pre>
<script id="job" type="application/json">${json}</script>
<script>${DRAW_BROWSER_JS}</script>`
}

function decodeHtmlEntities(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 从 --dump-dom 的输出里取回 report 与 PNG。纯函数，便于单测。 */
export function parseDrawBrowserOutput(dom) {
  const m = /<pre[^>]*id="out"[^>]*>([\s\S]*?)<\/pre>/i.exec(String(dom ?? ''))
  if (!m) throw new Error('浏览器没有把画的结果交回来（页面脚本没跑完）。')
  let data
  try { data = JSON.parse(decodeHtmlEntities(m[1])) } catch { throw new Error('浏览器交回来的结果不是 JSON。') }
  if (data?.error) throw new Error(`画布脚本报错：${data.error}`)
  const png = String(data?.png ?? '')
  const prefix = 'data:image/png;base64,'
  if (!png.startsWith(prefix) || png.length <= prefix.length) throw new Error('浏览器没给出 PNG。')
  return { report: data.report ?? null, buf: Buffer.from(png.slice(prefix.length), 'base64') }
}

/** Linux 渲染：起一次无头浏览器，页面自己画、自己量、把 PNG 用 data URL 交回来。 */
export async function renderJobBrowser(job, outPath, log = () => {}, root) {
  const exe = browserPath()
  if (!exe) {
    throw new Error('这台机器上没有 Edge / Chrome / Chromium，画不出来。装一个 chromium，或设 FISH_DRAW_BROWSER。')
  }
  const dir = mkdtempSync(join(tmpdir(), 'fish-draw-browser-'))
  const htmlPath = join(dir, 'draw.html')
  const profile = join(root ?? homedir(), 'cache', 'draw-browser')
  try {
    mkdirSync(profile, { recursive: true })
    writeFileSync(htmlPath, buildDrawHtml(job), 'utf8')
    const r = await runFile(exe, [
      ...browserArgs(profile),
      '--virtual-time-budget=8000',
      '--dump-dom',
      pathToFileURL(htmlPath).href,
    ], { windowsHide: true, timeout: 45_000, maxBuffer: 64 * 1024 * 1024 })
    const { report, buf } = parseDrawBrowserOutput(r.stdout)
    writeFileSync(outPath, buf)
    log(`draw: browser ${job.w}x${job.h} → ${basename(outPath)}`)
    return report
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录删不掉就算了 */ }
  }
}

/** 真正调渲染。Windows 走 PS + GDI；Linux（或 FISH_DRAW_ENGINE=browser）走无头浏览器。 */
async function renderJob(job, outPath, log, root) {
  const engine = String(process.env.FISH_DRAW_ENGINE || '').trim().toLowerCase()
  if (engine === 'browser' || (engine !== 'gdi' && process.platform !== 'win32')) {
    return renderJobBrowser(job, outPath, log, root)
  }
  const dir = mkdtempSync(join(tmpdir(), 'fish-draw-'))
  const jobPath = join(dir, 'job.json')
  const psPath = join(dir, 'draw.ps1')
  const reportPath = join(dir, 'report.json')
  try {
    // job/脚本都写 UTF-8 BOM：PS 5.1 只认这个（无 BOM 会被当 GBK，中文全毁——11-08 烟测踩过）
    writeFileSync(jobPath, '\uFEFF' + JSON.stringify({ ...job, out: outPath, report: reportPath }), { encoding: 'utf8' })
    writeFileSync(psPath, '\uFEFF' + PS_SCRIPT, { encoding: 'utf8' })
    await runFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath, '-JobPath', jobPath], {
      windowsHide: true,
      timeout: 20_000,
    })
    if (!existsSync(outPath)) throw new Error('渲染完了但没找到 PNG')
    // 测量回执读不到不算失败：图已经画好了，只是少了可对齐的数字。
    try {
      const raw = readFileSync(reportPath, 'utf8').replace(/^\uFEFF/, '')
      return JSON.parse(raw)
    } catch {
      return null
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录删不掉就算了 */ }
  }
}

const r1 = (v) => Math.round(Number(v) || 0)

/**
 * 把测量结果翻成人话（纯函数，便于测）。
 *
 * 只列「字」和「分数」——线、框、圆是她自己给的坐标，本来就知道在哪；
 * 字有多大、分数占多宽是 GDI 量出来的，她算不出来，这才需要回执告诉她。
 */
export function formatMeasureReport(report, { maxLines = 14 } = {}) {
  if (!report || !Array.isArray(report.items) || !report.items.length) return ''
  const canvas = report.canvas ?? {}
  const keep = report.items.filter((it) => it.t === 'text' || it.t === 'frac')
  const seg = keep
    .slice(0, maxLines)
    .map((it) => `${it.i}${it.t === 'frac' ? '分数' : '字'}@${r1(it.x)},${r1(it.y)} ${r1(it.w)}×${r1(it.h)}`)
  const more = keep.length > maxLines ? `；还有 ${keep.length - maxLines} 笔没列` : ''
  const lines = []
  if (seg.length) {
    lines.push(`实测（画布 ${r1(canvas.w)}×${r1(canvas.h)}；格式 第几笔@左上 宽×高）：${seg.join(' ｜ ')}${more}`)
  }
  const b = report.bbox
  if (b) lines.push(`整张画占 ${r1(b.x1)},${r1(b.y1)} → ${r1(b.x2)},${r1(b.y2)}。`)
  const clipped = Array.isArray(report.clipped) ? report.clipped.filter((n) => Number.isFinite(Number(n))) : []
  if (clipped.length) lines.push(`⚠ 第 ${clipped.join('、')} 笔超出画布，右下角会被裁掉。`)
  return lines.join('\n')
}

/** 画板预览图：media/board/<板 id>-r<修订号>.png。必须落 media/ 下，桥的 readLocalImage 才放行。 */
function previewPath(root, id, rev) {
  const dir = join(root, 'media', 'board')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${id}-r${rev}.png`)
}

/** 删掉某块板的旧预览图（keepRev < 0 = 全删）。 */
function cleanPreviews(root, id, keepRev) {
  const dir = join(root, 'media', 'board')
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(id + '-r') || !f.endsWith('.png')) continue
      if (keepRev >= 0 && f === `${id}-r${keepRev}.png`) continue
      try { rmSync(join(dir, f), { force: true }) } catch { /* 删不掉就算了 */ }
    }
  } catch { /* 目录还没有 */ }
}

/** 画布参数夹紧（create 时用；空 items 不能走 planDrawing）。 */
function normCanvas(canvas = {}) {
  const w = Math.max(LIMITS.canvasMin, Math.min(LIMITS.canvasMax, Number(canvas?.w) || 480))
  const h = Math.max(LIMITS.canvasMin, Math.min(LIMITS.canvasMax, Number(canvas?.h) || 360))
  return { w, h, bg: colorOf(canvas?.bg, '#ffffff') }
}

/**
 * 画板回执：每一笔按 **id** 列几何，她才知道「改 i3」指的是哪一笔。
 * 与 formatMeasureReport 分开：那个按「第 N 笔」说（一次性画法的旧口径），
 * 这个按 id 说（画板模式，用户 2026-11-10 定案用笔画 id 定位）。
 */
export function formatBoardReport(report, idMap = [], { maxLines = 16 } = {}) {
  if (!report || !Array.isArray(report.items) || !report.items.length) return ''
  const nameOf = (i) => idMap[i - 1] || `#${i}`
  const lines = []
  for (const it of report.items.slice(0, maxLines)) {
    lines.push(`${nameOf(it.i)} ${it.t}@${r1(it.x)},${r1(it.y)} ${r1(it.w)}×${r1(it.h)}`)
  }
  if (report.items.length > maxLines) lines.push(`…还有 ${report.items.length - maxLines} 笔没列（直接看图）`)
  const b = report.bbox
  if (b) lines.push(`整张画占 ${b.x1},${b.y1} → ${b.x2},${b.y2}`)
  const clipped = Array.isArray(report.clipped) ? report.clipped : []
  if (clipped.length) lines.push(`⚠ 出界会被裁：${clipped.map(nameOf).join('、')}`)
  return lines.join('\n')
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

  // 画板：只在这个进程里活着（用户 2026-11-10 定案：进程内 Map，不落盘、不记账、重启即丢）。
  // 放在 registerDraw 闭包里而不是模块级：插件启动时注册一次，天然就是「这次运行」。
  const boards = new Map()
  let boardSeq = 0
  const BOARD_MAX = 8

  const fail = (why) => ({ ok: false, path: '', note: why })
  const boardHint = () => (boards.size ? `现在有：${[...boards.keys()].join('、')}` : '现在一块都没有')
  // 空 text 不渲染（planDrawing 会跳过它）——统一在渲染前滤掉，
  // 保证 report.items 的下标与 idMap 一一对应，几何回执不会串笔。
  const liveItems = (items) =>
    items.filter((it) => !(String(it?.type ?? '') === 'text' && !String(it?.text ?? '').trim()))

  function createBoard(args) {
    if (boards.size >= BOARD_MAX) {
      return fail(`同时最多 ${BOARD_MAX} 块画板，先 export 一块（或 discard）再开新的。${boardHint()}。`)
    }
    boardSeq += 1
    const id = `b${boardSeq}`
    const cv = normCanvas(args?.canvas)
    boards.set(id, { id, canvas: cv, items: [], seq: 0, rev: 0 })
    return {
      ok: true,
      path: '',
      note: [
        `画板 ${id} 建好了（${cv.w}×${cv.h}）。`,
        '用 add 把笔放上去；edit 按 id 改指定的一笔；remove 按 id 删；export 才出成品并删掉这块板。',
        '⚠ 画板只在这次运行里活着，进程重启就没了。',
      ].join('\n'),
    }
  }

  // 候选 items 先 plan + 渲一张预览，通过才落回板子（坏参数不会污染板子）。
  async function renderBoard(b, items) {
    const live = liveItems(items)
    const plan = planDrawing({ canvas: b.canvas, items: live })
    if (!plan.ok) return { ok: false, why: plan.why }
    const rev = b.rev + 1
    const out = previewPath(root, b.id, rev)
    const report = await renderJob(plan.job, out, log, root)
    cleanPreviews(root, b.id, rev)
    return { ok: true, report, out, idMap: live.map((x) => x.id), rev }
  }

  function okBoard(b, r, what) {
    return {
      ok: true,
      path: r.out,
      note: [
        `${what}。画板 ${b.id} 现在 ${b.items.length} 笔。`,
        `预览（临时图，不是成品，这个路径别拿去发）：${slashed(r.out)}`,
        formatBoardReport(r.report, r.idMap),
        '哪里不对就 edit 指定 id（或 remove 掉重加）；export 才出成品并删掉这块板。',
        '板子只在这次运行里活着，进程重启就没了。',
      ].filter(Boolean).join('\n'),
    }
  }

  async function addItems(b, args) {
    const raw = Array.isArray(args?.items) ? args.items : []
    if (!raw.length) return fail('add 要把要画的笔放在 items 里（数组，一次可以给多笔）。')
    if (b.items.length + raw.length > LIMITS.itemsMax) {
      return fail(`一块画板最多 ${LIMITS.itemsMax} 笔，现在 ${b.items.length} 笔，再加 ${raw.length} 笔放不下。`)
    }
    const added = raw.map((it) => ({ ...it, id: 'i' + (++b.seq) }))
    const candidate = [...b.items, ...added]
    const r = await renderBoard(b, candidate)
    if (!r.ok) return fail(r.why)
    b.items = candidate
    b.rev = r.rev
    return okBoard(b, r, `加了 ${added.length} 笔：${added.map((x) => x.id).join('、')}`)
  }

  async function editItems(b, args) {
    const patches = Array.isArray(args?.items) ? args.items : []
    if (!patches.length) return fail('edit 要把改动放在 items 里，每项必须带 id（比如 {id:"i2", x:120}）。')
    const candidate = b.items.map((x) => ({ ...x }))
    for (const p of patches) {
      const pid = String(p?.id ?? '')
      const idx = candidate.findIndex((x) => x.id === pid)
      if (idx === -1) return fail(`画板上没有 id=${pid || '（空）'} 这一笔。现有：${candidate.map((x) => x.id).join('、')}`)
      const cur = candidate[idx]
      if (p.type && String(p.type) !== String(cur.type)) {
        return fail(`${pid} 是 ${cur.type}，不能直接改成 ${p.type}；先 remove 掉再 add 一笔新的。`)
      }
      candidate[idx] = { ...cur, ...p, id: cur.id }
    }
    const r = await renderBoard(b, candidate)
    if (!r.ok) return fail(r.why)
    b.items = candidate
    b.rev = r.rev
    return okBoard(b, r, `改了 ${patches.length} 笔：${patches.map((x) => x.id).join('、')}`)
  }

  async function removeItems(b, args) {
    const ids = Array.isArray(args?.ids) ? args.ids.map((x) => String(x)) : []
    if (!ids.length) return fail('remove 要把要删的 id 放在 ids 里（比如 {ids:["i2"]}）。')
    const missing = ids.filter((id) => !b.items.some((x) => x.id === id))
    if (missing.length) return fail(`画板上没有这些 id：${missing.join('、')}。现有：${b.items.map((x) => x.id).join('、')}`)
    const candidate = b.items.filter((x) => !ids.includes(x.id))
    if (!candidate.length) {
      b.items = []
      b.rev += 1
      cleanPreviews(root, b.id, -1)
      return { ok: true, path: '', note: `删掉了 ${ids.join('、')}。画板 ${b.id} 现在空了（还能继续 add）。` }
    }
    const r = await renderBoard(b, candidate)
    if (!r.ok) return fail(r.why)
    b.items = candidate
    b.rev = r.rev
    return okBoard(b, r, `删掉了 ${ids.join('、')}`)
  }

  async function exportBoard(b) {
    const live = liveItems(b.items)
    if (!live.length) return fail('画板是空的，没有可导出的东西。先用 add 画点什么。')
    const plan = planDrawing({ canvas: b.canvas, items: live })
    if (!plan.ok) return fail(plan.why)
    const { out } = outPathFor(root)
    const report = await renderJob(plan.job, out, log, root)
    // 导出成功才删板：渲染失败就留着，她还能接着改。
    boards.delete(b.id)
    cleanPreviews(root, b.id, -1)
    const shown = slashed(out)
    return {
      ok: true,
      path: out,
      note: [
        `导出好了，存在 ${shown}。没有发给他。`,
        formatMeasureReport(report),
        `画板 ${b.id} 已经删了，不能再改；想再调就重新 create 一块。`,
        `想发就把它写成 ![白板](${shown}) 放进 her_say，桥会把 media/ 下的图单独发成一条 QQ 图片消息。`,
      ].filter(Boolean).join('\n'),
    }
  }

  function discardBoard(b) {
    boards.delete(b.id)
    cleanPreviews(root, b.id, -1)
    return { ok: true, path: '', note: `画板 ${b.id} 丢了（没导出，什么图都没留下）。` }
  }

  async function runBoardAction(action, args) {
    if (action === 'create') return createBoard(args)
    const id = String(args?.board ?? '').trim()
    const b = boards.get(id)
    if (!b) {
      return fail(`没有 ${id || '（空 id）'} 这块画板。画板只在这次运行里活着，进程重启就没了——重新 create 一块。${boardHint()}。`)
    }
    if (action === 'add') return addItems(b, args)
    if (action === 'edit') return editItems(b, args)
    if (action === 'remove') return removeItems(b, args)
    if (action === 'export') return exportBoard(b)
    if (action === 'discard') return discardBoard(b)
    return fail(`不认识的 action=${action}。能用：create / add / edit / remove / export / discard；不带 action 就是一次画一整张。`)
  }

  ctx.tools.register(
    defineTool({
      name: 'her_draw',
      description: [
        '在一张白板上画画：线条、矩形、圆、箭头、分数线、写字，位置大小颜色都由你定。',
        '讲题排算式、画示意图、画流程、圈重点都用它。',
        '两种用法：① 直接给 canvas + items，一次画成一整张成品；② 先 create 一块画板，用 add 一笔笔加、edit 按 id 改指定的一笔、remove 按 id 删，每次改动自动出一张临时预览给你 read_image 看，最后 export 才出成品。',
        '回执会附上每一笔的实测宽高和整张画占到哪，对齐靠它，不用靠画三回。',
        '⚠ 画板只在这次运行里活着（重启就没了）；预览图不是成品，别拿预览路径去发；export 成功后画板立刻删除。',
        '画得直不直、好不好看是你的手艺——它是白板，不是画师。',
      ].join(''),
      parameters: toJsonSchema({
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'add', 'edit', 'remove', 'export', 'discard'],
            description:
              '画板动作。不带 action = 一次画一整张成品（老用法，仍可用）。' +
              'create 建一块板（返回 board）；add 加笔；edit 按 id 改指定笔；remove 按 id 删；' +
              'export 出成品并立刻删掉这块板；discard 直接丢掉板子。',
          },
          board: { type: 'string', description: '画板 id（create 返回的，如 b1）。add/edit/remove/export/discard 必填。' },
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
              '笔画。add 时是要新增的笔；edit 时是带 id 的补丁（只写要改的字段，如 {id:"i2", x:120}）。' +
              'x,y 都是这一笔的**左上角**（文字也一样，不是基线）。' +
              'text=写字（x,y,text,size,color,bold）；' +
              'frac=分数线（x,y,num,den,size,color）——分子分母自动量宽居中，num/den 可以写文字、{text,size}、' +
              '或者再套一个 frac（最多 3 层）；' +
              'line/arrow=线/箭头（x1,y1,x2,y2,color,width）；' +
              'rect=矩形（x,y,w,h,color,fill）；circle=圆（cx,cy,r,color,fill）。' +
              '颜色用中文名（黑/灰/红/蓝/绿/橙/黄/紫/粉/棕/浅灰/白）或 #RRGGBB。' +
              '行高大致是字号×1.75（16 号约 28）；回执里的「高」是实测值，按它往下加 y 最准。',
          },
          ids: { type: 'array', items: { type: 'string' }, description: 'remove 要删的笔画 id（如 ["i2","i5"]）。' },
        },
        required: [],
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
        const action = String(args?.action ?? '').trim()
        try {
          if (!action) {
            // 旧行为（2026-11-08 起她已学会）：一次给完整画布与 items，直接出一张成品。
            // 画板模式不能把这条吞掉——她的历史用法与旧测试都靠它。
            const plan = planDrawing(args)
            if (!plan.ok) {
              logLine('warn', ['her_draw：没画成', plan.why], root)
              return fail(plan.why)
            }
            const { out } = outPathFor(root)
            const report = await renderJob(plan.job, out, log, root)
            logLine('info', [`her_draw：画了一张 ${plan.job.w}×${plan.job.h}，${plan.job.items.length} 笔 → ${basename(out)}`], root)
            // 只存不发（用户定案）：回执如实说没发，并把完整路径给她——
            // 只写「media/draw/」她拿不到可抄的路径，就会以为只能绕表情库（11-08 她真卡在这）。
            // 2026-11-08 再加实测几何：她连着重画了几回才把字对齐，
            // 图她能用 read_image 看，但「这行字量出来多宽、整体占到哪」看不见，只能靠试。
            const shown = slashed(out)
            const note = [
              `画好了，存在 ${shown}。没有发给他。`,
              formatMeasureReport(report),
              `想发就把它写成 ![白板](${shown}) 放进 her_say，桥会把 media/ 下的图单独发成一条 QQ 图片消息。`,
            ].filter(Boolean).join('\n')
            return { ok: true, path: out, note }
          }
          return await runBoardAction(action, args)
        } catch (err) {
          // 不吞真因（fork.13）：只说「没画成」她既不知道为什么、也没法自己改参数重画
          const why = String(err?.message ?? err).split('\n')[0].slice(0, 200)
          logLine('warn', ['her_draw：', why], root)
          return { ok: false, path: '', note: `这次没画成：${why}` }
        }
      },
    }),
  )
  log('draw: her_draw registered')
}
