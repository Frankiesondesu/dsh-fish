/**
 * tunnel-gate.mjs —— 隧道门（2026-11-12）
 *
 * 为什么存在：查看器 auth.mjs 的 isLocal 靠「回环 + 无代理头」判本机；
 * 但 frp 这类纯 TCP 隧道把公网来客转成**不带代理头的回环请求**，查看器会
 * 把公网访客当本机 → 免密可写。管理器则压根没有认证。所以公网隧道不能
 * 直连 7788/7789，必须先进这道门。
 *
 * 口径：
 *   · 本机直开 7788 / 7789 —— 行为完全不变（免密可写 / 管理器免密）；
 *   · 公网隧道 → 门（7790→查看器、7791→管理器）→ 密码进 → 转发时注入
 *     `x-forwarded-for`，查看器立刻按「外部」办：密码 + 只读；管理器在门后。
 *   · 门复用查看器的密码与 cookie（`~/.dsh-fish/viewer-pass.txt` / `viewer_key`），
 *     一处密码、两端通用，登录一次两边都能进。
 *
 * 启动：`隧道门.cmd`（node tunnel-gate.mjs）。frp 隧道本地端口填 7790 / 7791，
 * **不要**建直连 7788 / 7789 的隧道。
 */

import http from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { COOKIE, cookieOf, ensurePass, loginPage, readBody, samePass } from './viewer/auth.mjs'

const HOME = process.env.FISH_GATE_HOME || join(homedir(), '.dsh-fish')
const VIEWER_PORT = Number(process.env.FISH_GATE_VIEWER_PORT || 7790)
const MANAGER_PORT = Number(process.env.FISH_GATE_MANAGER_PORT || 7791)
const VIEWER_UP = Number(process.env.FISH_GATE_VIEWER_UP || 7788)
const MANAGER_UP = Number(process.env.FISH_GATE_MANAGER_UP || 7789)

const PASS = ensurePass(HOME)

/** 门自己的登录页（复用查看器的样式，标题换成门）。 */
function gateLogin(label, bad = false) {
  const body = loginPage(bad)
    .replace('<title>她 · 查看器</title>', `<title>她 · ${label}</title>`)
    .replace('<h1>她 · 查看器</h1>', `<h1>她 · ${label}</h1>`)
    .replace('这是外部访问。输入本机的访问密码；手机上只能看，不能改。', '这是公网隧道入口。输入本机的访问密码。')
  return body
}

/** 一条「门 → 上游」的转发链。 */
function gate(upPort, label) {
  return async (req, res) => {
    // 门自己的健康检查（不认证，无敏感内容）——探活/管理器列表用
    if (req.url === '/__gate/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ ok: true, gate: label, up: `127.0.0.1:${upPort}` }))
    }
    // 登录：GET 出登录页，POST 校验密码、发 cookie（和查看器同一枚）
    if (req.url === '/__login') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(gateLogin(label))
      }
      if (req.method === 'POST') {
        let key = ''
        try { key = new URLSearchParams(await readBody(req)).get('key') ?? '' } catch { /* 体太大当空 */ }
        if (!samePass(key, PASS)) {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          return res.end(gateLogin(label, true))
        }
        res.writeHead(303, {
          location: '/',
          'set-cookie': `${COOKIE}=${encodeURIComponent(PASS)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
          'cache-control': 'no-store',
        })
        return res.end()
      }
    }
    // 没登录 → API 给 401 JSON，页面给登录页
    if (!samePass(cookieOf(req), PASS)) {
      const api = String(req.url).startsWith('/api/') || String(req.url).startsWith('/__gate/')
      res.writeHead(api ? 401 : 200, { 'content-type': api ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(api ? JSON.stringify({ ok: false, error: '需要访问密码' }) : gateLogin(label))
    }
    // 已登录 → 转发。注入 x-forwarded-for：查看器据此按「外部」办（密码+只读）。
    const headers = { ...req.headers, host: `127.0.0.1:${upPort}`, 'x-forwarded-for': 'tunnel-gate' }
    const up = http.request(
      { host: '127.0.0.1', port: upPort, path: req.url, method: req.method, headers },
      (pr) => {
        res.writeHead(pr.statusCode || 502, pr.headers)
        pr.pipe(res)
      },
    )
    up.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: `上游没起来（127.0.0.1:${upPort}）：${e.code ?? e.message}` }))
      } else {
        res.destroy()
      }
    })
    req.pipe(up)
  }
}

const viewer = http.createServer(gate(VIEWER_UP, '查看器（隧道）'))
const manager = http.createServer(gate(MANAGER_UP, '管理器（隧道）'))
viewer.listen(VIEWER_PORT, '127.0.0.1', () => {
  // 端口可配 0（测试让 OS 分配），日志必须报真实端口，frp 要填的是这个
  const p = viewer.address().port
  console.log(`隧道门·查看器： 127.0.0.1:${p} → 127.0.0.1:${VIEWER_UP}（frp 本地端口填 ${p}）`)
})
manager.listen(MANAGER_PORT, '127.0.0.1', () => {
  const p = manager.address().port
  console.log(`隧道门·管理器： 127.0.0.1:${p} → 127.0.0.1:${MANAGER_UP}（frp 本地端口填 ${p}）`)
})
console.log(`门密码与查看器同源：${join(HOME, 'viewer-pass.txt')}`)
