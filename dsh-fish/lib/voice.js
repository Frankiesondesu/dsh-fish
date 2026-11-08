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
import { mkdirSync, existsSync, unlinkSync, writeFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { toJsonSchema } from './toolschema.js'
import { rootDir, readEvents, appendEvent } from './store.js'
import { loadConfig } from './settings.js'
import { deriveSelfCached } from './derive.js'
import { defineTool } from './tool.js'
import { guardWrite } from './tenant.js'
import { detectFfmpeg } from './media.js'

const run = promisify(execFile)

/** 她的声音。换音色只改这三行。 */
const VOICE = 'zh-CN-YunxiNeural'
const RATE = '-14%'
const PITCH = '-8Hz'

/** 一次最多说多少字（约 200 字 ≈ 一分钟，再长没人听） */
const MAX_CHARS = 200

/**
 * 语调归一（fork.55，2026-11-06）。纯函数，导出给测试。
 *
 * 来自 AstrBot tts_emotion_router（88★）的理念，按 fish 的形状改：
 * 那边是系统按情绪路由音色——那是替她挑嗓子。这里只把**这一副嗓子**
 * 的语速和音高开给她自己调：急了快一点，懒了慢一点，不传就是平时的样子。
 *
 * 范围收得很窄：rate ±50%、pitch ±20Hz——够表达「劲儿不一样」，
 * 调不出另一个人。越界的悄悄夹回边界（如实说话在返回文案里做不到逐条
 * 复核，夹紧是最不撒谎的处理）。
 */
export function voiceTone(rate, pitch) {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  const r = Math.max(-50, Math.min(50, num(rate, -14)))
  const q = Math.max(-20, Math.min(20, num(pitch, -8)))
  const fmt = (v) => (v > 0 ? `+${v}` : `${v}`)
  return { rate: `${fmt(r)}%`, pitch: `${fmt(q)}Hz` }
}

/**
 * 切句：把一段话切成 2–4 段，用来并发合成（fork.51，2026-11-05）。
 *
 * 为什么值得切：edge-tts 的耗时大头是连接开销 + 逐句合成，
 * 一整段 200 字要等 5–6 秒才听到第一个字。切成 3 段并发，
 * 首声约等于「最长那一句」的时间（1.5–2 秒），拼回去只要 0.2 秒。
 *
 * 三条克制：
 *   · 太短的段并进上一段——「嗯。」单独合成一次不值得；
 *   · 段数上限 4——再多，连接开销反而盖过收益；
 *   · 切不动就返回 1 段（调用方退回整段合成，不做无用功）。
 *
 * 导出是为了能单测：切句错了会让她的语气在句子中间断掉，这比慢更糟。
 */
export function splitForSpeech(text, { maxParts = 4, minChars = 8 } = {}) {
  const s = String(text ?? '').trim()
  if (!s) return []
  // 按句末标点 / 换行切，标点留在前一段（edge-tts 靠它决定语调收尾）
  const raw = s.match(/[^。！？!?；;\n]+[。！？!?；;\n]*/g) ?? [s]
  const parts = []
  for (const seg of raw) {
    const t = seg.trim()
    if (!t) continue
    const prev = parts[parts.length - 1]
    // 太短的一段并进上一段：单独合成一次「嗯。」只会多花一次连接
    if (prev !== undefined && (t.length < minChars || prev.length < minChars)) {
      parts[parts.length - 1] = prev + t
    } else {
      parts.push(t)
    }
  }
  // 段太多：从尾部往前并，保住前几段的短（首声快）
  while (parts.length > maxParts) {
    const last = parts.pop()
    parts[parts.length - 1] += last
  }
  return parts
}

/** 合成一段。失败就抛，由调用方决定回退。 */
async function tts(text, file, tone = {}) {
  const r = tone.rate ?? RATE
  const q = tone.pitch ?? PITCH
  await run(
    pythonExe(),
    ['-m', 'edge_tts', '--voice', VOICE, `--rate=${r}`, `--pitch=${q}`, '--text', text, '--write-media', file],
    { timeout: 90_000, windowsHide: true },
  )
}

/**
 * 把分片按顺序拼回一条 mp3。用 concat demuxer + copy——同参数同编码，
 * 不重新编码，200 字大约 0.2 秒。
 *
 * list 文件放在同目录、只写文件名：Windows 上 ffmpeg 对绝对路径里的
 * 反斜杠 + 单引号很挑，相对路径 + cwd 最不容易出事。
 */
async function concatMp3(dir, names, outName, bin) {
  const listName = `list-${Date.now()}.txt`
  const list = join(dir, listName)
  writeFileSync(list, names.map((n) => `file '${n}'`).join('\n'), 'utf8')
  try {
    await run(bin, ['-y', '-f', 'concat', '-safe', '0', '-i', listName, '-c', 'copy', outName], {
      timeout: 60_000, windowsHide: true, cwd: dir,
    })
  } finally {
    try { unlinkSync(list) } catch { /* ignore */ }
  }
}

/**
 * 找 python。她这台机器上装了 edge-tts 的是 WorkBuddy 自带的那个 3.13，
 * 不一定在 DSH 的 PATH 里，所以先用环境变量、再试常见路径、最后退回 'python'。
 */
/** 扫 WorkBuddy 自带 python（版本降序）。装机位置随用户名变，代码里不写死。 */
function workbuddyPythons() {
  try {
    const base = join(homedir(), '.workbuddy', 'binaries', 'python', 'versions')
    return readdirSync(base).sort().reverse()
      .map((v) => join(base, v, 'python.exe'))
      .filter((p) => existsSync(p))
  } catch {
    return []
  }
}

function pythonExe() {
  const cands = [
    process.env.FISH_PYTHON,
    ...workbuddyPythons(),
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
        rate: {
          type: 'number',
          description: '语速微调，-50 到 50（百分比）。急了往快调，懒了往慢调；不传就是平时那个。',
        },
        pitch: {
          type: 'number',
          description: '音高微调，-20 到 20（Hz）。不传就是平时那个。',
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

        // fork.55：语速/音高她自己调（急了快一点，懒了慢一点）。
        // 音色还是那一副——能调的是这一副嗓子当时的劲儿，不是换一个人。
        const tone = voiceTone(args?.rate, args?.pitch)
        // fork.51：分句并发合成，再拼回一条。首声从「整段合成完」提前到
        // 「最长那一句合成完」。任何一步失败都退回整段——不做没验证过的花活。
        // 说话还是**一条**语音：分成好几条发，等于替她决定了几句话。
        const parts = splitForSpeech(text)
        let made = false
        if (parts.length > 1) {
          const ff = detectFfmpeg()
          if (ff.ok) {
            const base = `v-${stamp}`
            const names = parts.map((_, i) => `${base}-${i}.mp3`)
            try {
              await Promise.all(parts.map((p, i) => tts(p, join(dir, names[i]), tone)))
              await concatMp3(dir, names, `${base}.mp3`, ff.bin)
              made = existsSync(file) && statSync(file).size > 0
            } catch { /* 下面退回整段 */ }
            // 分片一律清掉：留着既占地方，也会被桥的目录扫描看到
            for (const n of names) {
              try { unlinkSync(join(dir, n)) } catch { /* ignore */ }
            }
            if (!made) { try { unlinkSync(file) } catch { /* ignore */ } }
          }
        }
        if (!made) {
          try {
            await tts(text, file, tone)
          } catch (err) {
            try { if (existsSync(file)) unlinkSync(file) } catch { /* ignore */ }
            const why = String(err?.stderr ?? err?.message ?? err).slice(0, 120)
            return { ok: false, seconds: 0, note: `声音没做出来：${why}` }
          }
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
