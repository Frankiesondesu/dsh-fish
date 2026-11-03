/**
 * tools/bench-hotpaths.mjs —— 热路径基准（fork.25–30 的收尾数字）
 *
 * 用法：node tools/bench-hotpaths.mjs [账本目录]
 * 默认读 ~/.dsh-fish。只读，不改任何文件，不进 test/（不参与回归）。
 *
 * 量的是四条路：配置读取、账本读取、deriveSelf（现算 vs 缓存）、recall 搜索。
 * 每组都跑一次预热再计时，避免 JIT 把第一轮算进去。
 */

import { performance } from 'node:perf_hooks'
import { readEvents, paths } from '../lib/store.js'
import { loadConfig } from '../lib/settings.js'
import { deriveSelf, deriveSelfCached, forgetDerived } from '../lib/derive.js'
import { searchEvents } from '../lib/recall.js'

const root = process.argv[2] || process.env.DSH_FISH_HOME || paths().root

function bench(label, fn, n = 30) {
  fn()
  fn()
  const t0 = performance.now()
  for (let i = 0; i < n; i++) fn()
  const ms = (performance.now() - t0) / n
  console.log(`${label.padEnd(34)} ${ms.toFixed(3)} ms/次`)
  return ms
}

const { events } = await readEvents(root)
console.log(`账本：${root}`)
console.log(`事件数：${events.length}\n`)

bench('loadConfig', () => loadConfig(root), 200)
bench('readEvents', () => readEvents(root), 200)

forgetDerived()
const raw = bench('deriveSelf（现算）', () => deriveSelf(events, { growthDays: 30 }), 20)
forgetDerived()
// 缓存版：第一次算完，后面全命中
deriveSelfCached(events, { growthDays: 30 })
const cached = bench('deriveSelfCached（命中）', () => deriveSelfCached(events, { growthDays: 30 }), 200)
console.log(`  → 提速 ${(raw / cached).toFixed(1)}x\n`)

bench('searchEvents（一次查询）', () => searchEvents(events, '视频', {}), 50)

// 合成账本：按当前账本循环复制到 3000 条，看增长后的曲线
const big = []
for (let i = 0; i < 3000; i++) {
  const s = events[i % events.length]
  big.push({ ...s, id: `${s.id}_${i}` })
}
console.log(`\n合成账本：3000 条`)
forgetDerived()
const bigRaw = bench('deriveSelf（现算）', () => deriveSelf(big, { growthDays: 30 }), 3)
forgetDerived()
deriveSelfCached(big, { growthDays: 30 })
const bigCached = bench('deriveSelfCached（命中）', () => deriveSelfCached(big, { growthDays: 30 }), 20)
console.log(`  → 提速 ${(bigRaw / bigCached).toFixed(0)}x`)
