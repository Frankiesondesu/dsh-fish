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
import { slashed } from './posix.js'

/** vs 插件 src 的默认位置；video.vsPath 可覆盖 */
export function vsSrcDefault() {
  return join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-video-storyboard', 'src')
}

/**
 * 入口文件的候选路径（2026-11-03，vs 0.6.5 挪了位置）。
 *
 * 0.6.4 及以前：`<src>/pipeline.js`
 * 0.6.5 起：    `<src>/storyboard/pipeline.js`（package.json 的 `./pipeline` 子路径跟着改）
 *
 * 这条路径硬编码过一次，插件一升级就整条路断掉——而且断得很安静：
 * 只报「没找到外挂」，她那边就是「这次没看成」。所以这里按版本列候选，
 * 谁能导出 runStoryboard + saveStoryboards 就用谁。
 * 另外也容忍 vsPath 指到**包根**而不是 src（用户手动配的时候两种都可能）。
 */
export function entryCandidates(base) {
  const b = String(base ?? '').replace(/[\\/]+$/, '')
  if (!b) return []
  return [
    join(b, 'pipeline.js'),                    // ≤0.6.4
    join(b, 'storyboard', 'pipeline.js'),      // ≥0.6.5
    join(b, 'src', 'pipeline.js'),             // vsPath 指到包根
    join(b, 'src', 'storyboard', 'pipeline.js'),
  ]
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
  const base = (raw || vsSrcDefault()).replace(/[\\/]+$/, '')
  if (modCache?.path === base) return modCache.mods
  let mods = null
  const tried = []
  for (const file of entryCandidates(base)) {
    try {
      const mod = await import(pathToFileURL(file).href)
      if (mod?.runStoryboard && mod?.saveStoryboards) { mods = mod; break }
      tried.push(`${file}：导出了 ${Object.keys(mod ?? {}).slice(0, 5).join('/') || '（空）'}，但没有 runStoryboard/saveStoryboards`)
    } catch (err) {
      tried.push(`${file}：${String(err?.message ?? err).slice(0, 120)}`)
    }
  }
  // 全失败时把**每条候选**的原因都留下来：插件升级挪位置是常态，
  // 只报「没找到」的话，下一次还是得把这段代码重读一遍。
  lastWhy = mods ? '' : tried.join(' ｜ ')
  modCache = { path: base, mods }
  return mods
}

/**
 * 走 vs 全管线看一条视频。
 *
 * @param {object} o
 *   bvid    视频号（本地视频时不传）
 *   input   本地视频绝对路径；传了就走本地，不拼 B 站 URL（2026-11-06）
 *   name    本地视频的显示名（本地时用）
 *   tag     落盘宫格图用的标识（本地时用，默认取 bvid）
 *   root    她的家（media 目录落在这里）
 *   hotword 热词（可选，转写用）
 *   at      她点名的时刻（秒，数组）；给了就只看这个窗口 [min-5, max+5]
 *   vsPath  vs 插件 src 目录（空 = 默认位置）
 *   ocr     硬字幕 OCR（默认开；全程本地，不花 token）
 *   ffmpegPath / ffprobePath  本地视频可显式指定（绕开 PATH 里的旧 ffmpeg）
 *   impl    注入的 { runStoryboard, saveStoryboards }（单测用；默认真加载 vs）
 * @returns {Promise<{ok:boolean, paths?:string[], path?:string, text?:string, why?:string, title?:string}>}
 */
export async function watchViaStoryboard(o = {}) {
  const mod = o.impl ?? (await loadStoryboard(o.vsPath))
  if (!mod?.runStoryboard || !mod?.saveStoryboards) {
    return { ok: false, why: `没找到 dsh-video-storyboard 外挂${lastWhy ? `（${lastWhy}）` : ''}` }
  }

  // 2026-11-06：vs 的 runStoryboard 本来就吃「视频路径」——fetch.js 的 resolveInput
  // 对本地路径原样返回，只有 http 链接才交给 yt-dlp 下载。以前我们只拼了 B 站 URL，
  // 所以她看不了他直接递过来的本地 mp4。传 input 就走本地，其余整条管线一字不改。
  const local = Boolean(o.input)
  const opts = {
    input: local ? String(o.input) : `https://www.bilibili.com/video/${o.bvid}`,
    // 硬字幕 OCR 全程本地（rapidocr），不花 token；烧在画面里的字她读得到
    ocr: o.ocr !== false,
  }
  if (o.hotword) opts.hotwords = String(o.hotword)
  // 本地视频显式带上 WinGet 的 ffmpeg（PATH 里那个是旧版），避免 probe / 取帧踩坑
  if (o.ffmpegPath) opts.ffmpegPath = String(o.ffmpegPath)
  if (o.ffprobePath) opts.ffprobePath = String(o.ffprobePath)
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
  // 本地视频没有 bvid，用它自己的名字当落盘标识；清洗掉非 ASCII 与路径字符
  const tag = String(o.tag || o.bvid || 'local').replace(/[^A-Za-z0-9_-]/g, '_')
  const outPath = join(dir, `sheet-${tag}-${Date.now()}.png`)
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
  const cellList = []
  let cells = 0
  let used = 0
  let dropped = 0
  for (const sheet of sheets) {
    for (const c of sheet.cells ?? []) {
      cells += 1
      const a = Number(c.t_start ?? c.t ?? 0) + winStart
      const b = Number(c.t_end ?? 0) + winStart
      // 记下「第几格 = 哪一段」：她之后要放大某一格，靠的就是这张表（fork.35）。
      cellList.push({ i: cells, from: a, to: b })
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
  //
  // 2026-11-03（实测三条片子）：她的错字**不是**我们听写错了，是 B 站自己的
  // AI 字幕（`site-cc:ai-zh`）就是机器听写。这跟 `site-cc:zh`（上传者给的字幕）
  // 是两回事，跟 `asr`（我们自己听写）也是两回事——三种成色，必须分开说。
  const src = String(tr?.source ?? '')
  const model = String(tr?.model ?? '')
  const isSiteCc = /site-cc/i.test(model)
  const srcText = src === 'asr'
    ? '我们自己听写的'
    : isSiteCc && /ai/i.test(model)
      ? 'B 站 AI 字幕，机器听写、可能有错字'
      : isSiteCc
        ? '上传者给的字幕'
        : (src || '未知')
  const ocrBits = []
  if (Number(ocr?.fixed) > 0) ocrBits.push(`其中 ${Number(ocr.fixed)} 处听写和画面字幕对不上、按字幕改过（后面标了「改自」）`)
  else if (ocr?.status === 'skipped' && ocr?.reason === 'no-subtitle-band') ocrBits.push('这条没找到硬字幕，台词只有听写')
  else if (ocr?.status === 'failed') ocrBits.push('字幕对照没跑成，台词只有听写')
  if (ocr?.basedOn === 'low-res-copy') ocrBits.push('对照用的是低清副本，可信度要打折')
  const trNote = Number(tr?.chars) > 0
    ? `（台词共 ${tr.chars} 字、${tr.segments ?? 0} 段，来源：${srcText}${ocrBits.length ? `；${ocrBits.join('；')}` : ''}）`
    : '（这条没有字幕轨，也没有听写到台词）'

  const title = String(res.info?.title ?? '') || (local ? String(o.name || '本地视频') : o.bvid)
  const text = [
    `《${title}》：这次认真看，${sheets.length} 张宫格、${cells} 格画面，都放在这儿：`,
    // 说明里列给她的路径必须是正斜杠：宿主渲染 markdown 图片时拿它拼 /api/file，
    // 反斜杠会解析失败显示「无法预览」（2026-10-26 实测；watch.js 早就转了 r.path，
    // 这里漏了 text 里那几行，于是「路径照抄——用正斜杠」这句话反而和列出来的路径对不上）。
    ...paths.map(slashed),
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
    // 格表（绝对秒）：watch.js 会存下来，供 bili_zoom 把「第 N 格」翻成时间段。
    cells: cellList,
  }
}

/**
 * 放大看一小段（fork.35，2026-11-03）。
 *
 * 她看完一条之后说「表格、界面那种小字，放大也不行」——整条视频拼进 4 张宫格时，
 * 每格只有一百多像素宽，UI 上的字必然糊。**唯一的解法是把那几秒单独重新取一次**：
 * 窗口短 → 格子少 → 每格占的像素多。
 *
 * 这里不做「按 cellId 查表」那套（vs 自己有 video_zoom，但它要宿主的 attachment 服务，
 * 从我们这个插件里调不稳）。我们走同一条 runStoryboard，只是把窗口卡到那一格。
 */
export async function zoomViaStoryboard(o = {}) {
  const mod = o.impl ?? (await loadStoryboard(o.vsPath))
  if (!mod?.runStoryboard || !mod?.saveStoryboards) {
    return { ok: false, why: `没找到 dsh-video-storyboard 外挂${lastWhy ? `（${lastWhy}）` : ''}` }
  }
  const from = Math.max(0, Number(o.from) - 0.4)
  const to = Math.max(from + 0.8, Number(o.to) + 0.4)
  const opts = {
    input: `https://www.bilibili.com/video/${o.bvid}`,
    from,
    to,
    // 一张图、几格、按画面大小均匀铺（sqrt(n) × sqrt(n)）——这正是"放大"的来源
    maxSheets: 1,
    minFrames: 4,
    uniformTier: 'auto',
    pick: 'sharp',
    // 放大只为看清画面；台词这一段已经在主清单里给过了，不再花时间做 OCR 校正
    ocr: false,
  }
  let res
  try {
    res = await mod.runStoryboard(opts)
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err) }
  }

  const dir = await mediaDir(o.root)
  const outPath = join(dir, `zoom-${o.bvid}-${Math.round(from)}-${Date.now()}.png`)
  let paths = []
  try {
    paths = await mod.saveStoryboards(res, outPath, { evidence: false })
  } catch (err) {
    return { ok: false, why: '放大图落盘失败：' + String(err?.message ?? err) }
  }
  if (!paths.length) return { ok: false, why: 'vs 没有产出放大图' }

  const winStart = Number(res.window?.start ?? 0)
  const mmss = (s) => {
    const n = Math.max(0, Math.round(Number(s) || 0))
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
  }
  const cells = []
  for (const sheet of Array.isArray(res.sheets) ? res.sheets : []) {
    for (const c of sheet.cells ?? []) {
      const a = Number(c.t_start ?? 0) + winStart
      const b = Number(c.t_end ?? 0) + winStart
      const say = String(c.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
      cells.push({ i: cells.length + 1, a, b, say })
    }
  }
  const text = [
    `放大 ${mmss(from)}–${mmss(to)} 这一段：${paths.length} 张图、${cells.length} 格。`,
    ...paths,
    '用 read_image 读。这一段每格比整条时大得多。',
    ...cells.map((c) => `第${c.i}格 ${mmss(c.a)}–${mmss(c.b)}${c.say ? `｜${c.say}` : ''}`),
  ].join('\n')

  return { ok: true, path: paths[0], paths, text, from, to, cells: cells.map((c) => ({ i: c.i, from: c.a, to: c.b })) }
}
