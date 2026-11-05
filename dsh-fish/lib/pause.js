/**
 * pause.js —— 临时静音（fork.49，2026-11-05）
 *
 * 为什么不是「关掉」：
 * 要让她现在闭嘴，只有改 config.proactive.enabled=false（持久，容易忘了改回来）
 * 或者关 devMode（会一起带走 her_say / her_dream）。她需要的是一个**临时**状态：
 * 接下来两小时别主动找我，但我找她时她照常回。
 *
 * 语义（跟文档里的 PAUSE 对齐）：
 *   - 文件存在 → 调度器不再主动开回合。她安静，但不是被关掉。
 *   - **闹钟默认照响**：那是她自己给自己定的约定，不是系统给的机会。
 *     真要连闹钟一起静音（开会、录音、睡觉），在文件里写 `mute-alarm`。
 *   - 用户主动发消息时她照常回——静音的是"叫醒"，不是"对话"。
 *
 * 为什么用文件而不是配置项：
 * 配置是持久的、要重启/热载才生效；文件是即时的、可被任何脚本/人操作，
 * 而且"文件在不在"这个判断不依赖任何缓存。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { paths, rootDir, writeAtomic } from './store.js'

export const PAUSE_FILE = 'PAUSE'
/** 文件里写这四个字（大小写不敏感）就连闹钟一起静音。 */
export const MUTE_ALARM_HINT = 'mute-alarm'

export function pausePath(root = rootDir()) {
  return join(paths(root).root, PAUSE_FILE)
}

/**
 * 读状态。不抛：读不了就当没暂停（宁可多叫她一次，也不要因为文件权限
 * 让她永远醒不过来——那是最坏的一种失败）。
 */
export async function readPause(root = rootDir()) {
  const p = pausePath(root)
  try {
    const st = await fs.stat(p)
    let reason = ''
    try {
      reason = (await fs.readFile(p, 'utf8')).split('\n')[0].trim().slice(0, 80)
    } catch { /* 文件在但读不了，仍然算暂停 */ }
    return {
      paused: true,
      since: st.mtimeMs,
      reason,
      muteAlarm: reason.toLowerCase().includes(MUTE_ALARM_HINT),
    }
  } catch (err) {
    if (err.code === 'ENOENT') return { paused: false, since: 0, reason: '', muteAlarm: false }
    return { paused: false, since: 0, reason: '', muteAlarm: false, error: err.message }
  }
}

export async function isPaused(root = rootDir()) {
  return (await readPause(root)).paused
}

/**
 * 开 / 关。reason 会写进文件第一行——以后翻日志能知道"那天为什么安静"。
 * 关的时候文件不存在也算成功（幂等）。
 */
export async function setPause(root = rootDir(), { on = true, reason = '' } = {}) {
  const p = pausePath(root)
  if (on) {
    await writeAtomic(p, reason ? `${reason}\n` : '', 0o600)
    return { paused: true, reason }
  }
  try {
    await fs.unlink(p)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  return { paused: false, reason: '' }
}

/** 给日志/查看器用的一句话。 */
export function pauseLine(p) {
  if (!p?.paused) return '未暂停'
  const why = p.reason ? `（${p.reason}）` : ''
  const alarm = p.muteAlarm ? '，闹钟也静音' : '，闹钟照响'
  return `已暂停${why}${alarm}`
}
