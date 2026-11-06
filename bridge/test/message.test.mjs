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
const att = await readFile(new URL('../attachment.mjs', import.meta.url), 'utf8')

test('readMessage 的返回值里带 files / forwards', () => {
  // 11-06：分类搬到 attachment.mjs，readMessage 只负责包一层 raw_message 兜底
  assert.match(src, /return \{ text, atMe, images, files, forwards, audios \}/,
    'readMessage 必须把 files / forwards / audios 一起返回，否则下游拿不到')
  assert.match(src, /classifySegments\(ev\.message, ev\.self_id\)/, '分类要交给独立模块')
})

test('handleMessage 必须把 files / forwards 一起解构出来', () => {
  assert.match(src, /const \{ text, atMe, images, files, forwards = \[\], audios = \[\] \} = brief/,
    '漏解构 → 一收到这类消息就 ReferenceError（2026-11-05 真踩过）')
})

test('「只有文件 / 只有转发」的消息不能被当成空消息丢掉', () => {
  assert.match(src, /if \(!text && !images\.length && !files\.length && !forwards\.length && !audios\.length\) \{/,
    '放行条件必须把 files 和 forwards 算进去，否则只发文件/只转记录会被跳过')
  assert.match(src, /schedule\(ev, \{ text, images, files, forwards, audios \}\)/,
    '合批入参也要带上 files / forwards')
})

test('所有附件不论格式，统一进 files / 落到收件箱', () => {
  // 11-06 真机事故：video 段没人接，整条被丢。改成按数据形态认附件。
  assert.match(att, /KNOWN_ATTACHMENT = new Set\(\['image', 'mface', 'video', 'file', 'flash'\]\)/,
    '图 / 视频 / 文件都在已知附件里')
  assert.match(att, /isAttachment\(s\)\) files\.push/, '按数据形态判定，不靠段名白名单')
  assert.match(src, /home', 'inbox'/, '统一落到 home/inbox（她的收件箱）')
  assert.match(src, /看不看、怎么处理，你自己定/, '只给事实，判断权留给她')
  // 转发落盘的 txt 那句仍写着 her_open 能打开（那是真的），这里只钉「递文件」这句
  const handLine = src.split('\n').find((l) => l.includes('搁在你手边：') && l.includes('lines.push'))
  assert.ok(handLine, '要有「递过来一个文件」那句话')
  assert.doesNotMatch(handLine, /her_open/, '统一文件模式不再承诺能打开（fork.13）')
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

test('文件大小上限对视频放宽，但仍然生效', () => {
  // 11-06：32MB 会把绝大多数视频挡在门外，默认改 512MB、可在 config.json 调
  assert.match(src, /fileMaxBytes: 512 \* 1024 \* 1024/, '默认 512MB')
  assert.match(src, /const FILE_MAX_BYTES = Number\(cfg\.fileMaxBytes\)/, '可配置')
  assert.match(src, /function withinSize/, '超限要走统一的检查')
  assert.match(src, /if \(srcPath\) copyFileSync\(srcPath, out\)/, '本机路径直接复制，大视频不进内存')
})
