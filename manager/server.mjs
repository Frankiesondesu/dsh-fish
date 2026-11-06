/**
 * server.mjs —— GUI 管理器的本地服务（2026-11-06）
 *
 * 只监听 127.0.0.1（这台机器上的浏览器），端口 7789（避开查看器的 7788）。
 *
 * 三个原则：
 *   1. **不做业务**：启停全部转发给 launch/shutdown/restart，这里只管转发与回话；
 *   2. **同一时刻只放一个操作**：连点「重启」两下会把进程收两次、起两次，
 *      比不让点更麻烦。忙的时候回 409，界面自己会提示；
 *   3. **动作立即返回，状态靠轮询**：启一个服务要几秒到几十秒（TTS 那种更久），
 *      让 HTTP 一直挂着等，前端会以为卡死。
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import { HERE, ROOT, probeAll, startOne, stopOne, restartOne, serviceOf } from './services.mjs'

const PORT = Number(process.env.FISH_MANAGER_PORT || 7789)
const UI = join(HERE, 'ui.html')

/** 同一时刻只允许一个动作在跑。 */
let busy = ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let s = ''
    req.on('data', (c) => {
      s += c
      if (s.length > limit) reject(new Error('too large'))
    })
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {})
      } catch {
        reject(new Error('body 不是 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function spawnBg(exe, args, cwd) {
  const p = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd })
  p.on('error', () => {})
  p.unref()
  return p.pid
}

const ACTION_LABEL = { start: '启动', stop: '停止', restart: '重启' }

/** 单项动作。返回给界面一句人话。 */
async function doOne(key, action) {
  const s = serviceOf(key)
  if (!s) throw new Error(`没有叫「${key}」的服务`)
  if (s.managed === false) throw new Error(`${s.name} 不归这里管`)

  if (action === 'start') {
    startOne(key)
    return `正在启动 ${s.name}…`
  }
  if (action === 'stop') {
    stopOne(key)
    return `正在关闭 ${s.name}…`
  }
  if (action === 'restart') {
    // 重启要等旧进程让出端口再起，所以这里**要等**（最多 12 秒）
    await restartOne(key)
    return `${s.name} 已重新拉起`
  }
  throw new Error(`不认识的动作：${action}`)
}

/** 全部动作：直接转给现成的三个脚本，别在这儿再拼一遍顺序。 */
function doAll(action) {
  if (action === 'start') {
    spawnBg(process.execPath, [join(ROOT, 'launch.mjs')], ROOT)
    return '正在启动全部…（DSH 和三路加载要一会儿）'
  }
  if (action === 'stop') {
    spawnBg(process.execPath, [join(ROOT, 'shutdown.mjs')], ROOT)
    return '正在关闭全部…'
  }
  if (action === 'restart') {
    // restart.mjs 不带参数 = 全部重启；它会自己等端口、再验证
    spawnBg(process.execPath, [join(ROOT, 'restart.mjs')], ROOT)
    return '正在全部重启…（会等每个端口真的让出来，慢一点）'
  }
  throw new Error(`不认识的动作：${action}`)
}

function openBrowser(url) {
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0]

  try {
    if (url === '/api/services') {
      const services = await probeAll()
      return json(res, 200, { at: Date.now(), busy, services })
    }

    if (url === '/api/action' && req.method === 'POST') {
      const body = await readBody(req)
      const key = String(body.key ?? '')
      const action = String(body.action ?? '')
      if (!ACTION_LABEL[action]) return json(res, 400, { ok: false, error: `不认识的动作：${action}` })
      if (busy) return json(res, 409, { ok: false, error: `正忙（${busy}），等它完` })

      busy = `${serviceOf(key)?.name || key} · ${ACTION_LABEL[action]}`
      try {
        const message = await doOne(key, action)
        return json(res, 200, { ok: true, message })
      } finally {
        // 启动/停止是「发出去就不等」，留一小会儿忙标记，防连点
        await sleep(action === 'restart' ? 0 : 600)
        busy = ''
      }
    }

    if (url === '/api/all' && req.method === 'POST') {
      const body = await readBody(req)
      const action = String(body.action ?? '')
      if (!ACTION_LABEL[action]) return json(res, 400, { ok: false, error: `不认识的动作：${action}` })
      if (busy) return json(res, 409, { ok: false, error: `正忙（${busy}），等它完` })

      busy = `全部 · ${ACTION_LABEL[action]}`
      try {
        const message = doAll(action)
        return json(res, 200, { ok: true, message })
      } finally {
        await sleep(1200)
        busy = ''
      }
    }

    if (url === '/' || url === '/index.html') {
      let html = ''
      try {
        html = readFileSync(UI, 'utf8')
      } catch {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('ui.html 读不到（是不是被搬走了？）')
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(html)
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  } catch (err) {
    json(res, 500, { ok: false, error: String(err?.message ?? err) })
  }
}).on('error', (err) => {
  // 双击两次 .cmd 是很常见的事（第一次开着的窗口被忘在任务栏）。
  // 端口被占说明已经有一个管理器在跑 —— 那就直接开浏览器指过去，别再起第二个。
  // 不加这段的话，第二次双击只会弹一个「EADDRINUSE」的黑框，用户会以为坏了。
  if (err && err.code === 'EADDRINUSE') {
    console.log(`  已经有一个管理器在 ${PORT} 端口上了，直接开浏览器。`)
    openBrowser(`http://127.0.0.1:${PORT}`)
    process.exit(0)
  }
  console.error('管理器起不来：', err)
  process.exit(1)
}).listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`
  console.log('')
  console.log('  她 · 管理器')
  console.log('  ──────────────────────────────────────────────')
  console.log(`  ${url}`)
  console.log('')
  console.log('  关掉这个窗口 = 关掉管理器（不会动她那些服务）')
  console.log('')

  // 自己开浏览器：这样 管理器.cmd 只留一个窗口，关窗口就等于关管理器。
  // --no-open 给测试用（起了服务但不想每次弹一个标签页）。
  if (!process.argv.includes('--no-open')) openBrowser(url)
})
