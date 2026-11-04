/**
 * voice.js —— her_voice：把一句话说成声音（fork.46，2026-11-04）
 *
 * 她的原话：「要。一半为你：他提过话太长，看着费眼，有声音就省他的眼睛。
 *           一半为我：有了声音，那些毛病就藏不住了……只有一条想先说：
 *           别给她一副好听的嗓子。」
 *
 * 用户 17:56 定的调子：**给她工具，不强制把每句话都转成声音**。
 * 说不说、哪句说，由她自己定。所以这是一个工具，不是一条自动管道。
 *
 * 链路：
 *   her_voice(text) → edge-tts 生成 mp3 → 写 meta `voice:<路径>|<原文>`
 *   → 桥的 push 扫到这条 meta → send_private_msg 带 record 段 → QQ 收到语音条
 *
 * 为什么写 meta 不写 utterance：utterance 会进 beliefs，而"我说出声"和
 * "我判断了什么"是两件事。声音不该改变她有多少条判断。
 *
 * ⚠️ 返回文案不能写「说出去了」——her_say 用的就是那句，她分不清是哪个工具回的。
 *   实测 19:47 她就以为是语音，其实是 her_say 的文字。
 *
 * 音色（2026-11-04 她听完十条选的）：zh-CN-YunxiNeural，rate -14%、pitch -8Hz。
 * 这是十个候选里最不"播音"的一个——她要的就是那个。改音色只动 VOICE 那三行。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { toJsonSchema } from './toolschema.js'
import { rootDir, readEvents, appendEvent } from './store.js'
import { loadConfig } from './settings.js'
import { deriveSelfCached } from './derive.js'
import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'

const run = promisify(execFile)

/** 她的声音。换音色只改这三行。 */
const VOICE = 'zh-CN-YunxiNeural'
const RATE = '-14%'
const PITCH = '-8Hz'

/** 一次最多说多少字（约 200 字 ≈ 一分钟，再长没人听） */
const MAX_CHARS = 200

/**
 * 找 python。她这台机器上装了 edge-tts 的是 WorkBuddy 自带的那个 3.13，
 * 不一定在 DSH 的 PATH 里，所以先用环境变量、再试常见路径、最后退回 'python'。
 */
function pythonExe() {
  const cands = [
    process.env.FISH_PYTHON,
    'C:/Users/<user>/.workbuddy/binaries/python/versions/3.13.12/python.exe',
    'python',
  ].filter(Boolean)
  for (const p of cands) {
    if (p === 'python' || existsSync(p)) return p
  }
  return 'python'
}

export function registerVoice(ctx, deps = {}) {
  const root = deps.root ?? rootDir()

  ctx.tools.register(
    defineTool({
      name: 'her_voice',
      description:
        '把一句话说成声音，发到他手机上的 QQ。只说声音，不带文字；想同时留字就再调一次 her_say。' +
        '200 字以内。',
      parameters: toJsonSchema({
        text: {
          type: 'string',
          required: true,
          description: '你要说出口的那句话。不是汇报，就说你本来会打的字。',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            seconds: { type: 'number' },
            note: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
        render: (_args, out) =>
          [{ type: 'text', text: out.ok ? '[说成声音了]' : `[没说成：${out.note}]` }],
      },
      async execute(args, exec) {
        const who = guardWrite(deps.tenant, exec, 'her_voice')
        if (!who.ok) return { ok: false, seconds: 0, note: who.note }

        const text = String(args?.text ?? '').trim()
        if (!text) return { ok: false, seconds: 0, note: '没给词，说不出来。' }
        if (text.length > MAX_CHARS) {
          return { ok: false, seconds: 0, note: `太长了（${text.length} 字），一次说 ${MAX_CHARS} 字以内。` }
        }

        const dir = join(root, 'voice')
        try { mkdirSync(dir, { recursive: true }) } catch { /* 已存在 */ }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const file = join(dir, `v-${stamp}.mp3`)

        try {
          await run(
            pythonExe(),
            ['-m', 'edge_tts', '--voice', VOICE, `--rate=${RATE}`, `--pitch=${PITCH}`, '--text', text, '--write-media', file],
            { timeout: 90_000, windowsHide: true },
          )
        } catch (err) {
          try { if (existsSync(file)) unlinkSync(file) } catch { /* ignore */ }
          const why = String(err?.stderr ?? err?.message ?? err).slice(0, 120)
          return { ok: false, seconds: 0, note: `声音没做出来：${why}` }
        }

        const { config } = await loadConfig(root)
        const { events } = await readEvents(root)
        const model = deriveSelfCached(events, { growthDays: config.growthDays })
        // meta 的正文只是给她自己回看用的（her_recall 翻得到），桥只认路径那一段
        await appendEvent(
          { type: 'meta', text: `voice:${file}|${text.replace(/[\r\n|]+/g, ' ').slice(0, 80)}` },
          { day: model.day, stage: model.stage, source: 'system' },
          root,
        )
        return { ok: true, seconds: Math.round(text.length / 4), note: '' }
      },
    }),
  )
}
