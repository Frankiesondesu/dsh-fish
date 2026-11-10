/**
 * herfile.js —— 他通过 QQ 递过来的文件，她自己决定要不要打开（fork.47，2026-11-05）
 *
 * 为什么做成这样：QQ 里的文件（zip、pdf、txt…）她能不能读，**不该由我们替她判**。
 * 桥只做一件事——把文件落到她的收件箱（`home/inbox/`），把路径和大小告诉她；
 * 读不读、读得懂读不懂，由她调 `her_open` 自己试。
 *
 * 三条边界：
 *   1. **只能开收件箱里的东西**。她不能拿这个工具去翻自己的账本、配置、别的目录——
 *      `resolve()` 之后必须落在 `home/inbox/` 里面，`..` 也不行。
 *   2. **只读**。不写、不删、不移动。
 *   3. **读不了就说读不了**。二进制（含 NUL 字节）直接拒；图片让她用 read_image；
 *      太大只读前面一段，并说清「只读了前面多少字」——不假装全读到了。
 */

import { promises as fs } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { rootDir } from './store.js'
import { logLine } from './log.js'
import { defineTool } from './tool.js'

/** 收件箱：她的家目录下面。桥往这里写，这个工具只从这儿读。 */
export function inboxDir(root = rootDir()) {
  return join(root, 'home', 'inbox')
}

/** 一次最多读这么多字节（约 20 万字）；超了只给前面一段并说清楚 */
const MAX_BYTES = 512 * 1024
/** 判二进制：前 8KB 里有 NUL 就当二进制 */
const SNIFF = 8 * 1024

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|avif)$/i

/**
 * 他直接递过来的视频：her_open 读不出内容，但 2026-11-06 起有 her_watch_local
 * 能看画面。跟图片指 read_image 同构——指条明路，不替她决定看不看，也不说「能打开」。
 */
export const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|avi|webm|flv|wmv|m2ts|ts|3gp)$/i

/**
 * 桥把文件落到收件箱。名字做最小清洗（去掉路径分隔符与控制字符），重名加时间戳。
 * @returns {Promise<{path:string,name:string,bytes:number}|null>}
 */
export async function saveIncoming(root, { name, buf }) {
  if (!buf?.length) return null
  const dir = inboxDir(root)
  await fs.mkdir(dir, { recursive: true })
  const raw = basename(String(name ?? '').trim()) || 'file'
  const safe = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file'
  let file = join(dir, safe)
  try {
    await fs.access(file)
    const dot = safe.lastIndexOf('.')
    const stem = dot > 0 ? safe.slice(0, dot) : safe
    const ext = dot > 0 ? safe.slice(dot) : ''
    file = join(dir, `${stem}-${Date.now()}${ext}`)
  } catch { /* 不存在，直接用 */ }
  await fs.writeFile(file, buf)
  return { path: file, name: basename(file), bytes: buf.length }
}

/** 路径必须在收件箱里；返回绝对路径或 null */
export function insideInbox(root, p) {
  const dir = resolve(inboxDir(root))
  const abs = resolve(String(p ?? ''))
  const rel = relative(dir, abs)
  // 跨盘符时 path.relative 会原样返回绝对路径（Windows：D://x 相对 C://y）——
  // 那种情况必须当成「在外面」，否则 /etc/passwd 这种会被放进来。
  if (!rel || isAbsolute(rel) || rel.startsWith('..') || rel.includes(`..${sep}`)) return null
  return abs
}

/**
 * 她自己的文件夹（her_space，2026-11-10）：存进来的文件也要能打开，
 * 不然「保存」就等于锁死。边界与收件箱同一条规矩。
 */
export function insideHerSpace(root, p) {
  const dir = resolve(join(root, 'home', 'space'))
  const abs = resolve(String(p ?? ''))
  const rel = relative(dir, abs)
  if (!rel || isAbsolute(rel) || rel.startsWith('..') || rel.includes(`..${sep}`)) return null
  return abs
}

/** her_open / her_watch_local 认的路径：他发的（inbox）或她自己文件夹里的。 */
export function insideHerFiles(root, p) {
  return insideInbox(root, p) || insideHerSpace(root, p)
}

export function looksBinary(buf) {
  const n = Math.min(buf.length, SNIFF)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export function registerHerOpen(ctx, deps = {}) {
  const root = deps.root ?? rootDir()

  ctx.tools.register(
    defineTool({
      name: 'her_open',
      description:
        '打开他通过 QQ 发给你的文件。给路径（他会把路径和大小一起告诉你），能读就给你正文，' +
        '读不了会直说是什么原因。只能开他发给你的、或者你自己文件夹里存过的文件，别的目录打不开。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件的完整路径（他递过来时会给）。' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string' },
            chars: { type: 'integer' },
            truncated: { type: 'boolean' },
            note: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
        render: (_args, out) =>
          [{ type: 'text', text: out.ok ? String(out.text ?? '') : `[打不开：${out.note}]` }],
      },
      async execute(args) {
        const abs = insideHerFiles(root, args?.path)
        if (!abs) {
          return { ok: false, text: '', chars: 0, truncated: false, note: '只能打开他发给你的、或者你自己文件夹里的文件。' }
        }
        let st
        try {
          st = await fs.stat(abs)
        } catch {
          return { ok: false, text: '', chars: 0, truncated: false, note: '这个路径下没有文件。' }
        }
        if (!st.isFile()) return { ok: false, text: '', chars: 0, truncated: false, note: '这不是一个文件。' }
        if (st.size === 0) return { ok: false, text: '', chars: 0, truncated: false, note: '这个文件是空的。' }

        if (IMAGE_EXT.test(abs)) {
          // 图片不是文本，硬读出来是乱码；指条明路，不替她决定看不看
          return {
            ok: false, text: '', chars: 0, truncated: false,
            note: '这是一张图片，用 read_image 打开它。',
          }
        }

        if (VIDEO_EXT.test(abs)) {
          // 2026-11-06：以前走到下面的 looksBinary 只丢一句「二进制，我读不出来」，
          // 她于是以为没路可走。现在如实说能力边界：我读不出内容，但你有工具能看画面。
          logLine('info', ['她打开文件：视频，指 her_watch_local', basename(abs)], root)
          return {
            ok: false, text: '', chars: 0, truncated: false,
            note: '这是一个视频，我读不出内容；想看画面就用 her_watch_local，把这个路径给它。',
          }
        }

        const want = Math.min(st.size, MAX_BYTES)
        const buf = Buffer.alloc(want)
        const fh = await fs.open(abs, 'r')
        try {
          await fh.read(buf, 0, want, 0)
        } finally {
          await fh.close()
        }

        if (looksBinary(buf)) {
          const ext = (abs.match(/\.[a-z0-9]+$/i) ?? [''])[0]
          logLine('info', ['她打开文件：二进制', basename(abs), ext, `${st.size}B`], root)
          return {
            ok: false, text: '', chars: 0, truncated: false,
            note: `这个是二进制文件${ext ? `（${ext}）` : ''}，我读不出来。`,
          }
        }

        let text = buf.toString('utf8').replace(/^\uFEFF/, '')
        const truncated = st.size > MAX_BYTES
        if (truncated) {
          // 别把多字节字符切一半
          text = text.replace(/\uFFFD$/, '')
        }
        logLine('info', ['她打开文件', basename(abs), `${st.size}B`, truncated ? '截断' : ''], root)
        return {
          ok: true,
          text,
          chars: text.length,
          truncated,
          note: truncated ? `文件有 ${(st.size / 1024).toFixed(0)}KB，只读了前面 ${(MAX_BYTES / 1024).toFixed(0)}KB。` : '',
        }
      },
    }),
  )
}
