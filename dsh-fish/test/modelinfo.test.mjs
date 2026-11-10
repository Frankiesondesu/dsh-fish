/**
 * modelinfo.test.mjs —— 「她那条会话用的是哪个模型、吃不吃图」。
 *
 * 为什么要单测：导出包里那一行是排查「看不见画面」的第一落点，
 * 但它拿的是宿主三个内部投影/服务。拿不到时必须说「说不准」，
 * 不能说「不支持」——后者会把排查的人直接带去换模型。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveHerModel } from '../lib/modelinfo.js'

function ctxOf({ snapshot, stateOf, llm } = {}) {
  const services = {}
  if (snapshot || stateOf) services.sessionProjections = { snapshot, stateOf }
  if (llm) services.llm = llm
  return { get: (name) => services[name] ?? null }
}

test('resolveHerModel：没有 projection 服务时判「说不准」，不猜', async () => {
  const r = await resolveHerModel({ get: () => null }, 's-1')
  assert.equal(r.provider, '')
  assert.equal(r.model, '')
  assert.equal(r.imageInput, null)
  assert.match(r.why, /读不到/)
})

test('resolveHerModel：没有 sessionId 时同一句「还没跟她说过话」', async () => {
  const r = await resolveHerModel(ctxOf({ snapshot: async () => ({ modelSelection: { lastUsed: { provider: 'p', model: 'm' } } }) }), '')
  assert.equal(r.imageInput, null)
  assert.match(r.why, /还没跟她说过话/)
})

test('resolveHerModel：模型声明了 image → 支持', async () => {
  const ctx = ctxOf({
    snapshot: async () => ({ modelSelection: { lastUsed: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } }),
    llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
  })
  const r = await resolveHerModel(ctx, 's-1')
  assert.equal(r.provider, 'deepseek-official')
  assert.equal(r.model, 'deepseek-v4-flash')
  assert.equal(r.imageInput, true)
  assert.equal(r.why, '')
})

test('resolveHerModel：模型没声明 image → 不支持（这是能回答「为什么看不见」的唯一硬证据）', async () => {
  const ctx = ctxOf({
    snapshot: async () => ({ modelSelection: { lastUsed: { provider: 'p', model: 'text-only' } } }),
    llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) },
  })
  const r = await resolveHerModel(ctx, 's-1')
  assert.equal(r.imageInput, false)
})

test('resolveHerModel：模型没报 inputModalities → 仍然是「说不准」，不是不支持', async () => {
  const ctx = ctxOf({
    snapshot: async () => ({ modelSelection: { lastUsed: { provider: 'p', model: 'm' } } }),
    llm: { resolveModelInfo: async () => ({}) },
  })
  const r = await resolveHerModel(ctx, 's-1')
  assert.equal(r.imageInput, null)
  assert.match(r.why, /inputModalities/)
})

test('resolveHerModel：宿主没给 llm 服务 → 说不准，且不抛', async () => {
  const ctx = ctxOf({ snapshot: async () => ({ modelSelection: { lastUsed: { provider: 'p', model: 'm' } } }) })
  const r = await resolveHerModel(ctx, 's-1')
  assert.equal(r.imageInput, null)
  assert.match(r.why, /llm/)
})

test('resolveHerModel：resolveModelInfo 抛错 → 说不准，绝不连累导出', async () => {
  const ctx = ctxOf({
    snapshot: async () => ({ modelSelection: { lastUsed: { provider: 'p', model: 'm' } } }),
    llm: { resolveModelInfo: async () => { throw new Error('boom') } },
  })
  const r = await resolveHerModel(ctx, 's-1')
  assert.equal(r.imageInput, null)
  assert.match(r.why, /问不到/)
  assert.match(r.why, /boom/)
})

test('resolveHerModel：snapshot 挂了就退回 stateOf，两条路都试过才放弃', async () => {
  const calls = []
  const ctx = ctxOf({
    snapshot: async () => { throw new Error('no snapshot') },
    stateOf: async (_sid, key) => {
      calls.push(key)
      return { lastUsed: { provider: 'p', model: 'm' } }
    },
    llm: { resolveModelInfo: async () => ({ inputModalities: ['image'] }) },
  })
  const r = await resolveHerModel(ctx, 's-1')
  assert.deepEqual(calls, ['modelSelection'])
  assert.equal(r.model, 'm')
  assert.equal(r.imageInput, true)
})
