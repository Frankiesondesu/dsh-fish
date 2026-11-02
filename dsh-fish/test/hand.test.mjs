/**
 * hand.test.mjs —— `hand:` 的两个写入口共用的那点逻辑（fork.20）
 *
 * 真的解析短链要联网，这里不测；测的是"哪段算短链"这条边界——
 * 判宽了会把正文里的普通字当成链接，判窄了他手机分享出来的就记不上。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { shortLinkOf, shortLinksOf } from '../lib/hand.js'

test('shortLinkOf：认出 b23.tv / bili2233.cn 的短链，带不带协议都行', () => {
  assert.equal(shortLinkOf('看看这个 https://b23.tv/AbCd12'), 'https://b23.tv/AbCd12')
  assert.equal(shortLinkOf('b23.tv/AbCd12 这个'), 'https://b23.tv/AbCd12')
  assert.equal(shortLinkOf('https://bili2233.cn/xyz'), 'https://bili2233.cn/xyz')
  // 短链后面还跟着字，链接本身要截干净
  assert.equal(shortLinkOf('https://b23.tv/AbCd12，你看'), 'https://b23.tv/AbCd12')
})

test('shortLinkOf：没有短链就是空串（BV 号那条走同步写，不归这里管）', () => {
  assert.equal(shortLinkOf('BV1ED4y1Y7dc'), '')
  assert.equal(shortLinkOf('https://www.bilibili.com/video/BV1ED4y1Y7dc'), '')
  assert.equal(shortLinkOf(''), '')
  assert.equal(shortLinkOf(null), '')
})

test('recordHandFromLink：不是短链就什么都不做，也不抛', async () => {
  const { recordHandFromLink } = await import('../lib/hand.js')
  assert.doesNotThrow(() => recordHandFromLink('/tmp/不存在', '没链接'))
  assert.doesNotThrow(() => recordHandFromLink('/tmp/不存在', ''))
})

test('shortLinksOf：一条消息里几条短链就返回几条', () => {
  const s = 'https://b23.tv/aaa 和 https://b23.tv/bbb 都看看'
  assert.deepEqual(shortLinksOf(s), ['https://b23.tv/aaa', 'https://b23.tv/bbb'])
  // 同一条重复只算一次
  assert.deepEqual(shortLinksOf('b23.tv/aaa b23.tv/aaa'), ['https://b23.tv/aaa'])
})
