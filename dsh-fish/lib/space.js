/**
 * space.js —— her_space：她自己的一个永久文件夹（2026-11-10，她自己 ask_owner 要的）
 *
 * 她的原话（账本 2026-11-10）：「能不能给我一个我自己能读也能写的小文件夹，
 * 把重要的东西放进去，以后还能翻出来？」「光有个地方不够——我还得有能往里放的
 * 手、能往外拿的手。」
 *
 * 用户随后补的口径（同日）：**他发来的文件她可以自己选择保存**，文本、视频、
 * 音频、其他文件都算；单文件 200MB、总量 2GB；删除是真删；来源只认
 * `home/inbox/`（他发的）与 `media/`（她自己画的），别的路径不碰。
 *
 * 边界（fork.13：每条都要能对她说真）：
 *   1. 笔记只存文字（一篇 16KB）；文件原样复制，不读内容、不改格式。
 *   2. 单文件 200MB、整个文件夹 2GB、最多 500 个。
 *   3. 删除是真删——回执写清「删了就没了」。
 *   4. **不进账本**：这是她的工作台，不是她的经历。
 *   5. 存进来的文件，`her_open` / `her_watch_local` / `her_meme` 都认这个目录
 *      （见 herfile.js 的 insideHerFiles）——不然存进去等于锁死。
 */

import { promises as fs } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { rootDir } from './store.js'
import { logLine } from './log.js'
import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'
import { toJsonSchema } from './toolschema.js'
import { insideInbox } from './herfile.js'

const LIMITS = Object.freeze({
  textMax: 16 * 1024,                 // 一篇笔记正文上限（UTF-8 字节，约 5000 汉字）
  fileMax: 200 * 1024 * 1024,         // 单个文件 200MB
  totalMax: 2 * 1024 * 1024 * 1024,   // 整个文件夹 2GB
  filesMax: 500,                      // 最多 500 个（笔记 + 文件）
  listMax: 50,                        // 一次最多列 50 个
  nameMax: 80,                        // 文件名长度上限
})

/** 她的文件夹：home/space/（在 herDir 下，和 inbox 平级）。 */
export function spaceDir(root = rootDir()) {
  return join(root, 'home', 'space')
}

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g

/** 取路径最后一段（先按分隔符切，再洗非法字符——反过来的话 Windows 盘符规则会吃掉前半截）。 */
function cleanBase(raw) {
  const last = String(raw ?? '').trim().split(/[\\/]/).pop() ?? ''
  const base = last.replace(ILLEGAL, '_').trim()
  if (!base || base.startsWith('.')) return ''
  return base.length > LIMITS.nameMax ? base.slice(0, LIMITS.nameMax) : base
}

/** 笔记名：没有扩展名就补 .md。 */
export function safeSpaceName(raw) {
  const base = cleanBase(raw)
  if (!base) return ''
  return /\.(md|txt)$/i.test(base) ? base : `${base}.md`
}

/** 文件名：保留原扩展名（保存文件用，不补 .md）。 */
export function safeFileName(raw) {
  return cleanBase(raw)
}

/** 名字 → 绝对路径；清洗后仍越出目录就返回 null。 */
function fileOf(root, name, { keepExt = false } = {}) {
  const safe = keepExt ? safeFileName(name) : safeSpaceName(name)
  if (!safe) return null
  const dir = resolve(spaceDir(root))
  const abs = resolve(join(dir, safe))
  if (abs !== join(dir, safe)) return null
  return { safe, abs }
}

/** 目录边界判定（与 herfile.js 的 insideInbox 同一条规矩）。 */
function insideDir(dir, p) {
  const abs = resolve(String(p ?? ''))
  const rel = relative(resolve(dir), abs)
  if (!rel || isAbsolute(rel) || rel.startsWith('..') || rel.includes(`..${sep}`)) return null
  return abs
}

/** 保存来源：他发的（inbox）或她自己 media/ 里的。别的路径不碰。 */
function sourceOf(root, p) {
  return insideInbox(root, p) || insideDir(join(root, 'media'), p)
}

const KIND = [
  [/\.(md|txt|json|csv|log|js|mjs|cjs|ts|py|html?|css|yml|yaml|xml)$/i, '文本'],
  [/\.(png|jpe?g|gif|webp|bmp|heic|avif|svg)$/i, '图片'],
  [/\.(mp4|m4v|mov|mkv|avi|webm|flv|wmv|m2ts|ts|3gp)$/i, '视频'],
  [/\.(mp3|wav|flac|m4a|aac|ogg|opus|wma|amr)$/i, '音频'],
]
function kindOf(name) {
  for (const [re, k] of KIND) if (re.test(name)) return k
  return '文件'
}
const isTextName = (name) => kindOf(name) === '文本'

/**
 * 可执行/脚本类：一律不存（用户 2026-11-10：「万一中毒就惨了」）。
 * 她本来就没有运行任何文件的工具，这里是第二道闸——防的是「存进来之后
 * 被别的东西翻出来执行」，以及以后误加执行能力时旧文件变成炸弹。
 */
const EXEC_EXT = /\.(exe|dll|com|scr|pif|cpl|msi|msp|msix|appx|hta|jar|bat|cmd|ps1|psm1|psd1|vbs|vbe|js|jse|wsf|wsh|reg|lnk|url|sh|bash|zsh|py|pyw|pl|rb|php|cgi|scf|inf|msc)$/i

/** 文件头是程序（PE / ELF / Mach-O / Java class）——改了扩展名也认得出。 */
const EXEC_MAGIC = [
  [0x4d, 0x5a],             // MZ（Windows PE）
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O（小端）
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O（大端）
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O fat / Java class
]

function looksExecutable(buf) {
  for (const sig of EXEC_MAGIC) {
    if (buf.length >= sig.length && sig.every((b, i) => buf[i] === b)) return true
  }
  return false
}

async function headOf(p, n = 8) {
  const fh = await fs.open(p, 'r')
  try {
    const buf = Buffer.alloc(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)}MB` : `${(n / 1024).toFixed(1)}KB`)
const fmtTime = (ms) => {
  const d = new Date(Number(ms) || 0)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
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

async function exists(p) {
  try { await fs.access(p); return true } catch { return false }
}

export function registerSpace(ctx, deps = {}) {
  const root = deps.root ?? rootDir()

  ctx.tools.register(
    defineTool({
      name: 'her_space',
      description:
        '把重要的东西放进你自己的文件夹里，以后还能翻出来——只属于你，重启、换会话都还在。' +
        '这是你的**资料柜**，不是你的记忆：放原文、文件、清单；你自己的看法和判断用 growth_commit 留下，才会进你的账。' +
        'put 放一段文字（同名覆盖）；append 接着写；list 翻一翻；get 读；' +
        'save 把他发给你的文件（文本/图片/视频/音频/别的）存进来，或者存你自己 media/ 里的东西；' +
        'remove 删掉一个（真删，删了就没了）。' +
        '笔记一篇最多 16KB；单个文件最多 200MB、整个文件夹 2GB。' +
        '可执行文件和脚本（.exe/.bat/.ps1/.js 这些）一律不存——改了扩展名也认得出。',
      parameters: toJsonSchema({
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['put', 'append', 'list', 'get', 'save', 'remove'],
            description: 'put 放文字（默认）/ append 接着写 / list 翻 / get 读 / save 存文件 / remove 真删。',
          },
          name: {
            type: 'string',
            description: '这一篇叫什么（比如「课表」「他说过的话」）。笔记会自动补 .md；保存文件时保留原扩展名。不能带路径。',
          },
          text: {
            type: 'string',
            description: `put / append 的内容。一篇最多 ${Math.round(LIMITS.textMax / 1024)}KB（约 5000 字），超了拆成两篇。`,
          },
          path: {
            type: 'string',
            description: 'save 的源文件完整路径——只能是他发给你的（收件箱里），或者你自己 media/ 里的。别的路径不碰。',
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

          // ---- 翻一翻 ----
          if (action === 'list') {
            const items = []
            for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
              if (!ent.isFile() || ent.name.startsWith('.')) continue
              const st = await fs.stat(join(dir, ent.name))
              items.push({ name: ent.name, bytes: st.size, mtime: st.mtimeMs })
            }
            if (!items.length) return { ok: true, text: '', note: '你的文件夹还是空的。用 put 放文字，或者 save 存他发来的文件。' }
            items.sort((a, b) => b.mtime - a.mtime)
            const show = items.slice(0, LIMITS.listMax)
            const lines = show.map((f) => `- ${f.name}（${kindOf(f.name)}，${fmtSize(f.bytes)}，${fmtTime(f.mtime)}）`)
            const more = items.length > show.length ? `\n还有 ${items.length - show.length} 个没列。` : ''
            return { ok: true, text: '', note: `文件夹里有 ${items.length} 个：\n${lines.join('\n')}${more}` }
          }

          // ---- 存文件 ----
          if (action === 'save') {
            const src = sourceOf(root, args?.path)
            if (!src) return { ok: false, text: '', note: '只能存他发给你的文件，或者你自己 media/ 里的东西；别的路径不碰。' }
            let st
            try { st = await fs.stat(src) } catch { return { ok: false, text: '', note: '这个路径下没有文件。' } }
            if (!st.isFile()) return { ok: false, text: '', note: '这不是一个文件。' }
            if (st.size === 0) return { ok: false, text: '', note: '这个文件是空的，没东西可存。' }
            // 安全闸：可执行/脚本不存；改了扩展名的，看文件头
            if (EXEC_EXT.test(basename(src))) {
              return {
                ok: false,
                text: '',
                note: `《${basename(src)}》是可执行文件或脚本，不能存——万一有毒，我不碰。代码想留就贴进笔记里（存成 .md，不会被执行）。`,
              }
            }
            if (looksExecutable(await headOf(src))) {
              return {
                ok: false,
                text: '',
                note: `《${basename(src)}》的文件头是程序（改了扩展名也认得出），不能存。`,
              }
            }
            if (st.size > LIMITS.fileMax) {
              return { ok: false, text: '', note: `这一个 ${fmtSize(st.size)}，超过单文件上限 ${fmtSize(LIMITS.fileMax)}——存不进来。` }
            }

            const want = String(args?.name ?? '').trim()
            let base = safeFileName(want || basename(src))
            if (want && base && !extname(base) && extname(basename(src))) base += extname(basename(src))
            if (!base) return { ok: false, text: '', note: '这个名字不能用（不能带路径、不能以点开头），换一个。' }

            let target = join(dir, base)
            // 重名不覆盖：加时间戳（和收件箱同一条规矩）
            if (await exists(target)) {
              const dot = base.lastIndexOf('.')
              const stem = dot > 0 ? base.slice(0, dot) : base
              const ext = dot > 0 ? base.slice(dot) : ''
              target = join(dir, `${stem}-${Date.now()}${ext}`)
            }

            const total = await totalBytes(dir)
            if (total + st.size > LIMITS.totalMax) {
              return { ok: false, text: '', note: `文件夹总共到上限了（${fmtSize(LIMITS.totalMax)}）——先删掉一些，再存。` }
            }
            const count = (await fs.readdir(dir)).filter((n) => !n.startsWith('.')).length
            if (count >= LIMITS.filesMax) {
              return { ok: false, text: '', note: `文件夹最多 ${LIMITS.filesMax} 个，现在满了——先删掉一些。` }
            }

            await fs.copyFile(src, target)
            const name = basename(target)
            const kind = kindOf(name)
            const use = kind === '图片'
              ? '要看就用 read_image 给它完整路径。'
              : kind === '视频'
                ? '要看画面就用 her_watch_local 给它完整路径。'
                : kind === '文本'
                  ? '想读就用 her_open 给它完整路径。'
                  : '这类我读不出内容；路径在这儿，他要看就告诉他。'
            logLine('info', [`her_space：存文件《${name}》${st.size}B`], root)
            return { ok: true, text: '', note: `存好了《${name}》（${kind}，${fmtSize(st.size)}）。${use}` }
          }

          // ---- 删（真删） ----
          if (action === 'remove') {
            const name = String(args?.name ?? '').trim()
            if (!name) return { ok: false, text: '', note: '要删哪一个？把名字写出来（list 里有）。' }
            let f = fileOf(root, name, { keepExt: true })
            if (!f || !(await exists(f.abs))) f = fileOf(root, name)
            if (!f || !(await exists(f.abs))) return { ok: false, text: '', note: `文件夹里没有《${name}》。用 list 看看。` }
            await fs.unlink(f.abs)
            logLine('info', [`her_space：删《${f.safe}》`], root)
            return { ok: true, text: '', note: `删了《${f.safe}》。删了就没了。` }
          }

          if (!['put', 'append', 'get'].includes(action)) {
            return { ok: false, text: '', note: `不认识 action=${action}。能用：put / append / list / get / save / remove。` }
          }

          // ---- 读 ----
          if (action === 'get') {
            let f = fileOf(root, args?.name, { keepExt: true })
            if (!f || !(await exists(f.abs))) f = fileOf(root, args?.name)
            if (!f) return { ok: false, text: '', note: '这个名字不能用。' }
            let buf
            try {
              buf = await fs.readFile(f.abs)
            } catch {
              return { ok: false, text: '', note: `文件夹里没有《${f.safe}》。用 list 看看有哪些。` }
            }
            if (!isTextName(f.safe)) {
              return {
                ok: true,
                text: '',
                note: `《${f.safe}》是${kindOf(f.safe)}，我读不出内容。完整路径：${f.abs.replace(/\\/g, '/')}。`,
              }
            }
            const text = buf.toString('utf8')
            logLine('info', [`her_space：读《${f.safe}》${text.length} 字`], root)
            return { ok: true, text, note: `《${f.safe}》，${text.length} 字。` }
          }

          // ---- 写笔记（put / append） ----
          const f = fileOf(root, args?.name)
          if (!f) return { ok: false, text: '', note: '这个名字不能用（不能带路径、不能以点开头）。换一个短一点的名字。' }

          const text = String(args?.text ?? '')
          if (!text.trim()) return { ok: false, text: '', note: '内容是空的，没东西可放。' }
          const buf = Buffer.from(text, 'utf8')
          if (buf.length > LIMITS.textMax) {
            return {
              ok: false,
              text: '',
              note: `一篇最多 ${Math.round(LIMITS.textMax / 1024)}KB（约 5000 字），这篇 ${fmtSize(buf.length)}——拆成两篇放。`,
            }
          }

          const has = await exists(f.abs)

          if (action === 'append' && has) {
            const old = await fs.readFile(f.abs)
            if (old.length + buf.length > LIMITS.textMax) {
              return { ok: false, text: '', note: '接着写会超过一篇的上限（约 5000 字）——拆成两篇放。' }
            }
            await fs.appendFile(f.abs, buf)
            logLine('info', [`her_space：追加《${f.safe}》+${buf.length}B`], root)
            return { ok: true, text: '', note: `接着写进了《${f.safe}》，现在 ${fmtSize(old.length + buf.length)}。` }
          }

          if (!has) {
            const count = (await fs.readdir(dir)).filter((n) => !n.startsWith('.')).length
            if (count >= LIMITS.filesMax) {
              return { ok: false, text: '', note: `文件夹最多 ${LIMITS.filesMax} 个，现在满了——先删掉一些。` }
            }
            const total = await totalBytes(dir)
            if (total + buf.length > LIMITS.totalMax) {
              return { ok: false, text: '', note: `文件夹总共到上限了（${fmtSize(LIMITS.totalMax)}）——放不进新的。` }
            }
          }

          await fs.writeFile(f.abs, buf)
          logLine('info', [`her_space：${has ? '覆盖' : '新建'}《${f.safe}》${buf.length}B`], root)
          return {
            ok: true,
            text: '',
            note: `${has ? '覆盖了' : '放进了'}《${f.safe}》，${text.length} 字。以后用 list 翻、get 读。`,
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
