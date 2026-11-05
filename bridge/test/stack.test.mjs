/**
 * 连发多张图（2026-11-05）。
 *
 * 用户发现的：连着发两张，她只读到第一张。
 * 根因不在识别——`readMessage` 收图是收全部（images 是数组）；
 * 卡在两条都是一张的通道上：
 *   · 桥的 fishSay(text, image) 只传一个；
 *   · 插件 /local/say 的 body.image 是单数，落盘成一个路径。
 *
 * 所以要么分两轮递（她会回两次话，中间还可能插别的），
 * 要么拼成一张。选了拼——她能一次看到、能对比，插件一个字不用改。
 *
 * 拼不动 / 超 6MB / 没装 ffmpeg 时退回第一张，并在话里说清还有几张没看到。
 * 静默只发第一张是这次要钉死的老毛病。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const src = await readFile(new URL('../bridge.mjs', import.meta.url), 'utf8')

test('多图拼成一张，用 ffmpeg 的 vstack', () => {
  assert.match(src, /function stackImages\(bufs/, '要有拼图函数')
  assert.match(src, /vstack=inputs=\$\{files\.length\}/, '竖着摞，不是横着')
  assert.match(src, /scale=\$\{width\}:-2/, '统一宽度（-2 保证偶数，否则 yuv420 会挂）')
  assert.match(src, /format=rgb24/, '统一像素格式，vstack 要求一致')
})

test('输出 jpg 不用 png：聊天截图拼起来会顶到 6MB', () => {
  assert.match(src, /fish-stack-\$\{tag\}\.jpg/, '输出 jpg')
  assert.match(src, /'-q:v', '3'/, '质量 3，够看清字又不至于太大')
})

test('拼完要检查大小，超了退回', () => {
  assert.match(src, /out\.length > IMAGE_MAX_BYTES/, '超过通路上限就别发')
})

test('多图走拼接分支，不是只取第一张', () => {
  assert.match(src, /for \(const seg of images\.slice\(0, STACK_MAX\)\)/, '要循环取多张')
  assert.match(src, /if \(bufs\.length > 1\) \{[\s\S]{0,120}stackImages\(bufs\)/, '两张以上才拼')
  assert.match(src, /她的通路一轮只收一张图/, '注释要写清为什么拼')
})

test('拼不动要说出来，不能静默只发第一张', () => {
  assert.match(src, /只递过来第一张/, '失败时的措辞')
  assert.match(src, /拼成一张：从上往下第 1 到第 \$\{bufs\.length\} 张/, '成功时要告诉她怎么读')
  assert.match(src, /另外还有 \$\{images\.length - bufs\.length\} 张/, '超过 STACK_MAX 的部分要说清')
})

test('拼图的说明要递进她这一轮的话里', () => {
  assert.match(src, /fishSay\(imgNote \+ fwdNote \+ fileNote \+ text, image\)/,
    '算出来不拼进去等于没做；顺序是 图说明 → 转发 → 文件 → 他说的话')
})

test('动图那条路不受影响：只在单张时走', () => {
  assert.match(src, /bufs\.length === 1 && isGif\(buf\)/,
    '多图已经拼过了，不要再套一层 GIF 抽帧')
})

test('一次最多四张', () => {
  assert.match(src, /const STACK_MAX = 4/, '再多每张都会小到看不清字')
  assert.match(src, /const STACK_WIDTH = 720/, '720 宽够看清聊天截图里的字')
})
