/**
 * fork.14（2026-11-02）：bili_watch 带字幕台词。
 *
 * pickTranscript 三条规则各测一遍：对齐画面、对不上就均匀抽、总量封顶。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickTranscript, TRANSCRIPT_MAX_CHARS } from '../lib/video.js'

const L = (...pairs) => pairs.map(([t, text]) => ({ t, text }))

test('对齐：取帧时刻正说着的那句要被选中', () => {
  const lines = L(
    [0, '开场白'],
    [10, '这句是被看见的'],
    [30, '后面的话'],
  )
  const out = pickTranscript(lines, { times: [12], maxChars: 500 })
  assert.ok(out.includes('这句是被看见的'), '12 秒的帧要对上 10 秒那句：' + out)
  assert.ok(!out.includes('后面的话'), '没被画面指到的不要硬塞')
  assert.ok(out.includes('[0:10]'), '要带时间戳')
})

test('对不上：均匀抽样，而不是空手而归', () => {
  const lines = L(...Array.from({ length: 40 }, (_, i) => [i * 30, `第 ${i} 句`]))
  // 最后一句话在 1170 秒；取帧在 5000 秒，差得太远，对不上 → 走均匀抽样
  const out = pickTranscript(lines, { times: [5000] })
  assert.ok(out.length > 0, '总该给几句')
  const n = out.split('\n').length
  assert.ok(n >= 4 && n <= 8, `抽样 4~8 句，实际 ${n}`)
})

test('预算：总字数不超上限，且按时间顺序', () => {
  const lines = L(...Array.from({ length: 20 }, (_, i) => [i * 5, '甲'.repeat(100) + i]))
  const times = Array.from({ length: 20 }, (_, i) => i * 5)
  const out = pickTranscript(lines, { times, maxChars: 500 })
  const body = out.split('\n').map((l) => l.replace(/^\[\d+:\d+\] /, '')).join('')
  assert.ok(body.length <= 500, `正文 ${body.length} 字，超了`)
  // 按时间升序
  const stamps = out.split('\n').map((l) => Number(l.match(/\[(\d+):\d+\]/)[1]))
  assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b))
})

test('空输入与去重', () => {
  assert.equal(pickTranscript([], { times: [5] }), '')
  assert.equal(pickTranscript(null), '')
  const out = pickTranscript(L([5, '同一句'], [6, '同一句']), { times: [5, 6] })
  assert.equal(out.split('\n').length, 1, '同一句只留一条')
})
