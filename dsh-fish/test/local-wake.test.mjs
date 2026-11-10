/**
 * /local/wake（2026-11-07）：7788 查看器的叫醒按钮走的本地通路。
 *
 * 它必须跟 /local/ping、/local/say 一样过 localOnly：只收回环连接、
 * 只认 <root>/local.key。这里用假 webServer 拿注册表，直接打 handler——
 * 不用真起端口，鉴权三态（没 key / 非 / 回环 / key 对）都能测到。
 * 和 /wake 共用 handleWake 这件事用源码形状断言钉住（照 forward.test 的惯例），
 * 免得哪天有人只改了一条路的行为。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerObserve } from '../lib/observe.js'

function harness(root) {
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name === 'connection') return { requestRejection: () => null }
      if (name === 'webServer') {
        return {
          register(ex) {
            routes.set(ex.path, ex.handler)
            return () => {}
          },
        }
      }
      return null
    },
  }
  registerObserve(ctx, { root })
  return routes
}

async function call(handler, { method = 'POST', key = '', remoteAddress = '127.0.0.1', url = '/' } = {}) {
  const req = Object.assign(Readable.from([]), {
    method,
    headers: key ? { 'x-fish-key': key } : {},
    socket: { remoteAddress },
    url,
  })
  let status = 0
  let text = ''
  const res = {
    writableEnded: false,
    writeHead(code) { status = code },
    end(chunk) { text = String(chunk ?? ''); res.writableEnded = true },
  }
  await handler(req, res)
  return { status, json: text ? JSON.parse(text) : null }
}

test('local/wake：回环 + local.key 鉴权三态，与 /wake 共用同一实现', async () => {
  const src = await readFile(new URL('../lib/observe.js', import.meta.url), 'utf8')
  assert.match(src, /\['\/local\/wake', handleWake\]/, '本地通路要挂 handleWake')
  assert.match(src, /\['\/wake', handleWake\]/, '/wake 也走同一个 handleWake，两条路不许分叉')

  const root = await mkdtemp(join(tmpdir(), 'fish-localwake-'))
  try {
    const routes = harness(root)
    const h = routes.get('/dsh-fish/local/wake')
    assert.ok(h, '/local/wake 要注册上')

    // local.key 是懒生成的（第一次鉴权才落盘），先打一发无 key 的请求把它生出来
    const noKey = await call(h, {})
    assert.equal(noKey.status, 401, '没带 key 不放行')
    const key = (await readFile(join(root, 'local.key'), 'utf8')).trim()

    const badKey = await call(h, { key: 'wrong'.repeat(12) })
    assert.equal(badKey.status, 401, 'key 不对不放行')
    const remote = await call(h, { key, remoteAddress: '8.8.8.8' })
    assert.equal(remote.status, 403, '非回环直接拒——这不是鉴权能放开的')

    // 密钥对了：handler 真跑起来。假 ctx 没有可叫的会话，wakeNow 会走它自己的
    // 降级路径（返回 ok:true 的「屋子没接上」或 ok:false 的规则拒绝都是合法结果），
    // 唯一不许出现的是 500——那说明实现没接住，会把「今天不该醒」变成技术错误。
    const ok = await call(h, { key })
    assert.notEqual(ok.status, 500, `handler 要接住假宿主（实际 ${ok.status}：${ok.json && JSON.stringify(ok.json)}）`)
    assert.equal(typeof ok.json?.ok, 'boolean', '返回值必须是结构化的 {ok,...}')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
