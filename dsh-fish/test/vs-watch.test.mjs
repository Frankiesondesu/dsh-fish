/**
 * vs 引擎桥接（fork.17 起；fork.22 起它是唯一的看画面引擎，lite 已删）。
 *
 * 不跑真管线（要下载整条视频）：往 watchViaStoryboard 里注入假的 impl，
 * 钉住三条职责：多张宫格落盘并给出路径、失败返回 ok:false（让调用方如实说没看成）、
 * 每格时刻与台词进说明文字。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { watchViaStoryboard } from '../lib/vs.js'
import { slashed } from '../lib/posix.js'

// 最小 PNG（1×1 白点）：encodeRaw 用 ffmpeg 编码，内容无所谓
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0300050201f34a24d50000000049454e44ae426082',
  'hex',
)

// 形状照真管线抄（2026-11-02 实测 BV1LExL6iE2Y）：
// `transcript.segments` 是**段数（数字）**，不是段数组；台词挂在 cells[].text 上。
const fixtureImpl = ({ fail = false, segments = 12 } = {}) => ({
  async runStoryboard(opts) {
    if (fail) throw new Error('yt-dlp 不在')
    return {
      info: { title: '测试视频', up: '某UP', duration: 10 },
      window: { start: 0 },
      sheets: [
        {
          buffer: TINY_PNG,
          width: 4,
          height: 4,
          cols: 1,
          rows: 1,
          cells: [{ i: 1, t_start: 0, t_end: 10, t_frame: 5, text: '你好，这是一段台词' }],
        },
      ],
      transcript: { source: 'subtitle', model: 'site-cc:ai-zh', segments, chars: 9, charsPerSec: 3 },
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

test('vs 引擎：多张宫格落盘、每格带时刻和台词、说明文字齐', async () => {
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
    assert.ok(r.text.includes('第1格 0:00–0:10'), '每格要带时刻：' + r.text.slice(0, 200))
    assert.ok(r.text.includes('你好，这是一段台词'), '台词要跟着格子进来')
    assert.ok(r.text.includes('台词共 9 字、12 段'), '要交代台词来源和规模')
    // 说明里列给她的路径用正斜杠；照抄反斜杠在客户端会「无法预览」（2026-10-26 实测）
    assert.ok(r.text.includes(slashed(r.path)), '路径要出现在说明里，且是正斜杠')
    assert.ok(!r.text.includes(String(r.path).replace(/\//g, '\\')), '不该把反斜杠原路径列给她')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// fork.22 回归：真机上 `transcript.segments` 是数字（544），当年被当数组 .map，
// vs 每次都在最后一步 TypeError 崩掉，于是永远只有九帧顶上。
test('vs 引擎：transcript.segments 是数字也不许崩', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-vs-'))
  try {
    for (const segments of [544, undefined, null, []]) {
      const r = await watchViaStoryboard({ bvid: 'BV1ED4y1Y7dc', root, impl: fixtureImpl({ segments }) })
      assert.equal(r.ok, true, `segments=${JSON.stringify(segments)} 时不该失败：${r.why ?? ''}`)
    }
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
