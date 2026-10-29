/**
 * keepsake.test.mjs —— 纪念品（0.6.17，用户 m02041 拍板）
 *
 * 守这几件事：
 *   1. 只有「进行中的出门会话」能问，别处问一律拒；
 *   2. 只能问这一次出门那个工作区里的**文件**（`..` 跑不出去、目录/链接/空文件不算）；
 *   3. 一趟最多 3 件，同时只能有 1 件等着点头；
 *   4. **点头才复制**：摇头什么都不动；点头时文件没了也不带；
 *   5. 工具参数是合法 JSON Schema，回执只回机器状态（不写成她能复述的句子）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  KEEPSAKE_MAX_BYTES,
  KEEPSAKES_PER_TRIP,
  askKeepsake,
  decideKeepsake,
  keepsakesFile,
  pendingKeepsakes,
  readKeepsakes,
  tripKey,
} from '../lib/keepsake.js'
import { registerBringBack } from '../lib/keep.js'

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'fish-keep-'))
  try { return fn(root) } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

function setup(root) {
  const cwd = join(root, 'ws')
  mkdirSync(join(cwd, 'stuff'), { recursive: true })
  writeFileSync(join(cwd, 'notes.txt'), 'a note from outside\n', 'utf8')
  writeFileSync(join(cwd, 'stuff', 'pic.txt'), 'picture bytes\n', 'utf8')
  const outing = {
    sessionId: 'session-abc',
    workspaceId: 'w-1',
    workspaceName: '素材区',
    cwd,
    startedAt: 1_700_000_000_000,
    status: 'active',
  }
  return { cwd, outing }
}

test('纪念品：没在外面、或者不是那条出门会话，都问不了', () => withRoot((root) => {
  const { outing } = setup(root)
  assert.equal(askKeepsake(root, { outing: null, sessionId: 'session-abc', rel: 'notes.txt' }).ok, false)
  assert.equal(askKeepsake(root, { outing: { ...outing, status: 'done' }, sessionId: 'session-abc', rel: 'notes.txt' }).ok, false)
  const wrong = askKeepsake(root, { outing, sessionId: 'session-other', rel: 'notes.txt' })
  assert.equal(wrong.ok, false)
  assert.match(wrong.note, /外面那条会话/)
  assert.equal(readKeepsakes(root).items.length, 0)
}))

test('纪念品：只能是这次工作区里的文件——越界、目录、空文件都拒', () => withRoot((root) => {
  const { cwd, outing } = setup(root)
  const outside = join(root, 'secret.txt')
  writeFileSync(outside, 'x', 'utf8')

  const escape = askKeepsake(root, { outing, sessionId: 'session-abc', rel: join('..', 'secret.txt') })
  assert.equal(escape.ok, false)
  assert.match(escape.note, /那个工作区/)

  const dir = askKeepsake(root, { outing, sessionId: 'session-abc', rel: 'stuff' })
  assert.equal(dir.ok, false)
  assert.match(dir.note, /文件夹/)

  writeFileSync(join(cwd, 'empty.txt'), '', 'utf8')
  const empty = askKeepsake(root, { outing, sessionId: 'session-abc', rel: 'empty.txt' })
  assert.equal(empty.ok, false)

  const ok = askKeepsake(root, { outing, sessionId: 'session-abc', rel: 'notes.txt', why: '这句想留着' })
  assert.equal(ok.ok, true)
  assert.equal(ok.item.rel, 'notes.txt')
  assert.equal(ok.item.status, 'asked')
  assert.equal(ok.item.why, '这句想留着')
}))

test('纪念品：太大带不动（20MB 上限，用稀疏文件验）', () => withRoot((root) => {
  const { cwd, outing } = setup(root)
  const big = join(cwd, 'big.bin')
  writeFileSync(big, 'x', 'utf8')
  truncateSync(big, KEEPSAKE_MAX_BYTES + 1)
  assert.equal(statSync(big).size, KEEPSAKE_MAX_BYTES + 1)
  const r = askKeepsake(root, { outing, sessionId: 'session-abc', rel: 'big.bin' })
  assert.equal(r.ok, false)
  assert.match(r.note, /太大/)
}))

test('纪念品：一趟最多 3 件，同时只能有 1 件等着点头', () => withRoot((root) => {
  const { cwd, outing } = setup(root)
  for (let i = 0; i < KEEPSAKES_PER_TRIP; i++) writeFileSync(join(cwd, `f${i}.txt`), `f${i}`, 'utf8')

  const first = askKeepsake(root, { outing, sessionId: 'session-abc', rel: 'f0.txt' })
  assert.equal(first.ok, true)
  const second = askKeepsake(root, { outing, sessionId: 'session-abc', rel: 'f1.txt' })
  assert.equal(second.ok, false, '上一件还等着点头时不能连问')

  // 摇头之后可以问下一件
  decideKeepsake(root, { id: first.item.id, yes: false })
  for (let i = 1; i < KEEPSAKES_PER_TRIP; i++) {
    const r = askKeepsake(root, { outing, sessionId: 'session-abc', rel: `f${i}.txt` })
    assert.equal(r.ok, true)
    decideKeepsake(root, { id: r.item.id, yes: false })
  }
  const overflow = askKeepsake(root, { outing, sessionId: 'session-abc', rel: 'notes.txt' })
  assert.equal(overflow.ok, false)
  assert.match(overflow.note, /带得够多/)
}))

test('纪念品：点头才复制，摇头什么都不动', () => withRoot((root) => {
  const { outing } = setup(root)
  const asked = askKeepsake(root, { outing, sessionId: 'session-abc', rel: join('stuff', 'pic.txt') })
  assert.equal(asked.ok, true)

  const no = decideKeepsake(root, { id: asked.item.id, yes: false })
  assert.equal(no.ok, true)
  assert.equal(no.item.status, 'declined')
  assert.equal(no.item.keptAs, undefined)
  assert.equal(readKeepsakes(root).items.filter((it) => it.status === 'kept').length, 0)
  assert.equal(pendingKeepsakes(root).length, 0)

  const again = askKeepsake(root, { outing, sessionId: 'session-abc', rel: 'notes.txt' })
  assert.equal(again.ok, true)
  const yes = decideKeepsake(root, { id: again.item.id, yes: true })
  assert.equal(yes.ok, true)
  assert.equal(yes.item.status, 'kept')
  assert.match(String(yes.item.keptAs), /^\d{4}-\d{2}-\d{2}\//)
  const copied = readFileSync(join(root, 'keepsakes', yes.item.keptAs), 'utf8')
  assert.match(copied, /a note from outside/)
  // 原来那个文件不动
  assert.equal(readFileSync(join(outing.cwd, 'notes.txt'), 'utf8'), 'a note from outside\n')
}))

test('纪念品：点头的时候文件没了，就不带（并记下原因）', () => withRoot((root) => {
  const { cwd, outing } = setup(root)
  const asked = askKeepsake(root, { outing, sessionId: 'session-abc', rel: 'notes.txt' })
  assert.equal(asked.ok, true)
  rmSync(join(cwd, 'notes.txt'))
  const r = decideKeepsake(root, { id: asked.item.id, yes: true })
  assert.equal(r.ok, false)
  assert.equal(r.item.status, 'declined')
  assert.match(String(r.item.why), /不在了/)
  assert.equal(readKeepsakes(root).items.filter((it) => it.status === 'kept').length, 0)
}))

test('纪念品：台账按趟分开记（tripKey 由会话 id + 出发时刻组成）', () => withRoot((root) => {
  const { outing } = setup(root)
  askKeepsake(root, { outing, sessionId: 'session-abc', rel: 'notes.txt' })
  const key = tripKey(outing)
  assert.equal(key, 'session-abc@1700000000000')
  const db = readKeepsakes(root)
  assert.equal(db.version, 1)
  assert.equal(db.items[0].trip, key)
  assert.ok(keepsakesFile(root).endsWith('keepsakes.json'))
}))

test('bring_back：出门那条会话的 cwd 在别人家，也不能被「另一个家」挡掉（2026-10-29 真机 bug）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-keep-out-'))
  try {
    const cwd = join(root, 'ws')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'notes.txt'), 'a note\n', 'utf8')
    const outing = {
      sessionId: 'session-abc',
      workspaceId: 'w-1',
      workspaceName: '素材区',
      cwd,
      startedAt: Date.now(),
      status: 'active',
    }
    writeFileSync(join(root, 'outings.json'), JSON.stringify({ version: 1, outings: [outing] }), 'utf8')
    const regs = new Map()
    const ctx = { tools: { register: (spec) => { regs.set(spec.name, spec); return () => {} } } }
    // deps.tenant 存在，但 root 是干净占有的；关键点：cwd 不在 herDir 里（出门就是这样）
    registerBringBack(ctx, { root, tenant: { root, herDir: join(root, 'her'), tenant: { ok: true } } })
    const tool = regs.get('bring_back')
    const out = await tool.execute(
      { path: 'notes.txt', why: '想学这种写法' },
      { session: { header: { id: 'session-abc', cwd } }, cwd },
    )
    assert.equal(out.ok, true)
    assert.match(out.note, /等他点头/)
    assert.equal(pendingKeepsakes(root).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('bring_back：参数是合法 JSON Schema，回执只回机器状态', () => {
  const regs = new Map()
  const ctx = { tools: { register: (spec) => { regs.set(spec.name, spec); return () => {} } } }
  registerBringBack(ctx, { root: mkdtempSync(join(tmpdir(), 'fish-keep-reg-')) })
  const tool = regs.get('bring_back')
  assert.ok(tool, '工具必须注册')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['path'])
  assert.equal(tool.parameters.properties.path.type, 'string')
  assert.equal(tool.parameters.properties.why.type, 'string')
  assert.ok(tool.parameters.additionalProperties === false || tool.parameters.additionalProperties === undefined)
  assert.ok(Array.isArray(tool.output.render({}, { ok: true })))
  assert.equal(tool.output.render({}, { ok: true })[0].text, '[已问]')
  assert.match(tool.output.render({}, { ok: false, note: '太大了' })[0].text, /没问/)
})

// ---- 0.7.5：点头从出门页搬进会话（用户 m00239）----
// 上面那条老用例的 ctx 没有 userQuestions，走的就是「没问到 → 保持 asked」这条降级路，
// 恰好也是超时/人不在时的真实行为。下面三条把每个答案分支钉住。

/** 造一个会替人点头的上下文：宿主那边「回答」直接由测试给定。 */
function answeringCtx(selected) {
  const agent = { id: 'session-abc' }
  const regs = new Map()
  const ctx = {
    tools: { register: (spec) => { regs.set(spec.name, spec); return () => {} } },
    get: (name) => (name === 'agents'
      ? {
          get: (id) => (String(id).replace(/^session-/, '') === 'abc' ? agent : undefined),
          list: () => [agent],
          roots: () => [agent],
        }
      : undefined),
    userQuestions: { ask: async () => ({ answers: [{ id: 'keepsake', selected: [selected] }] }) },
  }
  return { ctx, regs, agent }
}

async function outInTrip(selected) {
  const root = mkdtempSync(join(tmpdir(), 'fish-keep-ask-'))
  const cwd = join(root, 'ws')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'notes.txt'), 'a note\n', 'utf8')
  const outing = {
    sessionId: 'session-abc',
    workspaceId: 'w-1',
    workspaceName: '素材区',
    cwd,
    startedAt: Date.now(),
    status: 'active',
  }
  writeFileSync(join(root, 'outings.json'), JSON.stringify({ version: 1, outings: [outing] }), 'utf8')
  const { ctx, regs } = answeringCtx(selected)
  registerBringBack(ctx, { root, tenant: { root, herDir: join(root, 'her'), tenant: { ok: true } } })
  const out = await regs.get('bring_back').execute(
    { path: 'notes.txt', why: '想学这种写法' },
    { session: { header: { id: 'session-abc', cwd } }, cwd },
  )
  return { root, out, regs, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

test('bring_back：会话里点「准了」当场复制进家，回执只说机器状态', async () => {
  const { root, out, regs, cleanup } = await outInTrip('准了')
  try {
    assert.equal(out.ok, true)
    assert.equal(out.said, 'yes')
    assert.equal(pendingKeepsakes(root).length, 0, '点头之后不该还挂着')
    const db = readKeepsakes(root)
    assert.equal(db.items[0].status, 'kept')
    assert.ok(statSync(join(root, 'keepsakes', db.items[0].keptAs)).isFile(), '文件真的在家里了')
    assert.equal(regs.get('bring_back').output.render({}, out)[0].text, '[准了]')
  } finally { cleanup() }
})

test('bring_back：会话里点「算了」什么都不复制，记为 declined', async () => {
  const { root, out, regs, cleanup } = await outInTrip('算了')
  try {
    assert.equal(out.ok, true)
    assert.equal(out.said, 'no')
    assert.equal(out.note, '没带。')
    assert.equal(readKeepsakes(root).items[0].status, 'declined')
    assert.equal(regs.get('bring_back').output.render({}, out)[0].text, '[算了]')
  } finally { cleanup() }
})

test('bring_back：回答里没有这两个词（人自己写的话）就当作没答，仍挂着', async () => {
  const { root, out, cleanup } = await outInTrip('我自己想想')
  try {
    assert.equal(out.said, '')
    assert.match(out.note, /等他点头/)
    assert.equal(pendingKeepsakes(root).length, 1, '没答就等于没答，出门页还能点头')
  } finally { cleanup() }
})
