/**
 * memory.mjs —— 管理器的「记忆同步」数据（2026-11-12，用户要求）
 *
 * 要回答三个问题：
 *   1. 本机这份记忆现在是什么样（账本多少行、最后一条是什么、上次同步判了啥）
 *   2. 云端那份记忆最后一次被改是什么时候（谁改的、改了多大）
 *   3. 记忆是怎么长出来的 —— 一条时间轴，云端快照与本机增长都在上面
 *
 * 两条硬规矩：
 *   · **只读**。这里不 fetch、不 push、不动账本，纯粹把现状念出来。
 *   · **默认不联网**。`git ls-remote` 在网络差时要等十几秒，页面会像死了一样。
 *     所以默认只读本地已知的 origin/main（上次 fetch 的结果），并标明「这是哪次看到的」；
 *     要真去问远端，由前端显式带 `remote=1`，且整体限时。
 *
 * 失败一律折成 error 字段返回，不抛——管理器是给人看状态的，不是崩溃现场。
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { fishRoot } from '../shared/root.mjs'

const run = promisify(execFile)

const HERE = dirname(fileURLToPath(import.meta.url))   // manager/
const REPO = dirname(HERE)                              // fish/（仓库根）
const PLUG = dirname(REPO)                              // 仓库的同级目录（fish-private 在这层）

/** vault 仓库（加密快照那个）：优先环境变量，否则按仓库同级推 —— 它在仓外，故意不入库。 */
export function vaultDir() {
  return process.env.FISH_VAULT_DIR || join(PLUG, 'fish-private', 'vault')
}

function git(dir, args, timeout = 8000) {
  return run('git', ['-C', dir, ...args], { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    .then((r) => String(r.stdout || '').trim())
}

/** 目录里所有文件总字节数（只统计一层，`.dsh-fish` 下面还有 media 等大目录，够用了）。 */
function dirBytes(dir) {
  let total = 0
  let files = 0
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      try {
        const st = statSync(join(dir, e.name))
        if (st.isFile()) { total += st.size; files += 1 }
      } catch { /* 单个文件读不到不算事 */ }
    }
  } catch { /* 目录不在就算了 */ }
  return { total, files }
}

/** 账本：行数 + 最后几条事件 + 文件大小。整份读进来（几 MB 量级，比逐行流快）。 */
export function readLedger(root) {
  const p = join(root, 'events.jsonl')
  if (!existsSync(p)) return { ok: false, why: '没有 events.jsonl' }
  let buf = ''
  try {
    buf = readFileSync(p, 'utf8')
  } catch (e) {
    return { ok: false, why: String(e?.message ?? e) }
  }
  const lines = buf.split('\n').filter((l) => l.trim())
  const events = []
  for (let i = lines.length - 1; i >= 0 && events.length < 6; i -= 1) {
    try {
      const e = JSON.parse(lines[i])
      events.push({
        ts: String(e.ts ?? ''),
        type: String(e.type ?? ''),
        text: String(e.text ?? '').slice(0, 160),
      })
    } catch { /* 坏行跳过，不影响整份 */ }
  }
  let bytes = 0
  let mtime = ''
  try {
    const st = statSync(p)
    bytes = st.size
    mtime = st.mtime.toISOString()
  } catch { /* 上面已经确认存在了 */ }
  return { ok: true, lines: lines.length, bytes, mtime, recent: events }
}

/** 上次同步的状态文件（sync.mjs 写的）。 */
function readSyncState() {
  const out = {}
  for (const [key, file] of [
    ['sync', join(homedir(), '.fish-vault-sync.json')],
    ['state', join(homedir(), '.fish-vault.state')],
  ]) {
    try {
      if (!existsSync(file)) { out[key] = null; continue }
      const st = statSync(file)
      const raw = readFileSync(file, 'utf8').trim()
      out[key] = key === 'sync'
        ? { ...JSON.parse(raw), fileAt: st.mtime.toISOString() }
        : { fingerprint: raw, fileAt: st.mtime.toISOString() }
    } catch {
      out[key] = null
    }
  }
  return out
}

/**
 * 上传留痕（vault/history.jsonl，2026-11-12）：每台设备打包后追加一行，
 * 只有「时间 / 设备端 / 账本行数 / 包大小」四个字段，明文随仓库走。
 * 树状图靠它知道「这个快照是哪台机器打的」。
 */
function readHistory(dir) {
  const p = join(dir, 'history.jsonl')
  if (!existsSync(p)) return []
  const out = []
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        const o = JSON.parse(s)
        out.push({
          at: String(o.at || ''),
          device: String(o.device || '').slice(0, 12),
          ledger: Number(o.ledger) || 0,
          bytes: Number(o.bytes) || 0,
        })
      } catch { /* 坏行跳过，一条不认不影响整份 */ }
    }
  } catch { return [] }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 40)
}

/** 云端：本地 git 已知的最后一次提交 + 包大小。 */
async function readCloud(remote = false) {
  const dir = vaultDir()
  const out = { dir, ok: false, reachable: null }
  if (!existsSync(join(dir, '.git'))) {
    out.error = '找不到 vault 仓库（fish-private/vault）'
    return out
  }
  try {
    const fmt = '%H%n%cI%n%s'
    const head = await git(dir, ['log', '-1', `--format=${fmt}`, 'main'])
    const [sha, at, subject] = head.split('\n')
    // 注意：这是**本地** main 分支的快照，不是云端。云端要 ls-remote 才知道。
    out.localMain = { sha, at, subject }

    // 本地已知的远端位置（上次 fetch 的结果），不代表现在云端就是它
    try {
      out.originMain = await git(dir, ['rev-parse', 'origin/main'])
    } catch { out.originMain = '' }

    try {
      const st = statSync(join(dir, 'fish-vault.tar.gz.enc'))
      out.pkgBytes = st.size
      out.pkgAt = st.mtime.toISOString()
    } catch { out.pkgBytes = 0 }

    // 记忆修改树：main 上的快照历史（滚动静默，条数不多）
    try {
      const log = await git(dir, ['log', '--format=%h|%cI|%s', '-n', '12', 'main'])
      out.history = log.split('\n').filter(Boolean).map((l) => {
        const [h, t, s] = l.split('|')
        return { sha: h, at: t, subject: s }
      })
    } catch { out.history = [] }

    // 谁打的包（老快照没有这条记录，那时还没开始留痕）
    out.uploads = readHistory(dir)

    out.ok = true
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 200)
    return out
  }

  if (remote) {
    // 只有明确要求时才联网，且限时；问不到就明说问不到
    try {
      const r = await run('git', ['-C', dir, 'ls-remote', 'origin', 'refs/heads/main'], { timeout: 12000, windowsHide: true })
      const first = String(r.stdout || '').trim().split(/\s+/)[0] || ''
      out.remoteMain = first
      out.reachable = !!first
      out.checkedAt = new Date().toISOString()
    } catch (e) {
      out.reachable = false
      out.remoteError = String(e?.message ?? e).slice(0, 160)
      out.checkedAt = new Date().toISOString()
    }
  }
  return out
}

/** 本机账本按天计数（最近 7 天有记录的天），给时间轴用。 */
function ledgerByDay(root) {
  const p = join(root, 'events.jsonl')
  if (!existsSync(p)) return []
  const map = new Map()
  try {
    const lines = readFileSync(p, 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      let e
      try { e = JSON.parse(line) } catch { continue }
      const ts = String(e.ts ?? '')
      const day = ts.slice(0, 10)
      if (!day) continue
      const cur = map.get(day) || { day, count: 0, lastAt: '', types: new Set() }
      cur.count += 1
      if (ts > cur.lastAt) cur.lastAt = ts
      if (e.type) cur.types.add(String(e.type))
      map.set(day, cur)
    }
  } catch { return [] }
  return [...map.values()]
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, 7)
    .map((d) => ({ day: d.day, count: d.count, lastAt: d.lastAt, types: [...d.types].slice(0, 6) }))
}

/**
 * 判定「本机是不是有新记忆还没上去」。
 *
 * 为什么不用 git sha 比：vault 的 main 是**滚动静默**——`backup.sh` 每次
 * `commit --amend` 改写 HEAD，所以「本地 main == origin/main」只说明上一次
 * 推送成功了，完全不说明记忆内容有没有变。
 *
 * 靠得住的判据是时间：`backup.sh` **成功之后**才写 `.fish-vault.state`，
 * 所以 state 的 mtime = 上次备份成功的时刻。账本比它新，就是有东西没上去。
 */
export function verdictOf(ledger, fingerprint) {
  const ledgerAt = ledger?.mtime || ''
  const backupAt = fingerprint?.fileAt || ''
  if (!ledgerAt) return { kind: 'unknown', note: '读不到账本，判断不了' }
  if (!backupAt) return { kind: 'unknown', note: '没有本机备份记录（.fish-vault.state 不在）' }
  if (ledgerAt > backupAt) {
    return {
      kind: 'local-newer',
      note: '账本在上次备份之后又写过 —— 本机有新记忆还没上去',
      ledgerAt,
      backupAt,
    }
  }
  return {
    kind: 'same',
    note: '账本与上次备份时一致（之后没再写）',
    ledgerAt,
    backupAt,
  }
}

/**
 * 手机那一路（2026-11-12，用户要树里三格：手机 / 本机 / 云端）。
 *
 * 为什么要走 adb + ssh：手机上的账本住在 proot 容器里（/root/.dsh-fish），
 * `adb shell` 看不到；只能先 `adb forward` 再把 8022 转发给 Termux 的 sshd。
 * 用户名不写死——用 `adb shell whoami` 问，换台手机也能用。
 *
 * 这条路径慢（adb 握手 + ssh 登录，正常 3–10 秒），所以只在显式要求时跑，
 * 不进 30 秒轮询。连不上就照实说连不上，不拿上次的数据冒充现在。
 */
export async function readPhone() {
  const out = { ok: false, why: '' }
  const adb = (args, timeout = 8000) => run('adb', args, { timeout, windowsHide: true })
  const short = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 120)

  try {
    const d = await adb(['devices'])
    const line = String(d.stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /\tdevice$/.test(l))
    if (!line) {
      out.why = 'adb 里没有在线设备（没插线 / 没授权 / 屏幕锁着）'
      return out
    }
    out.serial = line.split('\t')[0].trim()
  } catch (e) {
    out.why = '找不到 adb：' + short(e)
    return out
  }

  try {
    const w = await adb(['-s', out.serial, 'shell', 'whoami'])
    out.user = String(w.stdout || '').trim()
  } catch { out.user = '' }
  if (!out.user) {
    out.why = '拿不到手机上的用户名（adb shell 没通）'
    return out
  }

  try { await adb(['forward', 'tcp:8022', 'tcp:8022'], 10000) } catch { /* 转发失败下面 ssh 会报 */ }

  // 一次登录把需要的都取回来：行数、mtime（ISO）、上次同步判定
  const remoteCmd = [
    'proot-distro login ubuntu -- bash -c',
    '"wc -l < /root/.dsh-fish/events.jsonl 2>/dev/null;',
    'date -Iseconds -r /root/.dsh-fish/events.jsonl 2>/dev/null;',
    'cat /root/.fish-vault-sync.json 2>/dev/null"',
  ].join(' ')

  try {
    const r = await run('ssh', [
      '-p', '8022',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=8',
      `${out.user}@127.0.0.1`,
      remoteCmd,
    ], { timeout: 25000, windowsHide: true })

    const lines = String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)
    out.lines = Number(lines[0]) || 0
    out.mtime = lines[1] || ''
    if (lines[2]) {
      try { out.lastSync = JSON.parse(lines[2]) } catch { /* 状态文件坏了不影响读数 */ }
    }
    out.ok = true
  } catch (e) {
    out.why = 'SSH 连不上手机容器：' + short(e)
  }
  return out
}

export async function readMemory({ remote = false, phone = false } = {}) {
  const root = fishRoot()
  const ledger = readLedger(root)
  const sync = readSyncState()
  // 云端与手机并行问，别串着等
  const [cloud, phoneData] = await Promise.all([
    readCloud(remote),
    phone ? readPhone() : Promise.resolve(null),
  ])
  const dir = dirBytes(root)
  const byDay = ledgerByDay(root)

  return {
    at: new Date().toISOString(),
    root,
    local: {
      dirBytes: dir.total,
      files: dir.files,
      ledger,
      lastSync: sync.sync,
      fingerprint: sync.state,
    },
    cloud,
    phone: phoneData,
    verdict: verdictOf(ledger, sync.state),
    byDay,
  }
}
