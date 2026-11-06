/**
 * attachment.mjs 的真单测（2026-11-06）
 *
 * 为什么不再只「读源码做正则」：这次改的是**分类行为**本身 —— 视频段到底会不会
 * 被丢、图片算不算文件、新格式接不接得住。正则只能证明代码里出现过某句话，
 * 证明不了跑起来对不对。分类逻辑抽成纯函数后可以直接测。
 *
 * 用户口径：他发的所有文件不论格式类型，一律存本地、只报事实、她自己判断。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifySegments, isAttachment, displayName, guessExt, ensureExt } from '../attachment.mjs'

const seg = (type, data = {}) => ({ type, data })

test('video 段不再被丢（11-06 真机事故）', () => {
  const r = classifySegments([seg('video', { file: 'abc.mp4', url: 'http://x/a.mp4' })], '1')
  assert.equal(r.files.length, 1)
  assert.equal(r.files[0]._kind, 'video')
  assert.equal(r.images.length, 0, '图也统一进 files，images 恒空')
  assert.equal(r.text, '')
})

test('图 / 文件 / 表情统一进 files，不再单列 images', () => {
  const r = classifySegments([
    seg('image', { url: 'http://x/1.png' }),
    seg('mface', { summary: '[动画表情]' }),
    seg('file', { name: '课表.ics', file_id: 'abc' }),
  ], '1')
  assert.equal(r.files.length, 3)
  assert.deepEqual(r.files.map((s) => s._kind), ['image', 'mface', 'file'])
  assert.equal(r.images.length, 0)
})

test('未知格式只要带可下载字段就算附件（不用改代码接新类型）', () => {
  assert.equal(isAttachment(seg('some_new_type', { file_id: 'x' })), true)
  assert.equal(isAttachment(seg('another', { file_path: '/tmp/a' })), true)
  assert.equal(isAttachment(seg('video', { url: 'http://x' })), true)
})

test('戳一戳 / 卡片 / 回执 / 小黄脸不是附件（别拿它们的 url 当文件下）', () => {
  for (const t of ['poke', 'reply', 'json', 'xml', 'share', 'location', 'music', 'face', 'dice', 'at']) {
    assert.equal(isAttachment(seg(t, { url: 'http://x' })), false, `${t} 不该当附件`)
  }
  assert.equal(isAttachment(seg('what', {})), false, '啥字段都没有的未知段也不算')
})

test('已知附件类型即便没带下载字段也收 —— 取不到会如实说，不静默丢', () => {
  assert.equal(isAttachment(seg('video', {})), true)
  assert.equal(isAttachment(seg('image', {})), true)
  const r = classifySegments([seg('video', {})], '1')
  assert.equal(r.files.length, 1)
})

test('record 走语音、forward / node 走转发，都不进 files', () => {
  const r = classifySegments([
    seg('record', { file: 'a.silk' }),
    seg('forward', { id: 'f1' }),
    seg('node', { id: 'n1' }),
  ], '1')
  assert.equal(r.audios.length, 1)
  assert.equal(r.forwards.length, 2)
  assert.equal(r.files.length, 0)
})

test('文字、@ 自己、mface 兜底', () => {
  const r = classifySegments([
    seg('text', { text: '看看这个 ' }),
    seg('at', { qq: '42' }),
    seg('video', { file: 'a.mp4' }),
  ], '42')
  assert.equal(r.text, '看看这个')
  assert.equal(r.atMe, true)
  assert.equal(r.files.length, 1)

  const m = classifySegments([seg('mface', { summary: '[动画表情]' })], '1')
  assert.equal(m.text, '[动画表情]', '没有 url 的 mface 用 summary 当文字兜底')
})

test('displayName 从 name / url 取，去掉查询串与路径', () => {
  assert.equal(displayName(seg('file', { name: '方案.pdf' })), '方案.pdf')
  assert.equal(displayName(seg('video', { url: 'http://x/v/a.mp4?token=1' })), 'a.mp4')
  assert.match(displayName(seg('image', { file: 'ABCDEF' })), /^ABCDEF$/)
  assert.match(displayName(seg('video', {})), /^video-\d+$/, '实在没名字就给个含类型的')
})

test('没后缀按魔数补：mp4 / png / gif / jpg / pdf / zip / wav', () => {
  const b = (n = 16) => Buffer.alloc(n)
  const mp4 = b(); Buffer.from('ftyp').copy(mp4, 4)
  const png = b(); Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(png)
  const gif = b(); Buffer.from('GIF89a').copy(gif)
  const jpg = b(); Buffer.from([0xff, 0xd8, 0xff]).copy(jpg)
  const pdf = b(); Buffer.from('%PDF').copy(pdf)
  const zip = b(); Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(zip)
  const wav = b(); Buffer.from('RIFF').copy(wav); Buffer.from('WAVE').copy(wav, 8)
  assert.equal(guessExt('a', mp4), '.mp4')
  assert.equal(guessExt('a', png), '.png')
  assert.equal(guessExt('a', gif), '.gif')
  assert.equal(guessExt('a', jpg), '.jpg')
  assert.equal(guessExt('a', pdf), '.pdf')
  assert.equal(guessExt('a', zip), '.zip')
  assert.equal(guessExt('a', wav), '.wav')
})

test('已有后缀不动；拿不到内容时按段类型兜底', () => {
  assert.equal(guessExt('片子.mov', Buffer.alloc(16)), '', '已有后缀不重复补')
  assert.equal(guessExt('hash', null, 'video'), '.mp4')
  assert.equal(guessExt('hash', null, 'image'), '.jpg')
  assert.equal(ensureExt('hash', null, 'video'), 'hash.mp4')
  assert.equal(ensureExt('a.txt', null, 'video'), 'a.txt')
})

test('一条消息里文字 + 多个附件，顺序不乱、一个不丢', () => {
  const r = classifySegments([
    seg('text', { text: '这三个都看看' }),
    seg('image', { url: 'http://x/1.jpg' }),
    seg('video', { file: 'a.mp4' }),
    seg('file', { name: '说明.txt' }),
  ], '1')
  assert.equal(r.text, '这三个都看看')
  assert.equal(r.files.length, 3)
  assert.deepEqual(r.files.map((s) => s._kind), ['image', 'video', 'file'])
})

test('一条无名 video 段会落成 .mp4 名字，不是无后缀的 hash', () => {
  // 真机里 video 段常只有 file_id，没名字；没后缀她就没法判断那是什么
  const s = { ...seg('video', { file_id: 'abc' }), _kind: 'video' }
  const mp4 = Buffer.alloc(16)
  Buffer.from('ftyp').copy(mp4, 4)
  const nm = ensureExt(displayName(s), mp4, s._kind)
  assert.match(nm, /\.mp4$/, '按魔数补出 .mp4')
  assert.match(nm, /^video-/, '实在没名字时带上段类型')
})
