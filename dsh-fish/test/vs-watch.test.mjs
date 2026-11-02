/**
 * fork.17：看画面双引擎——vs 全管线（默认）+ lite 九帧兜底。
 *
 * 不跑真管线（要下载整条视频）：往 watchViaStoryboard 里注入假的 impl，
 * 钉住三条职责：多张宫格落盘并给出路径、失败返回 ok:false（让调用方兜底）、
 * 台词对齐进说明文字。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { watchViaStoryboard } from '../lib/vs.js'

// 最小 PNG（1×1 白点）：encodeRaw 用 ffmpeg 编码，内容无所谓
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0300050201f34a24d50000000049454e44ae426082',
  'hex',
)

const fixtureImpl = ({ fail = false } = {}) => ({
  async runStoryboard(opts) {
    if (fail) throw new Error('yt-dlp 不在')
    return {
      info: { title: '测试视频', up: '某UP' },
      window: { start: 0 },
      sheets: [
        {
          buffer: TINY_PNG,
          width: 4,
          height: 4,
          cols: 1,
          rows: 1,
          cells: [{ i: 1, t_start: 0, t_end: 10 }],
        },
      ],
      transcript: { segments: [{ from: 2, to: 3, text: '你好' }] },
      totalDuration: 10,
    }
  },
  async saveStoryboards(result, outPath) {
    const paths = []
    for (const s of result.sheets) {
      const p = outPath.replace('.png', '') + '.png'
      // 真实现用 ffmpeg 编码；测试直接落盘一个占位文件
      const { writeFileSync } = await import('node:fs')
      writeFileSync(p, s.buffer)
      paths.push(p)
    }
    return paths
  },
})

test('vs 引擎：多张宫格落盘、台词对齐、说明文字齐', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-vs-'))
  try {
    const r = await watchViaStoryboard({
      bvid: 'BV1ED4y1Y7dc',
      root,
      hotword: '魔搭',
      impl: fixtureImpl(),
    })
    assert.equal(r.ok, true, r.why ?? '')
    assert.ok(r.paths?.length >= 1, '至少一张宫格')
    assert.ok(existsSync(r.path), '宫格图要真落盘')
    assert.ok(r.text.includes('测试视频'), '要有标题：' + r.text.slice(0, 80))
    assert.ok(r.text.includes('台词：'), '要带台词段')
    assert.ok(r.text.includes('你好'), '台词要对齐进来')
    assert.ok(r.text.includes(r.path), '路径要出现在说明里')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('vs 失败：返回 ok:false，让调用方退回轻量兜底', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-vs-'))
  try {
    const r = await watchViaStoryboard({
      bvid: 'BV1ED4y1Y7dc',
      root,
      impl: fixtureImpl({ fail: true }),
    })
    assert.equal(r.ok, false)
    assert.ok(r.why, '要带原因')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('at 点名：传给管线的窗口前后各留 5 秒', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fish-vs-'))
  try {
    let captured = null
    const impl = {
      async runStoryboard(opts) {
        captured = opts
        return (await fixtureImpl().runStoryboard(opts))
      },
      async saveStoryboards(res, outPath) {
        return [outPath]
      },
    }
    await watchViaStoryboard({ bvid: 'BV1ED4y1Y7dc', root, at: [30, 90], impl })
    assert.equal(captured.from, 25, '30-5')
    assert.equal(captured.to, 95, '90+5')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
