/**
 * usage.mjs —— 查看器的「用量/消费」数据层（2026-11-06）
 *
 * 数据来自 DSH 自己写的 `~/.dsh/dsh-usage/usage-ledger.json`：
 *
 *   { version: 1,
 *     days: { '2026-10-17': { '<provider>': { '<model>': {
 *       inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 *       reasoningTokens, calls, cost } } } } }
 *
 * ⚠️ **这个文件 2026-10-25 之后就没再更新过**（实测：文件 mtime 10-26，
 * 最后一条数据是 10-25）。DSH 0.9.1 的打包代码里仍然有完整的用量统计
 * （`prompt_tokens` 39 处、`cacheReadTokens` 111 处、一整套 usage-* 组件），
 * 但数据不再落到这个文件——落点没找到。所以这里只展示**真实存在的部分**，
 * 并在页面上把「数据截止到哪天」写出来，不假装实时。
 *
 * 三条口径：
 *   1. **不编数**：文件缺、坏、空，都返回 ok:false + 原因，页面照实说；
 *   2. **不猜单位**：`cost` 字段原样展示。我按 DeepSeek 公开价反推过，
 *      三种常见计价口径都对不上这个数，所以**不加货币符号**，只说明「DSH 记的值」；
 *   3. **不合并不同 provider**：本地（cost=0）和账号（cost>0）分开列，
 *      混在一起看不出钱花在哪。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** DSH 用量账本的路径。`DSH_USAGE_LEDGER` 可覆盖（测试与换机用）。 */
export function usageLedgerFile() {
  return process.env.DSH_USAGE_LEDGER || join(homedir(), '.dsh', 'dsh-usage', 'usage-ledger.json')
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/**
 * 读账本。读不到、不是 JSON、没有 days —— 一律 ok:false，不抛。
 * 调用方是 HTTP 接口，抛一次整个查看器就 500。
 */
export function readUsage() {
  const file = usageLedgerFile()
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { ok: false, file, why: '没找到用量账本（DSH 可能还没写过）', days: [], models: [], total: null }
  }

  let j
  try {
    j = JSON.parse(raw)
  } catch {
    return { ok: false, file, why: '用量账本读不出来（不是合法 JSON）', days: [], models: [], total: null }
  }

  const days = j?.days
  if (!days || typeof days !== 'object') {
    return { ok: false, file, why: '用量账本里没有 days 字段', days: [], models: [], total: null }
  }

  return { ok: true, file, why: '', ...summarize(days) }
}

/**
 * 把 `days` 摊平成两份视图：按天、按 provider+model。
 * 导出来是为了测试能直接喂假数据。
 */
export function summarize(days) {
  const byDay = []
  const modelMap = new Map()

  for (const [date, providers] of Object.entries(days || {})) {
    const d = { date, calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0 }
    for (const [provider, models] of Object.entries(providers || {})) {
      for (const [model, u] of Object.entries(models || {})) {
        const calls = num(u?.calls)
        const input = num(u?.inputTokens)
        const output = num(u?.outputTokens)
        const cacheRead = num(u?.cacheReadTokens)
        const cost = num(u?.cost)

        d.calls += calls
        d.input += input
        d.output += output
        d.cacheRead += cacheRead
        d.cost += cost

        const key = `${provider}\u0000${model}`
        const m = modelMap.get(key) || { provider, model, calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0 }
        m.calls += calls
        m.input += input
        m.output += output
        m.cacheRead += cacheRead
        m.cost += cost
        modelMap.set(key, m)
      }
    }
    byDay.push(d)
  }

  byDay.sort((a, b) => a.date.localeCompare(b.date))

  const total = byDay.reduce(
    (a, d) => ({
      calls: a.calls + d.calls,
      input: a.input + d.input,
      output: a.output + d.output,
      cacheRead: a.cacheRead + d.cacheRead,
      cost: a.cost + d.cost,
    }),
    { calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0 },
  )

  const models = [...modelMap.values()].sort((a, b) => b.cost - a.cost || b.calls - a.calls)

  return {
    days: byDay,
    models,
    total,
    from: byDay.length ? byDay[0].date : '',
    to: byDay.length ? byDay[byDay.length - 1].date : '',
  }
}
