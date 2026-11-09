/**
 * rotate.js —— 换会话的第二个触发器：会话内容大小（2026-11-09）。
 *
 * 背景（11-09 的 token 事故）：会话从 11-05 活到 11-09 没换过（rotateAfter 当时是 0），
 * 上下文涨到 3.3MB+，每次 API 调用都顶着窗口上限重发，一天烧 8700 万 tokens
 * （99.4% 是缓存命中的重复输入）。原有的 rotateAfter 只数「轮数」——
 * 但轮数和上下文大小不严格挂钩：一轮里她可以调 20 次工具（her_say 拆条那次，
 * 一天 158 次 her_say），几轮就把上下文顶爆。所以加一个**按大小**的触发器，
 * 和轮数那个谁先到谁生效。
 *
 * 「大小」怎么量：宿主的会话日志 session.v4.jsonl.zstd（多帧拼接 zstd），
 * 解开后把会进上下文的事件字节加起来（user/assistant/tool/spliced/system——
 * 与 2026-11-09 用量审计用同一口径）。带 mtime+size 缓存：文件没变不重解，
 * 每次结账只 stat 一次。
 */

import { statSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会进模型上下文的事件类型（审计口径，2026-11-09 定）。 */
const SURFACE_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'agent/inbox/spliced',
  'system/message',
  'developer/message',
])

// mtime+size 缓存：同一路径文件没变就不重解（3MB 解一次 ~130ms，结账一轮一次也得省）。
const cache = new Map()

/**
 * 解一个会话日志，返回「会进上下文的事件」总字节数（JSON 序列化后的 UTF-8 字节数）。
 * 文件不存在/解不动返回 null（调用方当「不知道大小」处理，不拦轮换）。
 */
export function surfaceBytesFromFile(path) {
  let st
  try {
    st = statSync(path)
  } catch {
    return null
  }
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.bytes
  let buf
  try {
    buf = readFileSync(path)
  } catch {
    return null
  }
  // 多帧拼接 zstd：按 magic 切段逐帧解（与 viewer 同法）。尾帧写一半时解不动，跳过。
  const frames = []
  let a = buf.indexOf(MAGIC)
  while (a !== -1) {
    const b = buf.indexOf(MAGIC, a + 4)
    frames.push(buf.subarray(a, b === -1 ? buf.length : b))
    a = b
  }
  let bytes = 0
  for (const fr of frames) {
    let text = ''
    try {
      text = zstdDecompressSync(fr).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      let e
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      if (e && SURFACE_TYPES.has(e.type)) bytes += Buffer.byteLength(JSON.stringify(e), 'utf8')
    }
  }
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, bytes })
  return bytes
}

/** 丢弃某条会话的缓存（换会话/测试用；不丢也不会错——路径变了键就变了）。 */
export function dropSurfaceCache(path) {
  cache.delete(path)
}

/**
 * 会话日志路径：~/.dsh/sessions/--<fishRoot+home 的 slug>--/<sessionId>/session.v4.jsonl.zstd。
 * slug 规则与 viewer 的 shared/root.mjs 一致。⚠️ 是 `[:\\/]+` 不是 `[:\\/|]` 单字符——
 * `C:\Users` 里的「冒号+反斜杠」两个字符只换出**一个**横线（真实目录 `--C-Users-...--`），
 * 逐字符替换会得到 `--C--Users-...--`，existsSync 恒 false 且不报错（viewer 踩过）。
 * base 参数只给测试用。
 */
export function sessionLogFile(root, sessionId, base = join(homedir(), '.dsh', 'sessions')) {
  if (!sessionId) return null
  const slug = join(root, 'home').replace(/[:\\/]+/g, '-')
  const guess = join(base, `--${slug}--`, sessionId, 'session.v4.jsonl.zstd')
  if (existsSync(guess)) return guess
  // 兜底：slug 对不上（宿主换了编码规则）就按后缀把候选目录**挨个试**——
  // 不能 find 第一个就罢手：同一后缀可能有多条目录（多个 home 各一条），
  // 第一条里没有这个 sessionId 不代表第二条没有。
  try {
    const cands = readdirSync(base).filter((d) => d.endsWith(slug + '--'))
    for (const d of cands) {
      const p = join(base, d, sessionId, 'session.v4.jsonl.zstd')
      if (existsSync(p)) return p
    }
  } catch {
    /* 没有 sessions 目录就是没有 */
  }
  return null
}

/** 便利封装：当前会话的 surface 字节数。文件找不到返回 null。 */
export function sessionSurfaceBytes(root, sessionId) {
  const p = sessionLogFile(root, sessionId)
  return p ? surfaceBytesFromFile(p) : null
}

/**
 * 纯决策：换不换会话。轮数与大小两个触发器，谁先到谁生效；轮数优先报告。
 * @param {object} o
 * @param {number} o.turns          当前轮数
 * @param {number} o.rotateAfter    轮数阈值（0 = 不看轮数）
 * @param {number|null} o.surfaceBytes  当前会话内容字节数（null = 量不到，不按大小触发）
 * @param {number} o.rotateWhenKB   大小阈值（KB，0 = 不看大小）
 * @returns {{rotate:boolean, why:''|'turns'|'size', kb:number}}
 */
export function shouldRotate({ turns = 0, rotateAfter = 0, surfaceBytes = null, rotateWhenKB = 0 } = {}) {
  if (rotateAfter > 0 && turns >= rotateAfter) return { rotate: true, why: 'turns', kb: 0 }
  const kb = surfaceBytes == null ? 0 : Math.round(surfaceBytes / 1024)
  if (rotateWhenKB > 0 && surfaceBytes != null && kb >= rotateWhenKB) return { rotate: true, why: 'size', kb }
  return { rotate: false, why: '', kb }
}

/** 会话日志文件名（观测/排查用）。 */
export const SESSION_LOG_NAME = 'session.v4.jsonl.zstd'
