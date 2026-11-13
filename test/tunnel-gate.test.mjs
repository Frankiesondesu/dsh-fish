/**
 * tunnel-gate.test.mjs —— 隧道门的门禁与转发（2026-11-12）
 *
 * 关键断言：
 *   · 没登录 → 登录页 / API 401，绝不透传；
 *   · 登录后 → 透传到上游，且注入 x-forwarded-for（查看器据此判「外部」）；
 *   · POST /__login 密码对 → 303 + cookie；密码错 → 401；
 *   · POST body 原样到达上游（管理器一键操作的通道不能吞字节）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))
const PASS = 'gate-test-pass'

function startUpstream(echo) {
  const up = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ url: req.url, method: req.method, xff: req.headers['x-forwarded-for'] ?? null, body }))
    })
  })
  return new Promise((resolve) => up.listen(0, '127.0.0.1', () => resolve({ up, port: up.address().port })))
}

function startGate(home, viewerUp, managerUp) {
  const child = spawn(process.execPath, [join(ROOT, 'tunnel-gate.mjs')], {
    env: {
      ...process.env,
      FISH_GATE_HOME: home,
      FISH_GATE_VIEWER_PORT: '0', FISH_GATE_MANAGER_PORT: '0',
      FISH_GATE_VIEWER_UP: String(viewerUp), FISH_GATE_MANAGER_UP: String(managerUp),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // 用 data 事件累积：stdout.read() 是非阻塞的，轮询时会把日志读丢
  let out = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { out += String(c) })
  return { child, waitPorts: async () => {
    // 端口 0 时真端口在日志里，等两行「隧道门·」出来
    for (let i = 0; i < 100; i++) {
      if (out.split('\n').filter((l) => l.includes('隧道门·')).length >= 2) break
      await sleep(50)
    }
    const ports = [...out.matchAll(/127\.0\.0\.1:(\d+) →/g)].map((m) => Number(m[1]))
    return { viewer: ports[0], manager: ports[1] }
  } }
}

const req = (port, path, { method = 'GET', cookie = '', body = '' } = {}) =>
  new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path, method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}) } },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { data += c })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }))
      },
    )
    r.on('error', reject)
    if (body) r.write(body)
    r.end()
  })

test('隧道门：门禁、转发与 XFF 注入', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gate-test-'))
  writeFileSync(join(home, 'viewer-pass.txt'), PASS + '\n')
  const [{ up: upV, port: upVp }, { up: upM, port: upMp }] = await Promise.all([startUpstream(), startUpstream()])
  const { child, waitPorts } = startGate(home, upVp, upMp)
  try {
    const { viewer, manager } = await waitPorts()
    assert.ok(viewer && manager, '门两个端口都应起来')

    // 没登录：页面给登录页，API 给 401
    const page = await req(viewer, '/')
    assert.equal(page.status, 200)
    assert.match(page.data, /公网隧道入口/)
    const api = await req(viewer, '/api/data')
    assert.equal(api.status, 401)
    assert.match(api.data, /需要访问密码/)

    // /__login 密码错 → 401
    const bad = await req(viewer, '/__login', { method: 'POST', body: `key=${encodeURIComponent('wrong')}` })
    assert.equal(bad.status, 401)

    // /__login 密码对 → 303 + cookie
    const ok = await req(viewer, '/__login', { method: 'POST', body: `key=${encodeURIComponent(PASS)}` })
    assert.equal(ok.status, 303)
    const cookie = (ok.headers['set-cookie'] ?? [''])[0].split(';')[0]
    assert.match(cookie, /^viewer_key=/)

    // 登录后：透传 + 注入 XFF（查看器据此判「外部」的关键）
    const thru = await req(viewer, '/api/data?probe=1', { cookie })
    assert.equal(thru.status, 200)
    const echo = JSON.parse(thru.data)
    assert.equal(echo.url, '/api/data?probe=1')
    assert.equal(echo.xff, 'tunnel-gate')

    // POST body 原样透传（管理器一键操作走 POST）
    const post = await req(manager, '/api/restart', { method: 'POST', cookie, body: 'target=dsh' })
    const postEcho = JSON.parse(post.data)
    assert.equal(postEcho.method, 'POST')
    assert.equal(postEcho.body, 'target=dsh')
    assert.equal(postEcho.xff, 'tunnel-gate')

    // 健康检查不需要登录
    const health = await req(manager, '/__gate/health')
    assert.equal(health.status, 200)
    assert.match(health.data, /"ok":true/)
  } finally {
    child.kill()
    upV.close(); upM.close()
  }
})
