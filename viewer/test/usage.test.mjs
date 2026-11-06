/**
 * 用量统计（2026-11-06）：把 DSH 的 usage-ledger.json 摊成两份视图。
 *
 * 这个模块的难点不在算，在**不编**：
 *   · 账本 2026-10-25 之后就没再更新过，页面必须能说清"数据截止到哪天"；
 *   · `cost` 字段的口径我反推不出来（按 DeepSeek 三种常见计价都对不上），
 *     所以原样展示、不加货币符号——猜一个单位比不给更坏。
 * 下面钉的就是这两条：缺/坏/空都要走 ok:false 并给出人话原因，不许抛。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readUsage, summarize } from '../usage.mjs'

async function withLedger(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fish-usage-'))
  const file = join(dir, 'usage-ledger.json')
  if (content !== null) await writeFile(file, content)
  const old = process.env.DSH_USAGE_LEDGER
  process.env.DSH_USAGE_LEDGER = file
  try {
    return await fn(file)
  } finally {
    if (old === undefined) delete process.env.DSH_USAGE_LEDGER
    else process.env.DSH_USAGE_LEDGER = old
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
}

// 真实账本里 2026-10-17 与 10-25 的形状（照抄）
const REAL = {
  version: 1,
  days: {
    '2026-10-25': {
      'deepseek-account': {
        'deepseek-flash': {
          inputTokens: 308972,
          outputTokens: 543,
          cacheReadTokens: 72320,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          calls: 5,
          cost: 0.31259,
        },
      },
    },
    '2026-10-17': {
      'deepseek-account': {
        'deepseek-flash': {
          inputTokens: 12145,
          outputTokens: 12817,
          cacheReadTokens: 1776384,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          calls: 11,
          cost: 0.09894,
        },
      },
      local: {
        'global:deepseek-v4.1-flash': {
          inputTokens: 436343,
          outputTokens: 56824,
          cacheReadTokens: 20641280,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          calls: 96,
          cost: 0,
        },
      },
    },
  },
}

// ---------------------------------------------------------------- 读不到就明说

test('账本不存在：ok:false + 人话原因，不抛', async () => {
  await withLedger(null, () => {
    const r = readUsage()
    assert.equal(r.ok, false)
    assert.match(r.why, /没找到/)
    assert.deepEqual(r.days, [])
    assert.equal(r.total, null)
  })
})

test('账本不是合法 JSON：ok:false，不抛', async () => {
  await withLedger('{ 这不是 json', () => {
    const r = readUsage()
    assert.equal(r.ok, false)
    assert.match(r.why, /读不出来/)
  })
})

test('账本没有 days：ok:false，不抛', async () => {
  await withLedger(JSON.stringify({ version: 1 }), () => {
    const r = readUsage()
    assert.equal(r.ok, false)
    assert.match(r.why, /days/)
  })
})

// ---------------------------------------------------------------- 汇总

test('按天汇总：跨 provider 相加，天按日期升序', async () => {
  await withLedger(JSON.stringify(REAL), () => {
    const r = readUsage()
    assert.equal(r.ok, true)
    assert.equal(r.from, '2026-10-17')
    assert.equal(r.to, '2026-10-25')
    assert.equal(r.days.length, 2)

    const d17 = r.days[0]
    assert.equal(d17.date, '2026-10-17')
    // 两个 provider 的 calls 相加：11 + 96
    assert.equal(d17.calls, 107)
    assert.equal(d17.input, 12145 + 436343)
    assert.equal(d17.output, 12817 + 56824)
    assert.equal(d17.cacheRead, 1776384 + 20641280)
    // local 的 cost 是 0，不影响
    assert.equal(d17.cost, 0.09894)
  })
})

test('按模型汇总：本地与账号分开列，cost 降序', async () => {
  await withLedger(JSON.stringify(REAL), () => {
    const r = readUsage()
    assert.equal(r.models.length, 2)
    // deepseek-flash 有真实消费，排第一
    assert.equal(r.models[0].provider, 'deepseek-account')
    assert.equal(r.models[0].model, 'deepseek-flash')
    assert.equal(r.models[0].calls, 5 + 11)
    assert.equal(r.models[0].cost, 0.31259 + 0.09894)
    // 本地那个 cost 全是 0，排在后面
    assert.equal(r.models[1].provider, 'local')
    assert.equal(r.models[1].cost, 0)
  })
})

test('总计：calls / 三类 token / cost 都对得上', async () => {
  await withLedger(JSON.stringify(REAL), () => {
    const { total } = readUsage()
    assert.equal(total.calls, 5 + 11 + 96)
    assert.equal(total.input, 308972 + 12145 + 436343)
    assert.equal(total.output, 543 + 12817 + 56824)
    assert.equal(total.cacheRead, 72320 + 1776384 + 20641280)
    assert.equal(total.cost, 0.31259 + 0.09894)
  })
})

test('cost 原样保留，不做四舍五入——它本来就是个很小的数', () => {
  const s = summarize({ '2026-10-17': { p: { m: { calls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cost: 0.000001 } } } })
  assert.equal(s.total.cost, 0.000001)
})

test('字段缺了当 0，不产生 NaN（NaN 会让页面显示 NaN）', () => {
  const s = summarize({ '2026-10-17': { p: { m: { calls: 2 } } } })
  assert.equal(s.total.calls, 2)
  assert.equal(s.total.input, 0)
  assert.equal(s.total.cacheRead, 0)
  assert.equal(s.total.cost, 0)
  assert.ok(Number.isFinite(s.total.cost))
})

test('空 days：ok:true 但没有任何天，from/to 是空串（页面据此说「还没记过」）', () => {
  const s = summarize({})
  assert.deepEqual(s.days, [])
  assert.deepEqual(s.models, [])
  assert.equal(s.from, '')
  assert.equal(s.to, '')
  assert.equal(s.total.calls, 0)
})
