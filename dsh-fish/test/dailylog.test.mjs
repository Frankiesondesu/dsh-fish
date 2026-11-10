/**
 * dailylog.test.mjs —— 同一天写两遍，两段都要留下（0.6.28，用户 m01952）
 *
 * 背景：issue #7 时（0.6.4）的修法是「覆盖前先把旧稿归档到 diary/archive/」，
 * 但归档版在界面上看不到，用户仍然觉得「多篇被盖掉了、又不出翻页键」。
 * 0.6.28 改成**同日追加**（方案 B）：
 *   ① 同一天第二次写不再覆盖，而是在当天文件末尾接一段，中间一行 `---` 隔开；
 *   ② 内容与最后一版完全一样时不追加（重写同一篇仍然幂等）；
 *   ③ 「一天一篇」的语义不变：listDiary 只认顶层 `YYYY-MM-DD.md`，
 *      跨天才有第二个日期（客户端的翻页键就挂在「日期 ≥ 2」上）；
 *   ④ 报告（out/）仍是整篇覆盖：它是派生品。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeDaily, readDaily, listDiary, paths, DAILY_JOIN } from '../lib/store.js'

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), 'fish-dailylog-'))
}

test('同一天写第二遍：接在后面，旧稿不丢', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-28', '第一版：今天刷到了三条猫', root)
    await writeDaily('diaryDir', '2026-10-28', '第二版：猫又被我忘了', root)

    const text = await readDaily('diaryDir', '2026-10-28', root)
    assert.equal(text, `第一版：今天刷到了三条猫${DAILY_JOIN}第二版：猫又被我忘了\n`)
    assert.ok(text.includes('第一版'), '旧的那段必须还在原文件里，不能只躺在 archive')
    assert.ok(text.indexOf('第一版') < text.indexOf('第二版'), '新的那段在后面')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('写三遍也不丢：三段按先后排好', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-28', '一', root)
    await writeDaily('diaryDir', '2026-10-28', '二', root)
    await writeDaily('diaryDir', '2026-10-28', '三', root)

    const text = await readDaily('diaryDir', '2026-10-28', root)
    assert.equal(text, `一${DAILY_JOIN}二${DAILY_JOIN}三\n`)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('内容一样就什么都不做：重写同一篇是幂等的', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-28', '同一篇', root)
    await writeDaily('diaryDir', '2026-10-28', '同一篇', root)
    await writeDaily('diaryDir', '2026-10-28', '同一篇', root)

    assert.equal(await readDaily('diaryDir', '2026-10-28', root), '同一篇')
    // 不再写归档目录：内容都在正文里，archive 只会堆垃圾
    await assert.rejects(readdir(join(paths(root).diaryDir, 'archive')), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('跨天才有两个日期：翻页键就挂在「日期 ≥ 2」上', async () => {
  const root = await tmpRoot()
  try {
    await writeDaily('diaryDir', '2026-10-27', '昨天', root)
    await writeDaily('diaryDir', '2026-10-28', '今天一版', root)
    await writeDaily('diaryDir', '2026-10-28', '今天二版', root)

    assert.deepEqual(await listDiary(root), ['2026-10-28', '2026-10-27'])
    const today = await readDaily('diaryDir', '2026-10-28', root)
    assert.ok(today.includes('今天一版') && today.includes('今天二版'))
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('报告（out/）仍然整篇覆盖：它是派生品，随时能由事件流重算', async () => {
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

test('同日追加后的历史文件：旧的 archive 还能读，不被清理', async () => {
  const root = await tmpRoot()
  try {
    // 模拟 0.6.27 留下的旧状态：archive 里有历史稿
    await writeDaily('diaryDir', '2026-10-28', '今天这篇', root)
    const archived = '0.6.27 时代的旧稿'
    await (await import('node:fs/promises')).mkdir(join(paths(root).diaryDir, 'archive'), { recursive: true })
    await (await import('node:fs/promises')).writeFile(
      join(paths(root).diaryDir, 'archive', '2026-10-28-051516.md'),
      archived,
      'utf8',
    )

    await writeDaily('diaryDir', '2026-10-28', '后来又写一段', root)

    assert.equal(await readFile(join(paths(root).diaryDir, 'archive', '2026-10-28-051516.md'), 'utf8'), archived)
    assert.deepEqual(await listDiary(root), ['2026-10-28'])
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})
