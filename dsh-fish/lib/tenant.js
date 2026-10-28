/**
 * tenant.js —— 「这条写入是谁发的、发给哪个家」的唯一校验口
 *
 * 为什么要有这个文件（2026-10-28 房客反馈，用户 m01319）：
 *   插件的数据目录（root）以前是**进程级**解析的（env → 迁移指针 → 默认路径），
 *   于是同一台机器上开两个工作区、或同一个人把插件文件夹搬过一次，就出现
 *   「两份大肥鱼都生效、共用同一份 events.jsonl」。写进去的事件没有「谁写的」，
 *   她自己也分不清那是哪一栋房子的事 —— 误认就发生在这里。
 *
 * 三条规矩（用户原话）：
 *   1. 写事件要带 sessionId（事件流里必须有「谁」）。
 *   2. 写之前校验调用者 cwd 属于当前 root，不属于就**拒绝并说明**，不许静默写进别人的屋子。
 *   3. 身份文件只允许 root 对应的那条会话写。
 *
 * 另外加一层「一个 root 只认一个实例」的占用声明（instance.json）：
 *   root 是进程级解析出来的，光靠调用者 cwd 分辨不出「两个实例指向同一个 root」——
 *   两边 cwd 都在同一个 root 里，校验会同时通过。所以必须在加载时就认出「这个家已经有人住」。
 */

import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import { activeOutingSync } from './outing.js'

/** 占用声明文件名（放在 root 里，跟着数据目录一起搬走）。 */
export const TENANT_FILE = 'instance.json'

/**
 * 声明的有效期。心跳每 15 秒一次，所以 45 秒 = 连掉三次心跳才算上一任已经没了。
 * 不能太长：崩过一次之后重启要能立刻接管。也不能太短：一次卡顿不该导致自己抢自己的家。
 */
export const CLAIM_TTL_MS = 45_000

/** 心跳间隔。 */
export const HEARTBEAT_MS = 15_000

const isWin = process.platform === 'win32'
/** Windows 写法的绝对路径：盘符（D:\）或 UNC（\\server\share）。 */
const WIN_ABS = /^[a-zA-Z]:[\\/]/
const UNC_ABS = /^\\\\[^\\]/

/** 归一化路径：绝对化、去掉末尾分隔符、Windows 下忽略大小写。 */
export function normPath(p) {
  const s = String(p ?? '').trim()
  if (!s) return ''
  // 2026-10-28 修（CI 在 ubuntu 上红）：`D:\a\home` 这种 Windows 写法的绝对路径，
  // 在 POSIX 上 resolve() 会把它当**相对路径**拼到 cwd 后面
  // （变成 /home/runner/.../D:\a\home），后面 isInside 的前缀判断就永远对不上。
  // 所以这类路径不看当前系统，一律按 Windows 规则归一：分隔符统一成 /、盘符路径小写。
  if (!isWin && (WIN_ABS.test(s) || UNC_ABS.test(s))) {
    let out = s.replace(/[\\/]+/g, '/')
    // 盘符根（C:/）保留末尾斜杠；其余去掉末尾分隔符
    if (!/^[a-zA-Z]:\/?$/.test(out)) out = out.replace(/\/+$/, '')
    return WIN_ABS.test(out) ? out.toLowerCase() : out
  }
  let out = resolve(s)
  // 盘符根（C:\）不能把反斜杠去掉，否则 isInside 的前缀判断会失准
  if (out.length > 3 || (out.length === 3 && !/[\\/]$/.test(out))) {
    out = out.replace(/[\\/]+$/, '')
  }
  return isWin ? out.toLowerCase() : out
}

/**
 * 进程还活着吗。只用来判断「上一个实例是不是崩了」：
 * 同一个家重启后，旧声明的心跳可能才过去几秒；只看 TTL 会把自己锁在门外 45 秒。
 */
export function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    // EPERM = 进程存在但不是我的（Windows 上常见）：仍算活着
    return err?.code === 'EPERM'
  }
}

/** child 是不是 parent 本身或在 parent 里。 */
export function isInside(child, parent) {
  // 比较前把两侧分隔符统一成 /：Windows 归一会给反斜杠，POSIX 上给正斜杠，
  // 混着比（比如 root 是 Windows 写法、cwd 是 POSIX 写法）会误判成「在外面」。
  const slash = (v) => (v ? v.replace(/[\\/]+/g, '/') : '')
  const c = slash(normPath(child))
  const p = slash(normPath(parent))
  if (!c || !p) return false
  if (c === p) return true
  return c.startsWith(p.endsWith('/') ? p : p + '/')
}

/** 取路径里最后一段目录名（用于拒绝话术里辨认「哪一栋房子」，不暴露整条路径给模型？这里只给日志用）。 */
export function leafName(p) {
  const parts = String(p ?? '').split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || ''
}

/**
 * 从宿主传进来的 ToolExecution 里读调用者。
 * exec.agent.session 是会话对象：id 在 session.id，cwd 在 session.header.cwd。
 * 没有 exec（单测、定时器、系统路径）时返回空，由 checkCaller 决定放不放行。
 */
export function callerOf(exec) {
  const session = exec?.agent?.session ?? exec?.session ?? null
  const id = session?.id ?? session?.header?.id ?? ''
  const cwd = session?.header?.cwd ?? session?.cwd ?? ''
  return {
    sessionId: id ? String(id) : '',
    cwd: cwd ? String(cwd) : '',
    sandbox: String(session?.header?.sandbox ?? ''),
  }
}

/**
 * 写入前的调用者校验。
 * @param {string} root 本实例的数据目录
 * @param {object} exec 宿主传的工具执行上下文（可能没有）
 * @param {object} opts { herDir, tool } herDir = root/her，她的会话 cwd 落在这里
 * @returns {{ok:boolean, sessionId:string, cwd:string, system?:boolean, unknownCwd?:boolean, why?:string}}
 */
export function checkCaller(root, exec, { herDir = '', tool = 'growth_commit', outsideOk = true } = {}) {
  const { sessionId, cwd } = callerOf(exec)
  // 1) 没有会话：定时器 / 测试 / 系统侧写入。这些本来就发生在 root 内部，放行。
  if (!sessionId && !cwd) {
    return { ok: true, sessionId: '', cwd: '', system: true }
  }
  // 2) 有会话但没有 cwd：宿主某种建会话方式不带 cwd。证明不了归属，但也不能
  //    因为「查不到」就把她写字的笔收走 —— 放行，事件里 cwd 留空，日志记一笔。
  if (!cwd) {
    return { ok: true, sessionId, cwd: '', unknownCwd: true }
  }
  // 3) cwd 必须在这个家里（root 或 root/her）。
  if (isInside(cwd, root) || (herDir && isInside(cwd, herDir))) {
    return { ok: true, sessionId, cwd }
  }
  // 3.5) 外面这一条：出门时她的会话 cwd 在别人的工作区里，但她写的事件还是要写回
  //      自己的屋子（不然回家审查什么都没有、旅行日记也永远写不出来）。
  //      判据不是 cwd，而是「这条会话正是当前那趟出门的会话」——两窝鱼互写仍然被挡。
  //      身份文件那条调用显式传 outsideOk:false：她出门时不能改自己的身份。
  if (outsideOk && sessionId) {
    let active = null
    try {
      active = activeOutingSync(root)
    } catch {
      active = null
    }
    if (active && String(active.sessionId ?? '') === sessionId) {
      return { ok: true, sessionId, cwd, outside: true }
    }
  }
  return {
    ok: false,
    sessionId,
    cwd,
    why:
      `这条调用来自另一个家（${cwd}），不是这里（${root}）。` +
      `为了不把话写进别人的屋子，${tool} 这次没有落盘。` +
      `如果这里就是她该待的地方，检查 profile 的 cordis.patch.yml 里这个插件的 root 配置；` +
      `如果你只是从别的窗口顺手点了一下，回到她自己的那条对话再说。`,
  }
}

/**
 * 占一个家。一个 root 同时只允许一个活着的实例。
 * @returns {Promise<{ok:boolean, instanceId:string, owner?:object, why?:string}>}
 */
export async function claimRoot(
  root,
  { version = '', now = Date.now(), instanceId = randomUUID(), pid = process.pid, host = hostname() } = {},
) {
  const file = join(root, TENANT_FILE)
  let prev = null
  try {
    prev = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    prev = null
  }

  // 三条同时成立才算「还住着」：有声明、心跳没过期、同机时那个进程真的还在。
  // 第三条是为了重启：旧声明的心跳可能才过去几秒，只看 TTL 会把自己锁在门外 45 秒。
  // 跨机器（共享盘）不查 pid —— 别人的 pid 在本地没有意义。
  const fresh = !!(prev && typeof prev === 'object' && prev.instanceId) && now - Number(prev.beatAt ?? 0) < CLAIM_TTL_MS
  const sameHost = !!prev && String(prev.host ?? '') === String(host)
  const alive = fresh && (!sameHost || pidAlive(prev.pid))
  if (alive && prev.instanceId !== instanceId) {
    return {
      ok: false,
      instanceId,
      owner: {
        instanceId: String(prev.instanceId),
        version: String(prev.version ?? ''),
        pid: Number(prev.pid ?? 0),
        beatAt: Number(prev.beatAt ?? 0),
        bootAt: Number(prev.bootAt ?? 0),
        dataDir: String(prev.dataDir ?? ''),
      },
      why:
        '这个数据目录已经被另一个插件实例占着（两份大肥鱼指向了同一个家）。' +
        '两边写进去的话会混在一条事件流里，她分不清是谁在跟她说话。' +
        '解决办法：给其中一个工作区在 profile 的 cordis.patch.yml 里单独配 root（或设置页里改数据目录），' +
        '让两个家真的分开。',
    }
  }

  const claim = {
    instanceId,
    version: String(version),
    pid: Number(pid),
    bootAt: prev && prev.instanceId === instanceId ? Number(prev.bootAt ?? now) : now,
    beatAt: now,
    host: String(host),
    dataDir: String(root),
  }
  try {
    await fs.writeFile(file, JSON.stringify(claim, null, 2) + '\n', 'utf8')
  } catch (err) {
    // 写不进去（只读盘 / 权限）不能等同于「有别人占着」：当没占成但也不拦，记原因。
    return { ok: true, instanceId, why: `占用声明没写成：${err?.code ?? err?.message ?? 'unknown'}` }
  }
  return { ok: true, instanceId }
}

/**
 * 心跳：只有自己还是房主时才续期。被别人接管后不再抢回来（否则两个实例会来回覆盖）。
 * @returns {Promise<boolean>} 还是不是房主
 */
export async function beatRoot(root, instanceId, { now = Date.now() } = {}) {
  if (!instanceId) return false
  const file = join(root, TENANT_FILE)
  try {
    const cur = JSON.parse(await fs.readFile(file, 'utf8'))
    if (cur?.instanceId !== instanceId) return false
    await fs.writeFile(file, JSON.stringify({ ...cur, beatAt: now }, null, 2) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 停用/卸载时让出这个家，让下一次加载能立刻接管。 */
export async function releaseRoot(root, instanceId, { now = Date.now() } = {}) {
  if (!instanceId) return false
  const file = join(root, TENANT_FILE)
  try {
    const cur = JSON.parse(await fs.readFile(file, 'utf8'))
    if (cur?.instanceId !== instanceId) return false
    await fs.writeFile(
      file,
      JSON.stringify({ ...cur, instanceId: '', releasedAt: now, beatAt: 0 }, null, 2) + '\n',
      'utf8',
    )
    return true
  } catch {
    return false
  }
}

/**
 * 给工具注册用的一层薄壳：把「检查 + 拒绝」写成统一形状，避免每个工具各写一遍。
 * @returns {{ok:true, sessionId:string} | {ok:false, note:string}}
 */
export function guardWrite(state, exec, tool) {
  // 房主的身份优先：root 已经被别人占着时，这个实例的任何写入都不该落盘。
  if (state && state.tenant && state.tenant.ok === false) {
    return { ok: false, note: state.tenant.why || '这个家被另一个实例占着，这次没有写。' }
  }
  const res = checkCaller(state?.root, exec, { herDir: state?.herDir, tool })
  if (!res.ok) return { ok: false, note: res.why }
  return { ok: true, sessionId: res.sessionId }
}
