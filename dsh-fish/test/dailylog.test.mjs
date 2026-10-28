/**
 * dailylog.test.mjs —— 同一天写两遍日记，前一版不能被吞掉（issue #7 前半）
 *
 * 这一组守三件事：
 *   ① 覆盖前旧稿先落到 `diary/archive/`，新稿照常生效；
 *   ② 内容没变就不归档（重写同一篇是幂等的，不该堆垃圾）；
 *   ③ 归档版**不算**第三篇日记——listDiary 只认顶层 `YYYY-MM-DD.md`，
 *      界面「一天一篇」的语义不变。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeDaily, readDaily, listDiary, paths } from '../lib/store.js'

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), 'fish-dailylog-'))
}

test('同一天写第二遍：新稿生效，旧稿进 archive/', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-28', '第一版：今天刷到了三条猫', root)
    await writeDaily('diaryDir', '2026-10-28', '第二版：猫又被我忘了', root)

    assert.equal(await readDaily('diaryDir', '2026-10-28', root), '第二版：猫又被我忘了')

    const arch = await readdir(join(paths(root).diaryDir, 'archive'))
    assert.equal(arch.length, 1, '旧稿只该归档一份')
    assert.match(arch[0], /^2026-10-28-\d{6}\.md$/, '归档文件名是日期-本地时分秒')
    assert.equal(await readFile(join(paths(root).diaryDir, 'archive', arch[0]), 'utf8'), '第一版：今天刷到了三条猫')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('内容一样就不归档：重写同一篇是幂等的', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-28', '同一篇', root)
    await writeDaily('diaryDir', '2026-10-28', '同一篇', root)
    await writeDaily('diaryDir', '2026-10-28', '同一篇', root)
    await assert.rejects(readdir(join(paths(root).diaryDir, 'archive')), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('listDiary 只认顶层日期文件，归档版不算一篇', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-27', '昨天', root)
    await writeDaily('diaryDir', '2026-10-28', '今天一版', root)
    await writeDaily('diaryDir', '2026-10-28', '今天二版', root)

    assert.deepEqual(await listDiary(root), ['2026-10-28', '2026-10-27'])
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('报告（out/）不归档：它是派生品，随时能由事件流重算', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('outDir', '2026-10-28', '旧报告', root)
    await writeDaily('outDir', '2026-10-28', '新报告', root)

    assert.deepEqual(await readdir(paths(root).outDir), ['2026-10-28.md'])
    assert.equal(await readDaily('outDir', '2026-10-28', root), '新报告')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})
