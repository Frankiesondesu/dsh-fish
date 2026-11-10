/**
 * bili_zoom（fork.35）：把看过的那条视频的某一格放大重看。
 *
 * 她的原话：「一是小字看不清：表格、界面那种，放大也不行。」
 * 整条拼进几张宫格时一格只有一百多像素宽，UI 上的字必然糊——唯一的解法是把那几秒
 * 单独重新取一次。这组用例钉住四件事：
 *   1. 格表能存能取，且只留最近 12 条；
 *   2. 没看过 / 没有这一格时，说事实（不编一个时间段出来）；
 *   3. 同一条一天最多放大 3 次，第 4 次如实说「够多了」；
 *   4. 成功时把图路径和「每格时刻」给她。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerZoom, rememberCells, cellsOf, lastWatched, cellMapFile } from '../lib/zoom.js'
import { dateKey } from '../lib/settings.js'

function fakeCtx() {
  const regs = new Map()
  return {
    regs,
    tools: { register: (t) => { regs.set(t.name, t); return () => regs.delete(t.name) } },
  }
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-zoom-'))
  await mkdir(join(root, 'media'), { recursive: true })
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
}

const CELLS = [
  { i: 1, from: 0, to: 3.5 },
  { i: 2, from: 3.5, to: 9 },
  { i: 3, from: 9, to: 14 },
]

test('格表：存进去能取出来，且记住最近看过的那条', async () => {
  await withRoot(async (root) => {
    await rememberCells(root, 'BV1aa', CELLS)
    assert.deepEqual(await cellsOf(root, 'BV1aa'), CELLS)
    assert.equal(await lastWatched(root), 'BV1aa')

    await new Promise((r) => setTimeout(r, 5))
    await rememberCells(root, 'BV1bb', [{ i: 1, from: 1, to: 2 }])
    assert.equal(await lastWatched(root), 'BV1bb', '最近看的排在前面')
    assert.deepEqual(await cellsOf(root, 'BV1aa'), CELLS, '老的那条不能丢')
  })
})

test('格表最多留 12 条，超了丢最老的', async () => {
  await withRoot(async (root) => {
    for (let i = 0; i < 14; i++) {
      await rememberCells(root, `BV${i}`, CELLS)
      await new Promise((r) => setTimeout(r, 2))
    }
    const raw = JSON.parse(await (await import('node:fs/promises')).readFile(cellMapFile(root), 'utf8'))
    assert.equal(Object.keys(raw).length, 12)
    assert.equal(raw.BV0, undefined, '最老的被挤掉')
    assert.ok(raw.BV13, '最新的还在')
  })
})

test('没看过任何视频：说「我还没看过哪条视频」', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerZoom(ctx, { root, zoom: async () => { throw new Error('不该走到这里') } })
    const out = await ctx.regs.get('bili_zoom').execute({ cell: 1 })
    assert.equal(out.ok, false)
    assert.match(out.note, /还没看过/)
  })
})

test('看过但没这一格：说清只有几格，不编时间段', async () => {
  await withRoot(async (root) => {
    await rememberCells(root, 'BV1aa', CELLS)
    let called = false
    const ctx = fakeCtx()
    registerZoom(ctx, { root, zoom: async () => { called = true; return { ok: true } } })
    const out = await ctx.regs.get('bili_zoom').execute({ cell: 9 })
    assert.equal(out.ok, false)
    assert.match(out.note, /只记了 3 格，没有第 9 格/)
    assert.equal(called, false, '不该真去取帧')
  })
})

test('放大成功：给出图路径与每格时刻', async () => {
  await withRoot(async (root) => {
    await rememberCells(root, 'BV1aa', CELLS)
    const seen = []
    const ctx = fakeCtx()
    registerZoom(ctx, {
      root,
      zoom: async (o) => {
        seen.push(o)
        return {
          ok: true,
          path: 'C:\\tmp\\zoom.png',
          text: '放大 0:03–0:10 这一段：1 张图、2 格。',
        }
      },
    })
    const out = await ctx.regs.get('bili_zoom').execute({ cell: 2 })
    assert.equal(out.ok, true)
    assert.equal(out.path, 'C:/tmp/zoom.png', '路径一律给正斜杠')
    assert.match(out.text, /放大 0:03–0:10/)
    assert.deepEqual(seen[0], { bvid: 'BV1aa', from: 3.5, to: 9, root, vsPath: '' })
  })
})

test('同一条一天最多放大 3 次，第 4 次如实说', async () => {
  await withRoot(async (root) => {
    await rememberCells(root, 'BV1aa', CELLS)
    let n = 0
    const ctx = fakeCtx()
    registerZoom(ctx, { root, zoom: async () => { n += 1; return { ok: true, path: '/x.png', text: 'ok' } } })
    const tool = ctx.regs.get('bili_zoom')
    for (let i = 0; i < 3; i++) assert.equal((await tool.execute({ cell: 1 })).ok, true, `第 ${i + 1} 次该成功`)
    const out = await tool.execute({ cell: 1 })
    assert.equal(out.ok, false)
    assert.match(out.note, /够多了/)
    assert.equal(n, 3, '第 4 次不该真去取帧')
  })
})

test('放大失败：只说「这次没放大成」，技术原因进日志', async () => {
  await withRoot(async (root) => {
    await rememberCells(root, 'BV1aa', CELLS)
    const ctx = fakeCtx()
    registerZoom(ctx, { root, zoom: async () => ({ ok: false, why: 'yt-dlp 不在' }) })
    const out = await ctx.regs.get('bili_zoom').execute({ cell: 1 })
    assert.equal(out.ok, false)
    assert.equal(out.note, '这次没放大成。')
    assert.ok(!out.note.includes('yt-dlp'), '技术原因不进她的话')
  })
})

test('设置里关了看视频：放大也一起关', async () => {
  await withRoot(async (root) => {
    const { updateConfig } = await import('../lib/settings.js')
    await updateConfig({ video: { enabled: false } }, root)
    await rememberCells(root, 'BV1aa', CELLS)
    const ctx = fakeCtx()
    registerZoom(ctx, { root, zoom: async () => { throw new Error('不该走到这里') } })
    const out = await ctx.regs.get('bili_zoom').execute({ cell: 1 })
    assert.equal(out.ok, false)
    assert.match(out.note, /看不了画面/)
  })
})

test('跨天归零：昨天的次数不算今天的', async () => {
  await withRoot(async (root) => {
    await rememberCells(root, 'BV1aa', CELLS)
    const { promises: fs } = await import('node:fs')
    // 手动把记录改成「昨天已经用满 3 次」
    const all = JSON.parse(await fs.readFile(cellMapFile(root), 'utf8'))
    all.BV1aa.zoomDay = '2000-01-01'
    all.BV1aa.zooms = 3
    await fs.writeFile(cellMapFile(root), JSON.stringify(all), 'utf8')

    const ctx = fakeCtx()
    registerZoom(ctx, { root, zoom: async () => ({ ok: true, path: '/x.png', text: 'ok' }) })
    const out = await ctx.regs.get('bili_zoom').execute({ cell: 1 })
    assert.equal(out.ok, true, `换一天该重新算（今天 ${dateKey()}）`)
  })
})
