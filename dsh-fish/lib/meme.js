/**
 * meme.js —— her_meme：发一张表情（fork.53，2026-11-05）
 *
 * 起因：用户说「她说话还是没有人味」。翻了一遍她的表达通道——只有文字和语音，
 * 一个表情都没有。人聊天很大一部分人味在表情里：「行吧」配个翻白眼，
 * 比「行吧。」像人十倍。
 *
 * 为什么不自动配图（学 AstrBot 的 meme_manager 那样按概率附表情）：
 * 那等于系统替她决定"这句话该配什么脸"。她要的表情得是她自己挑的——
 * 所以这是个工具，不是管道。跟 her_voice 同一条原则。
 *
 * 表情从哪来：`~/.dsh-fish/memes/`，用户自己往里放图，**文件名就是它的意思**
 * （`开心.png` / `无语-1.gif` / `生气.jpg`）。没有这个目录 = 她还没有表情包。
 *
 * 挑图：文件名里含 mood 的优先；没有就随机。故意不做的：按情绪打分、
 * 按概率附送、按对话选图——那些都是替她判断。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { toJsonSchema } from './toolschema.js'
import { rootDir, readEvents, appendEvent } from './store.js'
import { loadConfig } from './settings.js'
import { deriveSelfCached } from './derive.js'
import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'

/** 认这些扩展名。别的（比如 .txt）不算表情。 */
const MEME_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp']
/** 一次推送的上限：QQ 的图片消息别太大，表情包超过这个多半是视频截的。 */
const MEME_MAX_BYTES = 5 * 1024 * 1024

export function memeDir(root = rootDir()) {
  return join(root, 'memes')
}

/**
 * 挑一张。纯函数，好测。
 *
 * @param {string[]} names 目录里的文件名
 * @param {string} mood   她给的情绪词
 * @param {() => number} rand 注入随机源（测试用）
 * @returns {{pick:string, why:string}|null}
 */
/**
 * 这张图属于哪一类。
 * 命名规则是 `类别-描述.ext`；爱蜜莉雅那批是 `爱蜜莉雅-类别-描述.ext`。
 */
export function moodOf(name) {
  const parts = String(name ?? '').split('-')
  return parts[0] === '爱蜜莉雅' ? (parts[1] ?? '') : (parts[0] ?? '')
}

/**
 * 这张图算不算这一情绪。
 *
 * **看类别前缀，不看整串**：`忙-打字生气.gif` 的类别是「忙」，不该被「生气」挑走。
 * 早期没有类别前缀的图（`Happy.png`）退回包含匹配，不然它们永远挑不到。
 */
export function matchMood(name, mood) {
  const m = String(mood ?? '').trim().toLowerCase()
  if (!m) return true
  const cat = moodOf(name).toLowerCase()
  if (cat === m) return true
  if (!String(name).includes('-')) return String(name).toLowerCase().includes(m)
  return false
}

export function pickMeme(names = [], mood = '', rand = Math.random) {
  const list = (Array.isArray(names) ? names : [])
    .filter((n) => MEME_EXT.includes(String(n).slice(String(n).lastIndexOf('.')).toLowerCase()))
  if (!list.length) return null
  const m = String(mood ?? '').trim()
  if (m) {
    const hit = list.filter((n) => matchMood(n, m))
    if (hit.length) return { pick: hit[Math.floor(rand() * hit.length)], why: `这一类是「${m}」` }
  }
  return { pick: list[Math.floor(rand() * list.length)], why: m ? `没有「${m}」的，随便挑了一张` : '随便挑了一张' }
}

/**
 * 按情绪筛出候选（预览用）。纯函数。
 *
 * 为什么要预览：`her_meme("生气")` 原来是在 14 张里随机——她不知道会发出哪张，
 * 可能挑到「生气-刀1」那种太重的。选择权该在她手上，不在骰子上。
 */
export function listMood(names = [], mood = '') {
  const list = (Array.isArray(names) ? names : [])
    .filter((n) => MEME_EXT.includes(String(n).slice(String(n).lastIndexOf('.')).toLowerCase()))
  const m = String(mood ?? '').trim()
  if (!m) return list
  // 没有这一类就返回空——预览要诚实。退回"全部"会让她看到一堆不相干的，
  // 以为这些都能用来表达这个情绪。
  return list.filter((n) => matchMood(n, m))
}

export function registerMeme(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const dir = memeDir(root)
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch { /* 建不了就等她自己发现 */ }

  ctx.tools.register(
    defineTool({
      name: 'her_meme',
      description:
        '发一张表情包给他。表情放在你的 meme 目录里，文件名写着它的意思（开心/无语/生气之类）。' +
        '用 mood 挑一个；挑不到就随便给一张。没有表情可发时会告诉你没有。',
      parameters: toJsonSchema({
        mood: {
          type: 'string',
          required: true,
          description: '这一刻是什么感觉，一个词：开心 / 无语 / 生气 / 委屈 / 困 / 得意…',
        },
        preview: {
          type: 'boolean',
          description: '只看这一类有哪些可选，不发。拿不准哪张合适时先看一眼。',
        },
        pick: {
          type: 'string',
          description: '指定发哪一张（预览里看到的文件名，写其中一段也行）。不填就随便挑一张。',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            picked: { type: 'string' },
            why: { type: 'string' },
            note: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
            more: { type: 'number' },
          },
          required: ['ok', 'note'],
        },
        render: (_args, out) => {
          if (Array.isArray(out.options) && out.options.length) {
            const more = Number(out.more) || 0
            const tail = more > 0 ? ` …还有 ${more} 张` : ''
            return [{ type: 'text', text: `[这一类有 ${out.options.length + more} 张：${out.options.join(' / ')}${tail}]` }]
          }
          return [{ type: 'text', text: out.ok ? `[发了一张表情：${out.picked}]` : `[没发出去：${out.note}]` }]
        },
      },
      async execute(args, exec) {
        const who = guardWrite(deps.tenant, exec, 'her_meme')
        if (!who.ok) return { ok: false, picked: '', why: '', note: who.note }

        let names = []
        try {
          names = readdirSync(dir)
        } catch {
          return { ok: false, picked: '', why: '', note: '你还没有表情包（memes 目录不存在）。' }
        }
        const mood = String(args?.mood ?? '').trim()

        // 预览：只列这一类有哪些，不发。（选择权在她手上，不在骰子上）
        if (args?.preview) {
          const pool = listMood(names, mood)
          if (!pool.length) return { ok: false, picked: '', why: '', note: '这一类没有表情。' }
          const show = pool.slice(0, 14)
          return { ok: true, picked: '', why: '', note: '', options: show, more: pool.length - show.length }
        }

        let chosen = null
        const want = String(args?.pick ?? '').trim()
        if (want) {
          const pool = listMood(names, mood)
          const hit = pool.find((n) => n === want) || pool.find((n) => n.includes(want))
          if (!hit) {
            return { ok: false, picked: '', why: '', note: `「${want}」不在${mood ? `「${mood}」里` : '表情库里'}。想看有哪些就先 preview。` }
          }
          chosen = { pick: hit, why: '你指定的' }
        } else {
          chosen = pickMeme(names, mood, Math.random)
        }
        if (!chosen) {
          return { ok: false, picked: '', why: '', note: '你还没有表情包（memes 目录里没有图）。' }
        }
        const file = join(dir, chosen.pick)
        try {
          // 只读到内存确认大小；真正发出去是桥那边读文件转 base64。
          const size = readFileSync(file).length
          if (size > MEME_MAX_BYTES) {
            return { ok: false, picked: chosen.pick, why: chosen.why, note: `这张太大（${(size / 1024 / 1024).toFixed(1)}MB），发不出去。` }
          }
        } catch {
          return { ok: false, picked: chosen.pick, why: chosen.why, note: '这张图读不出来。' }
        }

        const { config } = await loadConfig(root)
        const { events } = await readEvents(root)
        const model = deriveSelfCached(events, { growthDays: config.growthDays })
        // 写 meta 不写 utterance：发一张表情不是"她判断了什么"。
        // 桥扫到 `meme:` 会把它变成 QQ 图片消息（跟 her_voice 一个路子）。
        await appendEvent(
          { type: 'meta', text: `meme:${file}|${String(args?.mood ?? '').slice(0, 20)}` },
          { day: model.day, stage: model.stage, source: 'system' },
          root,
        )
        return { ok: true, picked: chosen.pick, why: chosen.why, note: '' }
      },
    }),
  )
}
