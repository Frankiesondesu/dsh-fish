/**
 * swap.mjs —— 昼夜交接体检（2026-11-12）
 *
 * 场景（用户 12:49 定案）：白天 PC 开发并跑她，傍晚把真相源交给手机，
 * 手机在 DeepSeek 半价谷时自己醒、自己看视频；早上 PC 开机再接回。
 *
 * 铁律（shared/root.mjs）：
 *   1. 同一时刻只能一端跑她：账本 append 双写会交错，状态文件全量重写会覆盖。
 *   2. 交接只能「单向整份接管」，不能 merge；谁最后用过，谁就是真相源。
 *   3. 搬完必须核对账本行数与最后一行指纹，对不上立刻回滚，别带病启动。
 *
 * ⚠️ 这一版只实现 --check（只读体检）。`out` / `in` 会整份覆盖 ~/.dsh-fish，
 *    必须等手机在线、两端端到端验证通过之后才能交付——不能在没实测过的情况下
 *    交出一个能覆盖账本的脚本（fork.13：工具说的话必须为真）。
 *
 * 用法：node scripts/swap.mjs            （= --check，只读）
 *       node scripts/swap.mjs --check
 *       node scripts/swap.mjs out|in    （明确报「未交付」及原因）
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

/** 交接前必须全 DOWN 的端口。DSH 3080 / webchat 6210 也列上，防漏。 */
export const PORTS = [6199, 6198, 7788, 7789, 6210, 3080, 18765]

/**
 * 账本指纹：行数 + 最后一行的 sha256 前 12 位。
 * 不依赖事件有没有 id 字段——账本格式变了也照样能比对。
 */
export function ledgerStats(file) {
  let raw
  try { raw = readFileSync(file, 'utf8') } catch { return { ok: false, lines: 0, lastHash: '' } }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  if (!lines.length) return { ok: true, lines: 0, lastHash: '' }
  const lastHash = createHash('sha256').update(lines[lines.length - 1]).digest('hex').slice(0, 12)
  return { ok: true, lines: lines.length, lastHash }
}

/** 单个仓的 HEAD 与是否干净。git 不可用时如实说，不假装成功。 */
export function gitState(dir) {
  try {
    const head = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    const porcelain = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
    const dirty = porcelain ? porcelain.split('\n').length : 0
    return { ok: true, head, dirty }
  } catch {
    return { ok: false, head: '', dirty: 0 }
  }
}

/** 直连 127.0.0.1 探端口。不走 HTTP，避免代理造成假象。 */
export function probePorts(ports = PORTS, timeout = 250) {
  return Promise.all(ports.map((port) => new Promise((done) => {
    const s = net.connect({ host: '127.0.0.1', port })
    s.setTimeout(timeout)
    s.on('connect', () => { s.destroy(); done({ port, up: true }) })
    s.on('timeout', () => { s.destroy(); done({ port, up: false }) })
    s.on('error', () => done({ port, up: false }))
  })))
}

/** 只读体检。路径全部运行时拼出来，源码里不留任何机器的绝对路径。 */
export async function check(opts = {}) {
  const home = opts.home ?? homedir()
  const root = opts.root ?? resolve(fileURLToPath(new URL('..', import.meta.url)))
  const priv = opts.priv ?? resolve(root, '..', 'fish-private')
  const ledgerPath = join(home, '.dsh-fish', 'events.jsonl')
  const snapshot = join(priv, 'vault', 'fish-vault.tar.gz.enc')

  let snap = { ok: false, kb: 0, mtime: '' }
  try {
    const st = statSync(snapshot)
    const d = st.mtime
    const pad = (n) => String(n).padStart(2, '0')
    const mtime = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    snap = { ok: true, kb: Math.round(st.size / 1024), mtime }
  } catch { /* 没有分片包时再看下面 */ }

  return {
    platform: process.platform,
    ledger: ledgerStats(ledgerPath),
    ledgerPath,
    repos: {
      主仓: gitState(root),
      子仓: gitState(join(root, 'dsh-fish')),
    },
    ports: await probePorts(),
    snapshot: snap,
  }
}

export function render(r) {
  const out = []
  out.push(`平台        ${r.platform}`)
  out.push(`账本        ${r.ledger.ok ? `${r.ledger.lines} 行 · 尾指纹 ${r.ledger.lastHash || '（空）'}` : '读不到（没启动过或路径不对）'}`)
  for (const [name, g] of Object.entries(r.repos)) {
    out.push(`${name}        ${g.ok ? `${g.head} · ${g.dirty ? `${g.dirty} 个未提交改动（先提交再交接）` : '干净'}` : 'git 不可用 / 不是仓'}`)
  }
  const up = r.ports.filter((p) => p.up).map((p) => p.port)
  out.push(`服务端口    ${up.length ? `仍在跑：${up.join(' ')} → 先停全栈，别交接` : '全部 DOWN · 可安全交接'}`)
  out.push(`加密快照    ${r.snapshot.ok ? `${r.snapshot.kb} KB · ${r.snapshot.mtime}` : '没找到（分片包请人工核对）'}`)
  out.push('')
  out.push('交接前必做：两端不能同时跑她；账本行数与尾指纹逐字一致才算成功。')
  out.push('out / in 尚未交付：会整份覆盖数据目录，需手机在线端到端验证后再实现。')
  return out.join('\n')
}

const args = process.argv.slice(2)
const cmd = args.find((a) => !a.startsWith('-')) ?? 'check'

if (cmd !== 'check' && !args.includes('--check')) {
  console.log(`${cmd}: 尚未交付。`)
  console.log('原因：这一步会整份覆盖数据目录，必须在手机在线时做过一次真实的双向接管、')
  console.log('并验证账本行数与尾指纹一致之后才能交付。现在手机不在线，不做未经验证的脚本。')
  console.log('当前可用：node scripts/swap.mjs --check（只读体检）')
  process.exit(0)
}

console.log(render(await check()))
