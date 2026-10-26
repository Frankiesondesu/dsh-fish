import test from 'node:test'
import assert from 'node:assert/strict'

import { wakeIfBlank } from '../lib/home.js'

const tick = () => new Promise((r) => setTimeout(r, 0))

/** 只造 wakeIfBlank 用到的那一层 ctx。 */
function ctxWith(sc) {
  return { get: (name) => (name === 'sessionController' ? sc : undefined) }
}

test('空白会话：叫一声，形状和 scheduler 的唤醒一致', async () => {
  const calls = []
  const sc = {
    list: async () => ({ items: [{ sessionId: 's1', blank: true }] }),
    prompt: async (req) => { calls.push(req) },
  }
  const r = await wakeIfBlank(ctxWith(sc), { sessionId: 's1' })
  assert.equal(r.woke, true)
  await tick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sessionId, 's1')
  assert.equal(calls[0].mode, 'queue')
  assert.equal(calls[0].content[0].type, 'text')
  assert.ok(calls[0].requestId.startsWith('wake-fresh-'))
})

test('已经有内容的会话：一个字都不说', async () => {
  let called = 0
  const sc = {
    list: async () => ({ items: [{ sessionId: 's1', blank: false }] }),
    prompt: async () => { called += 1 },
  }
  const r = await wakeIfBlank(ctxWith(sc), { sessionId: 's1' })
  assert.equal(r.woke, false)
  await tick()
  assert.equal(called, 0)
})

test('列表里找不到这条会话：按有内容处理，不叫', async () => {
  let called = 0
  const sc = {
    list: async () => ({ items: [{ sessionId: 'other', blank: true }] }),
    prompt: async () => { called += 1 },
  }
  const r = await wakeIfBlank(ctxWith(sc), { sessionId: 's1' })
  assert.equal(r.woke, false)
  await tick()
  assert.equal(called, 0)
})

test('list 抛错：不唤醒、也不把错误抛给调用方', async () => {
  let called = 0
  const logs = []
  const sc = {
    list: async () => { throw new Error('宿主抽风') },
    prompt: async () => { called += 1 },
  }
  const r = await wakeIfBlank(ctxWith(sc), { sessionId: 's1', log: (m) => logs.push(m) })
  assert.equal(r.woke, false)
  await tick()
  assert.equal(called, 0)
  assert.equal(logs.length, 1)
})

test('宿主没有 sessionController / 没有 prompt：明确说不行，不抛', async () => {
  assert.equal((await wakeIfBlank({}, { sessionId: 's1' })).woke, false)
  assert.equal((await wakeIfBlank(ctxWith({ list: async () => ({ items: [{ sessionId: 's1', blank: true }] }) }), { sessionId: 's1' })).woke, false)
})

test('prompt 自己失败：只是记一笔，不产生未处理拒绝', async () => {
  const logs = []
  const sc = {
    list: async () => ({ items: [{ sessionId: 's1', blank: true }] }),
    prompt: async () => { throw new Error('模型不在') },
  }
  const r = await wakeIfBlank(ctxWith(sc), { sessionId: 's1', log: (m) => logs.push(m) })
  assert.equal(r.woke, true)
  await tick()
  assert.ok(logs.some((m) => m.includes('唤醒失败')))
})

test('新建的会话查不到行：按空白处理，叫一声', async () => {
  const calls = []
  const sc = {
    list: async () => ({ items: [] }),
    prompt: async (req) => { calls.push(req) },
  }
  const r = await wakeIfBlank(ctxWith(sc), { sessionId: 's1', freshOnly: true })
  assert.equal(r.woke, true)
  await tick()
  assert.equal(calls.length, 1)
})

test('新建会话唤醒：向宿主 prompt 传入 signal', async () => {
  let signal
  const sc = {
    list: async () => ({ items: [] }),
    prompt: async (_request, receivedSignal) => {
      signal = receivedSignal
      receivedSignal.throwIfAborted()
    },
  }
  const r = await wakeIfBlank(ctxWith(sc), { sessionId: 's1', freshOnly: true })
  assert.equal(r.woke, true)
  await tick()
  assert.equal(typeof signal.throwIfAborted, 'function')
})

test('复用的会话查不到行：不碰，免得每次启动都让她说话', async () => {
  let called = 0
  const sc = {
    list: async () => ({ items: [] }),
    prompt: async () => { called += 1 },
  }
  const r = await wakeIfBlank(ctxWith(sc), { sessionId: 's1', freshOnly: false })
  assert.equal(r.woke, false)
  await tick()
  assert.equal(called, 0)
})

test('宿主不给 blank 字段：新建才叫，复用不叫', async () => {
  let called = 0
  const sc = {
    list: async () => ({ items: [{ sessionId: 's1' }] }),
    prompt: async () => { called += 1 },
  }
  assert.equal((await wakeIfBlank(ctxWith(sc), { sessionId: 's1', freshOnly: true })).woke, true)
  await tick()
  assert.equal(called, 1)
  assert.equal((await wakeIfBlank(ctxWith(sc), { sessionId: 's1', freshOnly: false })).woke, false)
  await tick()
  assert.equal(called, 1)
})
