/**
 * launch.mjs —— 一键把这条链路拉起来（2026-11-02；2026-11-06 加语音三路）
 *
 *   1. DSH（她的宿主，必须开着才有"她"）
 *   2. LuckyLillia（QQ 个人号 + PMHQ + LLBot，出 OneBot）
 *   3. 语音三路（本地 HTTP 服务，python；脚本用相对路径，启动必须带 cwd）
 *        3a. smart-turn   话轮端点    18766
 *        3b. CosyVoice2   对话 TTS    18767
 *        3c. full-duplex  全双工接口  18768（判话轮会回打 18766，故排在它后面）
 *   4. bridge（QQ ↔ 她 的桥，监听 6199）
 *   5. viewer（人格/行动查看器，7788；「本机状态」会探活上面三路）
 *
 * 每一样都先看有没有在跑，已经在跑就跳过 —— 重复启动会抢端口，比不启动更麻烦。
 *
 * 用法：
 *   node launch.mjs          正常启动
 *   node launch.mjs --check  只体检，不启动任何东西
 */

import { spawn, execFileSync } from 'node:child_process'
import { connect } from 'node:net'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ensureLlbotPatch } from './llbot-patch.mjs'
import { ensureVsPatch } from './vs-patch.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHECK_ONLY = process.argv.includes('--check')
// restart.mjs 调这个脚本时传 --no-open：重启不该顺手弹一个浏览器窗口
// （尤其「只重启桥」时，用户根本没要开查看器）
const NO_OPEN = process.argv.includes('--no-open')

const DSH_EXE = 'D:\\Program Files (x86)\\DeepSeek Harness\\DeepSeek Harness.exe'
const LL_EXE = join(HERE, 'runtime', 'LL', 'LuckyLillia.exe')
const BRIDGE = join(HERE, 'bridge', 'bridge.mjs')
const VIEWER = join(HERE, 'viewer', 'viewer.mjs')
const VIEWER_URL = 'http://127.0.0.1:7788'

// 语音三路（2026-11-06）：都在 fish 的同级目录 D:\Code\<同级目录> 下。
// 启动命令是「venv 里的 python + 相对路径的脚本」，所以 detach 必须给 cwd。
// 注意 venv/Scripts/python.exe 是 launcher：它还会拉起真正的 uv python 子进程，
// 真正听端口、装模型的是那个子进程（关的时候要连树一起收，见 shutdown.mjs）。
const PLUG = dirname(HERE)
const PY_TURN = join(PLUG, 'turn-taking', 'venv', 'Scripts', 'python.exe')
const PY_TTS = join(PLUG, 'dialogue-tts', 'venv', 'Scripts', 'python.exe')
// duplex.py 只用标准库，不挑解释器；复用已存在的 venv，别写死 WorkBuddy 内置
// python（那个路径带版本号，升级就失效）。最后一条是兜底。
const PY_STDLIB = [
  PY_TURN,
  PY_TTS,
  'C:\\Users\\<用户名>\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe',
].find(existsSync)

const VOICE = [
  { key: '话轮 18766', port: 18766, exe: PY_TURN,
    args: ['server.py', '--port', '18766'], cwd: join(PLUG, 'turn-taking') },
  { key: 'TTS 18767', port: 18767, exe: PY_TTS,
    args: ['server.py', '--port', '18767'], cwd: join(PLUG, 'dialogue-tts') },
  { key: '全双工 18768', port: 18768, exe: PY_STDLIB,
    args: ['duplex.py', '--port', '18768'], cwd: join(PLUG, 'full-duplex') },
]

// ---------------------------------------------------------------- 小工具

const out = (...a) => console.log(...a)

/** 某个进程名在不在跑（Windows 上进程名带空格也能匹配） */
function running(imageName) {
  try {
    const s = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    // 没匹配到时 tasklist 会打一行「信息: 没有运行的任务...」，所以看进程名
    return s.toLowerCase().includes(String(imageName).toLowerCase())
  } catch {
    return false
  }
}

/** 端口有没有人在听（连着就算） */
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

/** 起一个脱离本窗口的进程：关掉这个黑框它也不会跟着死 */
function detach(exe, args, label, { cleanElectronEnv = false, cwd, hide = false } = {}) {
  // 2026-11-02：Electron 程序（DSH）在带 ELECTRON_RUN_AS_NODE=1 的环境里会
  // **降级成纯 Node** 跑：无脚本就立刻退出（退出码 0）、给 Chromium 参数就报
  // "bad option"。从 WorkBuddy 的终端里继承来的环境正好带这个变量，所以
  // 从那儿拉 DSH 永远是「启动了但没起来」，而双击快捷方式却没事。
  // NODE_OPTIONS 同理：那是 WorkBuddy 的 shim，不该注进别人的 Electron 主进程。
  // cwd 也要给：DSH 会按工作目录找 resources。
  let env = process.env
  if (cleanElectronEnv) {
    env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
  }
  // hide：语音三路是纯后台 HTTP 服务，stdio 已经丢了，没必要再弹三个黑框。
  const p = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: hide, env, ...(cwd ? { cwd } : {}) })
  // spawn 失败（路径没权限、被杀软拦、句柄耗尽）会 emit 'error'；不接住就是
  // uncaughtException，整个启动器当场崩掉，后面几项一个都起不来。
  p.on('error', (err) => out(`  ❌ ${label} 没启动：${err?.message ?? err}`))
  p.unref()
  out(`  ↑ 已启动 ${label}（PID ${p.pid}）`)
  return p
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 轮询端口，返回用时（毫秒）；超时返回 0。 */
async function waitPort(port, ms, step = 500) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await portOpen(port)) return Date.now() - t0
    await sleep(step)
  }
  return 0
}

// ---------------------------------------------------------------- 主流程

const report = []

async function main() {
  out('')
  out('  她 · 一键启动')
  out('  ' + '─'.repeat(46))

  // 1) DSH
  if (running('DeepSeek Harness.exe')) {
    out('  ✅ DSH 已经在跑')
    report.push(['DSH', '运行中'])
  } else if (CHECK_ONLY) {
    out('  ❌ DSH 没开')
    report.push(['DSH', '未启动'])
  } else if (existsSync(DSH_EXE)) {
    out('  … DSH 没开，正在拉起')
    detach(DSH_EXE, [], 'DSH', { cleanElectronEnv: true, cwd: dirname(DSH_EXE) })
    report.push(['DSH', '已拉起（要等它加载完插件）'])
  } else {
    out(`  ❌ 找不到 DSH：${DSH_EXE}`)
    report.push(['DSH', '找不到可执行文件'])
  }

  // 2) LuckyLillia
  //    先兜一次 LLBot 的补丁：LuckyLillia 更新 llbot 时会把 llbot.js 整份覆盖，
  //    补丁丢了 QQ 消息就会全部收不到（而且不报错，最难查的那种）。
  const lp = ensureLlbotPatch({ write: !CHECK_ONLY })
  if (lp.state === 'patched') {
    out('  ✅ LLBot 剥帧头补丁在位')
    report.push(['LLBot 补丁', '在位'])
  } else if (lp.state === 'applied') {
    out('  ✅ LLBot 剥帧头补丁已补回（之前被覆盖了）')
    report.push(['LLBot 补丁', '已补回'])
  } else if (lp.state === 'missing') {
    out('  ❌ LLBot 剥帧头补丁缺失 —— QQ 消息会全部收不到')
    report.push(['LLBot 补丁', '缺失'])
  } else {
    out(`  ⚠️  LLBot 补丁：${lp.detail ?? lp.state}`)
    report.push(['LLBot 补丁', '待人工确认'])
  }

  // 2b) vs 外挂的两处补丁（2026-11-03）
  //     dsh-video-storyboard 升级会整份覆盖：changes 上限会退回 5（她看到的
  //     「改自」标记就只剩前几条），OCR 校正会退回「只认 asr」（她看的 B 站
  //     AI 字幕片子一条都不会被校正）。所以每次启动兜一次，丢了自动补回。
  const vp = ensureVsPatch({ write: !CHECK_ONLY })
  const vpBad = vp.filter((r) => r.state === 'missing' || r.state === 'unknown')
  if (vpBad.length === 0) {
    out(`  ✅ vs 外挂补丁在位（${vp.map((r) => (r.state === 'applied' ? '刚补回' : '在位')).join(' / ')}）`)
    report.push(['vs 补丁', vp.some((r) => r.state === 'applied') ? '已补回' : '在位'])
  } else {
    out(`  ⚠️  vs 外挂补丁：${vpBad.map((r) => r.detail ?? r.state).join('；')}`)
    report.push(['vs 补丁', '待人工确认'])
  }

  if (running('LuckyLillia.exe')) {
    out('  ✅ LuckyLillia 已经在跑')
    report.push(['LuckyLillia', '运行中'])
  } else if (CHECK_ONLY) {
    out('  ❌ LuckyLillia 没开')
    report.push(['LuckyLillia', '未启动'])
  } else if (existsSync(LL_EXE)) {
    out('  … LuckyLillia 没开，正在拉起（可能要点登录）')
    detach(LL_EXE, [], 'LuckyLillia')
    report.push(['LuckyLillia', '已拉起（首次要扫码登录）'])
  } else {
    out(`  ❌ 找不到 LuckyLillia：${LL_EXE}`)
    report.push(['LuckyLillia', '找不到可执行文件'])
  }

  // 3) 语音三路 —— 先起：桥会用到话轮，查看器「本机状态」会探活它们
  for (const s of VOICE) {
    if (await portOpen(s.port)) {
      out(`  ✅ ${s.key} 已经在听`)
      report.push([s.key, '运行中'])
      continue
    }
    const script = join(s.cwd, s.args[0])
    if (!s.exe || !existsSync(s.exe) || !existsSync(script)) {
      const miss = !s.exe || !existsSync(s.exe) ? (s.exe ?? 'python 解释器') : script
      out(`  ❌ ${s.key} 缺文件：${miss}`)
      report.push([s.key, '缺文件，已跳过'])
      continue
    }
    if (CHECK_ONLY) {
      out(`  ❌ ${s.key} 没开`)
      report.push([s.key, '未启动'])
      continue
    }
    out(`  … ${s.key} 没开，正在拉起${s.port === 18767 ? '（模型加载要十几秒）' : ''}`)
    detach(s.exe, s.args, s.key, { cwd: s.cwd, hide: true })
    // 起完马上看一眼：python 依赖缺失时会秒退，而 stdio 已经丢了、什么都看不到。
    // 6 秒只是「有没有立刻死」，不是「加载完」—— 18766 要十几秒，18767 要两三分钟。
    const early = await waitPort(s.port, 6000)
    if (early) out(`    ✅ ${s.key} 已经在听（${(early / 1000).toFixed(1)}s）`)
    else out(`    … ${s.key} 进程已拉起，还在加载（端口晚点自己会开）`)
    report.push([s.key, early ? '已启动' : '已拉起（加载中）'])
  }

  // 4) 桥
  if (await portOpen(6199)) {
    out('  ✅ 桥已经在听 6199')
    report.push(['桥', '运行中（6199）'])
  } else if (CHECK_ONLY) {
    out('  ❌ 桥没开')
    report.push(['桥', '未启动'])
  } else {
    out('  … 桥没开，正在拉起')
    detach(process.execPath, [BRIDGE], '桥')
    report.push(['桥', '已启动（6199）'])
  }

  // 5) 查看器
  if (await portOpen(7788)) {
    out('  ✅ 查看器已经在跑')
    report.push(['查看器', '运行中（7788）'])
  } else if (CHECK_ONLY) {
    out('  ❌ 查看器没开')
    report.push(['查看器', '未启动'])
  } else {
    out('  … 查看器没开，正在拉起')
    detach(process.execPath, [VIEWER], '查看器')
    report.push(['查看器', '已启动（7788）'])
  }

  if (CHECK_ONLY) {
    out('')
    out('  （--check 模式：只体检，没启动任何东西）')
    return
  }

  // 等一下，让 HTTP 服务起来再把浏览器打开
  await sleep(1200)
  if (!NO_OPEN && (await portOpen(7788))) {
    try {
      spawn('cmd', ['/c', 'start', '', VIEWER_URL], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      out(`  ↗ 浏览器已打开 ${VIEWER_URL}`)
    } catch { /* 打不开就算了，地址照样印出来 */ }
  }

  out('')
  out('  ' + '─'.repeat(46))
  for (const [k, v] of report) out(`  ${k.padEnd(12, ' ')} ${v}`)
  out('')
  out('  查看器    ' + VIEWER_URL)
  out('  语音三路  18766 话轮 / 18767 TTS / 18768 全双工（查看器「本机状态」可探活）')
  out('  QQ 那条   QQ → 阿岸；桥连上后日志在 bridge\\bridge.log')
  out('')
  out('  关掉：双击 一键关闭.cmd（或 node shutdown.mjs --check 先看清单）')
  out('')
}

main().catch((err) => {
  console.error('启动失败：', err?.message ?? err)
  process.exitCode = 1
})
