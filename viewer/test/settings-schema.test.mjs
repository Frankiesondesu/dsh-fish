/**
 * 设置全量化的防漂移守卫（2026-11-07）。
 *
 * 两个不动点：
 * ① SETTINGS 每个键的顶层组必须落在 observe.js /config 的 allowed 白名单里——
 *    漏登记的组整表提交会被 400 挡回来（2026-10-29 真机踩过「漏登记 bili」，
 *    p5 那条测试就是为它建的；这里把 viewer 侧也钉住）。
 * ② 每个键必须真的存在于插件 DEFAULTS 里——打错字的键静默存不进去还看不出来。
 * allowed 数组从 observe.js 源码解析（镜像 p5 对 client.js 的做法）：
 * 那是真正的闸门，别在测试里再抄一份。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const { SETTINGS } = await import('../settings-schema.mjs')
const { DEFAULTS } = await import('file:///' + join(HERE, 'dsh-fish', 'lib', 'settings.js').replace(/\\/g, '/'))

test('SETTINGS 的顶层组全部在 /config 白名单里', async () => {
  const src = await readFile(join(HERE, 'dsh-fish', 'lib', 'observe.js'), 'utf8')
  const m = /const allowed = \[([^\]]+)\]/.exec(src)
  assert.ok(m, 'observe.js 里要能解析出 allowed 数组（它挪位置了就改这条）')
  const allowed = m[1].split(',').map((s) => s.trim().replaceAll("'", ''))
  const tops = [...new Set(SETTINGS.map((s) => s.key.split('.')[0]))]
  const bad = tops.filter((t) => !allowed.includes(t))
  assert.deepEqual(bad, [], `这些组没登记进 observe.js 的 allowed：${bad.join('、')}——加进去，否则整表提交全存不进去`)
})

test('SETTINGS 的每个键都在插件 DEFAULTS 里（打错字会静默失效）', () => {
  const bad = []
  for (const s of SETTINGS) {
    const parts = s.key.split('.')
    let cur = DEFAULTS
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object' || !(p in cur)) { bad.push(s.key); break }
      cur = cur[p]
    }
  }
  assert.deepEqual(bad, [], `这些键在 DEFAULTS 里不存在：${bad.join('、')}`)
})

test('kind 合法、danger 项都给了 hint', () => {
  const kinds = new Set(['num', 'bool', 'window', 'list', 'text'])
  for (const s of SETTINGS) {
    assert.ok(kinds.has(s.kind), `${s.key} 的 kind=${s.kind} 不在支持清单里`)
    assert.ok(s.label && s.group, `${s.key} 缺 label/group`)
    if (s.danger) assert.ok(s.hint, `${s.key} 是 danger 项，必须有 hint 说明后果`)
  }
  // 顶层组去重后应该覆盖了全部 allowed 里的「用户可调」组——防漏搬
  const tops = new Set(SETTINGS.map((s) => s.key.split('.')[0]))
  for (const g of ['world', 'video', 'comment', 'chat', 'rooms', 'memory', 'rules', 'outing', 'notify', 'tools']) {
    assert.ok(tops.has(g), `allowed 里的 ${g} 组没有任何一项被搬进查看器设置`)
  }
})

/**
 * 2026-11-10：核对查看器设置与插件设置时，查出 17 处范围对不上、1 个旋钮没搬
 * （bili.enabled）。两条都是「保存时静默夹值 / 用户根本调不到」的哑故障，人眼很难发现。
 * 这里直接从 settings.js 源码解析 LIMITS 与 DEFAULTS 对账——判据只有一份，别抄第二份。
 */
test('SETTINGS 的 num 范围与插件 LIMITS 逐项相等（防保存时静默夹值）', async () => {
  const src = await readFile(join(HERE, 'dsh-fish', 'lib', 'settings.js'), 'utf8')
  const m = /const LIMITS = \{([\s\S]*?)\n\}/.exec(src)
  assert.ok(m, 'settings.js 里要能解析出 LIMITS（它改名或挪位置了就改这条）')
  const limits = {}
  for (const line of m[1].split('\n')) {
    const g = /^\s*['"]?([A-Za-z.]+)['"]?\s*:\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/.exec(line)
    if (g) limits[g[1]] = [Number(g[2]), Number(g[3])]
  }
  assert.ok(Object.keys(limits).length >= 25, `LIMITS 只解析出 ${Object.keys(limits).length} 条，正则可能哑了`)
  const bad = []
  for (const s of SETTINGS.filter((x) => x.kind === 'num')) {
    const L = limits[s.key]
    if (!L) continue // 插件不夹紧的 fork 自有项，查看器保留自己的 UI 范围
    if (L[0] !== s.min || L[1] !== s.max) {
      bad.push(`${s.key}: 查看器 ${s.min}–${s.max} / 插件 ${L[0]}–${L[1]}`)
    }
  }
  assert.deepEqual(bad, [], `范围对不上，保存时会被静默夹值：\n${bad.join('\n')}`)
})

test('DEFAULTS 里用户可调的叶子键都在 SETTINGS 里（防上游加了旋钮没搬）', () => {
  // 这几项是运行时状态或观测接口，本来就不做成旋钮
  const INTERNAL = new Set([
    'notify.lastShown', 'comment.lastScanAt', 'ui.ownerHintDismissed',
    'observe.enabled', 'observe.port',
    // 上游 1.0：代词不是「人格旋钮」，只从 config.json / /config 接口写；
    // 这两项是 @ 扫描的内部时间戳，运行时状态，不做成开关。
    'owner.pronoun', 'at.lastScanAt', 'at.backoffUntil',
  ])
  const keys = new Set(SETTINGS.map((s) => s.key))
  const missing = []
  const walk = (o, p = '') => {
    for (const [k, v] of Object.entries(o)) {
      const path = p ? `${p}.${k}` : k
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path)
      else if (!INTERNAL.has(path) && !keys.has(path)) missing.push(path)
    }
  }
  walk(DEFAULTS)
  assert.deepEqual(missing, [], `这些可调键没出现在查看器设置页：${missing.join('、')}`)
})
