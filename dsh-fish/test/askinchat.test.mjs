/**
 * askinchat.test.mjs —— 在会话里直接问她那个人（0.7.5，用户 m00239）
 *
 * 守这几件事：
 *   1. 问题先整形好再问；没 agent / 没服务 / 空问题都**降级返回**，绝不抛；
 *   2. 超时和外部取消都只是「这次没问到」，不当错误；
 *   3. 答案只认选中项（`selected[0]`），自定义输入也认；
 *   4. 提问要带 agent（宿主只认 live root agent），不带就白问。
 *
 * 这里不发真问题：宿主的 answerer 在 Web 客户端里，测试里没有。
 * 所以用假的 `userQuestions.ask`，把它收到的请求原样留下，
 * 断言的是**我们递出去的形状**，不是宿主的行为。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ASK_TIMEOUT_MS, askInChat, picked } from '../lib/askinchat.js'

/** 假上下文：一个「活着」的 agent + 一个记下请求的提问服务。 */
function fakeCtx({ answer = null, agents = true, service = true, onAsk = null } = {}) {
  const agent = { id: 'session-abc' }
  const seen = []
  const ctx = {
    get: (name) => {
      if (name !== 'agents') return undefined
      if (!agents) return undefined
      return {
        get: (id) => (id === 'session-abc' || id === 'session-abc'.replace(/^session-/, '') ? agent : undefined),
        list: () => [agent],
        roots: () => [agent],
      }
    },
  }
  if (service) {
    ctx.userQuestions = {
      ask: async (request) => {
        seen.push(request)
        if (onAsk) return onAsk(request)
        return answer ?? { answers: [{ id: 'keepsake', selected: ['准了'] }] }
      },
    }
  }
  return { ctx, agent, seen }
}

const ONE = [{ id: 'keepsake', header: '想带回家', question: '行吗', options: [{ label: '准了' }, { label: '算了' }] }]

test('askInChat：空问题不打扰宿主，直接说没问', async () => {
  const { ctx, seen } = fakeCtx()
  assert.deepEqual(await askInChat(ctx, { sessionId: 'session-abc', questions: [] }), { ok: false, code: 'NO_QUESTIONS' })
  assert.equal(seen.length, 0)
})

test('askInChat：压根没有 agent 就收手（不空等、不抛）', async () => {
  const { ctx, seen } = fakeCtx({ agents: false })
  const r = await askInChat(ctx, { sessionId: 'session-abc', questions: ONE, waitAgentMs: 0 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_AGENT')
  assert.equal(seen.length, 0)
})

test('askInChat：宿主没装 user-questions 服务时降级，不抛', async () => {
  const { ctx } = fakeCtx({ service: false })
  const r = await askInChat(ctx, { sessionId: 'session-abc', questions: ONE })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_SERVICE')
})

test('askInChat：问出去时带上 live agent 与自己的取消信号', async () => {
  const { ctx, agent, seen } = fakeCtx()
  const r = await askInChat(ctx, { sessionId: 'session-abc', questions: ONE })
  assert.equal(r.ok, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].agent, agent, '必须把 agent 递过去：宿主只认 live root agent')
  assert.ok(seen[0].signal, '必须自带 signal，宿主靠它断超时')
  assert.deepEqual(seen[0].questions, ONE)
})

test('askInChat：宿主报错只是「这次没问到」，把错误码带回去', async () => {
  const { ctx } = fakeCtx({ onAsk: () => { const e = new Error('no answerer'); e.code = 'NO_PROVIDER'; throw e } })
  const r = await askInChat(ctx, { sessionId: 'session-abc', questions: ONE })
  assert.deepEqual(r, { ok: false, code: 'NO_PROVIDER' })
})

test('askInChat：超时就自己收手，不会一直挂着', async () => {
  // 宿主那边永远不回：只有我们自己的定时器能把它断掉。
  const { ctx } = fakeCtx({ onAsk: (request) => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.code = 'ASK_TIMEOUT_ED'; reject(e)
    }, { once: true })
  }) })
  const started = Date.now()
  const r = await askInChat(ctx, { sessionId: 'session-abc', questions: ONE, timeoutMs: 120 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'ASK_TIMEOUT_ED')
  assert.ok(Date.now() - started < 3000, '必须靠自己的定时器在 120ms 后收手')
})

test('askInChat：外面取消（她这一轮已经结束了）立刻收手', async () => {
  const ac = new AbortController()
  const { ctx } = fakeCtx({ onAsk: (request) => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => { const e = new Error('x'); e.name = 'AbortError'; reject(e) }, { once: true })
  }) })
  setTimeout(() => ac.abort(), 30)
  const r = await askInChat(ctx, { sessionId: 'session-abc', questions: ONE, signal: ac.signal, timeoutMs: 60_000 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'AbortError')
})

test('askInChat：给了空答案也算没问到', async () => {
  const { ctx } = fakeCtx({ answer: { answers: [] } })
  assert.deepEqual(await askInChat(ctx, { sessionId: 'session-abc', questions: ONE }), { ok: false, code: 'NO_ANSWER' })
})

test('picked：取选中的第一个，没有就退回自定义输入，再没有就是空', () => {
  assert.equal(picked([{ id: 'keepsake', selected: ['准了'] }], 'keepsake'), '准了')
  assert.equal(picked([{ id: 'keepsake', selected: [] }], 'keepsake'), '')
  assert.equal(picked([{ id: 'keepsake', selected: [], custom: ' 我自己说 ' }], 'keepsake'), '我自己说')
  assert.equal(picked([{ id: 'other', selected: ['准了'] }], 'keepsake'), '')
  assert.equal(picked(undefined, 'keepsake'), '')
})

test('askInChat：默认等 5 分钟', () => {
  assert.equal(ASK_TIMEOUT_MS, 5 * 60_000)
})
