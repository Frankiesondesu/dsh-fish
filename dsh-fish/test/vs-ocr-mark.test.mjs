/**
 * 「哪几句是听写和字幕对不上、按字幕改过的」（fork.33，2026-11-03）。
 *
 * 她看完第一条视频后要的东西：「台词像是机器听写下来的，错字不少……
 * 要说最想要的一样，是『哪几句它拿不准，标出来』。」
 *
 * vs 的 `ocr.changes` 里本来就记着每一次替换（{from, was, now, cover}），
 * 只是以前没人往下传。这组用例钉住四件事：
 *   1. 改过的格子后面有「（改自「原听写」）」；
 *   2. 没改过的格子不许乱标；
 *   3. 头部要交代改了几处——她得知道这份台词的成色；
 *   4. 没找到硬字幕 / 对照失败时要直说，不能让她以为「没标 = 准」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { watchViaStoryboard } from '../lib/vs.js'

const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0300050201f34a24d50000000049454e44ae426082',
  'hex',
)

/**
 * 两格：第 1 格被字幕校正过（听写成「大飞鱼」），第 2 格没动过。
 * `ocr.changes` 的 `from` 是**绝对时间**（ASR 段起点），和格子的 t_start 对得上。
 */
function implWithOcr({ ocr } = {}) {
  return {
    async runStoryboard() {
      return {
        info: { title: '测试视频', up: '某UP', duration: 20 },
        window: { start: 0 },
        sheets: [
          {
            buffer: TINY_PNG,
            width: 4,
            height: 4,
            cols: 1,
            rows: 2,
            cells: [
              { i: 1, t_start: 0, t_end: 10, t_frame: 5, text: '这条大肥鱼的视频我看完了' },
              { i: 2, t_start: 10, t_end: 20, t_frame: 15, text: '剩下的明天再说' },
            ],
          },
        ],
        transcript: { source: 'asr', model: 'paraformer', segments: 2, chars: 22, charsPerSec: 2 },
        ...(ocr ? { ocr } : {}),
        totalDuration: 20,
      }
    },
    async saveStoryboards(result, outPath) {
      const p = outPath.replace(/\.png$/, '') + '.png'
      writeFileSync(p, result.sheets[0].buffer)
      return [p]
    },
  }
}

test('改过的格子后面标「改自」原文，没改的不标', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-vs-ocr-'))
  try {
    const r = await watchViaStoryboard({
      bvid: 'BV1ED4y1Y7dc',
      root,
      impl: implWithOcr({
        ocr: {
          status: 'applied',
          fixed: 1,
          checked: 16,
          basedOn: 'source',
          changes: [{ from: 1.2, was: '这条大飞鱼的视频', now: '这条大肥鱼的视频', cover: 0.8 }],
        },
      }),
    })
    assert.equal(r.ok, true, r.why ?? '')
    const line1 = r.text.split('\n').find((l) => l.startsWith('第1格'))
    const line2 = r.text.split('\n').find((l) => l.startsWith('第2格'))
    assert.match(line1, /（改自「这条大飞鱼的视频」）/, '第 1 格要带原听写：' + line1)
    assert.ok(!line2.includes('改自'), '第 2 格没被改过，不该有标记：' + line2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('头部要交代「改了几处」', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-vs-ocr-'))
  try {
    const r = await watchViaStoryboard({
      bvid: 'BV1ED4y1Y7dc',
      root,
      impl: implWithOcr({
        ocr: {
          status: 'applied',
          fixed: 2,
          checked: 16,
          basedOn: 'source',
          changes: [{ from: 1.2, was: '大飞鱼', now: '大肥鱼', cover: 0.8 }],
        },
      }),
    })
    assert.match(r.text, /其中 2 处听写和画面字幕对不上、按字幕改过/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('没找到硬字幕：直说「台词只有听写」，别让她以为没标就是准', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-vs-ocr-'))
  try {
    const r = await watchViaStoryboard({
      bvid: 'BV1ED4y1Y7dc',
      root,
      impl: implWithOcr({ ocr: { status: 'skipped', reason: 'no-subtitle-band', checked: 3 } }),
    })
    assert.match(r.text, /这条没找到硬字幕，台词只有听写/)
    assert.ok(!r.text.includes('改自'), '一条都没改过，不该出现标记')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('对照跑失败：也要说出来', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-vs-ocr-'))
  try {
    const r = await watchViaStoryboard({
      bvid: 'BV1ED4y1Y7dc',
      root,
      impl: implWithOcr({ ocr: { status: 'failed', reason: 'no-python-with-rapidocr' } }),
    })
    assert.match(r.text, /字幕对照没跑成，台词只有听写/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('低清副本对照：可信度要打折说清楚', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-vs-ocr-'))
  try {
    const r = await watchViaStoryboard({
      bvid: 'BV1ED4y1Y7dc',
      root,
      impl: implWithOcr({
        ocr: {
          status: 'applied',
          fixed: 1,
          checked: 8,
          basedOn: 'low-res-copy',
          copyHeight: 360,
          changes: [{ from: 1.2, was: '大飞鱼', now: '大肥鱼', cover: 0.7 }],
        },
      }),
    })
    assert.match(r.text, /对照用的是低清副本，可信度要打折/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('没有 ocr 字段（老版本外挂）：照常出说明，不报错', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-vs-ocr-'))
  try {
    const r = await watchViaStoryboard({ bvid: 'BV1ED4y1Y7dc', root, impl: implWithOcr({}) })
    assert.equal(r.ok, true)
    assert.ok(!r.text.includes('改自'))
    assert.match(r.text, /来源：我们自己听写的/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * 台词的三种成色要分开说（2026-11-03 实测）：
 *   site-cc:ai-zh = B 站自己生成的 AI 字幕（她看到的错字就是它）
 *   site-cc:zh    = 上传者给的字幕
 *   asr           = 我们自己听写
 * 混成一句「来源：subtitle」她没法判断该不该信。
 */
test('台词来源要说清是 AI 字幕、人工字幕还是自己听写', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-vs-ocr-'))
  try {
    const cases = [
      ['site-cc:ai-zh', /B 站 AI 字幕，机器听写、可能有错字/],
      ['site-cc:zh', /上传者给的字幕/],
      ['paraformer', /我们自己听写的/],
    ]
    for (const [model, want] of cases) {
      const impl = implWithOcr({})
      const orig = impl.runStoryboard
      impl.runStoryboard = async (o) => {
        const res = await orig(o)
        return { ...res, transcript: { ...res.transcript, source: model === 'paraformer' ? 'asr' : 'subtitle', model } }
      }
      const r = await watchViaStoryboard({ bvid: 'BV1ED4y1Y7dc', root, impl })
      assert.match(r.text, want, `model=${model} 时说明不对：${r.text.split('\n').find((l) => l.includes('台词共'))}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
