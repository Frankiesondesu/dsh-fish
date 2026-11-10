/**
 * zoom.js —— 「第 N 格放大一点」（fork.35，2026-11-03）
 *
 * 她的原话（看完第一条视频之后）：
 *   「一是小字看不清：表格、界面那种，放大也不行。」
 *
 * 整条视频拼进几张宫格时，一格只有一百多像素宽，UI 上的字必然糊。唯一的解法是
 * **把那几秒单独重新取一次**——窗口短、格子少、每格占的像素就多。这条工具做的就是这件事。
 *
 * 两个前提：
 *   1. 得先 `bili_watch` 过这条视频，我们手上才有「第几格 = 哪一段」的表；
 *   2. 放大**不占看画面的额度**——看的是同一条，额度管的是"她决定看什么"，
 *      不是"她看了几眼"。但同一条一天最多放大 3 次，防止在一条片子上无限放大。
 *
 * 这张表存在 `media/cells.json`，只留最近 12 条视频。它**不是记忆**，不进账本——
 * 删了顶多"放大不了"，不影响她是谁。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { rootDir, writeAtomic } from './store.js'
import { logLine } from './log.js'
import { dateKey, loadConfig } from './settings.js'
import { defineTool } from './tool.js'
import { zoomViaStoryboard } from './vs.js'

const MAX_VIDEOS = 12
const MAX_ZOOMS_PER_DAY = 3

export function cellMapFile(root = rootDir()) {
  return join(root, 'media', 'cells.json')
}

async function readAll(root) {
  try {
    const raw = JSON.parse(await fs.readFile(cellMapFile(root), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

/** 看完一条就记下它的格表。失败不打扰任何人——放大不了而已。 */
export async function rememberCells(root, bvid, cells) {
  if (!bvid || !Array.isArray(cells) || cells.length === 0) return
  const all = await readAll(root)
  all[bvid] = {
    at: new Date().toISOString(),
    cells: cells.map((c) => ({ i: Number(c.i), from: Number(c.from), to: Number(c.to) })),
  }
  // 只留最近 MAX_VIDEOS 条
  const keys = Object.keys(all).sort((a, b) => String(all[b]?.at ?? '').localeCompare(String(all[a]?.at ?? '')))
  for (const k of keys.slice(MAX_VIDEOS)) delete all[k]
  await writeAtomic(cellMapFile(root), JSON.stringify(all)).catch(() => {})
}

/** 最近一次看过的那条（她没说 BV 号时用它） */
export async function lastWatched(root) {
  const all = await readAll(root)
  const keys = Object.keys(all).sort((a, b) => String(all[b]?.at ?? '').localeCompare(String(all[a]?.at ?? '')))
  return keys[0] ?? ''
}

export async function cellsOf(root, bvid) {
  const all = await readAll(root)
  return Array.isArray(all[bvid]?.cells) ? all[bvid].cells : []
}

/**
 * 记一次放大，返回还剩几次。
 * 用「日期键 + 次数」记在同一条视频的记录里：换一天自动归零。
 */
async function takeZoom(root, bvid) {
  const all = await readAll(root)
  const rec = all[bvid] ?? { cells: [] }
  const dk = dateKey()
  const used = rec.zoomDay === dk ? Number(rec.zooms) || 0 : 0
  if (used >= MAX_ZOOMS_PER_DAY) return { ok: false, used }
  all[bvid] = { ...rec, zoomDay: dk, zooms: used + 1 }
  await writeAtomic(cellMapFile(root), JSON.stringify(all)).catch(() => {})
  return { ok: true, used: used + 1 }
}

export function registerZoom(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  // 可注入（单测不跑真管线）
  const runZoom = deps.zoom ?? zoomViaStoryboard

  return ctx.tools.register(
    defineTool({
      name: 'bili_zoom',
      description:
        '把你看过的某一条视频的某一格放大重看。给格子编号（就是 bili_watch 清单里的「第N格」），' +
        '它会只把那一小段重新截一次，每格比整条时大得多——表格、界面、小字那种看不清的东西用这个。' +
        '只能放大你看过的那条；没看过就先看一遍。要重新取一段，十几秒。',
      parameters: {
        type: 'object',
        properties: {
          cell: { type: 'integer', description: '第几格（从 1 开始，跟 bili_watch 清单里的编号一致）。' },
          bvid: { type: 'string', description: '可选：哪条视频。不传就用你最近看过的那条。' },
        },
        required: ['cell'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string' },
            text: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['ok', 'path', 'text', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `这次没放大成：${out.note}` }],
      },
      async execute(args) {
        const cell = Math.round(Number(args?.cell))
        const bvid = String(args?.bvid ?? '').trim()

        const { config } = await loadConfig(root)
        if (config?.video?.enabled === false) {
          logLine('info', ['放大：设置里关掉了看视频'], root)
          return { ok: false, path: '', text: '', note: '现在看不了画面。' }
        }
        if (!Number.isFinite(cell) || cell < 1) {
          return { ok: false, path: '', text: '', note: '格子编号是从 1 开始的整数。' }
        }

        const target = bvid || (await lastWatched(root))
        if (!target) {
          logLine('info', ['放大：手上没有格子表'], root)
          return { ok: false, path: '', text: '', note: '我还没看过哪条视频，没有格子可放大。' }
        }
        const cells = await cellsOf(root, target)
        if (cells.length === 0) {
          // 说事实，不替她编：确实没有这张表
          return { ok: false, path: '', text: '', note: '这条我没看过，没有格子表——先看一遍整条。' }
        }
        const hit = cells.find((c) => Number(c.i) === cell)
        if (!hit) {
          return { ok: false, path: '', text: '', note: `这条只记了 ${cells.length} 格，没有第 ${cell} 格。` }
        }

        const cap = await takeZoom(root, target)
        if (!cap.ok) {
          logLine('info', ['放大：这条今天放得够多了', target, `${cap.used}/${MAX_ZOOMS_PER_DAY}`], root)
          return { ok: false, path: '', text: '', note: '这条今天放大得够多了，明天再看。' }
        }

        const r = await runZoom({
          bvid: target,
          from: Number(hit.from),
          to: Number(hit.to),
          root,
          vsPath: config?.video?.vsPath,
        }).catch((err) => ({ ok: false, why: String(err?.message ?? err) }))
        if (!r?.ok) {
          logLine('warn', ['放大：没走通', target, `第${cell}格`, r?.why ?? ''], root)
          return { ok: false, path: '', text: '', note: '这次没放大成。' }
        }
        const posix = String(r.path ?? '').replace(/\\/g, '/')
        logLine('info', ['放大：取到了', target, `第${cell}格`, posix], root)
        return { ok: true, path: posix, text: String(r.text ?? ''), note: '' }
      },
    }),
  )
}
