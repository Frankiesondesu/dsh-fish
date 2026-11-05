/**
 * 连发多张图（2026-11-05，第二次改）。
 *
 * 第一版是拼成一张递过去，用户否了：**不要拼接**，分别存到本地让她自己处理。
 *
 * 理由比第一版更硬：拼接会把两件不同的事压进一张图，分辨率还打折；
 * 而她的 read_image 本来就是一次读一张——「给你几个路径，你自己决定看哪张」
 * 才是这套系统本来的做法（跟文件、聊天记录一个路子）。
 *
 * 单张不动：照旧直传，她抬眼就看见。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const src = await readFile(new URL('../bridge.mjs', import.meta.url), 'utf8')

test('多张不拼接：拼图那条路已经拆掉', () => {
  assert.doesNotMatch(src, /vstack/, '不再用 ffmpeg 拼图')
  assert.doesNotMatch(src, /function stackImages/, '拼图函数应当已删除')
})

test('多张分别落盘，路径列给她', () => {
  assert.match(src, /for \(const seg of images\.slice\(0, MULTI_IMAGE_MAX\)\)/, '要循环取多张')
  assert.match(src, /saveInbox\(`图-\$\{stamp\}-\$\{i \+ 1\}\$\{ext\}`, b\)/, '每张单独落盘')
  assert.match(src, /lines\.push\(` \$\{i \+ 1\}\. \$\{saved\.path\}（/, '一条一行路径，带序号')
})

test('要告诉她自己怎么读，以及可以不读', () => {
  assert.match(src, /看哪张、看不看，你自己定/, '要留出"不看"的许可，否则她会以为必须看')
})

test('多张时不直传，避免她只盯着第一张', () => {
  assert.match(src, /buf = null \/\/ 多张时不直传，全走路径/, '多张必须清掉直传那张')
})

test('单张照旧直传（没被这次改动波及）', () => {
  assert.match(src, /bufs\.length === 1 && isGif\(buf\)/, 'GIF 处理仍然只在单张时走')
  assert.match(src, /if \(buf\) image = buf\.toString\('base64'\)/, '单张仍然直传')
})

test('一次最多记六张，其余说清没带', () => {
  assert.match(src, /const MULTI_IMAGE_MAX = 6/, '再多，那一轮的话就全是路径了')
  assert.match(src, /另外还有 \$\{images\.length - bufs\.length\} 张/, '没带的要说出来')
})

test('这些路径要真的进到这一轮的话里', () => {
  assert.match(src, /fishSay\(imgNote \+ fwdNote \+ fileNote \+ text, image\)/,
    '顺序：图路径 → 转发 → 文件 → 他说的话')
})

test('扩展名按内容认，不一律写 .jpg', () => {
  assert.match(src, /isGif\(b\) \? '\.gif'/, 'GIF 要保住 .gif（她能当动图理解）')
  assert.match(src, /b\[0\] === 0x89 && b\[1\] === 0x50/, 'PNG 用魔数认，不看段里的名字')
})
