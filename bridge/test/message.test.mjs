/**
 * bridge.mjs 的消息段守卫（2026-11-05）。
 *
 * 为什么用「读源码」而不是 import：bridge.mjs 是个脚本，import 就会连 LLBot、
 * 起 HTTP 端口、挂文件监视——测试里不能那么干。
 *
 * 这条守卫是拿真事故换来的：加 `file` 段那天，`readMessage` 已经返回了 files，
 * 但 `handleMessage` 里还是 `const { text, atMe, images } = brief`，
 * 于是 `if (!text && !images.length && !files.length)` 一执行就
 * `ReferenceError: files is not defined`——文件消息整条被吞，日志里只有
 * 一行「处理消息出错」。全量测试全绿，因为桥根本没有测试。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const src = await readFile(new URL('../bridge.mjs', import.meta.url), 'utf8')

test('readMessage 的返回值里带 files', () => {
  assert.match(src, /return \{ text: text\.trim\(\), atMe, images, files \}/,
    'readMessage 必须把 files 一起返回，否则下游拿不到')
})

test('handleMessage 必须把 files 一起解构出来', () => {
  assert.match(src, /const \{ text, atMe, images, files \} = brief/,
    '漏解构 files → 一收到文件就 ReferenceError（2026-11-05 真踩过）')
})

test('「只有文件」的消息不能被当成空消息丢掉', () => {
  assert.match(src, /if \(!text && !images\.length && !files\.length\) \{/,
    '放行条件必须把 files 算进去，否则只发文件会被跳过')
  assert.match(src, /schedule\(ev, \{ text, images, files \}\)/,
    '合批入参也要带上 files')
})

test('文件段要被识别，并落到收件箱', () => {
  assert.match(src, /s\?\.type === 'file'/, 'readMessage 要收 file 段')
  assert.match(src, /home', 'inbox'/, '文件要落到 home/inbox（她的收件箱）')
  assert.match(src, /her_open/, '要告诉她用 her_open 打开')
})

/**
 * 第二次真事故（2026-11-05 06:45）：QQ **不把文件的下载直链放进消息里**。
 * 私聊 file 段只有 `{ file: '日历-课表.ics', file_id }`，地址得拿 file_id
 * 去调 OneBot 才换得出来。第一版只认 `url` 和绝对路径，于是两条都空，
 * 她那边收到「我没拿到——链接可能过期了」，收件箱里一个文件都没有。
 */
test('取文件要拿 file_id 去调 OneBot 的接口，不能只认 url', () => {
  assert.match(src, /\['get_file', \{ file_id: id \}\]/,
    'QQ 的 file 段没有直链，必须调 get_file 才换得到')
  assert.match(src, /get_private_file_url/, '私聊还要能走 get_private_file_url')
  assert.match(src, /get_group_file_url/, '群文件走 get_group_file_url')
  assert.match(src, /loadFileSeg\(seg, ev\)/,
    '调用点要把 ev 传进去（群/私聊的参数不一样）')
})

test('三种取值形式都要认：base64 / http / 本机路径', () => {
  assert.match(src, /base64:\/\//, 'get_file 常常返回 base64://')
  assert.match(src, /data:/, 'data:…;base64, 也要认')
  assert.match(src, /\^https\?:/, 'http 链接')
})

test('取不到时要把段内容写进日志', () => {
  assert.match(src, /段内容：\$\{JSON\.stringify\(d\)/,
    '不写段内容，下次还得靠猜该加哪个字段')
  assert.match(src, /取文件失败（/, '失败要留一行明确的日志')
})

test('文件大小上限仍然生效', () => {
  assert.match(src, /FILE_MAX_BYTES = 32 \* 1024 \* 1024/, '32MB 上限')
  assert.match(src, /function withinLimit/, '超限要走统一的检查')
})
