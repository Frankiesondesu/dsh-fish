/**
 * 「她说的话」时间线合并（2026-11-07）：her_say 的话必须进得来，内心判断不许混。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { qqSaidOf, mergeSaid } from '../said.mjs'

test('qqSaidOf：剥「（她说）」前缀；旧前缀「（她主动说）」一并收', () => {
  const ev = (id, source, text) => ({ id, type: 'utterance', source, text, ts: '2026-11-07T03:24:08.825Z' })
  const got = qqSaidOf([
    ev('ev_1', 'tool', '（她说）好。那就这么定了。'),
    ev('ev_2', 'tool', '（她主动说）窗开着。今天风大。'),
    // 内心判断：growth_commit 也落 utterance+tool，但没有推送前缀——不是说给他听的
    ev('ev_3', 'tool', '我今天有点累。'),
    // 系统补写的 utterance（主动回合没开口那种）不该混进来
    ev('ev_4', 'system', '（她说）这句其实是系统写的口径不对，但前缀对就收——边界钉在 source 上'),
    { id: 'ev_5', type: 'meta', source: 'tool', text: '（她说）meta 不是 utterance' },
  ])
  assert.deepEqual(got.map((g) => g.id), ['ev_1', 'ev_2'], 'ev_4 是 system，ev_3 没前缀，ev_5 不是 utterance')
  assert.equal(got[0].text, '好。那就这么定了。')
  assert.equal(got[1].text, '窗开着。今天风大。')
  assert.equal(got[0].at, Date.parse('2026-11-07T03:24:08.825Z'))
})

test('mergeSaid：两路并一条时间线，新的在前，where 标来源', () => {
  const spoken = [
    { at: 1000, turn: 279, text: '窗口正文' },
    { at: 3000, turn: 280, text: '窗口后一句' },
  ]
  const qq = [
    { at: 2000, id: 'ev_b', text: 'QQ 上的话' },
    { at: 500, id: 'ev_a', text: '更早的 QQ 话' },
  ]
  const merged = mergeSaid(spoken, qq)
  assert.deepEqual(merged.map((m) => m.at), [3000, 2000, 1000, 500])
  assert.deepEqual(merged.map((m) => m.where), ['desk', 'qq', 'desk', 'qq'])
  // 传入数组不被改（render 每次都调）
  assert.equal(spoken.length, 2)
})

test('mergeSaid：空输入不抛（她还没说过话的页面也要能渲染）', () => {
  assert.deepEqual(mergeSaid([], []), [])
  assert.deepEqual(mergeSaid(undefined, undefined), [])
})
