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
let CHECK = process.argv.includes('--check')
let TARGET = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? ''

// 2026-11-06：也认 `node restart.mjs 3` 这种数字写法（和菜单同一个编号）。
// 以前只认中文名，传 3 会被当成不认识的目标，连一项都关不掉。
if (/^[1-4]$/.test(TARGET)) {
  const n = TARGET
  TARGET = n === '2' ? '桥' : n === '3' ? 'DSH' : ''
  if (n === '4') CHECK = true
}

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
  // DSH 不占这两个端口（她的通路是动态端口，桥发消息前会自己重新发现）。
  // 2026-11-05 用户选 3 时踩到：脚本傻等了 30 秒，还报了两条根本不成立的警告。
  if (/^dsh$/i.test(target)) return []
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

const before = herBootAt()

out('')
out('  她 · 一键重启')
out('  ' + '─'.repeat(46))
if (process.argv.includes('--menu')) {
  const pick = await choose()
  if (pick === '2') TARGET = '桥'
  else if (pick === '3') TARGET = 'DSH'
  else if (pick === '4') CHECK = true
  else if (pick !== '1' && pick !== '') {
    // 2026-11-06（用户）：以前「没认出来」会静默走默认＝全部重启。
    // 他按全角「３」时整条链路被关了一次——宁可什么都不做，也不能按最危险的那个默认跑。
    out('')
    out('  ✗ 只认 1 / 2 / 3 / 4（直接回车＝全部重启）。什么都没动。')
    process.exit(2)
  }
  out('')
}
// 菜单选完才算得出来：只重启桥时不该去等 DSH 的 bootAt（否则白等 90 秒还报假警告）
const touchesDsh = !TARGET || /^dsh$/i.test(TARGET)
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

/**
 * 交互菜单。**故意写在 node 里，不写进 .cmd**——
 * .cmd 里放中文会被 cmd.exe 按 GBK 解析（UTF-8 的中文字节错位后变成
 * & | > 这类元字符，整行被拆成几条命令）。2026-11-05 用户双击时踩到：
 * 「'启' is not recognized as an internal or external command」。
 * node 输出天生 UTF-8，控制台 chcp 65001 之后中文正常。
 */
async function choose() {
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q) => new Promise((res) => rl.question(q, res))
  out('')
  out('  1. 全部重启    DSH + QQ + 桥 + 查看器')
  out('  2. 只重启桥    改完 bridge.mjs 用这个')
  out('  3. 只重启 DSH  改完插件代码用这个（fork 生效）')
  out('  4. 只看会关什么，不动手')
  out('')
  const raw = await ask('  选一个（1-4，直接回车=全部重启）：')
  rl.close()
  const ans = normPick(raw)
  // 回显：让他一眼看到脚本到底理解成了什么，别默默按默认跑完才发现不对
  const LABEL = { '1': '全部重启', '2': '只重启桥', '3': '只重启 DSH', '4': '只看会关什么（不动手）' }
  const what = ans === '' ? '全部重启（按了回车）' : (LABEL[ans] ?? `不认识：「${raw}」`)
  out(`  → 你选的是：${what}`)
  return ans
}

/**
 * 归一化菜单输入。2026-11-06 用户踩到：中文输入法下按 3，上屏的是全角「３」，
 * `pick === '3'` 不成立，脚本就静默走了「直接回车＝全部重启」——整条链路被关了一次。
 * 全角数字按 Unicode 规律减 0xFEE0 就是半角；顺手去掉空格和常见标点。
 */
function normPick(s) {
  return String(s ?? '')
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s.。、,，]/g, '')
}
