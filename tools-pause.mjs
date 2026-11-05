// 临时静音：接下来一段时间别主动找他（她安静，但不是被关掉）
//
//   node tools-pause.mjs                 看现在是不是暂停着
//   node tools-pause.mjs 开会             暂停，理由是「开会」（会写进日志）
//   node tools-pause.mjs 录音 mute-alarm  暂停，连她自己定的闹钟一起静音
//   node tools-pause.mjs --off           恢复
//
// 语义：
//   · 暂停的是「叫醒」——她不会再自己开口；你发消息时她照常回。
//   · 闹钟默认照响（那是她自己的约定）；文件里写 mute-alarm 才一起静音。
//   · 记着恢复。停太久她会以为你不见了——那是另一件事（冷落检测）。
//
// 也可以在别的脚本里直接 touch 文件，但用这个入口至少会写一行理由。

import { readPause, setPause, pauseLine, pausePath } from './dsh-fish/lib/pause.js'

const argv = process.argv.slice(2)

if (!argv.length) {
  const p = await readPause()
  console.log(pauseLine(p))
  if (p.paused) {
    const since = new Date(p.since).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    console.log(`  从 ${since} 起`)
  }
  console.log(`  文件：${pausePath()}`)
  console.log('\n  开：node tools-pause.mjs <理由>')
  console.log('  关：node tools-pause.mjs --off')
  process.exit(0)
}

if (argv[0] === '--off' || argv[0] === 'off') {
  await setPause(undefined, { on: false })
  console.log('✓ 已恢复：她可以再主动找你了')
  process.exit(0)
}

const reason = argv.join(' ').trim().slice(0, 80)
const r = await setPause(undefined, { on: true, reason })
console.log(`✓ 已暂停${r.reason ? `：${r.reason}` : ''}`)
console.log('  她不会再自己开口；你发消息时她照常回。')
if (!/mute-alarm/i.test(reason)) console.log('  她自己的闹钟照响（要一起静音就加 mute-alarm）。')
console.log('  恢复：node tools-pause.mjs --off')
