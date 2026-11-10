/**
 * her_space（2026-11-10）：她自己的永久文件夹。
 *
 * 钉住四件事：
 *   1. 名字清洗——路径分隔符、点开头都进不来；
 *   2. 存取闭环——put / list / get / append / 同名覆盖；
 *   3. 边界——一篇 16KB 上限、空内容拒绝、找不到就说找不到；
 *   4. 落点——文件在 home/space/ 下，跑不出这个目录。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerSpace, safeSpaceName, spaceDir } from '../lib/space.js'
import { FISH_TOOLS } from '../lib/restrict.js'

async function withSpace(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-space-'))
  try {
    const regs = new Map()
    registerSpace({ tools: { register: (t) => regs.set(t.name, t) } }, { root })
    return await fn({ root, tool: regs.get('her_space') })
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const call = (tool, args) => tool.execute(args, { session: {} })

test('safeSpaceName：补 .md、去路径、拒绝点开头', () => {
  assert.equal(safeSpaceName('课表'), '课表.md')
  assert.equal(safeSpaceName('课表.txt'), '课表.txt')
  assert.equal(safeSpaceName('../local.key'), 'local.key.md', '路径只剩最后一段，跑不出去')
  assert.equal(safeSpaceName('a/b'), 'b.md')
  assert.equal(safeSpaceName(''), '')
  assert.equal(safeSpaceName('.hidden'), '', '点开头的不收')
  assert.equal(safeSpaceName('a:b*c?'), 'a_b_c_.md', '非法字符换成下划线')
})

test('her_space 在 FISH_TOOLS 里（她在收窄后的工具面上看得见）', () => {
  assert.ok(FISH_TOOLS.includes('her_space'))
})

test('存取闭环：put → list → get → append → 同名覆盖', async () => withSpace(async ({ root, tool }) => {
  const put = await call(tool, { action: 'put', name: '课表', text: '周一 数学\n周二 英语' })
  assert.equal(put.ok, true, put.note)
  assert.match(put.note, /放进了/)
  assert.equal(await readFile(join(spaceDir(root), '课表.md'), 'utf8'), '周一 数学\n周二 英语')

  const list = await call(tool, { action: 'list' })
  assert.match(list.note, /课表\.md/)
  assert.match(list.note, /篇/)

  const get = await call(tool, { action: 'get', name: '课表' })
  assert.equal(get.ok, true)
  assert.equal(get.text, '周一 数学\n周二 英语')

  const ap = await call(tool, { action: 'append', name: '课表', text: '\n周三 物理' })
  assert.equal(ap.ok, true, ap.note)
  assert.match(await readFile(join(spaceDir(root), '课表.md'), 'utf8'), /周三 物理/)

  const over = await call(tool, { action: 'put', name: '课表', text: '新的' })
  assert.match(over.note, /覆盖了/, '同名要如实说覆盖，不是新建')
  assert.equal(await readFile(join(spaceDir(root), '课表.md'), 'utf8'), '新的')
}))

test('路径穿越：名字里的 .. 只留最后一段，文件仍落在 space 里', async () => withSpace(async ({ root, tool }) => {
  const out = await call(tool, { action: 'put', name: '../../local.key', text: 'x' })
  assert.equal(out.ok, true, out.note)
  assert.equal(await readFile(join(spaceDir(root), 'local.key.md'), 'utf8'), 'x')
  let escaped = false
  try {
    await stat(join(root, 'local.key'))
    escaped = true
  } catch { /* 不存在，正常 */ }
  assert.equal(escaped, false, '不许写到 space 外面')
}))

test('边界：空内容、超一篇上限、读不存在的，都要给真因', async () => withSpace(async ({ tool }) => {
  const empty = await call(tool, { action: 'put', name: '空', text: '   ' })
  assert.equal(empty.ok, false)
  assert.match(empty.note, /空的/)

  const big = await call(tool, { action: 'put', name: '大', text: '字'.repeat(6000) })
  assert.equal(big.ok, false)
  assert.match(big.note, /最多/)

  const missing = await call(tool, { action: 'get', name: '没有这篇' })
  assert.equal(missing.ok, false)
  assert.match(missing.note, /没有《没有这篇\.md》/)
}))

test('列表：空文件夹说空，不是报错', async () => withSpace(async ({ tool }) => {
  const out = await call(tool, { action: 'list' })
  assert.equal(out.ok, true)
  assert.match(out.note, /还是空的/)
}))
