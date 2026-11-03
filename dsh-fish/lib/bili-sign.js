/**
 * bili-sign.js —— wbi 签名与文本小工具（从 bili.js 原样搬出，fork.29）
 *
 * 这一层全是纯函数：给定输入必有输出，没有网络、没有模块状态。
 * bili.js 原样 re-export，observe/watch/look 那边的 import 一行不用改。
 */

import { createHash } from 'node:crypto'

/** wbi 混淆表（B 站前端写死的常量，不是密钥） */
const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

/**
 * wbi 签名密钥：从 nav 接口的 img_url / sub_url 各取文件名，按 MIXIN 表打成 32 位。
 * @param {string} imgKey
 * @param {string} subKey
 */
export function mixinKey(imgKey, subKey) {
  const s = String(imgKey ?? '') + String(subKey ?? '')
  let out = ''
  for (const i of MIXIN) out += s[i] ?? ''
  return out.slice(0, 32)
}

/**
 * 给参数签名，返回可直接拼到 URL 后面的 query 串。
 * 规则：按键名排序 → 值去掉 !'()* → encodeURIComponent → 拼 mk 后取 md5 → w_rid
 */
export function signQuery(params, mk, wts = Math.floor(Date.now() / 1000)) {
  const all = { ...params, wts }
  const q = Object.keys(all)
    .sort()
    .map((k) => {
      const v = String(all[k] ?? '').replace(/[!'()*]/g, '')
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
    })
    .join('&')
  const w_rid = createHash('md5').update(q + mk).digest('hex')
  return `${q}&w_rid=${w_rid}`
}

/** 弹幕/评论里常见的 HTML 实体 */
export function unescapeHtml(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/** 搜索结果标题里带 <em class="keyword"> 高亮，去掉标签 */
export function stripEm(s) {
  return unescapeHtml(String(s ?? '').replace(/<[^>]*>/g, ''))
}

/** 秒 → 3:07 / 1:02:03 */
export function fmtDur(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(n / 3600)
  const m = Math.floor((n % 3600) / 60)
  const s = n % 60
  const pad = (x) => String(x).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/**
 * 把 cookie 串整理干净（允许从 Netscape cookies.txt 或 "a=1; b=2" 传入）
 */
export function normalizeCookie(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  if (s.includes('\t')) {
    const pairs = []
    for (const line of s.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue
      const p = line.split('\t')
      if (p.length >= 7 && p[5]) pairs.push(`${p[5]}=${p[6]}`)
    }
    return pairs.join('; ')
  }
  return s
}
