/**
 * tenant.test.mjs —— 「谁在写、写给哪个家」（2026-10-28 m01319 三条规矩）
 *
 * 房客把插件文件夹搬过一次，结果两个工作区、两份大肥鱼、共用一条事件流。
 * 根因有三层，这里逐层钉住：
 *   1. root 是进程级解析的 → 两个实例会解析到同一个家（claim/heartbeat 负责认出）
 *   2. 写入不看调用者 → 别人的会话也能写进这个家（checkCaller 负责拒）
 *   3. 事件流没有「谁」→ 事后分不清（schema 的 sessionId 负责记）
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  callerOf,
  checkCaller,
  guardWrite,
  claimRoot,
  beatRoot,
  releaseRoot,
  isInside,
  normPath,
  TENANT_FILE,
  CLAIM_TTL_MS,
} from '../lib/tenant.js'
import { validateEvent } from '../lib/schema.js'
import { writeSelfDoc } from '../lib/selfdoc.js'

const made = []
async function tmpRoot() {
  const dir = join(tmpdir(), `fish-tenant-${process.pid}-${Math.random().toString(16).slice(2, 8)}`)
  await fs.mkdir(dir, { recursive: true })
  made.push(dir)
  return dir
}
after(async () => {
  for (const d of made.reverse()) await fs.rm(d, { recursive: true, force: true }).catch(() => {})
})

test('isInside / normPath：大小写、末尾斜杠、越界都不认错', () => {
  assert.equal(isInside('D:\\a\\home', 'D:\\a'), true)
  assert.equal(isInside('D:\\a', 'D:\\a\\home'), false)
  assert.equal(isInside('D:\\a-other', 'D:\\a'), false, '前缀相同但不同目录不算在里面')
  assert.equal(normPath('D:\\a\\'), normPath('D:\\a'))
  if (process.platform === 'win32') assert.equal(normPath('D:/A/B'), normPath('d:\\a\\b'))
})

test('callerOf：从 exec 里读 sessionId 与 header.cwd；读不到就给空串', () => {
  const exec = { agent: { session: { id: 'sess_1', header: { cwd: 'D:\\a\\home' } } } }
  const who = callerOf(exec)
  assert.equal(who.sessionId, 'sess_1')
  assert.equal(who.cwd, 'D:\\a\\home')
  assert.equal(callerOf({}).sessionId, '')
  assert.equal(callerOf({}).cwd, '')
  assert.equal(callerOf(undefined).cwd, '')
  // header 缺 cwd（宿主允许）：有会话但没 cwd
  assert.equal(callerOf({ agent: { session: { id: 'x', header: {} } } }).cwd, '')
})

test('checkCaller：cwd 在 root 里放行；在外面拒绝并说清楚', () => {
  const root = 'D:\\houses\\a'
  const inside = checkCaller(root, { agent: { session: { id: 's1', header: { cwd: 'D:\\houses\\a\\home' } } } })
  assert.equal(inside.ok, true)
  assert.equal(inside.sessionId, 's1')

  const outside = checkCaller(root, { agent: { session: { id: 's2', header: { cwd: 'D:\\houses\\b' } } } })
  assert.equal(outside.ok, false)
  assert.match(outside.why, /另一个家|不属于/)
  assert.equal(outside.sessionId, 's2', '拒绝时也要留下是谁')

  // 她自己的房间（herDir）允许
  const her = checkCaller(root, { agent: { session: { id: 's3', header: { cwd: 'E:\\her-room' } } } }, { herDir: 'E:\\her-room' })
  assert.equal(her.ok, true)

  // 没有 exec（定时器 / 单测 / 系统路径）：放行但不冒充会话
  const sys = checkCaller(root, undefined)
  assert.equal(sys.ok, true)
  assert.equal(sys.sessionId, '')
})

test('claimRoot：先来的占住，后来的认出「这个家已经有人住」且不抢', async () => {
  const root = await tmpRoot()
  const first = await claimRoot(root, { version: '0.6.6', instanceId: 'A' })
  assert.equal(first.ok, true)

  const second = await claimRoot(root, { version: '0.6.6', instanceId: 'B' })
  assert.equal(second.ok, false)
  assert.equal(second.owner.instanceId, 'A')
  assert.match(second.why, /另一个插件实例|已经被/)

  // 认输的那一个不能把文件改写掉
  const raw = JSON.parse(await fs.readFile(join(root, TENANT_FILE), 'utf8'))
  assert.equal(raw.instanceId, 'A')
})

test('claimRoot：同机重启时旧 pid 已死 → 心跳再新也能立刻接管（否则重启后 45 秒写不了）', async () => {
  const root = await tmpRoot()
  const now = 1_800_000_000_000
  await claimRoot(root, { instanceId: 'A', now, pid: 0, host: 'testhost' })
  const restarted = await claimRoot(root, { instanceId: 'B', now: now + 1000, pid: process.pid, host: 'testhost' })
  assert.equal(restarted.ok, true, '上个进程没了就不该等 TTL')
  const raw = JSON.parse(await fs.readFile(join(root, TENANT_FILE), 'utf8'))
  assert.equal(raw.instanceId, 'B')
  assert.equal(raw.host, 'testhost')
})

test('claimRoot：同机 pid 还活着 → 心跳新鲜时仍然拒绝（两份大肥鱼同时开着）', async () => {
  const root = await tmpRoot()
  const now = 1_800_000_000_000
  await claimRoot(root, { instanceId: 'A', now, pid: process.pid, host: 'testhost' })
  const other = await claimRoot(root, { instanceId: 'B', now: now + 1000, pid: process.pid, host: 'testhost' })
  assert.equal(other.ok, false)
})

test('claimRoot：旧声明过期（心跳断了）可以被接管；release 之后也能立刻接管', async () => {
  const root = await tmpRoot()
  const now = 1_800_000_000_000
  await claimRoot(root, { instanceId: 'A', now })
  // 过期：beatAt 比 now 早了超过 TTL
  const fresh = await claimRoot(root, { instanceId: 'B', now: now + CLAIM_TTL_MS + 1 })
  assert.equal(fresh.ok, true)
  assert.equal(fresh.instanceId, 'B')

  assert.equal(await releaseRoot(root, 'B', { now: now + CLAIM_TTL_MS + 2 }), true)
  const again = await claimRoot(root, { instanceId: 'C', now: now + CLAIM_TTL_MS + 3 })
  assert.equal(again.ok, true, '释放之后下一个实例要能立刻接管，不用等 TTL')
})

test('beatRoot：房主续期成功，被接管的一方法续不上（也不抢回）', async () => {
  const root = await tmpRoot()
  const now = 1_800_000_000_000
  await claimRoot(root, { instanceId: 'A', now })
  assert.equal(await beatRoot(root, 'A', { now: now + 1000 }), true)
  assert.equal(await beatRoot(root, 'Ghost', { now: now + 2000 }), false)

  const raw = JSON.parse(await fs.readFile(join(root, TENANT_FILE), 'utf8'))
  assert.equal(raw.instanceId, 'A', '续期失败不能改 ownership')
})

test('guardWrite：家被别人占着时，任何写入都拒绝；否则交给 checkCaller', () => {
  const root = 'D:\\houses\\a'
  const blocked = guardWrite(
    { root, tenant: { ok: false, why: '这个家被另一个实例占着' } },
    { agent: { session: { id: 's1', header: { cwd: 'D:\\houses\\a\\home' } } } },
    'growth_commit',
  )
  assert.equal(blocked.ok, false)
  assert.match(blocked.note, /占着|占用|这个家/)

  const ok = guardWrite(
    { root, herDir: '', tenant: { ok: true } },
    { agent: { session: { id: 's2', header: { cwd: 'D:\\houses\\a\\home' } } } },
    'growth_commit',
  )
  assert.deepEqual(ok, { ok: true, sessionId: 's2' })
})

test('schema：sessionId 落进事件（裁剪控制字符、上限 120），没有就不写这个字段', () => {
  const base = { type: 'utterance', text: '今天的风是往南吹的。' }
  const withId = validateEvent({ ...base, sessionId: '  sess_abc\n' }, { day: 3, stage: 2 })
  assert.equal(withId.sessionId, 'sess_abc')

  const long = validateEvent({ ...base, sessionId: 'x'.repeat(500) }, { day: 3, stage: 2 })
  assert.equal(long.sessionId.length, 120)

  const none = validateEvent(base, { day: 3, stage: 2 })
  assert.equal('sessionId' in none, false)
})

test('身份文件：家被别人占着 / 调用者不在这个家 → 不落盘，但也不抛错', async () => {
  const root = await tmpRoot()
  const blocked = await writeSelfDoc(root, { tenant: { ok: false, why: '这个家被另一个实例占着' } })
  assert.equal(blocked.ok, false)
  assert.match(blocked.why, /占着|占用|这个家/)

  const outside = await writeSelfDoc(root, {
    exec: { agent: { session: { id: 's9', header: { cwd: 'D:\\somewhere\\else' } } } },
  })
  assert.equal(outside.ok, false)
  assert.match(outside.why, /另一个家|不属于/)
})
