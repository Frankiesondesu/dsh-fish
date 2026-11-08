/**
 * root.mjs —— 外围脚本（viewer / bridge / launch）怎么找到「她住在哪」。
 *
 * 为什么单独一个文件：这三个脚本一直把 '<用户主目录>/.dsh-fish' 写死在源码里，
 * 换一台电脑就得回去改 4 处源码——那不是「快速迁移」，那是每次都要重新踩一遍。
 *
 * 插件本体（`dsh-fish/lib/locate.js`，2026-10-28 m06510）早就解决过这件事，优先级是：
 *   1. 环境变量 `DSH_FISH_HOME`
 *   2. 指针文件 `~/.dsh-fish-location.json` 的 `root` 字段（搬家后写在里面的新位置）
 *   3. 老默认值 `~/.dsh-fish`
 * 这里**照抄同一套**，绝不引第二套规则——两边必须算出同一个目录，
 * 否则桥会把「插件的家」认成「另一个家」，然后盯着一个不动的账本干等。
 *
 * 指针文件在数据目录**之外**（`~/.dsh-fish-location.json`，不是 `<root>/location.json`）：
 * 放里面就等于搬家时把门牌号一起搬走了。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 指针文件的绝对路径。注意它在数据目录之外。 */
export function locationFile() {
  return process.env.DSH_FISH_LOCATION || join(homedir(), '.dsh-fish-location.json')
}

/** 默认位置（没迁移过时用的那个）。 */
export function defaultRoot() {
  return join(homedir(), '.dsh-fish')
}

/**
 * 读指针文件里记的位置。读不到、读坏了、字段不是绝对路径，一律返回空串
 * ——**绝不抛**。调用它的都是启动期代码，抛一次整个进程就起不来。
 */
export function readLocationSync() {
  try {
    const j = JSON.parse(readFileSync(locationFile(), 'utf8'))
    const root = typeof j?.root === 'string' ? j.root : ''
    // 只认绝对路径：相对路径搬一次就指到别处去了，比没有还坏
    return /^[A-Za-z]:[\\/]|^[\\/]{2}|^\//.test(root) ? root : ''
  } catch {
    return ''
  }
}

/** 顺序与 `dsh-fish/lib/store.js` 的 rootDir() 完全一致。 */
export function fishRoot() {
  return process.env.DSH_FISH_HOME || readLocationSync() || defaultRoot()
}

/**
 * 她那条 DSH 会话的目录。
 *
 * DSH 把会话 cwd 做成了目录名：`:` `\` `/` 全换成 `-`，前后各加 `--`。
 * 例：`<用户主目录>\.dsh-fish\home` → `--C-Users-<用户名>-.dsh-fish-home--`
 * （2026-11-06 对着真实目录名核过）。
 *
 * 这段规则是 DSH 的，不是我们的——它变了这里就得跟着变，所以算错了表现为
 * 「查看器的会话列表空着」，不会崩。
 */
export function dshSessionsDir(root = fishRoot()) {
  // ⚠️ 是 `[:\/]+` 不是 `[:\/]`：`C:\Users` 里的「冒号+反斜杠」两个字符只换出**一个**
  // 横线（真实目录是 `--C-Users-...`）。逐字符替换会得到 `--C--Users-...`，多一个横线，
  // 结果是 existsSync 恒为 false、查看器会话列表永远空着——而且不报错，很难发现。
  const slug = join(root, 'home').replace(/[:\\/]+/g, '-')
  const base = join(homedir(), '.dsh', 'sessions')
  const guess = join(base, `--${slug}--`)
  if (existsSync(guess)) return guess
  // 兜底：DSH 的编码规则不是我们的，将来它改了我们也不能跟着瞎猜。
  // 算出来的不存在时，就去目录里找后缀对得上的那个。
  try {
    const hit = readdirSync(base).find((d) => d.endsWith(slug + '--'))
    if (hit) return join(base, hit)
  } catch {
    /* 没有 sessions 目录就是没有，不算错 */
  }
  return guess
}

/**
 * WorkBuddy 内置 python 的候选路径。
 *
 * 原来写死 `.../python/versions/3.13.12/python.exe`——路径里带版本号，WorkBuddy
 * 一升级就失效（launch.mjs 自己的注释就吐槽过这件事，但它自己也写死了）。
 * 这里改成扫目录：版本号降序，存在的才算。
 */
export function workbuddyPythons() {
  const base = join(homedir(), '.workbuddy', 'binaries', 'python', 'versions')
  try {
    return readdirSync(base)
      .filter((d) => existsSync(join(base, d, 'python.exe')))
      // numeric 让 3.13.12 排在 3.9.1 前面（字符串比较会反过来）
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
      .map((d) => join(base, d, 'python.exe'))
  } catch {
    return []
  }
}
