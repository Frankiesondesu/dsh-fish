/**
 * 账本读取缓存（fork.26）的语义守卫。
 *
 * 账本只增不改，所以「读出来的东西」只跟文件内容有关，可以缓存。
 * 但缓存绝不能变成「看不见新账本」：
 *   - 追加一条，下一次读必须看见；
 *   - 外部直接改文件，下一次读也必须看见；
 *   - 返回的数组是拷贝，调用方随便改；
 *   - 坏行计数与 legacy 计数不能在缓存里丢掉。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEvents, appendEvent, forgetEvents } from '../lib/store.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fish-ledgercache-'))
  try {
    return await fn(root)
  } finally {
    forgetEvents(root)
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
}

function line(id, text, extra = {}) {
  return JSON.stringify({
    id,
    v: 2,
    ts: '2026-11-03T00:00:00.000Z',
    type: 'meta',
    text,
    day: 0,
    stage: 1,
    source: 'system',
    ...extra,
  })
}

test('连读两次：内容一致，但不是同一个数组', async () => {
  await withRoot(async (root) => {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'events.jsonl'), `${line('ev_1', 'seen:2026-11-03')}\n`, 'utf8')

    const a = await readEvents(root)
    const b = await readEvents(root)
    assert.equal(a.events.length, 1)
    assert.deepEqual(a, b)
    assert.notEqual(a.events, b.events, '数组必须是拷贝，调用方可能自己 push')
    assert.equal(a.events[0], b.events[0], '事件对象可以共享（账本只增不改）')
  })
})

test('追加一条之后，下一次读必须看见（appendEvent 会作废缓存）', async () => {
  await withRoot(async (root) => {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'events.jsonl'), `${line('ev_1', 'seen:2026-11-03')}\n`, 'utf8')
    const before = await readEvents(root)
    assert.equal(before.events.length, 1)

    await appendEvent(
      { type: 'meta', text: 'seen:2026-11-03T01:00:00.000Z' },
      { day: 0, stage: 1, source: 'system' },
      root,
    )
    const after = await readEvents(root)
    assert.equal(after.events.length, 2, '刚写进去的那条必须立刻读到')
  })
})

test('外部直接改账本（不经 appendEvent）也要看得见', async () => {
  await withRoot(async (root) => {
    await mkdir(root, { recursive: true })
    const file = join(root, 'events.jsonl')
    await writeFile(file, `${line('ev_1', 'seen:2026-11-03')}\n`, 'utf8')
    assert.equal((await readEvents(root)).events.length, 1)

    await appendFile(file, `${line('ev_2', 'seen:2026-11-03T02:00:00.000Z')}\n`, 'utf8')
    const after = await readEvents(root)
    assert.equal(after.events.length, 2, 'size 变了就得重读')
  })
})

test('调用方改写返回的数组，不影响下一次读', async () => {
  await withRoot(async (root) => {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'events.jsonl'), `${line('ev_1', 'seen:2026-11-03')}\n`, 'utf8')

    const first = await readEvents(root)
    first.events.push({ id: 'fake' })
    first.events.length = 0

    const second = await readEvents(root)
    assert.equal(second.events.length, 1, '缓存里的数组不能被调用方掏空')
    assert.equal(second.events[0].id, 'ev_1')
  })
})

test('坏行计数与 legacy 计数在缓存命中时也还在', async () => {
  await withRoot(async (root) => {
    await mkdir(root, { recursive: true })
    // 一条正常、一条坏 JSON、一条没有 id、一条没有 v（legacy）
    const noV = JSON.stringify({
      id: 'ev_old',
      ts: '2026-10-01T00:00:00.000Z',
      type: 'meta',
      text: 'seen:2026-10-01',
      day: 0,
      stage: 1,
      source: 'system',
    })
    await writeFile(
      join(root, 'events.jsonl'),
      `${line('ev_1', 'seen:2026-11-03')}\n{坏行\n${JSON.stringify({ type: 'meta', text: 'x' })}\n${noV}\n`,
      'utf8',
    )

    const first = await readEvents(root)
    const second = await readEvents(root)
    assert.equal(first.events.length, 2)
    assert.equal(first.skipped, 2)
    assert.equal(first.legacy, 1)
    assert.deepEqual(second, first, '计数也要跟着缓存走，不能命中时变回 0')
  })
})

test('账本不存在：返回空数组（这条不进缓存）', async () => {
  await withRoot(async (root) => {
    await mkdir(root, { recursive: true })
    const a = await readEvents(root)
    assert.deepEqual(a, { events: [], skipped: 0 })

    await writeFile(join(root, 'events.jsonl'), `${line('ev_1', 'seen:2026-11-03')}\n`, 'utf8')
    const b = await readEvents(root)
    assert.equal(b.events.length, 1, '文件刚出现就得读到')
  })
})
