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
import { classifySegments, isAttachment, displayName, guessExt, ensureExt, markOf } from '../attachment.mjs'

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

// ---------------------------------------------------------------- 2026-11-12：表情与卡片
// 真机事故：他 16:07 发了个表情，桥日志写「文字0字 附件0 → 跳过」，她那边一个字都没有，
// 看起来就是已读不回。以下钉住「不许静默丢」，同时钉住「拿不到名字就不许猜」。

test('小黄脸不再被吞：翻成 [表情:名字]，且 text 非空（否则桥会跳过整条）', () => {
  const r = classifySegments([seg('face', { id: '178', sub_type: 1 })], '1')
  assert.equal(r.text, '[表情:斜眼笑]')
  assert.equal(r.files.length, 0)
  assert.notEqual(r.text, '', '只发表情也必须留下东西，不能又变成「跳过」')
})

test('文字 + 表情：表情接在原话后面，不吞掉原话', () => {
  const r = classifySegments([seg('text', { text: '好累' }), seg('face', { id: '182' })], '1')
  assert.equal(r.text, '好累[表情:笑哭]')
})

test('表里没有的 id 只写 [表情]，绝不按 id 猜（fork.13）', () => {
  const r = classifySegments([seg('face', { id: '99999' })], '1')
  assert.equal(r.text, '[表情]')
  assert.doesNotMatch(r.text, /99999/, '不把 id 当名字塞给她')
})

test('表情表本身要对：抽查几个常用 id', () => {
  // 表由 LLOneBot 的 face_config.json 生成，不是手写；这条防的是「以后有人手改错一行」
  const expect = {
    0: '惊讶', 1: '撇嘴', 13: '呲牙', 14: '微笑', 76: '赞', 178: '斜眼笑', 182: '笑哭',
  }
  for (const [id, name] of Object.entries(expect)) {
    assert.equal(classifySegments([seg('face', { id })], '1').text, `[表情:${name}]`, `id ${id} 应为 ${name}`)
  }
})

test('戳 / 骰子 / 猜拳 / 抖动 / 位置 / 音乐 / 分享 / 名片 各有一句，不再静默丢', () => {
  const cases = [
    [seg('poke', {}), '[戳一戳]'],
    [seg('dice', { result: '4' }), '[骰子:4]'],
    [seg('rps', { result: '2' }), '[猜拳:剪刀]'],
    [seg('shake', {}), '[窗口抖动]'],
    [seg('location', { title: '某某大学' }), '[位置:某某大学]'],
    [seg('music', { title: '晴天', singer: '周杰伦' }), '[音乐:晴天-周杰伦]'],
    [seg('share', { title: '一个链接', url: 'https://b23.tv/x' }), '[分享:一个链接] https://b23.tv/x'],
    [seg('contact', { id: '1234567890' }), '[名片:1234567890]'],
  ]
  for (const [s, want] of cases) {
    assert.equal(classifySegments([s], '1').text, want, s.type)
  }
})

test('卡片标题优先取 meta 里的，拿不到才退回 prompt；坏数据不崩', () => {
  const withMeta = seg('json', {
    data: JSON.stringify({ prompt: '[QQ小程序]某应用', meta: { detail_1: { title: '真正的标题' } } }),
  })
  assert.equal(classifySegments([withMeta], '1').text, '[卡片:真正的标题]')

  const onlyPrompt = seg('json', { data: JSON.stringify({ prompt: '[QQ小程序]某应用' }) })
  assert.equal(classifySegments([onlyPrompt], '1').text, '[卡片:[QQ小程序]某应用]')

  assert.equal(classifySegments([seg('json', { data: '{坏' })], '1').text, '[卡片]')
  assert.equal(classifySegments([seg('xml', { data: '<msg><item><title><![CDATA[网易云分享]]></title></item></msg>' })], '1').text, '[卡片:网易云分享]')
})

test('引用回复不产生内容（正文本来就在这条消息里，不重复）', () => {
  const r = classifySegments([seg('reply', { id: '123' }), seg('text', { text: '对，就是这样' })], '1')
  assert.equal(r.text, '对，就是这样')
})

test('这些段仍然不是附件：别拿卡片的 url 去下载', () => {
  for (const t of ['face', 'poke', 'share', 'json', 'xml', 'location', 'music', 'contact']) {
    assert.equal(isAttachment(seg(t, { url: 'http://x/a.png' })), false, t)
  }
})

test('markOf 对普通 text / 附件返回空，不影响原路径', () => {
  assert.equal(markOf(seg('text', { text: 'hi' })), '')
  assert.equal(markOf(seg('image', { url: 'http://x/a.png' })), '')
  assert.equal(markOf(seg('mface', { summary: '[动画表情]' })), '')
})
