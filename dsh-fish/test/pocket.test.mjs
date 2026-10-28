import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { POCKET_TITLE, ensurePocket, pocketDirPath } from '../lib/pocket.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'fish-pocket-'))

test('口袋路径：没配就放用户目录下的 outing-pocket（ASCII，避开中文路径）', () => {
  assert.equal(pocketDirPath({}), join(homedir(), 'outing-pocket'))
  assert.equal(pocketDirPath(null), join(homedir(), 'outing-pocket'))
  // 配了就用配的那个（可以是中文路径，用户自己的选择）
  assert.equal(pocketDirPath({ outingPocket: 'D:\\口袋' }), 'D:\\口袋')
  // 空白字符串算没配
  assert.equal(pocketDirPath({ outingPocket: '   ' }), join(homedir(), 'outing-pocket'))
})

test('口袋已经登记过：认出来直接复用，不再 create 一次', async (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'pocket')
  let created = 0
  const ctx = {
    get: () => ({
      list: () => [{ id: 'ws-pocket', path: dir, title: POCKET_TITLE }],
      create: async () => { created += 1; return { id: 'ws-new' } },
    }),
  }
  const r = await ensurePocket(ctx, root, { outingPocket: dir })
  assert.equal(r.ok, true)
  assert.equal(r.wsId, 'ws-pocket')
  assert.equal(r.registered, true)
  assert.equal(created, 0, '已经登记过就不该再建一个')
  assert.equal(existsSync(dir), true, '目录要真的建出来')
})

test('口袋没登记过：建目录 + 登记工作区', async (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'pocket')
  const seen = []
  const ctx = {
    get: () => ({
      list: () => [],
      create: async (path, title) => { seen.push([path, title]); return { id: 'ws-new' } },
    }),
  }
  const r = await ensurePocket(ctx, root, { outingPocket: dir })
  assert.equal(r.ok, true)
  assert.equal(r.wsId, 'ws-new')
  assert.equal(r.registered, true)
  assert.deepEqual(seen, [[dir, POCKET_TITLE]])
})

test('登记工作区失败也能出门：registered:false 但 ok:true，并说清楚为什么', async (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'pocket')
  const ctx = {
    get: () => ({
      list: () => [],
      create: async () => { throw new Error('registry 写盘失败') },
    }),
  }
  const r = await ensurePocket(ctx, root, { outingPocket: dir })
  assert.equal(r.ok, true, '登记失败不该挡住出门')
  assert.equal(r.registered, false)
  assert.equal(r.wsId, '')
  assert.equal(r.dir, dir)
  assert.match(r.why, /登记工作区失败/)
  assert.match(r.why, /registry 写盘失败/)
})

test('连目录都建不出来：ok:false，别谎称能出门', async (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // 拿一个普通文件当父目录，mkdir 必然失败
  const blocker = join(root, 'blocker')
  writeFileSync(blocker, 'x')
  const ctx = { get: () => ({ list: () => [], create: async () => ({ id: 'nope' }) }) }
  const r = await ensurePocket(ctx, root, { outingPocket: join(blocker, 'inner') })
  assert.equal(r.ok, false)
  assert.match(r.why, /建口袋目录失败/)
  assert.equal(r.registered, false)
})

test('没有 workspaceRegistry 也不炸：目录照建，registered:false', async (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'pocket')
  const r = await ensurePocket({ get: () => null }, root, { outingPocket: dir })
  assert.equal(r.ok, true)
  assert.equal(r.registered, false)
  assert.equal(existsSync(dir), true)
  mkdirSync(dir, { recursive: true })
})
