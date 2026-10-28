/**
 * turns.test.mjs —— 侧栏里直接跟她说话，也算一轮（issue #6）
 *
 * 这一组守五件事：
 *   ① 来源判据：真人打的（带 clientTimeZone）/ 插件 prompt 的（wake-/say- 前缀、
 *      无时区）/ 宿主拼的上下文（kind 不是 user）分得清；
 *   ② 真机会话事件的形态能取到正文（content 数组里的 text 块）；
 *   ③ 她屋里那一轮的 turn/end 结账：turns +1、原话进 talkmem；
 *   ④ 不是她屋里、或者不是人打的，一律不涨轮数；
 *   ⑤ 满 rotateAfter 就换会话，事件流里留一条 meta。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classifyMessage, messageText, registerTurns } from '../lib/turns.js'
import { homeStatus } from '../lib/home.js'
import { appendEvent, readEvents, writeAtomic, paths } from '../lib/store.js'
import { recentExchanges } from '../lib/talkmem.js'

const HER_SESSION = 's-her'

async function tmpRoot(home = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fish-turns-'))
  const seed = {
    wsId: 'ws-1',
    sessionId: HER_SESSION,
    createdAt: '2026-10-28T00:00:00.000Z',
    turns: 0,
    ...home,
  }
  await writeAtomic(join(paths(root).root, 'home.json'), JSON.stringify(seed, null, 2))
  return root
}

async function writeCfg(root, patch) {
  await writeAtomic(paths(root).config, JSON.stringify(patch, null, 2))
}

/** 假宿主：只要一条事件总线 + 会话服务 */
function fakeCtx() {
  const handlers = new Map()
  const created = []
  const renamed = []
  const ctx = {
    on(ev, fn) {
      const set = handlers.get(ev) ?? new Set()
      set.add(fn)
      handlers.set(ev, set)
      return () => set.delete(fn)
    },
    emit(ev, ...args) {
      for (const fn of handlers.get(ev) ?? []) fn(...args)
    },
    sessionController: {
      async create() {
        const id = `s-new-${created.length + 1}`
        created.push(id)
        return { sessionId: id }
      },
      async rename(arg) {
        renamed.push(arg)
      },
    },
    get: () => null,
  }
  return { ctx, created, renamed }
}

const session = (id = HER_SESSION) => ({ header: { id }, id })

/** 真机形态：source 带 clientTimeZone —— 只有客户端亲手打的字才有 */
function humanMsg(text, extra = {}) {
  return {
    type: 'user/message',
    data: {
      id: `m-${Math.random().toString(36).slice(2)}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId: 'rpc-aa1', clientTimeZone: 'Asia/Shanghai', ...extra },
    },
  }
}

/** 我们 prompt 进去的：kind 也是 user，但 rpcId 带前缀、没有时区 */
function pluginMsg(text) {
  return {
    type: 'user/message',
    data: {
      id: 'm-wake',
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId: 'wake-1234' },
    },
  }
}

const TURN_END = { type: 'turn/end' }

// 全量跑时这个文件会和别的测试文件并行，CPU 一挤，3 秒就不够了
// （2026-10-28 全量回归里偶发超时，单跑必过）。放宽到 15 秒，只在真卡住时才失败。
async function waitFor(fn, timeout = 15000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error('等超时了：条件一直没成立')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** 给异步结账留一点时间，再断言"确实没记" */
async function settled() {
  await new Promise((r) => setTimeout(r, 80))
}

test('来源判据：真人 / 插件 / 上下文 分得清', () => {
  assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'uuid-1', clientTimeZone: 'Asia/Shanghai' } }), 'human')
  assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'wake-abc' } }), 'plugin')
  assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'say-abc' } }), 'plugin')
  assert.equal(classifyMessage({ source: { kind: 'runtime-context' } }), 'context')
  assert.equal(classifyMessage({ source: { kind: 'skill-catalog' } }), 'context')
  assert.equal(classifyMessage({ source: { kind: 'plugin:hindsight' } }), 'context')
  assert.equal(classifyMessage({}), 'context')
  // 老客户端 / 别的插件灌的：没有时区，分不清就不算——宁可少算一轮
  assert.equal(classifyMessage({ source: { kind: 'user', rpcId: 'uuid-2' } }), 'unknown')
})

test('正文提取：真机 content 数组、老宿主 data.text 都兜得住', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: '今天想说什么' }] }), '今天想说什么')
  assert.equal(messageText({ content: [{ type: 'text', text: '一' }, { type: 'text', text: '二' }] }), '一\n二')
  assert.equal(messageText({ text: ' 就这么一句 ' }), ' 就这么一句 ')
  assert.equal(messageText({ content: '字符串正文' }), '字符串正文')
  assert.equal(messageText({ message: { content: '包了一层' } }), '包了一层')
  assert.equal(messageText({}), '')
  assert.equal(messageText(null), '')
})

test('她屋里真人说一句 → turn/end 结账：turns +1、原话进 talkmem', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 40 } })
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(), humanMsg('今天外面下雨了'))
      // 等她那条人话把 pending 认下来（sinceId 记的是"这一轮开始前"的位置）
      await settled()
      await appendEvent({ type: 'utterance', text: '那我把窗开着' }, { day: 0, stage: 1, source: 'system' }, root)

      ctx.emit('session/event', session(), TURN_END)
      await waitFor(async () => (await homeStatus(root)).turns === 1)

      const list = await recentExchanges(root)
      assert.equal(list.length, 1, '换会话时要搬的那几句里得有这一轮')
      assert.match(list[0].me, /今天外面下雨了/)
      assert.match(list[0].her, /那我把窗开着/, '她那一轮说的话要一起记下来')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('插件自己 prompt 进去的消息不涨轮数（没有 clientTimeZone）', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(), pluginMsg('深夜的唤醒'))
      ctx.emit('session/event', session(), TURN_END)
      await settled()
      assert.equal((await homeStatus(root)).turns, 0)
      assert.deepEqual(await recentExchanges(root), [])
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('不是她屋里那个会话，不记', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session('s-other'), humanMsg('我在别的会话里说话'))
      ctx.emit('session/event', session('s-other'), TURN_END)
      await settled()
      assert.equal((await homeStatus(root)).turns, 0)
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('满 rotateAfter 就换会话，事件流里留一条 meta', async () => {
  const root = await tmpRoot()
  try {
    await writeCfg(root, { chat: { rotateAfter: 1 } })
    const { ctx, created, renamed } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    try {
      ctx.emit('session/event', session(), humanMsg('聊满一轮了'))
      ctx.emit('session/event', session(), TURN_END)

      const h = await waitFor(async () => {
        const st = await homeStatus(root)
        return st.sessionId && st.sessionId !== HER_SESSION ? st : null
      })
      assert.equal(created.length, 1, '只该建一个新会话')
      assert.equal(h.sessionId, 's-new-1')
      assert.equal(h.turns, 0, '换会话后轮数归零')
      // 旧会话改名留档，标题里带「之前」
      assert.equal(renamed[0]?.sessionId, HER_SESSION)
      assert.match(String(renamed[0]?.title ?? ''), /之前$/)

      // home.json 与 events.jsonl 是两条异步写盘线：等事件落盘，别假设它比 home 先落
      const meta = await waitFor(async () => {
        const { events } = await readEvents(root)
        const hits = events.filter(
          (e) => e.type === 'meta' && String(e.text ?? '').startsWith('rotate:'),
        )
        return hits.length === 1 ? hits : null
      })
      assert.equal(meta[0].text, 'rotate:1:s-new-1')
      assert.equal(meta[0].source, 'system')
    } finally {
      off()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('注销之后就不再记了', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const off = registerTurns(ctx, { root, log: () => {} })
    off()
    ctx.emit('session/event', session(), humanMsg('注销之后说的话'))
    ctx.emit('session/event', session(), TURN_END)
    await settled()
    assert.equal((await homeStatus(root)).turns, 0)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})
