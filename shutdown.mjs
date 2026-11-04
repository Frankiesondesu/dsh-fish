/**
 * shutdown.mjs —— 把这条链路彻底关掉（2026-11-02）
 *
 * 和 launch.mjs 是一对：那个负责拉起来，这个负责收干净。
 *
 * 关的顺序有讲究（反着启动顺序来）：
 *   1. 桥        —— 先断 QQ 那条线，免得它还在推话/等回话时下游已经没了
 *   2. 查看器    —— 只读，随时可关
 *   3. ASR       —— 本地听写服务，先请它自己退出，不行再杀
 *   4. LuckyLillia —— QQ 客户端，杀进程树（llbot / PMHQ 都是它的子进程）
 *   5. DSH       —— 她的宿主，最后关：关掉就等于她这一觉睡下去了
 *
 * 每个目标先**好好请它退**（taskkill 不带 /F），几秒还没走再强杀。
 * DSH 是 Electron，硬杀容易留一个半死的托盘图标。
 *
 * 用法：
 *   node shutdown.mjs          问一句再关
 *   node shutdown.mjs --yes    不问，直接关
 *   node shutdown.mjs --check  只列清单，什么都不关
 *   node shutdown.mjs 桥       只关这一个（改完桥想单独重启时用）
 */

import { execFileSync } from 'node:child_process'
import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本脚本所在目录 —— 认进程全靠它拼出来的绝对路径（见 collect 里的 SELF） */
const HERE = dirname(fileURLToPath(import.meta.url))

const CHECK_ONLY = process.argv.includes('--check')
const YES = process.argv.includes('--yes') || process.argv.includes('-y')
// 位置参数里不是 -- 开头的那个，当「只关这一个」的名字（桥 / 查看器 / ASR / LuckyLillia / DSH）
const ONLY = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? ''

const out = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- 列进程

/** 一次把全机进程名 + 命令行拿回来（wmic 在新系统上没了，走 CIM） */
function listProcesses() {
  const ps = [
    'Get-CimInstance Win32_Process |',
    'Select-Object ProcessId,ParentProcessId,Name,CommandLine |',
    'ConvertTo-Json -Compress',
  ].join(' ')
  let raw = ''
  try {
    raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (err) {
    out(`  ⚠️ 读不到进程列表：${err?.message ?? err}`)
    return []
  }
  let arr
  try {
    arr = JSON.parse(raw)
  } catch {
    return []
  }
  const list = Array.isArray(arr) ? arr : arr ? [arr] : []
  return list
    .filter((p) => p && p.ProcessId)
    .map((p) => ({
      pid: Number(p.ProcessId),
      ppid: Number(p.ParentProcessId ?? 0),
      name: String(p.Name ?? ''),
      cmd: String(p.CommandLine ?? ''),
    }))
}

/** 某个端口上 LISTENING 的 PID（拿不到就 0） */
function portPid(port) {
  try {
    const outText = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true })
    for (const raw of outText.split('\n')) {
      const m = raw.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i)
      if (!m) continue
      if (Number(m[2]) !== Number(port)) continue
      if (!/^(127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\])$/.test(m[1])) continue
      return Number(m[3])
    }
  } catch { /* 拿不到就当没有 */ }
  return 0
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port })
    const done = (v) => {
      s.destroy()
      resolve(v)
    }
    s.setTimeout(400)
    s.once('connect', () => done(true))
    s.once('timeout', () => done(false))
    s.once('error', () => done(false))
  })
}

// ---------------------------------------------------------------- 目标清单

/**
 * 找齐要关的东西。每个目标：名字、PIDs、怎么关。
 *
 * 只按**命令行特征 + 端口**认，不按 "node.exe" 一刀切——
 * 这台机器上还跑着别的东西（MCP 服务、WorkBuddy 自己的进程），误杀很麻烦。
 */
async function collect() {
  const procs = listProcesses()
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const targets = []
  const notes = [] // 认出来但没动的（比如端口被别的程序占了），给用户看

  /**
   * 判据一律是**绝对路径**，不是文件名。
   *
   * 这台机器上有 10 个 node 进程（WorkBuddy 的 MCP 服务、别的项目），
   * 按 "node.exe" 一刀切等于乱杀；按文件名（bridge.mjs）也不够——
   * 别的项目里也可能有个同名脚本。所以只认本仓库下这几个绝对路径。
   */
  const norm = (s) => String(s ?? '').replace(/\\/g, '/').toLowerCase()
  const SELF = {
    bridge: norm(join(HERE, 'bridge', 'bridge.mjs')),
    viewer: norm(join(HERE, 'viewer', 'viewer.mjs')),
    llDir: norm(join(HERE, 'runtime', 'LL')),
  }

  /** 命令行里带着这个绝对路径的进程 */
  const byPath = (absPath) => procs.filter((p) => norm(p.cmd).includes(absPath))

  /**
   * 端口兜底：只在「命令行读不到」时用（提权进程的 CommandLine 可能为空）。
   * 而且必须确认占着端口的确实是同类进程——不然端口被别人占了，我们就成了
   * 「杀一个无辜程序来腾端口」。认不出就只报告，不动手。
   */
  const byPort = (port, kindRe, label) => {
    const pid = portPid(port)
    if (!pid) return []
    const p = byPid.get(pid)
    if (!p) {
      notes.push(`端口 ${port} 被 PID ${pid} 占着，读不到它的信息，没动`)
      return []
    }
    if (!kindRe.test(p.name)) {
      notes.push(`端口 ${port} 被 ${p.name}(${pid}) 占着，不是${label}，没动`)
      return []
    }
    return [pid]
  }

  // 1) 桥
  const bridge = new Set(byPath(SELF.bridge).map((p) => p.pid))
  for (const pid of byPort(6199, /node(\.exe)?$/i, '桥')) bridge.add(pid)
  targets.push({ key: '桥', pids: [...bridge], note: 'QQ ⇄ 她 的转发', why: `命令行指向 ${SELF.bridge}` })

  // 2) 查看器
  const viewer = new Set(byPath(SELF.viewer).map((p) => p.pid))
  for (const pid of byPort(7788, /node(\.exe)?$/i, '查看器')) viewer.add(pid)
  targets.push({ key: '查看器', pids: [...viewer], note: '人格/行动查看器', why: `命令行指向 ${SELF.viewer}` })

  // 3) ASR：本地听写（python），端口 18765
  //    只认 .dsh 下那套 asr-server：机器上别的 python 服务（比如 SolidworksMCP 的
  //    solidworks_mcp_server.py）也带 "server.py"，宽匹配会误杀别人的工具
  const asr = new Set(
    procs.filter((p) => /python(w)?(\.exe)?$/i.test(p.name) && /asr-server/i.test(p.cmd)).map((p) => p.pid),
  )
  for (const pid of byPort(18765, /python(w)?(\.exe)?$/i, 'ASR')) asr.add(pid)
  targets.push({
    key: 'ASR',
    pids: [...asr],
    note: '本地听写（18765）',
    why: '命令行里带 asr-server',
    http: 'http://127.0.0.1:18765/shutdown',
  })

  // 4) LuckyLillia / 5) DSH：都是唯一命名的桌面程序，按进程名认。
  //    LuckyLillia 额外要求路径在本仓库 runtime/LL 下——万一别处装了同名程序不会误杀。
  //    Electron（DSH）是一串同名进程，只杀**根**那个（父进程不是自己人），带 /T 一次带走全部。
  const rootsOf = (pred) => {
    const same = new Set(procs.filter(pred).map((p) => p.pid))
    return procs.filter(pred).filter((p) => !same.has(p.ppid)).map((p) => p.pid)
  }

  const llAll = procs.filter((p) => /^LuckyLillia(\.exe)?$/i.test(p.name))
  const llMine = llAll.filter((p) => norm(p.cmd).includes(SELF.llDir))
  const llOthers = llAll.filter((p) => !norm(p.cmd).includes(SELF.llDir))
  for (const p of llOthers) notes.push(`LuckyLillia(${p.pid}) 不在本仓库 runtime/LL 下，没动`)
  targets.push({
    key: 'LuckyLillia',
    pids: rootsOf((p) => llMine.includes(p)),
    note: 'QQ 客户端（含 llbot/PMHQ）',
    why: `路径在 ${SELF.llDir}`,
    tree: true,
  })

  targets.push({
    key: 'DSH',
    pids: rootsOf((p) => /^DeepSeek Harness(\.exe)?$/i.test(p.name)),
    note: '她的宿主（关掉＝她睡下）',
    why: '进程名 DeepSeek Harness.exe',
    tree: true,
  })

  // 顺带认一下「孤儿」：桥/查看器被杀后可能留下的 node 子进程（父进程已经不在的）
  const targeted = new Set(targets.flatMap((t) => t.pids))
  const orphans = procs.filter(
    (p) =>
      /node(\.exe)?$/i.test(p.name) &&
      (norm(p.cmd).includes(SELF.bridge) || norm(p.cmd).includes(SELF.viewer)) &&
      p.pid !== process.pid &&
      !byPid.has(p.ppid) &&
      !targeted.has(p.pid),
  )

  return { targets, orphans, notes }
}

// ---------------------------------------------------------------- 关

function alive(pid) {
  try {
    const s = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true })
    return s.includes(String(pid))
  } catch {
    return false
  }
}

function taskkill(pid, { force = false, tree = false } = {}) {
  const args = ['/PID', String(pid)]
  if (tree) args.push('/T')
  if (force) args.push('/F')
  try {
    execFileSync('taskkill', args, { encoding: 'utf8', windowsHide: true, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** 先好好请它退，还不走就强杀。
 *
 *  为什么先试温和的：DSH 是 Electron，硬杀容易留个半死的托盘图标；窗口程序收到
 *  WM_CLOSE 会自己收拾干净。
 *  为什么温和失败就立刻强杀：控制台程序（node / python）没有窗口可关，
 *  taskkill 不带 /F 会直接报错——那就别白等，马上强杀。
 */
async function stopOne(pid, { tree = false, waitMs = 3000 } = {}) {
  if (pid === process.pid) return 'skip'
  if (!alive(pid)) return 'gone'
  const gentle = taskkill(pid, { tree })
  if (gentle) {
    const until = Date.now() + waitMs
    while (Date.now() < until) {
      await sleep(150)
      if (!alive(pid)) return 'graceful'
    }
  }
  taskkill(pid, { tree, force: true })
  await sleep(250)
  return alive(pid) ? 'failed' : 'forced'
}

/** 请 ASR 自己收摊（它有 /shutdown），失败再动手杀 */
async function askAsrShutdown(url) {
  if (!url) return false
  try {
    const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch {
    return false
  }
}

async function main() {
  out('')
  out('  她 · 一键关闭')
  out('  ' + '─'.repeat(46))

  const { targets, orphans, notes } = await collect()
  const all = targets.map((t) => ({ ...t, pids: t.pids.filter((p) => p && p !== process.pid) }))
  const plan = ONLY ? all.filter((t) => t.key.toLowerCase() === ONLY.toLowerCase()) : all
  const leftover = ONLY ? [] : orphans

  if (ONLY && !plan.length) {
    out('')
    out(`  没有叫「${ONLY}」的这一项。可选的：${all.map((t) => t.key).join(' / ')}`)
    out('')
    return
  }

  const total = plan.reduce((n, t) => n + t.pids.length, 0)

  if (!total && !leftover.length) {
    out('')
    out(ONLY ? `  ${ONLY} 本来就没开着。` : '  本来就没开着，没什么要关的。')
    for (const n of notes) out(`  · ${n}`)
    out('')
    return
  }

  out('')
  for (const t of plan) {
    if (!t.pids.length) {
      out(`  ○ ${t.key.padEnd(12, ' ')} 没开着`)
      continue
    }
    // 把「凭什么认定这是它」写出来：只按绝对路径/进程名认，不按 node.exe 一刀切
    out(`  ● ${t.key.padEnd(12, ' ')} PID ${t.pids.join(', ')}  ${t.note}`)
    out(`    ${' '.repeat(12)} 依据：${t.why}`)
  }
  if (leftover.length) out(`  ● 孤儿进程     PID ${leftover.map((p) => p.pid).join(', ')}`)
  for (const n of notes) out(`  · ${n}`)

  if (CHECK_ONLY) {
    out('')
    out('  （--check 模式：只列清单，什么都没关）')
    out('')
    return
  }

  if (!YES) {
    out('')
    const ok = await ask(ONLY ? `  关掉 ${ONLY}？[y/N] ` : '  真的全关？（DSH 一关，她这一轮会话就断了）[y/N] ')
    if (!/^y(es)?$/i.test(ok.trim())) {
      out('')
      out('  没关，什么都没动。')
      out('')
      return
    }
  }

  out('')
  const report = []
  for (const t of plan) {
    if (!t.pids.length) {
      report.push([t.key, '本来没开'])
      continue
    }
    const results = []
    for (const pid of t.pids) {
      // ASR 先请它自己退，别一上来就杀
      if (t.key === 'ASR' && (await askAsrShutdown(t.http))) {
        await sleep(600)
        if (!alive(pid)) {
          results.push('自己退了')
          continue
        }
      }
      results.push(await stopOne(pid, { tree: t.tree }))
    }
    report.push([t.key, results.join(' / ')])
    out(`  … ${t.key}：${results.join(' / ')}`)
  }

  // 剩下的孤儿进程（父进程已经没了，但还占着命令行特征）
  if (leftover.length) {
    const left = []
    for (const p of leftover) {
      const r = await stopOne(p.pid)
      if (r !== 'gone') left.push(`${p.pid}:${r}`)
    }
    if (left.length) report.push(['孤儿', left.join(' / ')])
  }

  // 收尾核对：端口都放掉了才算干净
  out('')
  await sleep(500)
  const ports = [
    [6199, '桥'],
    [7788, '查看器'],
    [18765, 'ASR'],
  ]
  for (const [port, name] of ports) {
    if (await portOpen(port)) out(`  ⚠️ ${name} 的端口 ${port} 还占着`)
  }

  out('')
  out('  ' + '─'.repeat(46))
  for (const [k, v] of report) out(`  ${k.padEnd(12, ' ')} ${v}`)
  out('')
  out('  要再开：双击 一键启动.cmd')
  out('')
}

function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(q, (a) => {
    rl.close()
    resolve(a)
  }))
}

main().catch((err) => {
  console.error('关闭失败：', err?.message ?? err)
  process.exitCode = 1
})
