/**
 * 合并转发的聊天记录（2026-11-05）。
 *
 * 用户问「她能读到我转发的群聊记录吗」，答案是不能——桥只认
 * text/at/image/mface/file，`forward` 段没人接，整条消息在放行条件那里
 * 就被当成「既没文字也没图」丢掉了，日志里只有一行跳过。
 *
 * 跟 file 段是同一个坑：**消息里放的是句柄，不是内容**。
 * 转发段只有 `{type:'forward', data:{id}}`，正文要拿 id 调 get_forward_msg。
 *
 * 这里仍然用「读源码」而不是 import：bridge.mjs 是脚本，import 就会连 LLBot、
 * 起端口、挂文件监视（见 message.test.mjs 开头那段说明）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const src = await readFile(new URL('../bridge.mjs', import.meta.url), 'utf8')

test('forward / node 段要被识别', () => {
  assert.match(src, /s\?\.type === 'forward' \|\| s\?\.type === 'node'/,
    '两个名字都要认：OneBot 11 是 forward，老实现常见 node')
  assert.match(src, /forwards\.push\(s\)/, '要收进 forwards 列表')
})

test('正文要拿 id 去调 get_forward_msg，不能指望消息里自带', () => {
  assert.match(src, /sendAction\('get_forward_msg', \{ id \}\)/,
    'QQ 的转发段只有 id，正文必须换')
  assert.match(src, /取聊天记录失败/, '失败要留一行明确日志，不能静默')
  assert.match(src, /段内自带|data\?\.content \?\? seg\?\.data\?\.message/,
    '少数实现会把内容直接塞进段里，也要认')
})

test('渲染成「昵称：内容」，图片/语音/嵌套转发要有记号', () => {
  assert.match(src, /m\?\.sender\?\.card \|\| m\?\.sender\?\.nickname/,
    '优先用群名片，退昵称')
  assert.match(src, /\[图片\]/, '图片要留记号，否则她以为那句话只有半截')
  assert.match(src, /\[语音\]/)
  assert.match(src, /\[又一层转发\]/, '嵌套转发不能当成正文')
  assert.match(src, /\[文件/, '文件段也要标记')
})

test('短的直接贴、长的落盘给路径（上下文不能被一段群聊吃光）', () => {
  assert.match(src, /FORWARD_INLINE_MAX = 3000/, '门槛写死在常量里，方便以后调')
  assert.match(src, /body\.length <= FORWARD_INLINE_MAX/, '短的走内联')
  assert.match(src, /聊天记录-\$\{stamp\}\.txt/, '长的落成 txt')
  assert.match(src, /想看得调 her_open/, '要说清怎么读——她只有这一个开文件的口')
})

test('只转发不写字也是合法消息（不能只放行 files）', () => {
  assert.match(src, /!forwards\.length\) \{[\s\S]{0,80}这条既没文字也没图/,
    '放行条件漏掉 forwards，整条转发会被静默丢掉——这次要钉死')
})

test('fetch 回来的东西要真的进到这一轮的话里', () => {
  assert.match(src, /const fwdNote = await forwardNote\(forwards\)/,
    '算出来不拼进去等于没做')
  assert.match(src, /fishSay\(imgNote \+ fwdNote \+ fileNote \+ text, image\)/,
    '顺序：图说明 → 转发 → 文件 → 他说的话')
})

test('合批窗口要带上 forwards，且一次不处理太多段', () => {
  assert.match(src, /part\.forwards\?\.length\) p\.forwards\.push/, '合批要带上')
  assert.match(src, /FORWARD_MAX_SEGS = 2/, '连着转好几段时只处理前两段')
})
