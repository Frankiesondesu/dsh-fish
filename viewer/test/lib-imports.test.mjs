/**
 * viewer.mjs 动态 import lib 模块的一致性（2026-11-09）。
 *
 * 背景（1a02a85 踩过）：buildData 里把调用从 deriveSelf 换成 deriveSelfCached，
 * 但上一行的解构 `{ deriveSelf }` 没跟着改——deriveSelfCached 不在作用域里，
 * 人格数据页直接报「deriveSelfCached is not defined」。这种错只在运行时炸，
 * 而 buildData 不导出、import viewer.mjs 又会占 7788 端口，单测跑不到，
 * 所以只能靠源码扫描钉死两个方向：
 *   1) 解构出来的名字必须是 lib 模块的真导出（防「导入不存在的名字」）
 *   2) lib 导出被裸调用（NAME(...)）就必须出现在解构里
 *      （防「调了没导入的名字」——本次事故的方向）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const VIEWER = join(HERE, '..')
const SUB = join(VIEWER, '..', 'dsh-fish')

const src = readFileSync(join(VIEWER, 'viewer.mjs'), 'utf8')

// const {a, b} = await import('file://'  + join(FISH, 'lib', 'mod.js'))
// const pm     = await import('file:///' + join(FISH, 'lib', 'mod.js'))
// 只认这个具体形状；形状变了「至少 3 处」的护栏测试会先失败提醒改这里。
const IMPORT_RE =
  /const\s+(\{([^}]*)\}|(\w+))\s*=\s*await\s+import\(\s*'file:\/\/\/?'\s*\+\s*join\(FISH,\s*'lib',\s*'([^']+\.js)'\)/g

function destructuredOf(destr, inner) {
  if (!inner) return new Set() // 整模块 import（pm / m），没有解构名单
  return new Set(
    inner.split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)
  )
}

function exportsOf(modPath) {
  const s = readFileSync(modPath, 'utf8')
  const names = new Set()
  for (const m of s.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) names.add(m[1])
  for (const m of s.matchAll(/^export\s+const\s+(\w+)/gm)) names.add(m[1])
  for (const m of s.matchAll(/^export\s+class\s+(\w+)/gm)) names.add(m[1])
  return names
}

function imports() {
  const found = [...src.matchAll(IMPORT_RE)]
  assert.ok(found.length >= 3, `至少要扫到 3 处 lib 动态 import（现在 ${found.length}）——import 写法变了，先改本文件的正则再谈守卫`)
  // 同一模块可能被 import 多次（settings.js 一处解构、一处整模块），按模块聚合解构名
  const byMod = new Map()
  for (const [, destr, inner, , mod] of found) {
    if (!byMod.has(mod)) byMod.set(mod, new Set())
    for (const n of destructuredOf(destr, inner)) byMod.get(mod).add(n)
  }
  return [...byMod].map(([mod, names]) => ({ mod, names }))
}

// viewer.mjs 本地定义的名字（同名不算调用 lib 导出）
const localDefined = new Set(
  [...src.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+(\w+)|(?:^|\n)\s*const\s+(\w+)\s*=/g)].map((m) => m[1] || m[2])
)

test('动态 import：解构的名字必须是 lib 模块的真导出', () => {
  for (const { mod, names } of imports()) {
    const exports = exportsOf(join(SUB, 'lib', mod))
    for (const n of names) {
      assert.ok(exports.has(n), `viewer.mjs 解构了 lib/${mod} 的 ${n}，但那边没有这个导出（拼错或改名没跟上？）`)
    }
  }
})

test('动态 import：lib 导出被裸调用就必须解构（deriveSelfCached 事故方向）', () => {
  for (const { mod, names } of imports()) {
    const exports = exportsOf(join(SUB, 'lib', mod))
    for (const exp of exports) {
      // 裸调用 = 名字后紧跟 ( 且前面不是 . 或标识符字符（m.updateConfig(...) 不算裸）
      if (!new RegExp(`(?<![\\w$.])${exp}\\s*\\(`).test(src)) continue
      if (localDefined.has(exp)) continue
      assert.ok(
        names.has(exp),
        `viewer.mjs 裸调用了 lib/${mod} 的 ${exp}(...)，但对应 import 没解构它——作用域里没有，运行时才炸（1a02a85 那种）`
      )
    }
  }
})
