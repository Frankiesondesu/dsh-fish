/**
 * restart.mjs —— 一键重启（2026-11-05）
 *
 * 和 launch / shutdown 是一组：launch 负责拉起、shutdown 负责收干净、
 * 这个只做一件事——把前两个按正确顺序串起来，并在中间**等到达成条件**。
 *
 * 为什么不能直接 shutdown && launch：
 *   ① 端口不是进程一死就空出来的。taskkill 返回了，6199 可能还在 TIME_WAIT，
 *      新桥 bind 会 EADDRINUSE，然后就变成「重启完桥没了」。
 *   ② DSH 是 Electron，进程起来 ≠ 插件加载完。她那条会话要等 dsh-fish 注册好
 *      才能说话，而这件事只有一个可观察的信号：instance.json 的 bootAt 变新。
 *
 * 用法：
 *   node restart.mjs             全部重启（关整条链路 → 再拉起来）
 *   node restart.mjs 桥           只重启桥（改完桥最常用）
 *   node restart.mjs DSH          只重启 DSH（改完插件代码，让 fork 生效）
 *   node restart.mjs 查看器       只重启查看器（纯前端，改完不用碰别的）
 *   node restart.mjs --check      只说明会关什么、起什么，不动手
 *
 * 为什么只重启桥是安全的：桥不是启动时记住端口就完了——它每次发消息前都会
 * 重新确认（discoverPort），缓存的端口不通就重扫。所以 DSH 先起后起都不影响。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const NODE = process.execPath
const CHECK = process.argv.includes('--check')
const TARGET = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? ''

const out = (...a) => console.log(...a)

function runNode(script, args) {
  try {
    execFileSync(NODE, [script, ...args], { stdio: 'inherit', cwd: HERE })
    return true
  } catch (err) {
    out(`  ✗ ${script} 没跑通：${err?.message ?? err}`)
    return false
  }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port, timeout: 500 })
    const done = (v) => { try { s.destroy() } catch { /* ignore */ } resolve(v) }
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    s.once('timeout', () => done(false))
  })
}

async function waitUntil(fn, ms, step = 500) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return Date.now() - t0
    await sleep(step)
  }
  return 0
}

/** 只重启某一项时，要等的端口不一样。 */
function portsFor(target) {
  if (target === '桥') return [6199]
  if (target === '查看器') return [7788]
  return [6199, 7788]
}

/** 她那条会话的就绪信号：插件启动时写进 instance.json 的 bootAt。 */
function herBootAt() {
  try {
    const p = join(process.env.USERPROFILE ?? '', '.dsh-fish', 'instance.json')
    if (!existsSync(p)) return 0
    return Number(JSON.parse(readFileSync(p, 'utf8'))?.bootAt ?? 0)
  } catch {
    return 0
  }
}

const touchesDsh = !TARGET || /^dsh$/i.test(TARGET)
const before = herBootAt()

out('')
out('  她 · 一键重启')
out('  ' + '─'.repeat(46))
if (TARGET) out(`  只重启：${TARGET}`)

if (CHECK) {
  out('')
  out('  [体检] 现在在跑什么、会被关掉什么：')
  runNode(join(HERE, 'shutdown.mjs'), ['--check', ...(TARGET ? [TARGET] : [])])
  out('')
  out('  （--check 只列清单，什么都没动。真重启去掉 --check）')
  process.exit(0)
}

// 1) 关
out('')
out('  [1/3] 关')
if (!runNode(join(HERE, 'shutdown.mjs'), ['--yes', ...(TARGET ? [TARGET] : [])])) {
  out('  ✗ 关都没关干净，不再往下起（半开半关比不重启更糟）')
  process.exit(1)
}

// 2) 等端口真的让出来
out('')
out('  [2/3] 等端口让出来')
let portsOk = true
for (const p of portsFor(TARGET)) {
  const ms = await waitUntil(async () => !(await portOpen(p)), 15_000)
  if (ms) out(`  ✅ ${p} 已空出（${(ms / 1000).toFixed(1)}s）`)
  else {
    portsOk = false
    out(`  ⚠️ ${p} 还占着 15 秒——继续起，但新桥可能会 bind 失败`)
  }
}

// 3) 起
out('')
out('  [3/3] 起')
if (!runNode(join(HERE, 'launch.mjs'), [])) {
  out('  ✗ 启动器报错，下面自查')
  process.exit(1)
}

// 4) 验证：端口 + （如果动了 DSH）她那条会话是否真的加载完
out('')
out('  验证')
await sleep(2000)
for (const p of portsFor(TARGET)) {
  const open = await portOpen(p)
  out(open ? `  ✅ ${p} 在听` : `  ❌ ${p} 没起来`)
  if (!open) portsOk = false
}

if (touchesDsh) {
  out('  等 DSH 把插件加载完（她那边的 bootAt 会变新）…')
  const ms = await waitUntil(() => herBootAt() > before, 90_000, 2000)
  if (ms) {
    out(`  ✅ 她已经醒着（${(ms / 1000).toFixed(0)}s）`)
  } else {
    out('  ⚠️ 90 秒内没等到她的 bootAt 变新。')
    out('     可能 DSH 还没加载完，或插件启动失败——看 ~/.dsh-fish/logs/dsh-fish.log 最后几行。')
    portsOk = false
  }
} else {
  out('  （没动 DSH，她不用重新加载；桥会自己重新认端口）')
}

out('')
out(portsOk ? '  ✅ 重启完成' : '  ⚠️ 重启完成，但有上面几条没到位')
out('')
out('  下一步：')
if (touchesDsh) out('    · 她那边刚醒，头几句可能还在加载，等半分钟再说话')
out('    · 体检：node launch.mjs --check')
out('    · 只想关：node shutdown.mjs --check')
out('')
process.exit(portsOk ? 0 : 1)
