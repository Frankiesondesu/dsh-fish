/**
 * /local/answer（2026-11-08）：QQ 桥把他点选项的回答送回来结算。
 *
 * 链路：她 ask_owner 挂卡 → push 推到 QQ → 他回数字 → 桥拦下 → 这里 answerCard。
 * 测试用真实账本（临时 root）：ask 事件写进去，直接打本地路由，
 * 断言 answer 事件真的落账、applyVerdict 真的走完——这是「他答了但没记上」
 * 那类事故的守卫。鉴权三态与 /local/wake 同款（见 local-wake.test.mjs）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerObserve } from '../lib/observe.js'
import { readEvents } from '../lib/store.js'

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

async function call(handler, { method = 'POST', key = '', body = null } = {}) {
  const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
    method,
    headers: { ...(key ? { 'x-fish-key': key } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    socket: { remoteAddress: '127.0.0.1' },
    url: '/',
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

test('local/answer：真实账本上把一张 ask 卡结掉（answer 事件落账）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-answer-'))
  try {
    const events = [
      JSON.stringify({ id: 'ev_ask1', type: 'ask', ts: new Date().toISOString(), text: '能不能给我一样能把算式排成图片的东西？', ask: { kind: 'need-tool', options: ['可以', '这次不行'] } }),
    ]
    await writeFile(join(root, 'events.jsonl'), events.join('\n') + '\n', 'utf8')

    const routes = harness(root)
    const h = routes.get('/dsh-fish/local/answer')
    assert.ok(h, '/local/answer 要注册上')
    await call(h, {}) // 触发 local.key 懒生成
    const key = (await readFile(join(root, 'local.key'), 'utf8')).trim()

    // 走 answerCard 的卡 id 约定：ask:<事件id>，selected 是选项原文
    const r = await call(h, { key, body: { id: 'ask:ev_ask1', selected: ['可以'] } })
    assert.equal(r.status, 200, `应答成功（实际 ${r.status}：${JSON.stringify(r.json)}）`)

    const { events: after } = await readEvents(root)
    const answer = after.find((e) => e.type === 'answer')
    assert.ok(answer, 'answer 事件要落账')
    assert.equal(answer.ask?.askId, 'ev_ask1')
    assert.equal(answer.ask?.verdict, 'approve')
    assert.equal(answer.ask?.via, 'relay')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('local/answer：已答过的卡再答要如实拒绝（不能双裁决）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-answer2-'))
  try {
    const events = [
      JSON.stringify({ id: 'ev_ask1', type: 'ask', ts: new Date().toISOString(), text: '问一句', ask: { kind: 'other', options: ['可以', '这次不行'] } }),
    ]
    await writeFile(join(root, 'events.jsonl'), events.join('\n') + '\n', 'utf8')
    const routes = harness(root)
    const h = routes.get('/dsh-fish/local/answer')
    await call(h, {}) // 生成 key
    const key = (await readFile(join(root, 'local.key'), 'utf8')).trim()

    await call(h, { key, body: { id: 'ask:ev_ask1', selected: ['可以'] } })
    const again = await call(h, { key, body: { id: 'ask:ev_ask1', selected: ['这次不行'] } })
    assert.equal(again.status, 409)
    assert.match(String(again.json?.error ?? again.json?.why), /已经答过/)

    const { events: after } = await readEvents(root)
    assert.equal(after.filter((e) => e.type === 'answer').length, 1, '账上只有一次裁决')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
