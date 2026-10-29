import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { POCKET_TITLE, ensurePocket, ensurePocketOrder, findPocketWorkspace, pocketDirPath } from '../lib/pocket.js'

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

// ---- 侧栏顺序：口袋要排在她的家下面（2026-10-30 用户 m01078）----

/** 假注册表：按宿主 workspaceRegistry.insertBefore(id, beforeId) 的真实语义改顺序。 */
function fakeReg(ids, paths = {}) {
  const order = [...ids]
  const calls = []
  const list = () => order.map((id) => ({ id, path: paths[id] ?? '', title: id }))
  const insertBefore = async (id, before) => {
    calls.push([id, before])
    if (!order.includes(id)) throw new Error(`unknown ${id}`)
    if (before !== undefined && !order.includes(before)) throw new Error(`unknown ${before}`)
    if (before === id) return [...order]
    const rest = order.filter((x) => x !== id)
    const at = before === undefined ? rest.length : rest.indexOf(before)
    const next = [...rest.slice(0, at), id, ...rest.slice(at)]
    order.length = 0
    order.push(...next)
    return [...order]
  }
  return { list, insertBefore, calls, order }
}

test('口袋排在家上面：挪到家下面，只动一次', async () => {
  const reg = fakeReg(['pocket', 'home', 'other'])
  const ctx = { get: () => reg }
  const r = await ensurePocketOrder(ctx, { pocketWsId: 'pocket', homeWsId: 'home' })
  assert.equal(r.ok, true)
  assert.equal(r.moved, true)
  assert.deepEqual(reg.order, ['home', 'pocket', 'other'])
  assert.deepEqual(reg.calls, [['pocket', 'other']])
})

test('口袋已经在家的下面：不再动它（幂等）', async () => {
  const reg = fakeReg(['home', 'pocket', 'other'])
  const r = await ensurePocketOrder({ get: () => reg }, { pocketWsId: 'pocket', homeWsId: 'home' })
  assert.equal(r.ok, true)
  assert.equal(r.moved, false)
  assert.deepEqual(reg.calls, [], '位置对了就不该调 insertBefore')
})

test('家在最后一位：口袋挪到末尾（紧跟在家后面）', async () => {
  const reg = fakeReg(['other', 'pocket', 'home'])
  const r = await ensurePocketOrder({ get: () => reg }, { pocketWsId: 'pocket', homeWsId: 'home' })
  assert.equal(r.ok, true)
  assert.equal(r.moved, true)
  assert.deepEqual(reg.order, ['other', 'home', 'pocket'])
})

test('老宿主没有 insertBefore：不炸，只报 why', async () => {
  const r = await ensurePocketOrder({ get: () => ({ list: () => [] }) }, { pocketWsId: 'p', homeWsId: 'h' })
  assert.equal(r.ok, false)
  assert.equal(r.moved, false)
  assert.match(r.why, /insertBefore/)
})

test('缺 id 或两者相同：直接说清楚，不碰注册表', async () => {
  const reg = fakeReg(['pocket', 'home'])
  assert.match((await ensurePocketOrder({ get: () => reg }, { pocketWsId: 'pocket' })).why, /缺工作区 id/)
  assert.match((await ensurePocketOrder({ get: () => reg }, { pocketWsId: 'x', homeWsId: 'x' })).why, /同一个/)
  assert.deepEqual(reg.calls, [])
})

test('findPocketWorkspace：认得出已登记的口袋，没登记就返回空 id', async (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'pocket')
  const hit = findPocketWorkspace({ get: () => ({ list: () => [{ id: 'ws-pocket', path: dir }] }) }, { outingPocket: dir })
  assert.equal(hit.wsId, 'ws-pocket')
  assert.equal(hit.registered, true)
  assert.equal(hit.dir, dir)
  const miss = findPocketWorkspace({ get: () => ({ list: () => [] }) }, { outingPocket: dir })
  assert.equal(miss.wsId, '')
  assert.equal(miss.registered, false)
})

test('老标题「出门口袋」：认出来顺手改成「工作园区」，不新建（m02411）', async (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'pocket')
  const seen = []
  const ws = { id: 'ws-pocket', path: dir, title: '出门口袋', setTitle: async (x) => { seen.push(x); ws.title = x } }
  let created = 0
  const ctx = { get: () => ({ list: () => [ws], create: async () => { created += 1; return { id: 'ws-new' } } }) }
  const r = await ensurePocket(ctx, root, { outingPocket: dir })
  assert.equal(r.wsId, 'ws-pocket')
  assert.equal(r.registered, true)
  assert.equal(r.retitled, true)
  assert.equal(created, 0, '已经登记过就不该再建一个')
  assert.deepEqual(seen, [POCKET_TITLE], '侧栏里那个旧名字要跟着换掉')
})

test('启动排序时也顺手改名：位置本来是对的也要改', async () => {
  const order = ['home', 'pocket']
  const seen = []
  const list = () => order.map((id) => (id === 'pocket'
    ? { id, path: '/p', title: '出门口袋', setTitle: async (x) => { seen.push(x) } }
    : { id, path: '/h', title: '大肥鱼的家' }))
  const reg = { list, insertBefore: async () => order }
  const r = await ensurePocketOrder({ get: () => reg }, { pocketWsId: 'pocket', homeWsId: 'home' })
  assert.equal(r.ok, true)
  assert.equal(r.moved, false, '位置对了不挪')
  assert.equal(r.retitled, true)
  assert.deepEqual(seen, [POCKET_TITLE])
})
