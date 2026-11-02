/**
 * fork.10（2026-11-02）：让 her_recall 换句话也能翻到，并且能翻到「经历」。
 *
 * 真机形状：她问"上次那个视频"，账本里明明有标题，一条都搜不出来；
 * 她记得"皮影"，问"变戏法"全落空。两个缺口：只会对字、只搜"想法"不搜"经历"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchEvents, tokensOf, looseScore, renderRecall } from '../lib/recall.js'

const T0 = Date.parse('2026-11-01T12:00:00.000Z')

const ev = (id, type, text, extra = {}) => ({
  id,
  v: 1,
  ts: new Date(T0 - (extra.daysAgo ?? 0) * 86400000).toISOString(),
  day: 1,
  stage: 1,
  type,
  source: extra.source ?? (type === 'meta' ? 'system' : 'her'),
  text,
  refs: [],
  verdict: null,
  confidence: 0.5,
  flags: [],
})

test('近义词：说"片子"也能翻到写着"视频"的那条', () => {
  const events = [ev('ev_1', 'utterance', '四条视频里我最想看《皮影》。')]
  const { rows } = searchEvents(events, '上次那个片子')
  assert.equal(rows.length, 1, '换了说法也该翻得到')
  assert.equal(rows[0].id, 'ev_1')
})

test('字面兜底：整词对不上时，看字面重合', () => {
  const events = [ev('ev_2', 'utterance', '拿掉挡板不是更好，是它不成立了。')]
  const { rows } = searchEvents(events, '挡板多余')
  assert.equal(rows.length, 1, '重合够多就该翻到')
  assert.equal(rows[0].id, 'ev_2')
  // 虚字不算：全是"的了是我你"这种，不该被当成相关
  assert.equal(looseScore('拿掉屏风不是更好', '的了是我你'), 0)
})

test('经历也能翻到：saw: / watched: 进回忆，seen: 不进', () => {
  const events = [
    ev('ev_saw', 'meta', 'saw:BV1cuZwYZEZr 《皮影》 某某UP'),
    ev('ev_seen', 'meta', 'seen:2026-11-01T12:00:00.000Z'),
    ev('ev_watch', 'meta', 'watched:2026-11-01 BV1JD4y1e7Q4 {"title":"大闹天宫","up":"某UP","duration":300}'),
  ]
  const { rows } = searchEvents(events, '皮影')
  assert.deepEqual(rows.map((r) => r.id), ['ev_saw'], '看过的那条要能翻到')

  const { rows: rows2 } = searchEvents(events, '大闹天宫')
  assert.deepEqual(rows2.map((r) => r.id), ['ev_watch'])

  const { rows: rows3 } = searchEvents(events, '2026-11-01')
  assert.ok(!rows3.some((r) => r.id === 'ev_seen'), 'seen: 是记账噪音，不该进回忆')
})

test('她读到的不是配置项：meta 要翻成人话', () => {
  const events = [ev('ev_saw', 'meta', 'saw:BV1cuZwYZEZr 《皮影》 某某UP')]
  const { rows } = searchEvents(events, '皮影')
  const text = renderRecall(rows)
  assert.ok(text.includes('你看过：'), '要说成人话：' + text)
  assert.ok(!text.includes('saw:'), '不该让她看见前缀：' + text)
})

test('分词：短词不切碎，长词补二字片', () => {
  assert.deepEqual(tokensOf('皮影').sort(), ['皮影'])
  const t = tokensOf('屏风是艺术')
  assert.ok(t.includes('屏风'), '长词要切出二字片')
})
