/**
 * launch.mjs —— 一键把这条链路上的四样东西拉起来（2026-11-02）
 *
 *   1. DSH（她的宿主，必须开着才有"她"）
 *   2. LuckyLillia（QQ 个人号 + PMHQ + LLBot，出 OneBot）
 *   3. bridge（QQ ↔ 她 的桥，监听 6199）
 *   4. viewer（人格/行动查看器，7788）
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

const DSH_EXE = 'D:\\Program Files (x86)\\DeepSeek Harness\\DeepSeek Harness.exe'
const LL_EXE = join(HERE, 'runtime', 'LL', 'LuckyLillia.exe')
const BRIDGE = join(HERE, 'bridge', 'bridge.mjs')
const VIEWER = join(HERE, 'viewer', 'viewer.mjs')
const VIEWER_URL = 'http://127.0.0.1:7788'

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
function detach(exe, args, label, { cleanElectronEnv = false, cwd } = {}) {
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
  const p = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false, env, ...(cwd ? { cwd } : {}) })
  p.unref()
  out(`  ↑ 已启动 ${label}（PID ${p.pid}）`)
  return p
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
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

  // 3) 桥
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

  // 4) 查看器
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
  if (await portOpen(7788)) {
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
  out('  QQ 那条   QQ → 阿岸；桥连上后日志在 bridge\\bridge.log')
  out('')
  out('  关掉：双击 一键关闭.cmd（或 node shutdown.mjs --check 先看清单）')
  out('')
}

main().catch((err) => {
  console.error('启动失败：', err?.message ?? err)
  process.exitCode = 1
})
