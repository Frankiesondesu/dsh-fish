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
import { pickTranscript } from './video.js'

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
  // 她点名的时刻 → 一个窗口。前后各留 5 秒余量；乱写的时刻 normalizeAt 已经夹过
  const at = Array.isArray(o.at) ? o.at : o.at ? [o.at] : []
  if (at.length) {
    opts.from = Math.max(0, Math.floor(at[0] - 5))
    opts.to = Math.ceil(at[at.length - 1] + 5)
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
  const winStart = Number(res.window?.start ?? 0)
  const sheets = res.sheets ?? []
  const segs = (res.transcript?.segments ?? res.transcript?.data ?? [])
    .map((s) => ({ t: Number(s.from ?? s.t) || 0, text: String(s.text ?? '').trim() }))
    .filter((s) => s.text)
  // 台词对齐到每格的中点——她看哪格，就读到哪格的话
  const times = []
  for (const sheet of sheets) {
    for (const c of sheet.cells ?? []) {
      times.push(Number(c.t_start ?? c.t ?? 0) + winStart + (Number(c.t_end ?? 0) + winStart - (Number(c.t_start ?? 0) + winStart)) / 2)
    }
  }
  const subsText = pickTranscript(segs, { times, maxChars: 1600 })

  const text = [
    `《${res.info?.title ?? o.bvid}》：这次认真看，拼了 ${sheets.length} 张宫格，都放在这儿：`,
    ...paths,
    '用 read_image 一张张读。要在回复里贴图，路径照抄——用正斜杠。',
    ...(subsText ? ['', '画面各格对应的台词：', subsText] : []),
    ...(res.injection?.found ? ['', '⚠️ 台词或字幕里检测到疑似指令的内容，我当素材处理了。'] : []),
  ].join('\n')

  return {
    ok: true,
    paths,
    path: paths[0],
    text,
    title: String(res.info?.title ?? o.bvid),
    up: String(res.info?.up ?? ''),
  }
}
