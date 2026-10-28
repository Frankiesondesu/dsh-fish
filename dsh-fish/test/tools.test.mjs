/**
 * tools.test.mjs —— 工具注册的形状守门
 *
 * 为什么单独一个文件（2026-10-25）：
 *   用全新 profile 从 tarball 装一遍才发现，npm 装进来的插件真实路径在
 *   `<profile>/node_modules/dsh-fish/`，往上能找到宿主的 `@deepseek-ai/dsh-tools`，
 *   于是 `defineTool` 真的被调用——它期待「简写 DSL 属性表」，我们传的是完整
 *   JSON Schema，编译时把根上的 `type:'object'` 当成一个叫 type 的参数，报
 *     unsupported JSON schema: parameters.type must be a value schema object
 *   → 6 个工具全部注册失败。本机是 link: 装的，往上找不到那个包，走兜底，所以
 *   这条 bug 只会在别人装了之后出现。
 *
 * 这里守三件事：
 *   1. lib/ 里不许再 import 宿主的 dsh-tools；
 *   2. `defineTool(spec)` 就是恒等（注册时直接交 JSON Schema）；
 *   3. 七个工具定义都长成宿主认的形状（parameters 是 object-rooted JSON Schema、
 *      output.schema 也是、render / execute 是函数）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { defineTool } from '../lib/tool.js'
import { registerCapture } from '../lib/capture.js'
import { registerLetter } from '../lib/letter.js'
import { registerLook } from '../lib/look.js'
import { registerRecall } from '../lib/recall.js'
import { registerHerDiary } from '../lib/herdiary.js'
import { registerSpeak } from '../lib/speak.js'
import { registerWatch } from '../lib/watch.js'
import { FISH_TOOLS, HER_TOOLS } from '../lib/restrict.js'
import { runChecks } from '../lib/selfcheck.js'

const LIB = fileURLToPath(new URL('../lib/', import.meta.url))
const ROOT = join(tmpdir(), 'dsh-fish-tools-test')

function fakeCtx() {
  const defs = []
  return {
    defs,
    tools: {
      register(d) {
        defs.push(d)
        return () => {}
      },
    },
  }
}

test('lib/ 里不再 import 宿主的 dsh-tools', () => {
  const hits = []
  for (const f of readdirSync(LIB)) {
    if (!f.endsWith('.js')) continue
    const s = readFileSync(join(LIB, f), 'utf8')
    // 注释里可以提这个名字（tool.js 就在解释为什么不用它），但代码里不许出现
    const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    if (/@deepseek-ai\/dsh-tools/.test(code)) hits.push(f)
  }
  assert.deepEqual(hits, [], '这些文件又把宿主的 dsh-tools import 回来了')
})

test('defineTool 是恒等：不编译、不改写', () => {
  const spec = { name: 'x', parameters: { type: 'object', properties: {} } }
  assert.equal(defineTool(spec), spec)
})

test('八个工具定义都长成宿主认的形状', () => {
  const ctx = fakeCtx()
  const deps = { root: ROOT, log: () => {} }
  registerCapture(ctx, deps)
  registerLetter(ctx, deps)
  registerLook(ctx, deps)
  registerRecall(ctx, deps)
  registerHerDiary(ctx, deps)
  registerSpeak(ctx, deps)
  registerWatch(ctx, deps)

  assert.equal(ctx.defs.length, 7, '我们自己的工具是 7 个（第 8 个 read_image 是宿主的）')
  const names = ctx.defs.map((d) => d.name)
  for (const n of names) assert.ok(FISH_TOOLS.includes(n), `${n} 不在 FISH_TOOLS 里`)

  for (const d of ctx.defs) {
    assert.equal(typeof d.name, 'string')
    assert.ok(d.description.length > 10, `${d.name} 的说明太短`)
    // parameters：根级 object JSON Schema（不是简写 DSL）
    assert.equal(d.parameters?.type, 'object', `${d.name}.parameters 根级必须是 object`)
    assert.equal(typeof d.parameters.properties, 'object', `${d.name}.parameters.properties 缺失`)
    assert.ok(!('required' in d.parameters) || Array.isArray(d.parameters.required))
    // output：宿主 registry 会校验它
    assert.equal(d.output?.schema?.type, 'object', `${d.name}.output.schema 根级必须是 object`)
    assert.equal(typeof d.output.render, 'function', `${d.name}.output.render 必须是函数`)
    assert.equal(typeof d.execute, 'function', `${d.name}.execute 必须是函数`)
  }
})

test('自检按 registry 里真的在不在判断，而不是配置名单', async () => {
  const cfg = { growthDays: 30, window: { start: '20:00', end: '23:00' }, tools: {} }
  const allThere = { get: (n) => (HER_TOOLS.includes(n) ? { name: n } : undefined) }
  const R = { allow: [...HER_TOOLS], applied: 1, failed: '' }
  const ok = await runChecks({ root: ROOT, config: cfg, host: {}, tools: allThere, restrict: R, net: false })
  const okItem = ok.items.find((i) => i.id === 'tools')
  assert.equal(okItem.ok, true, okItem.detail)

  // 2026-10-28 深夜改写（用户 m05885 的真机反证）：
  // 原先这里断言「全局工具表里没有 read_image ⇒ 必须报红」。那个判据是**必然误报**——
  // 宿主把 read_image 注册在 agent 平面（由 attachments 服务挂着），全局表里根本查不到。
  // 用户同一条会话里 read_image 明明取到了 1096x622 的 PNG、她还照着画面把内容讲了，
  // 自检却说她「看不了图」。所以现在的判据是「有正面证据才算有，没证据就说判不准」。
  //
  // ① 真机那种情况：全局表查不到，但收窄真的挂上了、名单里有它 ⇒ 绿（宿主认过这个名字）。
  const noImage = { get: (n) => (n === 'read_image' ? undefined : { name: n }) }
  const img = await runChecks({ root: ROOT, config: cfg, host: {}, tools: noImage, restrict: R, net: false })
  const imgTools = img.items.find((i) => i.id === 'tools')
  assert.equal(imgTools.ok, true, imgTools.detail)
  const imgItem = img.items.find((i) => i.id === 'read-image')
  assert.ok(HER_TOOLS.includes('read_image'), '收窄名单里得有 read_image，这条用例才成立')
  assert.equal(imgItem.ok, true, `全局表查不到、但收窄认过，不能报红：${imgItem.detail}`)
  assert.match(imgItem.detail, /read_image/)
  // 整体可能因为别的项（cookie / 宿主接口 / 这台机器没装 ffmpeg）红，但「看画面」这一项不能再红。
  // 2026-10-28 修（GitHub 的 Windows runner 红）：早先这里断言 summary 不含 /看画面/，
  // 会把另一项的标题「看画面用的 ffmpeg」也连坐禁掉——那条红说的是 ffmpeg 缺失，跟 read_image 无关。
  const redIds = img.items.filter((i) => !i.ok).map((i) => i.id)
  assert.ok(!redIds.includes('read-image'), `「看画面」不能进要注意清单：${img.summary}`)

  // ② 全局表里直接看到 ⇒ 绿。
  const allTools = { get: (n) => ({ name: n }) }
  const withImg = await runChecks({ root: ROOT, config: cfg, host: {}, tools: allTools, restrict: R, net: false })
  const okImg = withImg.items.find((i) => i.id === 'read-image')
  assert.equal(okImg.ok, true, okImg.detail)

  // ③ 宿主明说了没挂附件服务 ⇒ 一定没有 read_image，报红并给修法。
  const noAttach = await runChecks({
    root: ROOT, config: cfg, host: {}, tools: noImage, restrict: { allow: [], applied: 0, failed: '' },
    attachments: false, net: false,
  })
  const noAttachItem = noAttach.items.find((i) => i.id === 'read-image')
  assert.equal(noAttachItem.ok, false, '没挂附件服务必须报出来')
  assert.match(noAttachItem.detail, /read_image/)
  assert.match(noAttachItem.fix, /附件|图片/)

  // ④ 什么旁证都没有 ⇒ 说「判不准」，不冤枉她看不了图。
  const unclear = await runChecks({
    root: ROOT, config: cfg, host: {}, tools: noImage, restrict: { allow: [], applied: 0, failed: '' }, net: false,
  })
  const unclearItem = unclear.items.find((i) => i.id === 'read-image')
  assert.equal(unclearItem.ok, true, unclearItem.detail)
  assert.match(unclearItem.detail, /查不准|判不准/)

  // ⑤ 没有 tools（预检/假环境）时不冒充结论：这一项干脆不出现。
  const noTools = await runChecks({ root: ROOT, config: cfg, host: {}, restrict: R, net: false })
  assert.equal(noTools.items.find((i) => i.id === 'read-image'), undefined)

  const missingOne = { get: (n) => (n === 'growth_commit' ? undefined : { name: n }) }
  const bad = await runChecks({ root: ROOT, config: cfg, host: {}, tools: missingOne, net: false })
  const badItem = bad.items.find((i) => i.id === 'tools')
  assert.equal(badItem.ok, false)
  assert.match(badItem.detail, /growth_commit/)
  assert.match(badItem.fix, /日志/)
})
