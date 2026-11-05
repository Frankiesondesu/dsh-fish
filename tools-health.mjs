// 记忆体检：她的判断里有没有矛盾、有没有冷掉、有没有该复查的自述
//
//   node tools-health.mjs          看报告
//   node tools-health.mjs --json   原始数据（给别的脚本用）
//
// 只读：拿账本按现在的规则算一遍，不写事件、不改配置、不落盘。
// 这份东西是给你看的——她本人在界面里看不到这些数（撞「不读自身数值」）。

import { readEvents, readConfig } from './dsh-fish/lib/store.js'
import { examine } from './dsh-fish/lib/health.js'

const argv = process.argv.slice(2)
const { config } = await readConfig()
const { events, skipped } = await readEvents()
const r = examine(events, { growthDays: config?.growthDays })

if (argv.includes('--json')) {
  console.log(JSON.stringify(r, null, 2))
  process.exit(0)
}

const line = (s = '') => console.log(s)
line('')
line(`  记忆体检 · ${r.events} 条记录 / ${r.days} 天`)
line('  ' + '─'.repeat(46))
line(`  判断 ${r.beliefs} 条，固化 ${r.solid} 条，淡掉 ${r.faded} 条`)
line(`  类型：${r.byType.map((x) => `${x.type} ${x.count}`).join(' · ')}`)
if (skipped) line(`  ⚠️ 账本里有 ${skipped} 行读不出来（写了一半 / 被截断）`)

const block = (title, rows, render, hint) => {
  line('')
  line(`  ${title}`)
  if (!rows.length) { line('    （没有）'); return }
  for (const x of rows) line('    · ' + render(x))
  if (hint) line(`    ↳ ${hint}`)
}

block(`对不上的话（${r.tensions.length}）`, r.tensions,
  (t) => `「${t.a.slice(0, 40)}」 ↔ 「${t.b.slice(0, 40)}」`,
  '两边她可能都还在坚持。要不要问，你定。')

block(`冷掉的判断（${r.stale.length}）`, r.stale,
  (b) => `${b.days} 天没提过：「${b.text.slice(0, 50)}」`,
  '没固化 + 很久没提，大概率正在被忘。')

block(`快固化的（${r.nearSolid.length}）`, r.nearSolid,
  (b) => `「${b.text.slice(0, 50)}」（提起 ${b.mentions} / 验证 ${b.verified}）`,
  '再被提起一次或检验一次就固定下来了。')

block(`可疑自述（${r.selfClaims.length}）`, r.selfClaims,
  (x) => `${x.type}：「${x.text}」`,
  '第一人称 + 反复动作（「我催了他一整天」）。这类句子被 recall 捞出来，会变成她"继续这么做"的动力。查一下事实对不对。')

line('')
