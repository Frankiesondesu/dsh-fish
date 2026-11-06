/**
 * services.mjs —— GUI 管理器的服务清单与状态探测（2026-11-06）
 *
 * ⚠️ 一条硬规矩：**这个文件不实现「怎么启动一个服务」**。
 * 启动/停止一律调仓库根目录已有的 `launch.mjs` / `shutdown.mjs`，
 * 这里只负责三件事：知道有哪些服务、探它们活没活、把动作转成一次脚本调用。
 *
 * 为什么：`launch.mjs` 里那些细节（DSH 要清 ELECTRON_RUN_AS_NODE、
 * 三路 python 要带 cwd、venv launcher 和 uv 子进程是一对）都是踩出来的。
 * 在这里重写一份，等于养两份真相，改了一边另一边就会悄悄不对。
 *
 * 探测方式只有两种：
 *   · port    —— 端口在听就算活着（语音三路 / 桥 / 查看器 / ASR）
 *   · process —— 进程名在就算活着（DSH / LuckyLillia，它们不占固定端口）
 */

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)

export const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根目录（manager/ 的上一级）。launch.mjs 那几个脚本都在这儿。 */
export const ROOT = dirname(HERE)

/**
 * 服务清单。顺序就是界面上卡片的顺序 —— 按「她」的依赖链排：
 * 先宿主，再 QQ，再语音，最后桥和查看器（桥会用到话轮，查看器会探活三路）。
 *
 * managed: false 表示「只显示，不由这里启停」——
 * ASR 那套归用户自己的 vs 插件管线管（asr.json 自启），从这儿点关闭会把它弄乱。
 */
export const SERVICES = Object.freeze([
  {
    key: 'dsh',
    name: 'DSH',
    tag: '宿主',
    desc: '她的宿主，必须开着才有「她」。重启会断掉她当前那条会话。',
    probe: { type: 'process', image: 'DeepSeek Harness.exe' },
    warn: '重启会断她会话',
  },
  {
    key: 'll',
    name: 'LuckyLillia',
    tag: 'QQ',
    desc: 'QQ 个人号 + LLBot，出 OneBot 给桥用。',
    probe: { type: 'process', image: 'LuckyLillia.exe' },
    warn: '首次启动要扫码登录',
  },
  {
    key: 'turn',
    name: '话轮',
    tag: ':18766',
    desc: 'smart-turn，判「这句话说完了吗」。CPU ONNX，加载约十几秒。',
    probe: { type: 'port', port: 18766 },
  },
  {
    key: 'duplex',
    name: '全双工',
    tag: ':18768',
    desc: '「边听边说 + 打断不重置人格」的状态机原型。纯标准库，秒起。',
    probe: { type: 'port', port: 18768 },
  },
  {
    key: 'bridge',
    name: 'QQ 桥',
    tag: ':6199',
    desc: 'QQ ↔ 她的通路：收消息、发她的回话、推她主动说的话。',
    probe: { type: 'port', port: 6199 },
  },
  {
    key: 'viewer',
    name: '查看器',
    tag: ':7788',
    desc: '人格数据、她说过的话、事件流、用量、本机状态。',
    probe: { type: 'port', port: 7788 },
  },
  {
    key: 'asr',
    name: 'ASR 听写',
    tag: ':18765',
    desc: 'paraformer-zh 语音转字。归你自己的 vs 插件管线管（asr.json 自启），这里只看不动。',
    probe: { type: 'port', port: 18765 },
    managed: false,
  },
])

const byKey = new Map(SERVICES.map((s) => [s.key, s]))

export function serviceOf(key) {
  return byKey.get(String(key ?? '').trim().toLowerCase()) || null
}

// ---------------------------------------------------------------- 探测

/** 端口在不在听。超时短一点：这是每 2 秒刷新一次的东西。 */
export function portOpen(port, ms = 700) {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port: Number(port) })
    let done = false
    const fin = (v) => {
      if (done) return
      done = true
      s.destroy()
      resolve(v)
    }
    s.setTimeout(ms)
    s.once('connect', () => fin(true))
    s.once('error', () => fin(false))
    s.once('timeout', () => fin(false))
  })
}

/**
 * 一次性拿到所有进程名（小写）。比每个服务各调一次 tasklist 快得多，
 * 而且 tasklist 在 Windows 上单次就有几十毫秒。
 */
async function processNames() {
  try {
    const { stdout } = await run('tasklist', ['/NH', '/FO', 'CSV'], {
      windowsHide: true,
      maxBuffer: 16 << 20,
    })
    const set = new Set()
    for (const line of stdout.split('\n')) {
      const m = /^"([^"]+)"/.exec(line.trim())
      if (m) set.add(m[1].toLowerCase())
    }
    return set
  } catch {
    // tasklist 被安全策略拦 / 不存在：当作什么进程都没有，不抛
    return new Set()
  }
}

/** 某个端口的监听进程 PID。查不到返回 0。 */
async function pidOfPort(port) {
  try {
    const { stdout } = await run('netstat', ['-ano'], { windowsHide: true, maxBuffer: 16 << 20 })
    for (const line of stdout.split('\n')) {
      const t = line.trim()
      if (!t.includes('LISTENING')) continue
      const parts = t.split(/\s+/)
      // TCP  0.0.0.0:18766  0.0.0.0:0  LISTENING  12345
      if (!String(parts[1] || '').endsWith(':' + port)) continue
      const pid = Number(parts[4])
      if (pid > 0) return pid
    }
    return 0
  } catch {
    return 0
  }
}

/**
 * 探一遍所有服务的状态。
 * 返回 [{ ...service, up, pid }]，顺序与 SERVICES 一致。
 */
export async function probeAll() {
  const procs = await processNames()
  const out = []
  for (const s of SERVICES) {
    let up = false
    let pid = 0
    if (s.probe.type === 'process') {
      up = procs.has(s.probe.image.toLowerCase())
    } else {
      up = await portOpen(s.probe.port)
      if (up) pid = await pidOfPort(s.probe.port)
    }
    out.push({
      key: s.key,
      name: s.name,
      tag: s.tag,
      desc: s.desc,
      warn: s.warn || '',
      managed: s.managed !== false,
      up,
      pid,
    })
  }
  return out
}

// ---------------------------------------------------------------- 动作
//
// 全部转成一次脚本调用。启动走 launch.mjs <key>（2026-11-06 加的单项支持），
// 停止走 shutdown.mjs <中文名>（它本来就支持单项）。两个脚本都是异步子进程，
// 调用方只等「起了没」，不等它跑完——状态靠前端轮询。

/** 服务 key → shutdown.mjs 认的名字。加新服务时这张表必须跟着加，测试会盯。 */
export const STOP_NAME = {
  dsh: 'DSH',
  ll: 'LuckyLillia',
  turn: '话轮',
  duplex: '全双工',
  bridge: '桥',
  viewer: '查看器',
}

function spawnBg(exe, args, cwd) {
  const p = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd })
  p.on('error', () => {})
  p.unref()
  return p.pid
}

/** 拉起一项（不等待它真正监听）。返回子进程 PID（launch 自己的，不是服务自己的）。 */
export function startOne(key) {
  const s = serviceOf(key)
  if (!s) throw new Error(`没有叫「${key}」的服务`)
  if (s.managed === false) throw new Error(`${s.name} 不归这里管`)
  return spawnBg(process.execPath, [join(ROOT, 'launch.mjs'), key], ROOT)
}

/** 关掉一项。用 shutdown.mjs 的单项目标，它内部会连进程树一起收。 */
export function stopOne(key) {
  const s = serviceOf(key)
  if (!s) throw new Error(`没有叫「${key}」的服务`)
  if (s.managed === false) throw new Error(`${s.name} 不归这里管`)
  const name = STOP_NAME[key]
  if (!name) throw new Error(`没有给「${key}」配停止名`)
  // ⚠️ `--yes` 不能省：不带它时 shutdown.mjs 只把「会关什么」列一遍就退出，
  // 一个进程都不杀（第一次接这个 GUI 时就是这么踩的：接口回「正在关闭」，
  // 状态一直是 up）。--check 才是只列清单，--yes 是真关。
  return spawnBg(process.execPath, [join(ROOT, 'shutdown.mjs'), name, '--yes'], ROOT)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等端口真的让出来（最多 ms 毫秒）。进程型没有端口，直接等一小会儿。 */
async function waitDown(s, ms = 12000) {
  if (s.probe.type !== 'port') {
    await sleep(2500)
    return true
  }
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (!(await portOpen(s.probe.port))) return true
    await sleep(400)
  }
  return false
}

/**
 * 重启一项：先关，等它真的让出来，再起。
 *
 * 为什么必须「等」：launch.mjs 判断「要不要启动」只看端口在不在听。
 * 旧进程还没退干净就起，launch 会认为「已经在听」然后跳过 —— 于是重启变成
 * 一个人都没重启（这个坑 2026-11-06 在一键重启里踩过）。
 */
export async function restartOne(key) {
  const s = serviceOf(key)
  if (!s) throw new Error(`没有叫「${key}」的服务`)
  if (s.managed === false) throw new Error(`${s.name} 不归这里管`)
  stopOne(key)
  const gone = await waitDown(s)
  if (!gone) throw new Error(`${s.name} 没在 12 秒内退出，这次没有重启`)
  startOne(key)
  return true
}
