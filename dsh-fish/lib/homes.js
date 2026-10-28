/**
 * homes.js —— 「这台机器上有过哪些家」的唯一记账处（0.6.8，房客日志 m01863）
 *
 * 为什么必须记在数据目录之外：这一份记录的作用恰恰是**跨家比较**——
 * 要在启动时回答「这次住的 root 跟上次是不是同一间」。写进 root 里，
 * 换一次家就是一份新的、空的记录，永远比不出变化。
 *
 * 它只做两件事：
 *   1. 记住每次启动时真正生效的 root（`effRroot`，来自 baseConfig.root /
 *      DSH_FISH_HOME / 指针文件，见 index.js:41）；
 *   2. 跟上次比，不一样就告诉调用方「换家了，从 A 到 B」。
 *
 * **它不负责切换**。换家仍然是用户改 `cordis.patch.yml` 里那条配置、
 * 或者用搬家功能写指针；这里只留痕，让「我明明只开了一条，怎么多出来一间屋」
 * 这种问题在日志和观测台里一眼能看见。也绝不因为"发现换了"就去动老目录。
 */

import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { writeAtomic } from './store.js'

/** 记录文件的绝对路径（数据目录之外）。测试用 DSH_FISH_HOMES 指到临时目录。 */
export function homesFile() {
  return process.env.DSH_FISH_HOMES || join(homedir(), '.dsh-fish-homes.json')
}

/** 只比较用：统一小写、去掉尾分隔符。Windows 上盘符与路径大小写都可能变。 */
export function normRoot(p) {
  let s = resolve(String(p ?? ''))
  while (s.length > 1 && (s.endsWith(sep) || s.endsWith('/'))) s = s.slice(0, -1)
  return s.toLowerCase()
}

/** 读不到、读坏了、字段不对，一律当成「没有记录」，绝不抛。 */
export function readHomesSync(file = homesFile()) {
  try {
    const obj = JSON.parse(readFileSync(file, 'utf8'))
    const homes = Array.isArray(obj?.homes)
      ? obj.homes
        .map((h) => ({ root: String(h?.root ?? ''), lastAt: String(h?.lastAt ?? '') }))
        .filter((h) => h.root)
      : []
    return { lastRoot: String(obj?.lastRoot ?? ''), homes }
  } catch {
    return { lastRoot: '', homes: [] }
  }
}

/**
 * 记一次「这次住在哪」。返回 {changed, from, to, homes}。
 *
 * `changed` 的判据是规范化之后的 root 不同；同一个家换了个写法（大小写、尾斜杠）
 * 不算换家，免得每次启动都往事件流里灌一条假消息。
 */
export async function noteRoot(root, { now = () => Date.now(), file = homesFile(), keep = 20 } = {}) {
  const to = resolve(String(root ?? ''))
  const prev = readHomesSync(file)
  const from = prev.lastRoot
  const changed = Boolean(from) && normRoot(from) !== normRoot(to)
  const at = new Date(now()).toISOString()

  const others = prev.homes.filter((h) => normRoot(h.root) !== normRoot(to))
  const homes = [{ root: to, lastAt: at }, ...others].slice(0, Math.max(1, Number(keep) || 20))

  try {
    await writeAtomic(file, JSON.stringify({ lastRoot: to, lastAt: at, homes }, null, 2))
  } catch { /* 记不下来只影响下一次比对，不影响她的家本身 */ }

  return { ok: true, changed, from, to, homes }
}
