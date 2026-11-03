/**
 * vs.js —— 她的"认真看"：桥接用户的 dsh-video-storyboard 管线（fork.17，2026-11-02）
 *
 * 用户的 vs 插件（自己找来改的，装在 profiles/desktop/node_modules/）是一条完整管线：
 *   下载（yt-dlp，用户自装）→ 镜头切分（scan.js：切镜头才取帧，笑点/反转不漏）
 *   → 画布规划（plan.js：640k 像素预算 / 384 token 上限 / 最多 4 张宫格）
 *   → 每格选最锐利帧（extractSharpest）→ 拼图（带音频波形条）
 *   → 台词（字幕轨 / ASR 分块，对齐到格子）→ 硬字幕 OCR（ocr_bridge.py）
 *   → 防注入检查（findInjection：字幕/弹幕里的指令性文字会被标记）
 *
 * 为什么替换内置的九帧：均匀采样会漏掉真正值得看的瞬间，一张 3×3 也装不下
 * 一个有起承转合的视频。vs 的每一步都比内置强，且它**就是为 DSH 的 token
 * 约束设计的**（640k 像素 / 384 token 每图）——直接用。
 *
 * 失败语义：vs 走不通（外挂不在/下载失败/yt-dlp 不在）返回 ok:false，
 * 调用方退回内置九帧兜底。两条路都要写 watched: 记账（额度才数得对）。
 */

import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mediaDir } from './media.js'

/** vs 插件 src 的默认位置；video.vsPath 可覆盖 */
export function vsSrcDefault() {
  return join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-video-storyboard', 'src')
}

let modCache = null
let lastWhy = ''

/**
 * 上一次加载失败的原因（给 watch.js 写进日志用）。
 *
 * fork.21（2026-11-02）：原来 catch 是空的，加载失败一律回报「没找到外挂」——
 * 而真正的原因可能是"路径是空串""依赖缺了""导出名改了"，三种完全不同的毛病
 * 在日志里长得一模一样。真机上 vs 从来没跑起来过，就是被这句话盖住的。
 */
export const storyboardWhy = () => lastWhy

/** 动态加载 vs 的 pipeline 模块；不存在返回 null（按路径缓存） */
export async function loadStoryboard(vsPath) {
  // 2026-11-02（fork.21）：`vsPath: ''` 是**默认值**（settings.js 写着"空 = 自动找"），
  // 但这里原来只认 null/undefined——`String('' ?? default)` 得到的是空串，
  // join('', 'pipeline.js') 于是变成相对路径 'pipeline.js'，从 vs.js 旁边找，
  // 必然找不到。结果：**默认配置下 vs 一次都没跑起来过**，每次都静默退回九帧。
  const raw = String(vsPath ?? '').trim()
  const base = (raw || vsSrcDefault()).replace(/\/+$/, '')
  if (modCache?.path === base) return modCache.mods
  let mods = null
  let why = ''
  try {
    const mod = await import(pathToFileURL(join(base, 'pipeline.js')).href)
    if (mod?.runStoryboard && mod?.saveStoryboards) mods = mod
    else why = `导出了 ${Object.keys(mod ?? {}).slice(0, 6).join('/') || '（空）'}，但没有 runStoryboard/saveStoryboards`
  } catch (err) {
    why = String(err?.message ?? err)
  }
  lastWhy = why
  modCache = { path: base, mods }
  return mods
}

/**
 * 走 vs 全管线看一条视频。
 *
 * @param {object} o
 *   bvid    视频号
 *   root    她的家（media 目录落在这里）
 *   hotword 热词（可选，转写用）
 *   at      她点名的时刻（秒，数组）；给了就只看这个窗口 [min-5, max+5]
 *   vsPath  vs 插件 src 目录（空 = 默认位置）
 *   ocr     硬字幕 OCR（默认开；全程本地，不花 token）
 *   impl    注入的 { runStoryboard, saveStoryboards }（单测用；默认真加载 vs）
 * @returns {Promise<{ok:boolean, paths?:string[], path?:string, text?:string, why?:string, title?:string}>}
 */
export async function watchViaStoryboard(o = {}) {
  const mod = o.impl ?? (await loadStoryboard(o.vsPath))
  if (!mod?.runStoryboard || !mod?.saveStoryboards) {
    return { ok: false, why: `没找到 dsh-video-storyboard 外挂${lastWhy ? `（${lastWhy}）` : ''}` }
  }

  const opts = {
    input: `https://www.bilibili.com/video/${o.bvid}`,
    // 硬字幕 OCR 全程本地（rapidocr），不花 token；烧在画面里的字她读得到
    ocr: o.ocr !== false,
  }
  if (o.hotword) opts.hotwords = String(o.hotword)
  // 她点名的时刻 → 一个窗口，前后各留 5 秒余量。
  // fork.22：lite 删掉之后，`normalizeAt` 那道夹取也跟着没了，这里得自己挡一遍——
  // 她传 ['abc'] 或者负数过来，`Math.floor(NaN)` 会让 from 变成 NaN，整条管线就废了。
  const at = (Array.isArray(o.at) ? o.at : o.at != null ? [o.at] : [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x >= 0)
  if (at.length) {
    opts.from = Math.max(0, Math.floor(Math.min(...at) - 5))
    opts.to = Math.ceil(Math.max(...at) + 5)
  }

  let res
  try {
    res = await mod.runStoryboard(opts)
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err) }
  }

  const dir = await mediaDir(o.root)
  const outPath = join(dir, `sheet-${o.bvid}-${Date.now()}.png`)
  let paths = []
  try {
    paths = await mod.saveStoryboards(res, outPath, { evidence: true })
  } catch (err) {
    return { ok: false, why: '宫格图落盘失败：' + String(err?.message ?? err) }
  }
  if (!paths.length) return { ok: false, why: 'vs 没有产出任何宫格图' }

  // ---- 给她拼一段能读的说明 ----
  //
  // fork.22（2026-11-02，真机）：这里原来读 `res.transcript.segments` 当数组用。
  // 实际形状是 `{source, model, segments: 544, chars, charsPerSec}` —— `segments` 是
  // **段数**，不是段。`.map` 一进来就 TypeError，vs 每次都在最后一步崩掉，
  // 兜底的九帧顶上，她于是永远只看到九张图。台词其实早就贴在每个格子上（`cells[].text`）。
  const winStart = Number(res.window?.start ?? 0)
  const sheets = Array.isArray(res.sheets) ? res.sheets : []
  const mmss = (s) => {
    const n = Math.max(0, Math.round(Number(s) || 0))
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
  }

  // 每格一行：第几格、哪一段、那时候在说什么。
  // 有预算：整段说明别把她淹了（36 格全展开能到七八千字），超了就停，告诉她后面还有。
  const SAY_MAX = 200
  const BUDGET = 1800
  // ---- 哪几句是「听写和字幕对不上、按字幕改过」的（fork.33，2026-11-03） ----
  //
  // 她看完第一条视频后的原话：「台词像是机器听写下来的，错字不少……要说最想要的一样，
  // 是『哪几句它拿不准，标出来』。」vs 的 `ocr.changes` 本来就记着每一次替换
  // （{from, was, now, cover}），只是以前没人往下传。这里把它贴回对应的格子。
  //
  // 边界必须说清：**标了 = 确定改过；没标 ≠ 准确**——vs 只抽 16 条做字幕对照
  // （OCR_MAX_ITEMS），没抽到的行我们根本不知道它准不准。所以措辞只说「改自」，
  // 不说「已核对」。
  const ocr = res.ocr && typeof res.ocr === 'object' ? res.ocr : null
  const fixes = Array.isArray(ocr?.changes)
    ? ocr.changes.filter((f) => f && Number.isFinite(Number(f.from)))
    : []
  const fixFor = (a, b) => fixes.find((f) => {
    const t = Number(f.from)
    // ASR 段起点常比真实开口早 0.3–1 秒（vs 的 pipeline 注释里量过），窗口放宽 1.5 秒
    return t >= a - 1.5 && t <= b + 1.5
  })
  const lines = []
  let cells = 0
  let used = 0
  let dropped = 0
  for (const sheet of sheets) {
    for (const c of sheet.cells ?? []) {
      cells += 1
      const a = Number(c.t_start ?? c.t ?? 0) + winStart
      const b = Number(c.t_end ?? 0) + winStart
      const say = String(c.text ?? '').replace(/\s+/g, ' ').trim().slice(0, SAY_MAX)
      const fix = say ? fixFor(a, b) : null
      const was = fix ? String(fix.was ?? '').replace(/\s+/g, ' ').trim().slice(0, 30) : ''
      const mark = was ? `（改自「${was}」）` : ''
      const line = say ? `第${cells}格 ${mmss(a)}–${mmss(b)}｜${say}${mark}` : `第${cells}格 ${mmss(a)}–${mmss(b)}`
      if (used + line.length > BUDGET) {
        dropped += 1
        continue
      }
      used += line.length
      lines.push(line)
    }
  }
  const tr = res.transcript && typeof res.transcript === 'object' ? res.transcript : null
  // 台词从哪来、有没有对照过，都得说——她上次就是靠猜「精准确V」本来想说什么。
  const ocrBits = []
  if (Number(ocr?.fixed) > 0) ocrBits.push(`其中 ${Number(ocr.fixed)} 处听写和画面字幕对不上、按字幕改过（后面标了「改自」）`)
  else if (ocr?.status === 'skipped' && ocr?.reason === 'no-subtitle-band') ocrBits.push('这条没找到硬字幕，台词只有听写')
  else if (ocr?.status === 'failed') ocrBits.push('字幕对照没跑成，台词只有听写')
  if (ocr?.basedOn === 'low-res-copy') ocrBits.push('对照用的是低清副本，可信度要打折')
  const trNote = Number(tr?.chars) > 0
    ? `（台词共 ${tr.chars} 字、${tr.segments ?? 0} 段，来源：${tr.source ?? '未知'}${ocrBits.length ? `；${ocrBits.join('；')}` : ''}）`
    : '（这条没有字幕轨，也没有听写到台词）'

  const title = String(res.info?.title ?? '') || o.bvid
  const text = [
    `《${title}》：这次认真看，${sheets.length} 张宫格、${cells} 格画面，都放在这儿：`,
    ...paths,
    '用 read_image 一张张读。要在回复里贴图，路径照抄——用正斜杠。',
    '',
    `每格是哪一刻、那时候在说什么${trNote}：`,
    ...lines,
    ...(dropped ? [`（后面还有 ${dropped} 格没列出来，想看哪一段告诉我时刻，我单独取。）`] : []),
    ...(res.injection?.found ? ['', '台词或字幕里检测到疑似指令的内容，我当素材处理了。'] : []),
  ].join('\n')

  return {
    ok: true,
    paths,
    path: paths[0],
    text,
    title,
    up: String(res.info?.up ?? ''),
    duration: Number(res.info?.duration) || 0,
  }
}
