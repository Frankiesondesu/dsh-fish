/**
 * 分句并发合成（fork.51，2026-11-05）。
 *
 * 她原来整段一次合成：200 字要等 5–6 秒才听到第一个字。
 * 切句并发之后，首声约等于最长那一句的时间。
 *
 * 但切句切错了比慢更糟——语气会在句子中间断掉。所以这里只测切分：
 *   短句不分（不值得多一次连接）；
 *   句末标点留在前一段（edge-tts 靠它收尾）；
 *   段数有上限（再多，连接开销盖过收益）；
 *   切不动就返回 1 段，调用方退回整段合成。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { splitForSpeech } from '../lib/voice.js'

test('空文本：不分，也没有空段', () => {
  assert.deepEqual(splitForSpeech(''), [])
  assert.deepEqual(splitForSpeech('   '), [])
})

test('短句不分：加起来还没一句长，切了只是多一次连接', () => {
  const s = '今天天气不错。你呢？'
  assert.deepEqual(splitForSpeech(s), [s], '总长不到 20 字，不该分')
})

test('三句话切三段，句末标点跟着前一段', () => {
  const s = '我今天去了那个菜市场，人特别多。卖鱼的那家换了人，刀法不一样了。回来的路上下了点雨，我把外套顶在头上跑回来的。'
  const parts = splitForSpeech(s)
  assert.equal(parts.length, 3)
  assert.ok(parts[0].endsWith('。'))
  assert.ok(parts[1].endsWith('。'))
  assert.equal(parts.join(''), s, '不能丢字，也不能重复')
})

test('段数有上限：六句合成四段', () => {
  const one = '这一句大概十几个字的样子。'
  const s = one.repeat(6)
  const parts = splitForSpeech(s, { maxParts: 4 })
  assert.equal(parts.length, 4)
  assert.equal(parts.join(''), s)
})

test('太短的一段并进上一段：不单独为「嗯。」开一次连接', () => {
  const s = '嗯。我今天去了菜市场，人特别多，卖鱼的换了人。'
  const parts = splitForSpeech(s)
  assert.equal(parts.length, 1, '开头那段太短，整句并成一段')
  assert.ok(parts[0].startsWith('嗯。'))
})

test('换行和英文标点也认', () => {
  const s = '第一行写了一些东西在这里。\n第二行也写了一些东西在那里!'
  const parts = splitForSpeech(s)
  assert.equal(parts.length, 2)
  assert.equal(parts[0], '第一行写了一些东西在这里。', '换行不该被念出来')
  assert.ok(parts[1].endsWith('!'))
  assert.equal(parts.join('').replace(/\s/g, ''), s.replace(/\s/g, ''), '一个字都不能丢')
})

test('切不动就一段：调用方会退回整段合成', () => {
  const s = '这一整段话没有句末标点所以切不开只能一次说完'
  assert.equal(splitForSpeech(s).length, 1)
})

test('源码守卫：失败要能退回整段（不要只有并发这一条路）', async () => {
  const src = await fs.readFile(new URL('../lib/voice.js', import.meta.url), 'utf8')
  assert.match(src, /splitForSpeech\(text\)/, '要真的用了切句')
  assert.match(src, /detectFfmpeg\(\)/, '要确认 ffmpeg 在才走并发')
  assert.match(src, /if \(!made\) \{[\s\S]*?await tts\(text, file(, tone)?\)/, '并发失败必须退回整段（fork.55 起带语调参数）')
  assert.match(src, /Promise\.all\(parts\.map/, '分片要并发，不是串行')
})
