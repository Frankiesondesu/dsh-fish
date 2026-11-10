/**
 * fork.12（2026-11-02）：看画面的额度按 DeepSeek 峰谷分开算。
 *
 * 计价规则（用户提供的说明）：北京时间周一至周五（不含法定节假日）
 * 9:00–12:00、14:00–18:00 为高峰，其余——含周末与法定节假日全天——都是空闲、半价。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tariffOf, watchedInTariff } from '../lib/watch.js'

// 北京时间 = UTC+8。下例都是「北京时间某天某点」对应的 UTC 构造。
const bj = (y, m, d, hh, mm = 0) => new Date(Date.UTC(y, m - 1, d, hh - 8, mm))

test('高峰：工作日 9–12 点、14–18 点', () => {
  assert.equal(tariffOf(bj(2026, 11, 2, 9, 0)), 'peak', '周一 9:00 整进高峰')
  assert.equal(tariffOf(bj(2026, 11, 2, 10, 30)), 'peak', '周一上午')
  assert.equal(tariffOf(bj(2026, 11, 2, 11, 59)), 'peak', '12 点前都算')
  assert.equal(tariffOf(bj(2026, 11, 2, 15, 0)), 'peak', '周一下午')
  assert.equal(tariffOf(bj(2026, 11, 2, 17, 59)), 'peak', '18 点前都算')
})

test('空闲：午休、晚上、清早，以及周末全天', () => {
  assert.equal(tariffOf(bj(2026, 11, 2, 8, 59)), 'idle', '9 点前不算')
  assert.equal(tariffOf(bj(2026, 11, 2, 12, 0)), 'idle', '12 点整出高峰')
  assert.equal(tariffOf(bj(2026, 11, 2, 13, 30)), 'idle', '午休')
  assert.equal(tariffOf(bj(2026, 11, 2, 18, 0)), 'idle', '18 点整出高峰')
  assert.equal(tariffOf(bj(2026, 11, 2, 22, 0)), 'idle', '晚上——她现在的作息窗口在这档')
  assert.equal(tariffOf(bj(2026, 11, 7, 10, 0)), 'idle', '周六全天空闲')
  assert.equal(tariffOf(bj(2026, 11, 8, 15, 0)), 'idle', '周日全天空闲')
})

test('额度分开算：峰一个数、谷一个数，老档按空闲算', () => {
  const mk = (bv, json) => ({ type: 'meta', text: `watched:2026-11-02 ${bv} ${JSON.stringify(json)}` })
  const events = [
    mk('BV1peak', { title: '甲', tariff: 'peak' }),
    mk('BV1idle', { title: '乙', tariff: 'idle' }),
    mk('BV1old', { title: '丙' }), // fork.12 之前写的，没有 tariff 字段
    { type: 'meta', text: 'watched:2026-11-01 BV1yesterday {"tariff":"peak"}' }, // 昨天的，不算今天
  ]

  assert.equal(watchedInTariff(events, '2026-11-02', 'peak'), 1, '峰的只有一条')
  assert.equal(watchedInTariff(events, '2026-11-02', 'idle'), 2, '谷的两条：明写的 + 老档（缺字段的按空闲算）')
  assert.equal(watchedInTariff(events, '2026-11-01', 'peak'), 1, '别的日子另算')
})
