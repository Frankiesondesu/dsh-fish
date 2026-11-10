/**
 * bili-danmaku.js —— 弹幕解析与采样（从 bili.js 原样搬出，fork.29）
 *
 * 纯函数：XML 进，{t,text}[] 出。bili.js 原样 re-export。
 */

import { unescapeHtml } from './bili-sign.js'

/**
 * 解析弹幕 XML（<d p="时间,模式,字号,颜色,时间戳,池,uid,rowid">内容</d>）
 * @returns {{t:number,text:string}[]} 按时间升序
 */
export function parseDanmaku(xml) {
  const out = []
  const re = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g
  let m
  while ((m = re.exec(String(xml ?? '')))) {
    const p = m[1].split(',')
    const t = Number(p[0])
    const text = unescapeHtml(m[2]).trim()
    if (!Number.isFinite(t) || !text) continue
    if (text.length > 60) continue
    out.push({ t, text })
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

/**
 * 从一堆弹幕里均匀抽 n 条，返回带时间标签的"观众在第 X 分 Y 秒说"。
 * 为什么不按热度：弹幕没有赞数；均匀采样更接近"真的在看"。
 * 过滤掉纯符号、纯数字、复读机（同一文本出现 >3 次只留一次）。
 */
export function sampleDanmaku(list, n = 8, durationSec = 0) {
  const clean = []
  const seen = new Map()
  for (const d of list) {
    const t = String(d.text ?? '')
    if (!t || /^[\s\p{P}\p{S}\d]+$/u.test(t)) continue
    if (t.length <= 1) continue
    const c = (seen.get(t) ?? 0) + 1
    seen.set(t, c)
    if (c > 3) continue
    clean.push(d)
  }
  if (!clean.length) return []
  const want = Math.max(0, Math.min(Number(n) || 0, clean.length))
  if (!want) return []
  // 按时间分桶，每桶取一条 —— 这样抽出来的是"贯穿全片"的，不是开头挤成一堆
  const dur = Number(durationSec) > 0 ? Number(durationSec) : clean[clean.length - 1].t || 1
  const buckets = Array.from({ length: want }, () => [])
  for (const d of clean) {
    const idx = Math.min(want - 1, Math.floor((d.t / dur) * want))
    buckets[idx].push(d)
  }
  const picked = []
  for (let i = 0; i < want; i++) {
    const b = buckets[i]
    if (!b.length) continue
    // 桶内取中间那条，避开最吵的第一条
    picked.push(b[Math.floor(b.length / 2)])
  }
  // 桶不够（弹幕集中在中间）时用剩下的补满
  if (picked.length < want) {
    for (const d of clean) {
      if (picked.length >= want) break
      if (!picked.includes(d)) picked.push(d)
    }
  }
  return picked.sort((a, b) => a.t - b.t)
}
