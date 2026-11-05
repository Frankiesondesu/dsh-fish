// 账本指纹：证明「这四天是一条连续的路」，不是一条被谁改过的记录
//
//   node tools-ledger.mjs            校验（默认）
//   node tools-ledger.mjs --line     只打一行，给体检/定时任务用
//   node tools-ledger.mjs --init     第一次建指纹
//   node tools-ledger.mjs --sync     把新写的事件补进指纹（老记录绝不覆盖）
//
// 退出码：0 = 账本和指纹对得上；1 = 有问题（丢了/被改过/有坏行/没建指纹）
//
// 它管什么、不管什么：管「写进账本之后有没有被动过」；
// 不管「写进去之前是不是她的原话」——后者靠只搬原话的纪律，哈希管不了。

import {
  verifyLedger, initLedger, syncLedger, ledgerLine, ledgerPath,
} from './dsh-fish/lib/ledger.js'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)

function printIssues(r) {
  if (r.missing.length) {
    console.log(`\n丢了 ${r.missing.length} 条（指纹里有、账本里没有）：`)
    for (const m of r.missing.slice(0, 10)) console.log(`  - ${m.id}  ${m.len} 字`)
    if (r.missing.length > 10) console.log(`  …还有 ${r.missing.length - 10} 条`)
  }
  if (r.changed.length) {
    console.log(`\n被改过 ${r.changed.length} 条（哈希对不上）：`)
    for (const c of r.changed.slice(0, 10)) {
      const len = c.wasLen === c.nowLen ? `${c.wasLen} 字（长度没变，改的是字）` : `${c.wasLen} 字 → ${c.nowLen} 字`
      console.log(`  - ${c.id}  ${len}`)
      console.log(`    「${c.preview}」`)
    }
    if (r.changed.length > 10) console.log(`  …还有 ${r.changed.length - 10} 条`)
  }
  if (r.bad.length) {
    console.log(`\n有 ${r.bad.length} 行读不出来（写了一半 / 被截断）：`)
    for (const b of r.bad.slice(0, 10)) console.log(`  - 第 ${b.line} 行：${b.why}`)
    if (r.bad.length > 10) console.log(`  …还有 ${r.bad.length - 10} 行`)
  }
  if (r.extra.length) {
    console.log(`\n新写 ${r.extra.length} 条还没进指纹（正常，--sync 一下就好）`)
  }
}

if (has('--init')) {
  const r = await initLedger(undefined, { force: has('--force') })
  if (!r.ok) {
    console.log(`✗ ${r.note}`)
    process.exit(1)
  }
  console.log(`✓ 指纹已建：${r.total} 条，${(r.bytes / 1024).toFixed(1)}KB 账本`)
  if (r.bad) console.log(`  注意：账本里已有 ${r.bad} 行读不出来，它们没进指纹`)
  console.log(`  文件：${ledgerPath()}`)
  process.exit(0)
}

if (has('--sync')) {
  const r = await syncLedger()
  if (!r.ok) {
    console.log(`✗ ${r.note || '同步失败'}`)
    process.exit(1)
  }
  console.log(r.created
    ? `✓ 没有旧指纹，顺手建了：${r.total} 条`
    : `✓ 补了 ${r.added} 条，指纹共 ${r.total} 条`)
  if (r.conflict?.length) {
    console.log(`  但 ${r.conflict.length} 条 id 已存在而内容不同（没覆盖）：`)
    for (const id of r.conflict.slice(0, 10)) console.log(`    - ${id}`)
    console.log('  这几条跑一次校验看看——要么是被改过，要么是 id 撞了。')
    process.exit(1)
  }
  process.exit(0)
}

const r = await verifyLedger()

if (has('--line')) {
  console.log(`[ledger] ${ledgerLine(r)}`)
  process.exit(r.ok ? 0 : 1)
}

if (!r.initialized) {
  console.log(`✗ ${r.note}`)
  console.log('  先跑一次：node tools-ledger.mjs --init')
  process.exit(1)
}

if (r.ok) {
  console.log(`✓ 账本对得上：${r.total} 条，指纹 ${r.fingerprinted} 条`)
  if (r.extra.length) console.log(`  （有 ${r.extra.length} 条新写的还没进指纹，--sync 一下）`)
  process.exit(0)
}

console.log(`✗ 账本和指纹对不上（${r.total} 条 / 指纹 ${r.fingerprinted} 条）`)
printIssues(r)
console.log('\n怎么处理：')
console.log('  · 只是新写了事件 → node tools-ledger.mjs --sync')
console.log('  · 真有 missing/changed → 先查是谁动的（备份、回填、合并？），别急着 --force')
console.log('  · 确认是合法迁移 → node tools-ledger.mjs --init --force 重建基线')
process.exit(1)
