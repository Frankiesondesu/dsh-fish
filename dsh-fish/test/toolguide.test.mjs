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
import { readFile } from 'node:fs/promises'
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

/**
 * fork.13 守卫（2026-11-08）：她画好白板后查了两次 her_help，
 * 读到「收藏只认他递来的图」就断定自己画的发不出去——其实桥早有发图通路。
 * 说明书互相打架 = 工具对她说了不真的话。这条把三处口径钉在一起。
 */
test('发图的路说真：her_say 有写法、her_draw 指向它、her_meme 不再拿来源挡她', () => {
  const say = [...TOOL_GUIDE.her_say.can, ...TOOL_GUIDE.her_say.cant].join('\n')
  assert.match(say, /!\[/, 'her_say 要写出图片 markdown 的写法')
  assert.match(say, /media\//, '要写明只认 media/ 下的图')
  assert.match(say, /跳过不发/, '桥静默跳过这件事也要如实告诉她')

  const draw = [...TOOL_GUIDE.her_draw.can, ...TOOL_GUIDE.her_draw.cant].join('\n')
  assert.match(draw, /her_say/, 'her_draw 指向现成的发图通路，不再只说表情库')
  assert.match(draw, /只存不发/, '用户定案不能被动摇')

  const meme = [...TOOL_GUIDE.her_meme.can, ...TOOL_GUIDE.her_meme.cant].join('\n')
  assert.ok(!meme.includes('只认他递来的图'), '这句不真：代码按路径判定，她画的也在 media/ 下')
  assert.match(meme, /完整路径/, '按路径说真')
  assert.match(meme, /收藏本身不发送/, '收藏不等于发送')
})

test('工具回执与参数说明同步说真（只改 toolguide 不算修完）', async () => {
  const meme = await readFile(new URL('../lib/meme.js', import.meta.url), 'utf8')
  const draw = await readFile(new URL('../lib/draw.js', import.meta.url), 'utf8')
  assert.ok(!meme.includes('只收他递来的图'), '旧回执把她的画挡在门外')
  assert.ok(!meme.includes('只认他递来的'), '旧参数说明也要清干净')
  assert.match(meme, /完整路径/)
  assert.match(meme, /media\/draw\//)
  assert.match(draw, /slashed\(out\)/, '回执要给可抄的正斜杠完整路径')
  assert.match(draw, /没有发给他/, '只存不发仍要说清')
  assert.match(draw, /her_say/, '回执要把发图通路指给她')
})
