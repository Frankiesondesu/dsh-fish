/**
 * localwatch.js —— 工具 `her_watch_local`：看他直接递过来的本地视频（2026-11-06）
 *
 * 为什么会有这个工具：他发来的 mp4 落在 home/inbox/，`her_open` 只能如实说
 * 「二进制，我读不出来」，而 `bili_watch` 只认 B 站 BV 号——她明明手上有文件，
 * 却没有任何一条路能看它。缺的不是判断力（她从 .mp4 后缀就知道是视频），
 * 是一个能收本地路径的入口。
 *
 * 关键发现：vs 的 `runStoryboard` 本来就吃「视频路径」（fetch.js 的 resolveInput
 * 对本地路径原样返回，链接才下载）。所以**不改外挂、不加模型、不写第二套取帧**，
 * 只是把 `input` 从 `https://www.bilibili.com/video/BV...` 换成 inbox 里的绝对路径，
 * 整条管线（切镜 → 拼宫格 → 硬字幕 OCR → 本地听写 → 台词对齐）原样复用。
 *
 * 三条边界（和这个项目其余部分一致）：
 *   1. **只能看 inbox 里的文件**：复用 `insideInbox()`，她不能拿它去翻别的目录；
 *   2. **不占额度**：本地文件全是他递过来的，按 fork.20「他给的不记在她头上」，
 *      写 `watched:` 凭证但带 `free: true`，`watchedInTariff` 会跳过；
 *   3. **失败如实说**：技术原因只进日志，对她只说「这次没看成」（fork.13）。
 *
 * 看不看由她定——桥只报事实、不替她指工具，这个工具只是把能力放在她手边。
 */

import { existsSync, promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { appendEvent, rootDir } from './store.js'
import { loadConfig, dateKey } from './settings.js'
import { watchViaStoryboard } from './vs.js'
import { logLine } from './log.js'
import { slashed } from './posix.js'
import { guardWrite } from './tenant.js'
import { tenancyOf } from './watch.js'
import { insideInbox } from './herfile.js'
import { detectFfmpeg } from './media.js'
import { defineTool } from './tool.js'

/**
 * ffmpeg 走用户自己指的 WinGet 版（DSH_FISH_FFMPEG）；PATH 里那个是旧版。
 * 只在显式配了路径时才传，没配就让 vs 用它自己的默认探测，行为与 B 站那条路一致。
 */
function ffmpegOpts() {
  const ff = detectFfmpeg()
  if (!ff.ok || ff.bin === 'ffmpeg') return {}
  const out = { ffmpegPath: ff.bin }
  const probe = join(dirname(ff.bin), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  if (existsSync(probe)) out.ffprobePath = probe
  return out
}

/** 落盘图名用的短标识：去掉后缀、只留安全字符 */
function tagOf(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'local'
}

export function registerLocalWatch(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const runWatch = deps.watch ?? watchViaStoryboard

  return ctx.tools.register(
    defineTool({
      name: 'her_watch_local',
      description:
        '看他直接递过来的本地视频（他发文件时给你的那个完整路径）。' +
        '会把整条片子按镜头切开、每段挑一帧，拼成宫格图存下来，告诉你文件在哪，' +
        '你用 read_image 打开就能看见；每一格是哪一刻、那时候在说什么也一起给你。' +
        '看一条要几十秒到几分钟，看不看由你定。只想看某几段就传 at（秒）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '他递过来的那个文件的完整路径（在收件箱里）。' },
          at: {
            type: 'array',
            items: { type: 'number' },
            description: '可选：只看这几个时刻（秒），比如 [30, 90]。不传就整条片子分段取。',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string', description: '拼好的图在哪（用 read_image 读它）' },
            text: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['ok', 'path', 'text', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `这次没看成：${out.note}` }],
      },
      async execute(args, exec) {
        const who = guardWrite(tenancyOf(root, deps.tenant), exec, 'her_watch_local')
        if (!who.ok) return { ok: false, path: '', text: '', note: who.note }

        // 路径安全：与 her_open 同一道闸，只能开他递过来的那些
        const abs = insideInbox(root, args?.path)
        if (!abs) {
          return { ok: false, path: '', text: '', note: '只能看他递给你的那些文件。' }
        }
        let st
        try {
          st = await fs.stat(abs)
        } catch {
          return { ok: false, path: '', text: '', note: '这个路径下没有文件。' }
        }
        if (!st.isFile()) return { ok: false, path: '', text: '', note: '这不是一个文件。' }
        if (st.size === 0) return { ok: false, path: '', text: '', note: '这个文件是空的。' }

        const { config } = await loadConfig(root)
        if (!config?.browse?.enabled) return { ok: false, path: '', text: '', note: '现在打不开。' }
        if (config?.video?.enabled === false) {
          logLine('info', ['看本地视频：设置里关掉了看视频'], root)
          return { ok: false, path: '', text: '', note: '现在看不了画面。' }
        }

        const name = basename(abs)
        const r = await runWatch({
          input: abs,
          name,
          tag: tagOf(name),
          root,
          hotword: config?.video?.hotword,
          at: args?.at,
          vsPath: config?.video?.vsPath,
          ...ffmpegOpts(),
        }).catch((err) => ({ ok: false, why: String(err?.message ?? err) }))

        if (!r?.ok) {
          // 技术原因只进日志，不进她的话：说一堆 ffmpeg/ffprobe 对她没有意义
          logLine('warn', ['看本地视频：vs 没走通', name, r?.why ?? ''], root)
          return { ok: false, path: '', text: '', note: '这次没看成。' }
        }

        // 记账：她确实看过（报告、评论闸门认这条凭证），但他是递文件的人，
        // 选择是他做的 —— 跟 fork.20 的 hand: 同一个口径，free 让额度跳过。
        const dk = dateKey()
        await appendEvent(
          {
            type: 'meta',
            ...(who.sessionId ? { sessionId: who.sessionId } : {}),
            text: `watched:${dk} ${name} ${JSON.stringify({
              title: name,
              up: '',
              duration: Number(r.duration) || 0,
              view: 0,
              tariff: '',
              free: true,
              local: true,
            })}`,
          },
          { source: 'system' },
          root,
        ).catch(() => {})

        // 路径一律正斜杠：宿主渲染 markdown 图片时反斜杠会取不到文件
        const posix = slashed(r.path)
        logLine('info', ['看本地视频：取到了', name, '他给的，不占额度', `${(r.paths ?? []).length} 张`, posix], root)
        return { ok: true, path: posix, text: String(r.text ?? ''), note: '' }
      },
    }),
  )
}
