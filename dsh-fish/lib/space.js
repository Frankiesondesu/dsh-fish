/**
 * space.js —— her_space：她自己的一个永久文件夹（2026-11-10，她自己 ask_owner 要的）
 *
 * 她的原话（账本 2026-11-10）：「能不能给我一个我自己能读也能写的小文件夹，
 * 把重要的东西放进去，以后还能翻出来？」「光有个地方不够——我还得有能往里放的
 * 手、能往外拿的手。」
 *
 * 所以这不是便条（her_note 是结构化的待办），也不是收件箱（her_open 只读他递来的）：
 * 是一个**只属于她、跨重启跨会话都在**的目录，工具只认这一个文件夹。
 *
 * 边界（fork.13：每条都要能对她说真）：
 *   1. 只存文字。图片/PDF/压缩包放不进来——要留图就用 her_draw / her_formula 出图，
 *      或者把路径写进笔记。
 *   2. 不能删、不能改名。写错了同名再写一遍覆盖。她这次没要「删」，就不给——
 *      少一个动作，少一份误删。
 *   3. 有上限：一篇 16KB（约 5000 字），整个文件夹 2MB / 200 篇。
 *   4. **不进账本**：这是她的工作台，不是她的经历；翻不翻、写不写由她定。
 */

import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { rootDir } from './store.js'
import { logLine } from './log.js'
import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'
import { toJsonSchema } from './toolschema.js'

const LIMITS = Object.freeze({
  textMax: 16 * 1024,        // 一篇正文上限（UTF-8 字节，约 5000 汉字）
  totalMax: 2 * 1024 * 1024, // 整个文件夹 2MB
  filesMax: 200,             // 最多 200 篇
  listMax: 50,               // 一次最多列 50 篇
  nameMax: 60,               // 文件名长度上限
  headChars: 40,             // list 时每篇带的开头字数
})

/** 她的文件夹：home/space/（在 herDir 下，和 inbox 平级）。 */
export function spaceDir(root = rootDir()) {
  return join(root, 'home', 'space')
}

/**
 * 文件名清洗：只留最后一段、去掉路径分隔符与控制字符、不许点开头。
 * 没有扩展名就补 .md（纯文本，谁都能打开看）。
 */
export function safeSpaceName(raw) {
  // 先按路径分隔符取最后一段，再洗非法字符——反过来的话 Windows 的
  // «盘符» 规则会把「a:b」切掉前半截（basename('a:b') === 'b'）。
  const last = String(raw ?? '').trim().split(/[\\/]/).pop() ?? ''
  const base = last.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  if (!base || base.startsWith('.')) return ''
  const withExt = /\.(md|txt)$/i.test(base) ? base : `${base}.md`
  return withExt.length > LIMITS.nameMax ? withExt.slice(0, LIMITS.nameMax) : withExt
}

/** 名字 → 绝对路径；清洗后仍越出目录就返回 null。 */
function fileOf(root, name) {
  const safe = safeSpaceName(name)
  if (!safe) return null
  const dir = resolve(spaceDir(root))
  const abs = resolve(join(dir, safe))
  if (abs !== join(dir, safe)) return null
  return { safe, abs }
}

async function totalBytes(dir) {
  let n = 0
  try {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      if (!ent.isFile()) continue
      try { n += (await fs.stat(join(dir, ent.name))).size } catch { /* 刚被删 */ }
    }
  } catch { /* 目录还没建 */ }
  return n
}

const kb = (n) => `${(n / 1024).toFixed(n < 1024 ? 1 : 0)}KB`

function fmtTime(ms) {
  const d = new Date(Number(ms) || 0)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function registerSpace(ctx, deps = {}) {
  const root = deps.root ?? rootDir()

  ctx.tools.register(
    defineTool({
      name: 'her_space',
      description:
        '把重要的东西放进你自己的文件夹里，以后还能翻出来——只属于你，重启、换会话都还在。' +
        'put 放一篇（同名就是覆盖，回执会说清是新建还是覆盖）；append 往同一篇后面接着写；' +
        'list 翻一翻有哪些；get 读某一篇的全文。' +
        '只能存文字，图片和别的文件放不进来；也不能删，写错了就同名再写一遍。',
      parameters: toJsonSchema({
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['put', 'append', 'list', 'get'],
            description: 'put 放一篇（默认）/ append 接着写 / list 翻一翻 / get 读全文。',
          },
          name: {
            type: 'string',
            description: '这一篇叫什么（比如「课表」「他说过的话」）。不用带 .md，会自动补。不能带路径。',
          },
          text: {
            type: 'string',
            description: `put / append 的内容。一篇最多 ${Math.round(LIMITS.textMax / 1024)}KB（约 5000 字），超了拆成两篇。`,
          },
        },
        required: [],
      }),
      output: {
        schema: toJsonSchema({
          type: 'object',
          properties: { ok: { type: 'boolean' }, text: { type: 'string' }, note: { type: 'string' } },
          required: ['ok', 'note'],
        }),
        render: (_args, out) => [{ type: 'text', text: out.ok ? String(out.text || out.note || '') : `[没成：${out.note}]` }],
      },
      async execute(args = {}, exec) {
        const who = guardWrite(deps.tenant, exec, 'her_space')
        if (!who.ok) return { ok: false, text: '', note: who.note || '这次没成。' }

        const action = String(args?.action ?? 'put').trim() || 'put'
        const dir = spaceDir(root)
        try {
          await fs.mkdir(dir, { recursive: true })

          if (action === 'list') {
            const files = []
            for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
              if (!ent.isFile() || ent.name.startsWith('.')) continue
              const st = await fs.stat(join(dir, ent.name))
              files.push({ name: ent.name, bytes: st.size, mtime: st.mtimeMs })
            }
            if (!files.length) return { ok: true, text: '', note: '你的文件夹还是空的。用 put 放第一篇进来。' }
            files.sort((a, b) => b.mtime - a.mtime)
            const show = files.slice(0, LIMITS.listMax)
            const lines = show.map((f) => `- ${f.name}（${kb(f.bytes)}，${fmtTime(f.mtime)}）`)
            const more = files.length > show.length ? `\n还有 ${files.length - show.length} 篇没列，再写几篇也能翻到。` : ''
            return {
              ok: true,
              text: '',
              note: `文件夹里有 ${files.length} 篇：\n${lines.join('\n')}${more}`,
            }
          }

          if (!['put', 'append', 'get'].includes(action)) {
            return { ok: false, text: '', note: `不认识 action=${action}。能用：put / append / list / get。` }
          }

          const f = fileOf(root, args?.name)
          if (!f) return { ok: false, text: '', note: '这个名字不能用（不能带路径、不能以点开头）。换一个短一点的名字。' }

          if (action === 'get') {
            let buf
            try {
              buf = await fs.readFile(f.abs)
            } catch {
              return { ok: false, text: '', note: `文件夹里没有《${f.safe}》。用 list 看看有哪些。` }
            }
            const text = buf.toString('utf8')
            logLine('info', [`her_space：读《${f.safe}》${text.length} 字`], root)
            return { ok: true, text, note: `《${f.safe}》，${text.length} 字。` }
          }

          const text = String(args?.text ?? '')
          if (!text.trim()) return { ok: false, text: '', note: '内容是空的，没东西可放。' }
          const buf = Buffer.from(text, 'utf8')
          if (buf.length > LIMITS.textMax) {
            return {
              ok: false,
              text: '',
              note: `一篇最多 ${Math.round(LIMITS.textMax / 1024)}KB（约 5000 字），这篇 ${kb(buf.length)}——拆成两篇放。`,
            }
          }

          let exists = true
          try { await fs.access(f.abs) } catch { exists = false }

          if (action === 'append' && exists) {
            const old = await fs.readFile(f.abs)
            if (old.length + buf.length > LIMITS.textMax) {
              return { ok: false, text: '', note: '接着写会超过一篇的上限（约 5000 字）——拆成两篇放。' }
            }
            await fs.appendFile(f.abs, buf)
            logLine('info', [`her_space：追加《${f.safe}》+${buf.length}B`], root)
            return { ok: true, text: '', note: `接着写进了《${f.safe}》，现在 ${kb(old.length + buf.length)}。` }
          }

          if (!exists) {
            const count = (await fs.readdir(dir)).filter((n) => !n.startsWith('.')).length
            if (count >= LIMITS.filesMax) {
              return { ok: false, text: '', note: `文件夹最多 ${LIMITS.filesMax} 篇，现在满了——同名覆盖可以，新开不行。` }
            }
            const total = await totalBytes(dir)
            if (total + buf.length > LIMITS.totalMax) {
              return { ok: false, text: '', note: `文件夹总大小到上限了（${kb(LIMITS.totalMax)}）——放不进新的。` }
            }
          }

          await fs.writeFile(f.abs, buf)
          logLine('info', [`her_space：${exists ? '覆盖' : '新建'}《${f.safe}》${buf.length}B`], root)
          return {
            ok: true,
            text: '',
            note: `${exists ? '覆盖了' : '放进了'}《${f.safe}》，${text.length} 字。以后用 list 翻、get 读。`,
          }
        } catch (err) {
          // 不吞真因（fork.13）：她要知道为什么没成，才能自己改
          const why = String(err?.message ?? err).split('\n')[0].slice(0, 160)
          logLine('warn', ['her_space：', why], root)
          return { ok: false, text: '', note: `这次没成：${why}` }
        }
      },
    }),
  )
}
