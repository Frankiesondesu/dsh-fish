/**
 * 附件统一「文件模式」（2026-11-06）。
 *
 * 历史：这个文件原来测「连发多张图分别落盘、单张直传、GIF 拼帧」。
 * 用户 11-06 改了口径：**他发的所有文件不论格式类型，全部存本地 +
 * 只告诉他 + 由她自己判断**。于是单张直传、抽帧、read_image 指路全部停用，
 * 图也并进 files。文件名留着当历史线索，断言已整套换成新口径。
 *
 * 真正的分类行为在 attachment.test.mjs 里直接测函数；这里守的是桥里的接线。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const src = await readFile(new URL('../bridge.mjs', import.meta.url), 'utf8')
const att = await readFile(new URL('../attachment.mjs', import.meta.url), 'utf8')

test('旧图片直传通路已停用', () => {
  assert.doesNotMatch(src, /if \(buf\) image = buf\.toString\('base64'\)/, '不再直传单张图')
  assert.doesNotMatch(src, /imgNote/, '不再有独立的图说明前缀')
  assert.doesNotMatch(src, /read_image 能打开它们/, '不再替她指工具')
})

test('所有附件走同一个 files 循环，全部落盘', () => {
  assert.match(src, /for \(const seg of files\) \{/, '不再 slice(0, 3)，全部处理')
  assert.match(src, /ensureExt\(nm, head, seg\?\._kind\)/, '落盘前补后缀')
  assert.match(src, /看不看、怎么处理，你自己定/, '判断权留给她')
})

test('不承诺「能打开」—— 对她说的话必须为真', () => {
  const handLine = src.split('\n').find((l) => l.includes('搁在你手边：') && l.includes('lines.push'))
  assert.ok(handLine, '要有「递过来一个文件」那句话')
  assert.doesNotMatch(handLine, /her_open/, '视频是二进制，her_open 会如实说读不出来')
  assert.match(att, /不承诺某个工具能打开/, '分类模块的口径注释也要在')
})

test('没后缀要按内容补，视频别落成无后缀文件', () => {
  assert.match(att, /s\(4, 8\) === 'ftyp'/, 'mp4 / mov 魔数')
  assert.match(att, /kind === 'video'\) return '\.mp4'/, '兜底按段类型给 .mp4')
  assert.match(att, /b\[0\] === 0xff && b\[1\] === 0xd8 && b\[2\] === 0xff/, 'jpg 魔数')
})

test('大文件走本机路径直接复制，不进内存', () => {
  assert.match(src, /function localSource/, '先 stat 判大小，不读内容')
  assert.match(src, /if \(srcPath\) copyFileSync\(srcPath, out\)/, '复制而不是 Buffer 往返')
  assert.match(src, /function sniffHead/, '只读 12 字节做魔数判断')
})

test('路径太多时如实说明没全列，但不是只存前几个', () => {
  assert.match(src, /savedCount > FILE_NOTE_MAX/, '超出才补一句说明')
  assert.match(src, /也存进收件箱了，路径没全列/, '说清是路径没列、不是文件没存')
})

test('取不到就如实说没到你手上，不假装存了', () => {
  assert.match(src, /没到你手上——QQ 没给下载地址/, '不许把「没拿到」说成「搁在你手边」')
})

test('合批窗口从第一个附件起算（发完文件补一句不拆两轮）', () => {
  assert.match(src, /if \(!p\.attachAt\) p\.attachAt = now/, '图归到 files 后窗口不能丢')
  assert.match(src, /hasImage: p\.attachAt > 0/, '仍沿用 batch-wait 的 10 秒规则')
})
