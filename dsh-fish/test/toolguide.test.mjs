/**
 * 工具说明书（fork.44，2026-11-04）。
 *
 * 用户要的是「每次做好新工具，她能查到它是什么」。
 * 这层不常驻上下文——工具表里的 description 只留一句话，细节按需查。
 *
 * 最重要的一条测试：**每个真实存在的工具都必须有说明书**。
 * 少了它，下次加工具就会静默漏掉说明，她又会对着一个不认识的名字发呆。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_GUIDE, guideIndex, guideOf } from '../lib/toolguide.js'
import { FISH_TOOLS } from '../lib/restrict.js'

test('每个插件工具都写了说明（加了工具不写说明会在这里红）', () => {
  const missing = FISH_TOOLS.filter((n) => !TOOL_GUIDE[n])
  assert.deepEqual(missing, [], `这些工具没有说明书：${missing.join(', ')}`)
})

test('说明书里没有不存在的工具（避免改名后留下孤儿条目）', () => {
  // read_image 是宿主工具、不在 FISH_TOOLS 里，但它确实在她手上，允许存在
  const allowed = new Set([...FISH_TOOLS, 'read_image', 'her_say'])
  const orphan = Object.keys(TOOL_GUIDE).filter((n) => !allowed.has(n))
  assert.deepEqual(orphan, [], `说明书里有她已经用不了的工具：${orphan.join(', ')}`)
})

test('目录：每个工具一行，带一句话', () => {
  const idx = guideIndex()
  assert.equal(idx.length, Object.keys(TOOL_GUIDE).length)
  for (const line of idx) assert.match(line, /^- \S+：\S/)
})

test('详情：能做什么和做不到都写清楚', () => {
  const t = guideOf('her_alarm')
  assert.ok(t.includes('## her_alarm'))
  assert.ok(t.includes('能做：'))
  assert.ok(t.includes('做不到：'))
  assert.ok(t.includes('每天'), '要说明它做不到"每天"这件事')
})

test('查一个没有的：返回空串，由调用方决定怎么说', () => {
  assert.equal(guideOf('her_teleport'), '')
  assert.equal(guideOf(''), '')
})

test('说明书不写"你应该"——那是替她做判断', () => {
  const all = Object.entries(TOOL_GUIDE)
    .flatMap(([n, g]) => [n, g.brief, ...g.can, ...g.cant])
    .join('\n')
  assert.ok(!/你应该|你必须|记得要/.test(all), '说明书只写事实，不写指令')
})
