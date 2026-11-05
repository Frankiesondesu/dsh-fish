/**
 * intercom 纯函数的守卫（2026-11-06）。
 *
 * 对讲机链路里大多数步骤要碰真服务（听写、她的通路、edge-tts），
 * 那些只能真机验。这里钉住的是不需要服务的判定逻辑——
 * 每一条都对应一种「错了她那边会怪」的形状。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  pickReply,
  splitForSpeech,
  needsConvert,
  safeAudioName,
  clampForSpeech,
} from '../intercom.mjs'

test('pickReply：只认她说出口的话，growth_commit 记下的判断不混进来（fork.2 口径）', () => {
  assert.equal(pickReply({ spoken: '她说的', herReply: '她说的+她记的判断' }), '她说的')
  // 她一句话没说、只记了一条判断：拿 herReply 兜底（老调用方还得有得念）
  assert.equal(pickReply({ spoken: '', herReply: '只记了一句判断' }), '只记了一句判断')
  assert.equal(pickReply({ ok: true, note: '她这次没说话' }), '')
  assert.equal(pickReply(null), '')
  assert.equal(pickReply({ spoken: 123 }), '123')
})

test('splitForSpeech：段数封顶、短段并入、切不动就原样', () => {
  // 正常切：句末标点留在前一段（每段都够长，不会被并入）
  const r = splitForSpeech('今天风好大，路上全是被吹跑的叶子。我看了会儿视频，讲秋天的那些！后来就睡了，睡得还不算晚')
  assert.equal(r.length, 3)
  assert.ok(r[0].endsWith('。'))
  assert.ok(r[1].endsWith('！'))
  assert.ok(r[2].endsWith('晚'))
  // 短段并入是设计（「嗯。」单独合成一次不值得）——开头短段会被并进后面
  assert.deepEqual(splitForSpeech('嗯。今天风大。'), ['嗯。今天风大。'])
  // 超量：压回 4 段以内，且不丢字
  const many = splitForSpeech('第一句话挺长的吧。第二句话也挺长的呀。第三句话还是长的呢。第四句话依旧是长的哦。第五句照样长。第六句还是长。第七句真的很长。第八句！第九句？第十句。')
  assert.ok(many.length <= 4)
  assert.ok(many.join('').includes('第十句'))
  // 空的返回空数组（调用方退回整段合成）
  assert.deepEqual(splitForSpeech(''), [])
  assert.deepEqual(splitForSpeech(null), [])
})

test('needsConvert：mp3/wav 直接喂，浏览器录的 webm/ogg 要转', () => {
  assert.equal(needsConvert('audio/webm;codecs=opus'), true)
  assert.equal(needsConvert('audio/ogg'), true)
  assert.equal(needsConvert('audio/mpeg'), false)
  assert.equal(needsConvert('audio/mp3'), false)
  assert.equal(needsConvert('audio/wav'), false)
  assert.equal(needsConvert(''), true)
})

test('safeAudioName：只认白名单形状，路径穿越进不来', () => {
  assert.equal(safeAudioName('ic-2026-11-06T00-00-00.mp3'), 'ic-2026-11-06T00-00-00.mp3')
  assert.equal(safeAudioName('a.mp3'), 'a.mp3')
  assert.equal(safeAudioName('../events.jsonl'), '')
  assert.equal(safeAudioName('..\\voice\\x.mp3'), '')
  assert.equal(safeAudioName('x.mp3/../../secret'), '')
  assert.equal(safeAudioName(''), '')
  assert.equal(safeAudioName('.mp3'), '')
  assert.equal(safeAudioName('没有转义.mp3'), '')
})

test('clampForSpeech：截断退到句末标点，并报告丢了几字', () => {
  const long = '第一句。'.repeat(200)
  const c = clampForSpeech(long, 500)
  assert.ok(c.text.length <= 500)
  assert.ok(c.text.endsWith('。'))
  assert.equal(c.dropped, long.length - c.text.length)
  assert.equal(clampForSpeech('短的一句话。').dropped, 0)
  // 没有标点也不丢内容：硬切
  const noPunc = '字'.repeat(600)
  const c2 = clampForSpeech(noPunc, 500)
  assert.equal(c2.text.length, 500)
  assert.equal(c2.dropped, 100)
})
