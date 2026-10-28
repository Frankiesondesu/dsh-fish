/**
 * outing.test.mjs —— 出门台账与「回家前先验一遍」。
 *
 * 这里测的是**判据**，不是流程：出门最坏的结果不是她回不来，是
 * 「她回来时发现自己的记忆被动过，但没人发现」。所以 verifyEvents
 * 的三态（缩水 / 尾部被改写 / 只是正常追加）必须有测试钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  awayNow, awayLine, endOuting, readOutings, snapshotEvents, startOuting, verifyEvents,
  activeOutingSync, startPossession, endPossession, bindOutingSession, abortOuting,
} from '../lib/outing.js'

function tmp() {
  const root = mkdtempSync(join(tmpdir(), 'fish-outing-'))
  return { root, done: () => rmSync(root, { recursive: true, force: true }) }
}

const base = (root) => ({ sessionId: 's-1', workspaceId: 'w-1', workspaceName: '素材', cwd: join(root, 'ws'), now: 1_700_000_000_000 })

test('出门前是空的：awayNow 返回 kind=null', async () => {
  const { root, done } = tmp()
  try {
    const a = await awayNow(root)
    assert.equal(a.kind, null)
    assert.equal(a.why, '')
  } finally { done() }
})

test('startOuting 记账、activeOutingSync 同步读得到、时间线按开始升序', async () => {
  const { root, done } = tmp()
  try {
    const r = await startOuting(root, base(root))
    assert.equal(r.ok, true)
    const a = await awayNow(root)
    assert.equal(a.kind, 'outing')
    assert.equal(a.outing.workspaceName, '素材')
    assert.equal(a.outing.status, 'active')
    assert.equal(activeOutingSync(root)?.sessionId, 's-1')
    await endOuting(root, { sessionId: 's-1', status: 'done', kept: true, now: 1_700_000_100_000 })
    const { outings: list } = await readOutings(root)
    assert.equal(list.length, 1)
    assert.equal(list[0].status, 'done')
    assert.equal(list[0].kept, true)
  } finally { done() }
})

test('已经有一次出门时，第二次被拒（不想让她同时出现在两个工作区）', async () => {
  const { root, done } = tmp()
  try {
    await startOuting(root, base(root))
    const again = await startOuting(root, { ...base(root), sessionId: 's-2', workspaceId: 'w-2' })
    assert.equal(again.ok, false)
    assert.match(again.why, /已经出门|已经在外面/)
  } finally { done() }
})

test('出门期间不许请神（两条会互相踩身份）', async () => {
  const { root, done } = tmp()
  try {
    await startOuting(root, base(root))
    const p = await startPossession(root, { sessionId: 'x', now: 1 })
    assert.equal(p.ok, false)
    assert.match(p.why, /出门/)
  } finally { done() }
})

test('请神与出门互斥的另一半：请神没结束不能出门', async () => {
  const { root, done } = tmp()
  try {
    await startPossession(root, { sessionId: 'x', now: 1, title: '别人的对话' })
    const o = await startOuting(root, base(root))
    assert.equal(o.ok, false)
    assert.match(o.why, /请神/)
    const a = await awayNow(root)
    assert.equal(a.kind, 'possession')
    await endPossession(root, { sessionId: 'x', now: 2 })
    assert.equal((await awayNow(root)).kind, null)
  } finally { done() }
})

test('回家时事件流变小 → ok:false（被删过行），这是必须拒收的那一种', async () => {
  const { root, done } = tmp()
  try {
    const f = join(root, 'events.jsonl')
    writeFileSync(f, '{"a":1}\n{"a":2}\n{"a":3}\n', 'utf8')
    const snap = await snapshotEvents(f)
    writeFileSync(f, '{"a":1}\n{"a":3}\n', 'utf8')
    const v = verifyEvents(f, snap)
    assert.equal(v.checkable, true)
    assert.equal(v.ok, false)
    assert.match(v.why, /变小/)
  } finally { done() }
})

test('回家时大小没变但尾部被改写 → ok:false（原地篡改）', async () => {
  const { root, done } = tmp()
  try {
    const f = join(root, 'events.jsonl')
    writeFileSync(f, '{"a":"旧"}\n', 'utf8')
    const snap = await snapshotEvents(f)
    const same = '{"a":"新"}\n'   // 同样的字节数，内容不同
    assert.equal(Buffer.byteLength(same), Buffer.byteLength('{"a":"旧"}\n'))
    writeFileSync(f, same, 'utf8')
    const v = verifyEvents(f, snap)
    assert.equal(v.ok, false)
    assert.match(v.why, /尾部/)
  } finally { done() }
})

test('正常追加（她自己写日记）算干净，且报出追加条数', async () => {
  const { root, done } = tmp()
  try {
    const f = join(root, 'events.jsonl')
    writeFileSync(f, '{"a":1}\n', 'utf8')
    const snap = await snapshotEvents(f)
    appendFileSync(f, '{"a":2}\n{"a":3}\n', 'utf8')
    const v = verifyEvents(f, snap)
    assert.equal(v.ok, true)
    // appended 是**字节数**不是行数：只用来让人看见「这趟她写过东西」
    assert.equal(v.appended, Buffer.byteLength('{"a":2}\n{"a":3}\n'))
  } finally { done() }
})

test('没有基线时 checkable:false —— 不谎报「验过没问题」', async () => {
  const { root, done } = tmp()
  try {
    const v = verifyEvents(join(root, 'nope.jsonl'), null)
    assert.equal(v.checkable, false)
    assert.equal(v.ok, null)
  } finally { done() }
})

test('awayLine 说人话：外面报工作区，替人说话报标题', async () => {
  const line = awayLine({ kind: 'outing', outing: { workspaceName: '素材库', startedAt: Date.now() - 3600_000 } })
  assert.match(line, /此刻在外面：素材库/)
  assert.match(line, /小时/)
  const p = awayLine({ kind: 'possession', possession: { title: '别人的对话', startedAt: Date.now() - 60_000 } })
  assert.match(p, /替人说话/)
  assert.equal(awayLine({ kind: null }), '')
})

test('台账文件坏了也不抛：当没出门处理，但下一次 start 会重写', async () => {
  const { root, done } = tmp()
  try {
    writeFileSync(join(root, 'outings.json'), '{坏掉的 json', 'utf8')
    const a = await awayNow(root)
    assert.equal(a.kind, null)
    const r = await startOuting(root, base(root))
    assert.equal(r.ok, true)
    assert.ok(existsSync(join(root, 'outings.json')))
    assert.match(readFileSync(join(root, 'outings.json'), 'utf8'), /"outings"/)
  } finally { done() }
})

test('先记账再建会话：id 可以先空着，建完再补', async () => {
  const { root, done } = tmp()
  try {
    const st = await startOuting(root, { sessionId: '', workspaceId: 'w-1', workspaceName: '素材', cwd: join(root, 'ws'), now: 1_700_000_000_000 })
    assert.equal(st.ok, true)
    const first = await readOutings(root)
    assert.equal(first.outings.length, 1, '空 id 的那条不能被当成坏档丢掉')
    assert.equal(activeOutingSync(root)?.workspaceName, '素材')

    const b = await bindOutingSession(root, { sessionId: 'session-abc' })
    assert.equal(b.ok, true)
    assert.equal(b.bound, true)
    assert.equal(activeOutingSync(root)?.sessionId, 'session-abc')

    const again = await bindOutingSession(root, { sessionId: 'session-abc' })
    assert.equal(again.ok, true)
    assert.equal(again.bound, false, '同一条 id 再补一次是幂等的')

    const other = await bindOutingSession(root, { sessionId: 'session-other' })
    assert.equal(other.ok, false, '已经记了别的 id 就不能覆盖')
  } finally {
    done()
  }
})

test('建会话失败时撤掉空壳，否则她会一直「挂在门外」', async () => {
  const { root, done } = tmp()
  try {
    await startOuting(root, { sessionId: '', cwd: join(root, 'ws'), now: 1_700_000_000_000 })
    const a = await abortOuting(root)
    assert.equal(a.ok, true)
    assert.equal(activeOutingSync(root), null)
    assert.equal((await readOutings(root)).outings.length, 0)
  } finally {
    done()
  }
})

test('已经绑了会话的那条不能被当空壳撤掉', async () => {
  const { root, done } = tmp()
  try {
    await startOuting(root, { sessionId: 'session-x', cwd: join(root, 'ws'), now: 1_700_000_000_000 })
    const a = await abortOuting(root)
    assert.equal(a.ok, false)
    assert.equal(activeOutingSync(root)?.sessionId, 'session-x')
  } finally {
    done()
  }
})
