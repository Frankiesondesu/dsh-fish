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
import { mkdtemp, rm, readFile, stat, writeFile, mkdir, open } from 'node:fs/promises'
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
  assert.match(list.note, /文件夹里有 \d+ 个/)

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

// ---- 存文件（2026-11-10 用户补充：他发的文件她可以自己选择保存）----

test('save：收件箱里的文件存进来，重名不覆盖', async () => withSpace(async ({ root, tool }) => {
  await mkdir(join(root, 'home', 'inbox'), { recursive: true })
  await writeFile(join(root, 'home', 'inbox', '课表.txt'), '周一数学', 'utf8')

  const out = await call(tool, { action: 'save', path: join(root, 'home', 'inbox', '课表.txt') })
  assert.equal(out.ok, true, out.note)
  assert.match(out.note, /存好了/)
  assert.equal(await readFile(join(spaceDir(root), '课表.txt'), 'utf8'), '周一数学')

  const again = await call(tool, { action: 'save', path: join(root, 'home', 'inbox', '课表.txt') })
  assert.equal(again.ok, true, again.note)
  assert.equal(await readFile(join(spaceDir(root), '课表.txt'), 'utf8'), '周一数学', '重名不覆盖原件')
}))

test('save：media/ 里的也能存，别的路径不碰', async () => withSpace(async ({ root, tool }) => {
  await mkdir(join(root, 'media', 'draw'), { recursive: true })
  await writeFile(join(root, 'media', 'draw', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

  const ok = await call(tool, { action: 'save', path: join(root, 'media', 'draw', 'a.png') })
  assert.equal(ok.ok, true, ok.note)

  const bad = await call(tool, { action: 'save', path: join(root, 'config.json') })
  assert.equal(bad.ok, false)
  assert.match(bad.note, /只能存/)
}))

test('save：超过单文件上限就拒绝（不复制）', async () => withSpace(async ({ root, tool }) => {
  await mkdir(join(root, 'home', 'inbox'), { recursive: true })
  const src = join(root, 'home', 'inbox', 'big.bin')
  const fh = await open(src, 'w')
  await fh.truncate(200 * 1024 * 1024 + 1) // 稀疏文件，不真占盘
  await fh.close()

  const out = await call(tool, { action: 'save', path: src })
  assert.equal(out.ok, false)
  assert.match(out.note, /超过单文件上限/)
}))

test('安全闸：可执行文件与脚本一律不存，改扩展名的也认得出', async () => withSpace(async ({ root, tool }) => {
  await mkdir(join(root, 'home', 'inbox'), { recursive: true })

  await writeFile(join(root, 'home', 'inbox', 'evil.exe'), Buffer.from('MZ\x90\x00', 'binary'))
  const exe = await call(tool, { action: 'save', path: join(root, 'home', 'inbox', 'evil.exe') })
  assert.equal(exe.ok, false)
  assert.match(exe.note, /可执行/)

  await writeFile(join(root, 'home', 'inbox', 'run.js'), 'console.log(1)')
  const js = await call(tool, { action: 'save', path: join(root, 'home', 'inbox', 'run.js') })
  assert.equal(js.ok, false, '脚本也不存')

  // 改了扩展名：PE 魔数认得出
  await writeFile(join(root, 'home', 'inbox', 'fake.txt'), Buffer.from([0x4d, 0x5a, 0x90, 0x00]))
  const fake = await call(tool, { action: 'save', path: join(root, 'home', 'inbox', 'fake.txt') })
  assert.equal(fake.ok, false)
  assert.match(fake.note, /文件头是程序/)

  // 普通文本照常
  await writeFile(join(root, 'home', 'inbox', 'ok.txt'), 'hello')
  assert.equal((await call(tool, { action: 'save', path: join(root, 'home', 'inbox', 'ok.txt') })).ok, true)
}))

test('remove 是真删；get 对二进制只给路径', async () => withSpace(async ({ root, tool }) => {
  await mkdir(join(root, 'home', 'inbox'), { recursive: true })
  await writeFile(join(root, 'home', 'inbox', 'v.mp4'), Buffer.from([0, 1, 2, 3]))

  const saved = await call(tool, { action: 'save', path: join(root, 'home', 'inbox', 'v.mp4'), name: '视频' })
  assert.equal(saved.ok, true, saved.note)
  assert.match(saved.note, /视频\.mp4/, '没给扩展名时要沿用源文件的扩展名')

  const g = await call(tool, { action: 'get', name: '视频.mp4' })
  assert.equal(g.ok, true)
  assert.match(g.note, /读不出内容/)
  assert.match(g.note, /home\/space\/视频\.mp4/)

  const rm1 = await call(tool, { action: 'remove', name: '视频.mp4' })
  assert.equal(rm1.ok, true, rm1.note)
  assert.match(rm1.note, /删了就没了/)
  let gone = false
  try { await stat(join(spaceDir(root), '视频.mp4')) } catch { gone = true }
  assert.equal(gone, true, '真删')
}))
