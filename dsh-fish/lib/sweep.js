/**
 * sweep.js —— 硬盘上的缓存要有人扫（fork.52，2026-11-05）
 *
 * 用户问：「发给她的文件最后怎么处理的？不会一直存在我电脑里吧。」
 * 查下来：**不会清**。`media.js` 里明明写了 `MEDIA_TTL_MS = 3 天`、也写了
 * `sweepMedia()`，但全仓库**没有任何地方调用它**——四天 40MB，一年 3.6G。
 * `home/inbox/`（他发的文件、聊天记录）和 `voice/`（她说成声音的 mp3）
 * 更是连期限都没有。
 *
 * 这里把三处收口，各给一个期限：
 *   media/        他发来的图、截图              3 天
 *   home/inbox/   他发来的文件、转发的聊天记录   7 天（文件比图更值得留）
 *   voice/        她说成声音的 mp3               3 天
 *
 * 三条纪律：
 *   ① **只删这三个目录里的普通文件**。账本、日记、配置、她的房间，一个字不碰。
 *   ② 期限填 0 或负数 = 关掉这一项，不是"立刻全删"（那会把她刚收到的图删掉）。
 *   ③ 删不掉不算错（可能正被别的程序占着），下一轮再试。
 *
 * 删了就删了，不写账本、不通知她。她要是提起旧文件，`her_open` 会打不开——
 * 那是真话（文件确实没了），比替她记一笔「这个过期了」更像她那边会发生的事。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { paths, rootDir } from './store.js'
import { sweepMedia } from './media.js'

const DAY_MS = 86_400_000

export const RETENTION_DEFAULTS = Object.freeze({
  mediaDays: 3,
  inboxDays: 7,
  voiceDays: 3,
})

function days(v, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(0, Math.min(365, n))
}

/** 从 config.retention 读，缺的用默认。 */
export function retentionOf(config = {}) {
  const raw = config?.retention ?? {}
  return {
    mediaDays: days(raw.mediaDays, RETENTION_DEFAULTS.mediaDays),
    inboxDays: days(raw.inboxDays, RETENTION_DEFAULTS.inboxDays),
    voiceDays: days(raw.voiceDays, RETENTION_DEFAULTS.voiceDays),
  }
}

/**
 * 按 mtime 清一个目录。只删普通文件；子目录一概不碰
 * （她屋里以后要是长出别的东西，不该被一个清理函数带走）。
 */
async function sweepDir(dir, now, ttlMs) {
  let removed = 0
  let kept = 0
  let names = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return { removed, kept } // 目录不存在 = 没什么可清
  }
  for (const name of names) {
    const p = join(dir, name)
    try {
      const st = await fs.stat(p)
      if (!st.isFile()) continue
      if (now - st.mtimeMs > ttlMs) {
        await fs.unlink(p)
        removed++
      } else kept++
    } catch {
      kept++
    }
  }
  return { removed, kept }
}

/**
 * 扫一遍。任何一项的期限 <= 0 就跳过那一项。
 * @returns {{removed:number, media:object, inbox:object, voice:object, retention:object}}
 */
export async function sweepCaches(root = rootDir(), { now = Date.now(), config = {}, log } = {}) {
  const r = retentionOf(config)
  const say = typeof log === 'function' ? log : () => {}
  const base = paths(root).root

  const media = r.mediaDays > 0
    ? await sweepMedia(root, { now, ttlMs: r.mediaDays * DAY_MS })
    : { removed: 0, kept: 0, skipped: true }
  const inbox = r.inboxDays > 0
    ? await sweepDir(join(base, 'home', 'inbox'), now, r.inboxDays * DAY_MS)
    : { removed: 0, kept: 0, skipped: true }
  const voice = r.voiceDays > 0
    ? await sweepDir(join(base, 'voice'), now, r.voiceDays * DAY_MS)
    : { removed: 0, kept: 0, skipped: true }

  const removed = media.removed + inbox.removed + voice.removed
  if (removed) {
    say(`缓存清理：图 ${media.removed} / 文件 ${inbox.removed} / 语音 ${voice.removed}` +
      `（保留 ${r.mediaDays} / ${r.inboxDays} / ${r.voiceDays} 天）`)
  }
  return { removed, media, inbox, voice, retention: r }
}

/** 给设置页/体检用的一句话。 */
export function retentionLine(config = {}) {
  const r = retentionOf(config)
  const part = (v, label) => (v > 0 ? `${label} ${v} 天` : `${label} 不清`)
  return [part(r.mediaDays, '图'), part(r.inboxDays, '文件'), part(r.voiceDays, '语音')].join(' · ')
}
