/**
 * her_meme（fork.53，2026-11-05）。
 *
 * 起因：她说话没有人味。翻了一遍她的表达通道——只有文字和语音，一个表情都没有。
 * 人不靠形容词表达情绪，靠一张图。
 *
 * 设计上有两条故意：
 *   · **工具，不是管道**：不按概率自动配图（那是替她决定"这句该配什么脸"）
 *   · **挑图规则越笨越好**：文件名含情绪词就优先，否则随机。不打分、不学偏好
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { pickMeme } from '../lib/meme.js'

const names = ['开心.png', '无语-1.gif', '生气.jpg', '委屈.webp', '说明.txt']

test('只认图片，文本文件不算表情', () => {
  const r = pickMeme(['说明.txt'], '开心')
  assert.equal(r, null)
})

test('空目录 → null（她还没有表情包）', () => {
  assert.equal(pickMeme([], '开心'), null)
  assert.equal(pickMeme(undefined, '开心'), null)
})

test('文件名里有这个情绪 → 优先挑它', () => {
  const r = pickMeme(names, '无语', () => 0)
  assert.equal(r.pick, '无语-1.gif')
  assert.match(r.why, /名字里有「无语」/)
})

test('没有匹配的情绪 → 随机，但要说清楚是随机', () => {
  const r = pickMeme(names, '震惊', () => 0)
  assert.equal(r.pick, '开心.png', 'rand()=0 取第一张')
  assert.match(r.why, /没有「震惊」的/)
})

test('不给情绪 → 随机', () => {
  const r = pickMeme(names, '', () => 0.99)
  assert.ok(r.pick.endsWith('.webp'), 'rand ≈ 1 取最后一张')
  assert.match(r.why, /随便/)
})

test('大小写不敏感，且能匹配到带后缀的名字', () => {
  const r = pickMeme(['Happy.png', 'SAD.jpg'], 'happy', () => 0)
  assert.equal(r.pick, 'Happy.png')
})

test('同一个词命中多张时随机取（不是永远第一张）', () => {
  const many = ['开心1.png', '开心2.png', '开心3.png']
  const picks = new Set([0, 0.4, 0.8].map((v) => pickMeme(many, '开心', () => v).pick))
  assert.equal(picks.size, 3, '三个随机值应落到三张不同的图上')
})

test('工具注册了，而且写的是 meta 不是 utterance', async () => {
  const src = await fs.readFile(new URL('../lib/meme.js', import.meta.url), 'utf8')
  assert.match(src, /name: 'her_meme'/, '工具名')
  assert.match(src, /text: `meme:\$\{file\}/, '写 meta `meme:<路径>|<情绪>`，桥才认')
  assert.match(src, /MEME_MAX_BYTES/, '要有大小上限，否则 QQ 发不出去')
})
