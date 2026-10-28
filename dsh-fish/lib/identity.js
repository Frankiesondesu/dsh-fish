/**
 * identity.js —— 把「此刻的她」送进 **system 角色**，而不是送进对话
 *
 * 为什么换掉 AGENTS.md（2026-10-25）：
 *   原来身份写在 `<她的屋子>/home/AGENTS.md`，靠宿主的「工作区指令」注入。
 *   那条链路（内核 0.2.1-rc.3 已核实）注入的是**普通的 user 消息**，
 *   带 `<system-reminder>` 外壳、会留在对话历史里——用户一眼就看见
 *   「规则约束/人格设定」，等于把她每一轮都在读的东西摊开给人看。
 *
 *   宿主还有另一条路：`agent.ctx.systemPrompt.section({ name, order, text })`。
 *   它渲染成 **system 角色消息**（surface 节点 0），**不进对话历史**，
 *   面板与对话框里都看不到；`text` 允许传函数，每次组装提示词时才求值，
 *   所以内容变了下一轮就生效，不需要重建会话。
 *
 * 为什么不直接每次读文件：
 *   `text()` 是同步求值，不能 await。这里用 mtime 缓存：
 *   文件没变就直接返回上次的字符串，变了才 `readFileSync`。
 *   文件很小（几 KB），一次 stat 的成本可以忽略。
 *
 * 边界：
 *   - 拿不到 `systemPrompt`（宿主版本不同）→ 返回 `{ ok:false }`，记一条日志，不崩。
 *     这种情况下身份会**完全不可见**（因为不再写 AGENTS.md）——宁可让她少一段，
 *     也不要把设定重新塞回对话里。缺了会由 `/selfcheck` 的 `identity` 项报出来。
 *   - 只挂在她那个 agent 上（判据 herDir == 会话 cwd），不影响用户自己的会话。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { selfDocPath } from './selfdoc.js'
import { cwdOf, isHerHome } from './restrict.js'
import { activeOutingSync, bindOutingSession } from './outing.js'

/** 段名与顺序：放在宿主自己的段之后、`complete` 段之前（order 越大越靠后）。 */
export const IDENTITY_SECTION = 'fish:identity'
export const IDENTITY_ORDER = 8500

/**
 * 「这一次的处境」段（2026-10-25 晚）。
 *
 * 为什么另开一段（用户 m04080 报的问题）：
 *   定时唤醒、自动刷 B 站推视频给她时，唤醒消息原来整段走 `sc.prompt()` 进对话，
 *   于是他在对话框里看见「你该醒了」「这次推给你的是……」这些系统说的话。
 *   宿主没有「模型看得见、用户看不见」的注入通道（核对过 asar：
 *   `PromptContentPart` 没有 hidden 字段，`SurfaceOp` 只有 append/replace，
 *   append 就一定进人类可见的对话流）。所以唯一的办法是**不把它放进对话**——
 *   正文改从 system prompt 走，对话里只留一句极短的触发语。
 *
 * 生命周期：`setWakeSection()` 在 `sc.prompt()` **之前**写好，
 * 她这一轮组装提示词时求值拿到；`turn/end` 之后立刻 `clearWakeSection()`，
 * 免得他之后主动聊天时她还带着上一次的「此刻处境」。
 */
export const WAKE_SECTION = 'fish:wake'
export const WAKE_ORDER = 8700

/** 这一次唤醒的处境正文；空串表示没有（正常聊天时就是空）。 */
let wakeText = ''

/**
 * 设这一次的处境正文。传空串等于清掉。
 * @param {string} text
 */
export function setWakeSection(text) {
  wakeText = String(text ?? '')
}

/** 清掉。回合结束、唤醒失败、插件卸载时都要调。 */
export function clearWakeSection() {
  wakeText = ''
}

/** 测试用：看现在挂着什么。 */
export function getWakeSection() {
  return wakeText
}

const cache = { file: '', mtimeMs: -1, text: '' }

/**
 * 读她的身份文本（带 mtime 缓存）。永不抛。
 * @param {string} root
 * @returns {string} 文件不存在时返回空串
 */
export function identityText(root) {
  try {
    const file = selfDocPath(root)
    const st = statSync(file)
    if (cache.file !== file || cache.mtimeMs !== st.mtimeMs) {
      cache.text = readFileSync(file, 'utf8')
      cache.file = file
      cache.mtimeMs = st.mtimeMs
    }
    return cache.text
  } catch {
    return cache.text
  }
}

/** 测试用：清掉缓存，强制下次重新读盘。 */
export function resetIdentityCache() {
  cache.file = ''
  cache.mtimeMs = -1
  cache.text = ''
}

/**
 * 把身份段挂到某个 agent 的 system prompt 上。
 * @param {object} agent
 * @param {string} root
 * @returns {{ ok: boolean, why?: string }}
 */
export function attachIdentity(agent, root, { frozen = '' } = {}) {
  const sp = agent?.ctx?.systemPrompt
  if (!sp || typeof sp.section !== 'function') {
    return { ok: false, why: '宿主的 agent.ctx 上没有 systemPrompt.section（版本不支持）' }
  }
  try {
    const snapshot = String(frozen ?? '')
    sp.section({
      name: IDENTITY_SECTION,
      order: IDENTITY_ORDER,
      // 出门时 `frozen` 是出门那一刻的只读副本：她在外面读到的是「离开时的自己」，
      // 而不是家里随时可改的那份文件 —— 否则人已经出去了，身份还能被自己在别处改写。
      text: () => (snapshot ? snapshot : identityText(root)),
    })
    // 「这一次的处境」单独一段：平时是空串（等于不存在），唤醒前才填。
    // 它不进对话历史，所以他看不到系统在跟她说些什么。
    sp.section({
      name: WAKE_SECTION,
      order: WAKE_ORDER,
      text: () => wakeText,
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 200) }
  }
}


/** 把路径归一成可比较的串（Windows 大小写与反斜杠都要抹平）。 */
export function flatPath(p) {
  const s = String(p ?? '').split(String.fromCharCode(92)).join('/')
  return (s.endsWith('/') ? s.slice(0, -1) : s).toLowerCase()
}

/**
 * 出门时除了她自己的屋子，还有什么不许碰（2026-10-28，用户 m01127 拍板）。
 *
 * 为什么连宿主家也要挡：她的白板、交接账本、每日日志都在
 * `<用户目录>/.dsh/memory` 里——读得到，就等于把「守卫怎么做的、基线怎么记的」
 * 摊开给她看。`sessions` 是所有会话原文，`profiles` 是配置与插件。
 *
 * 只挡「文件工具按路径去翻」这一条路；记忆类工具（参数是关键词）不在这一层挡，
 * 用户拍板保留（m01145「保留记忆工具」）——那几条结论由白板的写法决定。
 *
 * @returns {string[]} 小写化、可做子串比对的路径片段
 */
export function awayBlockedPaths({ root, herDir } = {}) {
  const out = [flatPath(herDir), flatPath(root)].filter((w) => w.length > 3)
  // 她的屋子 `<用户目录>/.dsh-fish` 的上一级，就是宿主的家 `<用户目录>/.dsh`。
  const hostHome = String(root ?? '').replace(/[\\/][^\\/]*$/, '')
  if (hostHome) {
    for (const sub of ['memory', 'sessions', 'profiles']) {
      const dir = `${hostHome}/.dsh/${sub}`
      if (existsSync(dir)) out.push(flatPath(dir))
    }
  }
  return out
}

/**
 * 出门时的兜底守卫（方案 3.5 第②层）：
 * `restrict` 挡的是「看不见」，它挡不住写文件这件更直接的事。
 * 这一层只做一件事：**任何工具调用里出现她家里的路径，就拒绝**。
 *
 * 为什么按路径而不是按工具名：外面能用什么工具取决于那个工作区，
 * 不该替人决定；能决定的是「不许伸手回自己屋子」。
 * 拒绝话术与 restrict 里的 guard 一致：不带「权限/禁止」，她该以为是自己做不到。
 */
export function attachAwayGuard(agent, { root, herDir, log } = {}) {
  const scoped = agent?.ctx?.tools
  if (typeof scoped?.guard !== 'function') {
    return { ok: false, why: '宿主的 agent.ctx 上没有 tools.guard（这一层没挂上）' }
  }
  const words = awayBlockedPaths({ root, herDir })
  if (!words.length) return { ok: false, why: '拿不到她屋子的路径' }
  let blocked = 0
  try {
    const dispose = scoped.guard((exec) => {
      const parts = []
      const walk = (v, depth) => {
        if (depth > 4 || v == null || parts.length > 400) return
        if (typeof v === 'string') { parts.push(v); return }
        if (typeof v !== 'object') return
        if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return }
        let keys = []
        try { keys = Object.keys(v) } catch { return }
        for (const k of keys) {
          let x = null
          try { x = v[k] } catch { continue }
          walk(x, depth + 1)
        }
      }
      // 宿主真实形状是 `exec.arguments`（dsh-tools 的 createExecution 只挂这一个字段）。
      // 0.6.3 真机踩过：只认 args/input/params → 守卫每次看到的都是空对象，
      // 日志写着「挂上了」，实际一次也没拦（session-3f0d99a2 里它照读了 PLAN.md）。
      try { walk(exec?.arguments ?? exec?.args ?? exec?.input ?? exec?.params ?? {}, 0) } catch { /* 拿不到实参就只能放行 */ }
      const joined = flatPath(parts.join(' '))
      if (words.some((w) => joined.includes(w))) {
        if (blocked < 10) {
          blocked += 1
          log?.('[dsh-fish] 在外面挡住了一次伸回自己屋里的调用')
        }
        return '这件事我做不到。'
      }
      return undefined
    })
    try { agent.ctx.effect?.(() => dispose) } catch { /* 没 effect 就靠父级回收 */ }
    return { ok: true }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 160) }
  }
}

/**
 * 注册 `agent/created` 监听。**必须先于任何 agent 创建**（与工具面收窄同理），
 * 所以 index.js 里放在 ensureHer 之后、bootstrapHome 之前。
 *
 * @returns {() => void} 卸载函数；挂不上时返回一个空函数，不抛
 */
export function registerIdentity(ctx, { root, herDir, log } = {}) {
  const state = { ok: false, applied: 0, why: '' }
  const onCreated = ({ agent } = {}) => {
    try {
      if (!herDir) return
      // 0.6.3：判据从「在她屋里」放宽成「是她」——出门那一位也得带着身份，
      // 否则她在外面会失去全部来历。出门名单只有一条 active，读档失败当没出门。
      const outing = activeOutingSync(root)
      const sid = String(agent?.session?.header?.id ?? agent?.session?.id ?? '')
      const cwd = cwdOf(agent)
      const home = isHerHome(agent, herDir)
      // 出门那条会话怎么认出来（三种都认：`agent/created` 的时机不一定带 cwd）：
      // ① 台账里已经记了会话 id，对上了；
      // ② cwd 就是出门那个工作区；
      // ③ 台账刚写、id 还空着（start 路由「先记账再建会话」），而这条会话还没有 cwd。
      const sidMatch = Boolean(
        outing?.sessionId && sid &&
        (sid === outing.sessionId || sid === String(outing.sessionId).replace(/^session-/, '')),
      )
      const cwdMatch = Boolean(outing?.cwd && flatPath(cwd) && flatPath(cwd) === flatPath(outing.cwd))
      const starting = Boolean(outing && !outing.sessionId && !cwd)
      const isOuting = sidMatch || cwdMatch || starting
      if (!home && !isOuting) {
        if (outing) log?.(`[dsh-fish] 有条出门记录，但这条会话没对上：cwd=${cwd || '(空)'} sid=${sid || '(空)'}`)
        return
      }
      const outside = isOuting
      // ③ 那种情况顺手把 id 补进台账；写盘是异步的，钩子不能等，失败就算了。
      if (outside && sid && !outing?.sessionId) void bindOutingSession(root, { sessionId: sid }).catch(() => {})
      const r = attachIdentity(agent, root, { frozen: outside ? outing.identity : '' })
      if (outside) {
        const g = attachAwayGuard(agent, { root, herDir, log })
        if (g.ok) log?.('[dsh-fish] 外面这一条挂上了兜底守卫')
        else log?.(`[dsh-fish] 兜底守卫没挂上：${g.why}`)
      }
      if (r.ok) {
        state.ok = true
        state.applied += 1
        log?.(`[dsh-fish] 身份段已挂进 system prompt（第 ${state.applied} 次）`)
      } else {
        state.ok = false
        state.why = r.why ?? 'unknown'
        log?.(`[dsh-fish] 身份段没挂上：${state.why}`)
      }
    } catch (err) {
      state.why = String(err?.message ?? err).slice(0, 200)
      log?.(`[dsh-fish] 身份段挂了：${state.why}`)
    }
  }
  const off = ctx.on?.('agent/created', onCreated)
  if (typeof off !== 'function') {
    // 没挂上监听也别抛：index.js 会让插件照常启动，只是她的身份会缺一段。
    state.why = 'ctx.on 不可用'
    return () => {}
  }
  return off
}
