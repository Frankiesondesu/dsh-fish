/**
 * herdiary.test.mjs —— 她自己回头翻日记（issue #7 第二半）
 *
 * 这一组守五件事：
 *   ① 不给日期就是最近那一篇；给日期就读那一天；
 *   ② list=true 只要日期清单；
 *   ③ 参数是日期不是路径——`../` 这类传不进来；
 *   ④ 那天没写 / 一篇都没写过，说的是人话，两者分得清；
 *   ⑤ 太长的截到 DIARY_READ_MAX，并且告诉她后面还有。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerHerDiary, renderDiary, DIARY_READ_MAX } from '../lib/herdiary.js'
import { writeDaily } from '../lib/store.js'

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), 'fish-herdiary-'))
}

/** 抓注册出来的那个工具，直接调 execute */function toolFor(root) {
  let def = null
  const ctx = { tools: { register: (d) => ((def = d), d) } }
  registerHerDiary(ctx, { root })
  return def
}

test('不给日期：给最近那一篇', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-27', '昨天写的', root)
    await writeDaily('diaryDir', '2026-10-28', '今天写的', root)
    const t = toolFor(root)
    const out = await t.execute({})
    assert.equal(out.found, true)
    assert.match(out.text, /2026-10-28 那天你写的/)
    assert.match(out.text, /今天写的/)
    assert.doesNotMatch(out.text, /昨天写的/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('指定日期：只读那一天', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-27', '昨天写的', root)
    await writeDaily('diaryDir', '2026-10-28', '今天写的', root)
    const out = await toolFor(root).execute({ date: '2026-10-27' })
    assert.equal(out.found, true)
    assert.match(out.text, /2026-10-27/)
    assert.match(out.text, /昨天写的/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('list=true：只回日期清单，不带正文', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-26', '更早', root)
    await writeDaily('diaryDir', '2026-10-28', '最近', root)
    const out = await toolFor(root).execute({ list: true })
    assert.equal(out.found, true)
    assert.match(out.text, /2026-10-28/)
    assert.match(out.text, /2026-10-26/)
    assert.doesNotMatch(out.text, /更早/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('参数只认 YYYY-MM-DD：路径传不进来', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-28', '正常的一篇', root)
    const t = toolFor(root)
    for (const bad of ['../config', '../../events', 'diary/2026-10-28', '2026-10-28.md', '*']) {
      const out = await t.execute({ date: bad })
      assert.equal(out.found, false, `不该读 ${bad}`)
      assert.match(out.text, /YYYY-MM-DD/, `要告诉 ${bad} 怎么传`)
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('那天没写：说没写，并给出最近的一篇是哪天', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-28', '最近', root)
    const out = await toolFor(root).execute({ date: '2026-09-01' })
    assert.equal(out.found, false)
    assert.match(out.text, /2026-09-01 那天没有日记/)
    assert.match(out.text, /最近的一篇是 2026-10-28/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('一篇都没写过：说没写过，不装作读了', async () => {
  const root = await tmpRoot()
  try {
    const out = await toolFor(root).execute({})
    assert.equal(out.found, false)
    assert.match(out.text, /还没写过日记/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('太长的截到 DIARY_READ_MAX，并说明后面还有', async () => {
  const root = await tmpRoot()
  try {
    const long = '字'.repeat(DIARY_READ_MAX + 500)
    await writeDaily('diaryDir', '2026-10-28', long, root)
    const out = await toolFor(root).execute({})
    assert.equal(out.found, true)
    assert.match(out.text, /后面还有/)
    // 正文部分是第二行（后面那句提示单独一行，不算正文）
    assert.equal(out.text.split('\n')[1].length, DIARY_READ_MAX)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('renderDiary：三种结局各说各的话', () => {
  assert.match(renderDiary({ why: '打不开' }), /打不开/)
  assert.match(renderDiary({ dates: ['2026-10-28'] }), /- 2026-10-28/)
  assert.match(renderDiary({}), /还没写过日记/)
})
