/**
 * llbot-patch.mjs —— 给 LLBot 打「剥帧头」补丁（2026-11-02）
 *
 * 为什么需要它：
 *   PMHQ 通过 ws 推过来的 `recv` 包，pb 前面带 4 字节大端长度帧头
 *   （值恒等于整段字节数）。LLBot 8.3.2 的 PmhqQQProtocol 直接把整段当
 *   裸 protobuf 交给 `Msg.PushMsg.decode`，多这 4 字节会让
 *   `contentHead.msgType` 解析成 undefined，消息被 switch 静默丢掉 ——
 *   日志里连一条 warn 都没有，表现就是「QQ 收到了，她一点反应都没有」。
 *
 *   实测证据（2026-11-02 19:11 抓的包）：
 *     pb 开头 00 00 01 32 = 306 = 总长；剥掉后首字节 0a，
 *     解出 fromUin=<主人QQ> → toUin=<机器人QQ>，msgType=166，正文「你好」。
 *
 * 补丁做的事：
 *   在 `PmhqQQProtocol.start()` 的 resListener 里，把
 *     const payload = Buffer.from(data.data.pb, "hex");
 *   换成「先取 let，再在『前 4 字节 == 总长』时 subarray(4)」。
 *   带帧头、不带帧头两种 PMHQ 行为都能吃下，所以是幂等且向后兼容的。
 *
 * 注意：
 *   llbot.js 是打包产物，LuckyLillia 更新 llbot 时会整份覆盖 —— 补丁会丢。
 *   所以 launch.mjs 每次启动都会调本脚本兜一次，丢了自动补回。
 *
 * 用法：
 *   node llbot-patch.mjs          缺就补，有就跳过
 *   node llbot-patch.mjs --check  只报告，不改文件
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const TARGET = join(HERE, 'runtime', 'LL', 'bin', 'llbot', 'llbot.js')
const BACKUP = TARGET + '.orig'

const MARKER = '[fish 补丁'
const NEEDLE = '\t\t\t\tconst payload = Buffer.from(data.data.pb, "hex");'

const PATCH_LINES = [
  '\t\t\t\tlet payload = Buffer.from(data.data.pb, "hex");',
  '\t\t\t\t// [fish 补丁 2026-11-02] PMHQ 会在 pb 前加 4 字节大端长度帧头（值恒等于总字节数）。',
  '\t\t\t\t// LLBot 原来直接把整段当裸 protobuf 交给 Msg.PushMsg.decode，多这 4 字节会让',
  '\t\t\t\t// contentHead.msgType 解析成 undefined，于是消息被静默丢弃（连 warn 都没有）。',
  '\t\t\t\t// 只在帧头值恰好等于总长时才剥，带不带帧头两种 PMHQ 行为都能吃下。',
  '\t\t\t\tif (payload.length > 4 && payload.readUInt32BE(0) === payload.length) payload = payload.subarray(4);',
]

/**
 * @returns {{ state: 'patched'|'missing'|'applied'|'nofile'|'unknown', detail?: string }}
 */
export function ensureLlbotPatch({ write = true } = {}) {
  if (!existsSync(TARGET)) return { state: 'nofile', detail: TARGET }

  const src = readFileSync(TARGET, 'utf8')

  if (src.includes(MARKER)) return { state: 'patched' }

  const at = src.indexOf(NEEDLE)
  if (at < 0) {
    // 要么 LLBot 换了写法，要么上游自己修了。两种都不该盲改。
    return { state: 'unknown', detail: '找不到补丁点，LLBot 可能改过版本' }
  }

  if (!write) return { state: 'missing' }

  if (!existsSync(BACKUP)) copyFileSync(TARGET, BACKUP)
  writeFileSync(TARGET, src.replace(NEEDLE, PATCH_LINES.join('\n')))
  return { state: 'applied' }
}

// ---------------------------------------------------------------- CLI

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const checkOnly = process.argv.includes('--check')
  const r = ensureLlbotPatch({ write: !checkOnly })

  const say = {
    patched: () => console.log('  ✅ LLBot 剥帧头补丁在位'),
    applied: () => console.log('  ✅ LLBot 剥帧头补丁已补回（刚被覆盖过）'),
    missing: () => console.log('  ❌ LLBot 剥帧头补丁缺失（重启 LuckyLillia 前先跑一次本脚本）'),
    nofile: () => console.log(`  ❌ 找不到 LLBot：${r.detail}`),
    unknown: () => console.log(`  ⚠️  ${r.detail} —— 补丁点没了，需要人工确认`),
  }[r.state]

  say()
  if (r.state === 'unknown' || r.state === 'nofile') process.exitCode = 1
}
