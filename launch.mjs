/**
 * launch.mjs —— 一键把这条链路拉起来（2026-11-02；2026-11-06 加语音三路）
 *
 *   1. DSH（她的宿主，必须开着才有"她"）
 *   2. LuckyLillia（QQ 个人号 + PMHQ + LLBot，出 OneBot）
 *   3. 语音两路（本地 HTTP 服务，python；脚本用相对路径，启动必须带 cwd）
 *        3a. smart-turn   话轮端点    18766
 *        3b. full-duplex  全双工接口  18768（判话轮会回打 18766，故排在它后面）
 *      ——CosyVoice2 / 18767 于 2026-11-06 摘出：搭好后从没接进任何链路，
 *        每次启动只净赔 2-3 分钟加载 5.3G 权重。详见下面 VOICE 处的注释。
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ensureLlbotPatch } from './llbot-patch.mjs'
import { ensureVsPatch } from './vs-patch.mjs'
import { fishRoot, workbuddyPythons } from './shared/root.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHECK_ONLY = process.argv.includes('--check')

// 单项启动（2026-11-06）：`node launch.mjs 桥` 只拉桥，其他一律不碰。
// 为什么要这个：GUI 管理器（manager/）要能单独开关某一项，而原来这个脚本
// 只有「全部启动」。另写一套启动逻辑等于养两份真相，所以能力长在这里。
// 不传就是全部启动——和以前一模一样。
const ONLY_ARG = (process.argv.slice(2).find((a) => !a.startsWith('-')) || '').trim()
const ALIAS = {
  桥: 'bridge', bridge: 'bridge',
  查看器: 'viewer', viewer: 'viewer',
  话轮: 'turn', turn: 'turn',
  全双工: 'duplex', duplex: 'duplex',
  dsh: 'dsh',
  ll: 'll', luckylillia: 'll',
}
const TARGET = ONLY_ARG ? (ALIAS[ONLY_ARG] || ALIAS[ONLY_ARG.toLowerCase()] || '') : ''
const want = (k) => !TARGET || TARGET === k
// restart.mjs 调这个脚本时传 --no-open：重启不该顺手弹一个浏览器窗口
// （尤其「只重启桥」时，用户根本没要开查看器）
const NO_OPEN = process.argv.includes('--no-open')

/**
 * 每拉起一项就把时刻记进 `~/.dsh-fish/launch-stamp.json`（2026-11-07）。
 *
 * 为什么需要：GUI 管理器要告诉你「改了代码、这个服务得重启」，而判断的前提是
 * 知道**这个进程是什么时候起的**。DSH 那边有 instance.json 的 bootAt，
 * 其他六项没有——它们的启动时间只能从这儿记。
 *
 * 只在这个脚本里写，因为它是所有启动路径的唯一入口（管理器也转发到这里）。
 * 你手动 `node bridge.mjs` 起的不会被记到，那属于「不知道启动时间」，
 * 管理器会如实标成「不确定」而不是瞎猜。
 */
const STAMP_FILE = join(fishRoot(), 'launch-stamp.json')
function stamp(key) {
  if (CHECK_ONLY || !key) return
  try {
    let j = {}
    try {
      j = JSON.parse(readFileSync(STAMP_FILE, 'utf8'))
    } catch {
      j = {}
    }
    if (!j || typeof j !== 'object') j = {}
    j[key] = Date.now()
    mkdirSync(dirname(STAMP_FILE), { recursive: true })
    writeFileSync(STAMP_FILE, JSON.stringify(j, null, 2) + '\n')
  } catch {
    // 记不下也不该影响启动本身
  }
}

// 2026-11-06：DSH 装在哪台机可能不一样（有人装 D 盘、有人装 C 盘、有人装进
// AppData）。原来写死一个路径，换台机就「❌ 找不到 DSH」。现在按常见位置挨个试，
// 还支持 DSH_EXE 环境变量直接指定。都找不到时下面报错会把试过的路径列出来。
const DSH_CANDIDATES = [
  process.env.DSH_EXE,
  'D:\\Program Files (x86)\\DeepSeek Harness\\DeepSeek Harness.exe',
  'C:\\Program Files (x86)\\DeepSeek Harness\\DeepSeek Harness.exe',
  'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
  join(homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
].filter(Boolean)
const DSH_EXE = DSH_CANDIDATES.find((p) => existsSync(p)) ?? ''
const LL_EXE = join(HERE, 'runtime', 'LL', 'LuckyLillia.exe')
const BRIDGE = join(HERE, 'bridge', 'bridge.mjs')
const VIEWER = join(HERE, 'viewer', 'viewer.mjs')
const VIEWER_URL = 'http://127.0.0.1:7788'

// 语音三路（2026-11-06）：都在 fish 的同级目录 D:\Code\<同级目录> 下。
// 启动命令是「venv 里的 python + 相对路径的脚本」，所以 detach 必须给 cwd。
// 注意 venv/Scripts/python.exe 是 launcher：它还会拉起真正的 uv python 子进程，
// 真正听端口、装模型的是那个子进程（关的时候要连树一起收，见 shutdown.mjs）。
const PLUG = dirname(HERE)
// 2026-11-07（用户两次追问「这个黑框」）：用 **pythonw.exe**。
//
// pythonw 是 GUI 子系统程序，**根本不创建控制台**，所以那个空黑窗口从根上就没有了。
// 第一次我试过又回退了，理由是「18766 起不来」——**那个判断是错的**：那次是我这边
// 起的进程被沙箱回收，误当成了 pythonw 的问题。后来单独用 PowerShell 验证：
//   server.py  → HTTP 200 {"ok":true,"model":"smart-turn-v3.2-cpu.onnx"}
//   duplex.py  → HTTP 200 {"ok":true,"mode":"mock","state":"LISTENING"}
// 两个在 pythonw 下都正常。
//
// 代价是 pythonw 下 sys.stdout 是 None，脚本里的 print 会抛 AttributeError ——
// server.py 与 duplex.py 的那两处 print 已经包了 try（它们还会顺手把自己的
// 控制台藏掉，万一哪天又用回 python.exe 也不会有窗口）。
//
// 没有 pythonw 的机器（极少数）回退到 python.exe，只是会重新出现那个窗口。
const PY_TURN_DIR = join(PLUG, 'turn-taking', 'venv', 'Scripts')
const PY_TURN = [join(PY_TURN_DIR, 'pythonw.exe'), join(PY_TURN_DIR, 'python.exe')].find(existsSync)
// dialogue-tts 的 venv 2026-11-06 已删（12G）。这条留着是给「哪天手动重建了 TTS」
// 的情况——路径不存在时 PY_STDLIB 的 find(existsSync) 会自动跳过它。
const PY_TTS = join(PLUG, 'dialogue-tts', 'venv', 'Scripts', 'python.exe')
// duplex.py 只用标准库，不挑解释器；复用已存在的 venv，别写死 WorkBuddy 内置
// python（那个路径带版本号，升级就失效）。最后一条是兜底。
// 2026-11-06：最后那条原来写死 .../versions/3.13.12/python.exe——注释自己都在说
// 「那个路径带版本号，升级就失效」，但兜底那行还是写死了。改成扫目录。
const PY_STDLIB = [PY_TURN, PY_TTS, ...workbuddyPythons()].filter(Boolean).find(existsSync)

const VOICE = [
  { id: 'turn', key: '话轮 18766', port: 18766, exe: PY_TURN,
    args: ['server.py', '--port', '18766'], cwd: join(PLUG, 'turn-taking') },
  // 2026-11-06（用户问「dialogue-tts 到底有没有用过」）：查下来是**一次都没用过**——
  // 业务代码引用 0 处、插件日志 0 条、账本 0 次提及，唯一产物是搭完测的 3.6 秒 wav。
  // 她的声音一直走 edge-tts（zh-CN-YunxiNeural，她自己听完十条挑的，理由「别给我一副
  // 好听的嗓子」）。留着它只意味着每次启动多等 2-3 分钟加载 5.3G 权重，于 11-06 摘出。
  // 要用时手动：cd D:\Code\<同级目录>\dialogue-tts && venv\Scripts\python.exe server.py --port 18767
  { id: 'duplex', key: '全双工 18768', port: 18768, exe: PY_STDLIB,
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
  // 参数写错就当场拒，别静默走「全部启动」——那是最容易误伤的一种失败
  if (ONLY_ARG && !TARGET) {
    out('')
    out(`  ✗ 不认识「${ONLY_ARG}」。能单独启动的是这几项：`)
    out('       dsh / ll / turn / duplex / bridge / viewer')
    out('       （也认中文：话轮 / 全双工 / 桥 / 查看器）')
    out('     不给参数就是全部启动。')
    out('')
    process.exit(2)
  }

  out('')
  out('  她 · 一键启动')
  if (TARGET) out(`  （只启动：${TARGET}）`)
  out('  ' + '─'.repeat(46))

  // 1) DSH
  if (!want('dsh')) {
    // 单项启动别的：DSH 一点不碰（它不是可重启的普通服务，重启会断她会话）
  } else if (running('DeepSeek Harness.exe')) {
    out('  ✅ DSH 已经在跑')
    report.push(['DSH', '运行中'])
  } else if (CHECK_ONLY) {
    out('  ❌ DSH 没开')
    report.push(['DSH', '未启动'])
  } else if (existsSync(DSH_EXE)) {
    out('  … DSH 没开，正在拉起')
    detach(DSH_EXE, [], 'DSH', { cleanElectronEnv: true, cwd: dirname(DSH_EXE) })
    stamp('dsh')
    report.push(['DSH', '已拉起（要等它加载完插件）'])
  } else {
    out('  ❌ 找不到 DSH。找过这些位置：')
    for (const p of DSH_CANDIDATES) out(`       ${p}`)
    out('     装在别处的话，设环境变量 DSH_EXE 指过去。')
    report.push(['DSH', '找不到可执行文件'])
  }

  // 2) LuckyLillia
  //    先兜一次 LLBot 的补丁：LuckyLillia 更新 llbot 时会把 llbot.js 整份覆盖，
  //    补丁丢了 QQ 消息就会全部收不到（而且不报错，最难查的那种）。
  const lp = want('ll') ? ensureLlbotPatch({ write: !CHECK_ONLY }) : { state: 'skip' }
  if (!want('ll')) {
    // 单项启动别的：补丁检查也跳过（它会写盘）
  } else if (lp.state === 'patched') {
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
  const vp = want('ll') ? ensureVsPatch({ write: !CHECK_ONLY }) : []
  const vpBad = vp.filter((r) => r.state === 'missing' || r.state === 'unknown')
  if (!want('ll')) {
    // 单项启动别的：vs 补丁也跳过
  } else if (vpBad.length === 0) {
    out(`  ✅ vs 外挂补丁在位（${vp.map((r) => (r.state === 'applied' ? '刚补回' : '在位')).join(' / ')}）`)
    report.push(['vs 补丁', vp.some((r) => r.state === 'applied') ? '已补回' : '在位'])
  } else {
    out(`  ⚠️  vs 外挂补丁：${vpBad.map((r) => r.detail ?? r.state).join('；')}`)
    report.push(['vs 补丁', '待人工确认'])
  }

  if (!want('ll')) {
    // 单项启动别的
  } else if (running('LuckyLillia.exe')) {
    out('  ✅ LuckyLillia 已经在跑')
    report.push(['LuckyLillia', '运行中'])
  } else if (CHECK_ONLY) {
    out('  ❌ LuckyLillia 没开')
    report.push(['LuckyLillia', '未启动'])
  } else if (existsSync(LL_EXE)) {
    out('  … LuckyLillia 没开，正在拉起（可能要点登录）')
    detach(LL_EXE, [], 'LuckyLillia')
    stamp('ll')
    report.push(['LuckyLillia', '已拉起（首次要扫码登录）'])
  } else {
    out(`  ❌ 找不到 LuckyLillia：${LL_EXE}`)
    report.push(['LuckyLillia', '找不到可执行文件'])
  }

  // 3) 语音三路 —— 先起：桥会用到话轮，查看器「本机状态」会探活它们
  for (const s of VOICE) {
    if (!want(s.id)) continue
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
    out(`  … ${s.key} 没开，正在拉起`)
    detach(s.exe, s.args, s.key, { cwd: s.cwd, hide: true })
    stamp(s.id)
    // 起完马上看一眼：python 依赖缺失时会秒退，而 stdio 已经丢了、什么都看不到。
    // 6 秒只是「有没有立刻死」，不是「加载完」—— 18766（ONNX）实测要十几秒。
    const early = await waitPort(s.port, 6000)
    if (early) out(`    ✅ ${s.key} 已经在听（${(early / 1000).toFixed(1)}s）`)
    else out(`    … ${s.key} 进程已拉起，还在加载（端口晚点自己会开）`)
    report.push([s.key, early ? '已启动' : '已拉起（加载中）'])
  }

  // 4) 桥
  if (!want('bridge')) {
    // 单项启动别的
  } else if (await portOpen(6199)) {
    out('  ✅ 桥已经在听 6199')
    report.push(['桥', '运行中（6199）'])
  } else if (CHECK_ONLY) {
    out('  ❌ 桥没开')
    report.push(['桥', '未启动'])
  } else {
    out('  … 桥没开，正在拉起')
    detach(process.execPath, [BRIDGE], '桥')
    stamp('bridge')
    report.push(['桥', '已启动（6199）'])
  }

  // 5) 查看器
  if (!want('viewer')) {
    // 单项启动别的
  } else if (await portOpen(7788)) {
    out('  ✅ 查看器已经在跑')
    report.push(['查看器', '运行中（7788）'])
  } else if (CHECK_ONLY) {
    out('  ❌ 查看器没开')
    report.push(['查看器', '未启动'])
  } else {
    out('  … 查看器没开，正在拉起')
    detach(process.execPath, [VIEWER], '查看器')
    stamp('viewer')
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
  out('  语音两路  18766 话轮 / 18768 全双工（查看器「本机状态」可探活）')
  out('            TTS 18767 已停用（从没接进任何链路，用了只赔启动时间）')
  out('  QQ 那条   QQ → 阿岸；桥连上后日志在 bridge\\bridge.log')
  out('')
  out('  关掉：双击 一键关闭.cmd（或 node shutdown.mjs --check 先看清单）')
  out('')
}

main().catch((err) => {
  console.error('启动失败：', err?.message ?? err)
  process.exitCode = 1
})
