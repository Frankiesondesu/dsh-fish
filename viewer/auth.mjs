/**
 * auth.mjs —— 查看器的两套权限（2026-11-10，用户定案）
 *
 * 口径：
 *   · **本机**（浏览器开 127.0.0.1）：免密，可读写——和以前一样；
 *   · **外部**（局域网、手机、隧道）：必须访问密码，而且**只读**。
 *
 * 为什么不能只看 remoteAddress：
 *   走隧道（cloudflared / cpolar / natapp）时，请求是从本机回环转发进来的，
 *   `remoteAddress` 会是 127.0.0.1 —— 只看 IP 就会把公网来客当成"本机"。
 *   所以只要带了代理头（x-forwarded-for / cf-connecting-ip / x-real-ip / forwarded），
 *   一律当外部。
 *
 * 密码存在 `~/.dsh-fish/viewer-pass.txt`（仓外，不进 git）；删掉重启会重新生成。
 * 比较用 timingSafeEqual，避免按字符比较泄漏长度/前缀。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const COOKIE = 'viewer_key'

export function passFile(root) {
  return join(root, 'viewer-pass.txt')
}

/** 读密码；没有就生成一个 12 位的，写盘后返回。 */
export function ensurePass(root) {
  const file = passFile(root)
  try {
    const s = readFileSync(file, 'utf8').trim()
    if (s) return s
  } catch { /* 还没有 */ }
  const pass = randomBytes(9).toString('base64url')
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, pass + '\n', 'utf8')
  } catch { /* 写不了也让本次运行有个密码 */ }
  return pass
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** 是不是真的本机（隧道转发的回环请求算外部）。 */
export function isLocal(req) {
  const ip = String(req?.socket?.remoteAddress ?? '')
  if (!LOOPBACK.has(ip)) return false
  const h = req?.headers ?? {}
  return !(h['x-forwarded-for'] || h['cf-connecting-ip'] || h['x-real-ip'] || h['forwarded'])
}

export function cookieOf(req, name = COOKIE) {
  const raw = String(req?.headers?.cookie ?? '')
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()) } catch { return '' }
    }
  }
  return ''
}

export function samePass(a, b) {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  if (!x.length || x.length !== y.length) return false
  try { return timingSafeEqual(x, y) } catch { return false }
}

/** 带了正确 cookie 才算登录。 */
export function authed(req, pass) {
  return samePass(cookieOf(req), pass)
}

/** 登录页：手机上一屏放得下，错了就回来说一句。 */
export function loginPage(bad = false) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>她 · 查看器</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e1014;color:#e9ebf2;font:14px/1.6 system-ui,"Microsoft YaHei UI",sans-serif}
form{background:#171a21;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:26px 24px;width:min(92vw,320px);box-shadow:0 10px 40px rgba(0,0,0,.35)}
h1{font-size:16px;margin:0 0 6px;font-weight:650}p{color:#8b93a7;font-size:12.5px;margin:0 0 16px}
input{width:100%;box-sizing:border-box;background:#0e1014;border:1px solid rgba(255,255,255,.12);color:#e9ebf2;border-radius:10px;padding:10px 12px;font:inherit;margin-bottom:12px}
button{width:100%;background:#8aa4ff;color:#0e1014;border:0;border-radius:10px;padding:10px;font:inherit;font-weight:650;cursor:pointer}
.err{color:#f0788a;font-size:12.5px;min-height:18px;margin-bottom:8px}
</style>
<form method="POST" action="/__login">
<h1>她 · 查看器</h1>
<p>这是外部访问。输入本机的访问密码；手机上只能看，不能改。</p>
<div class="err">${bad ? '密码不对。' : ''}</div>
<input type="password" name="key" autofocus autocomplete="current-password" placeholder="访问密码">
<button type="submit">进来</button>
</form>`
}

/** 读请求体（只用于登录表单，小）。 */
export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let s = ''
    req.setEncoding('utf8')
    req.on('data', (c) => {
      s += c
      if (s.length > limit) { reject(new Error('请求体太大')); req.destroy() }
    })
    req.on('end', () => resolve(s))
    req.on('error', reject)
  })
}
