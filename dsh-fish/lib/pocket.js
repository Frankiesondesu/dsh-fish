/**
 * pocket.js —— 出门口袋（2026-10-28 用户 m01145 拍板的「干活模式」；0.6.16 从 observe.js 搬出来）
 *
 * 为什么要有它：她的白板与交接账本按**工作区**注入。只要出门的目标是
 * `D:\deepseekagent`，那些实现细节就会跟着记忆一起进她的会话——
 * 真机 5fd70849 那趟就是这么漏的。口袋是一个**从没写过记忆的空目录**，
 * 注入只剩骨架；她的身份、工具、网络都照常。
 *
 * 代价（写进 UI，不藏着）：沙箱的写权限跟工作区走，她在口袋里写不进
 * `02-我的项目` / `03-我的文档`——要交付就从口袋搬。这条取舍无法两全。
 *
 * 为什么要单独一个文件（0.6.16）：这段之前埋在 observe.js 里，
 * 路由一测就带着整个宿主上下文；搬出来之后「登记失败仍能出门」这种判据
 * 才能用假 registry 直接测（用户 m01613 第⑤条）。
 */
import fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const POCKET_TITLE = '出门口袋'

/** 口袋路径：配置 `outingPocket` 优先；缺省放用户目录下（ASCII，避开中文路径那条老坑）。 */
export function pocketDirPath(config) {
  const raw = String(config?.outingPocket ?? '').trim()
  if (raw) return raw
  return join(homedir(), 'outing-pocket')
}

/** 比对路径用：Windows 大小写不敏感。只比对，不做文件访问。 */
function pathKey(p) {
  const s = String(p ?? '')
    .split(String.fromCharCode(92)).join('/')
    .replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/**
 * 建好口袋目录，并登记成工作区（登记失败也能出门：`sc.create({ cwd })` 是退路）。
 * `registered:false` 时 UI 会写明——那时记忆分区可能落到「未知工作区」。
 *
 * @param {object} ctx    宿主 ctx（只用 `get('workspaceRegistry')`）
 * @param {string} root   她的屋子（保留参数：日志与将来可能的记忆分区要用）
 * @param {object} config 读好的配置
 * @returns {Promise<{ok:boolean, wsId:string, dir:string, registered:boolean, why?:string}>}
 */
export async function ensurePocket(ctx, root, config) {
  const dir = pocketDirPath(config)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    return { ok: false, why: `建口袋目录失败：${String(err?.message ?? err).slice(0, 140)}`, dir, wsId: '', registered: false }
  }
  let reg = null
  try { reg = ctx?.get?.('workspaceRegistry') ?? null } catch { reg = null }
  let wsId = ''
  try {
    const list = typeof reg?.list === 'function' ? reg.list() : []
    const found = list.find((w) => w && pathKey(w.path) === pathKey(dir))
    wsId = String(found?.id ?? found?.workspaceId ?? '')
  } catch { /* 列不出来就试着建 */ }
  if (!wsId && typeof reg?.create === 'function') {
    try {
      const ws = await reg.create(dir, POCKET_TITLE)
      wsId = String(ws?.id ?? ws?.workspaceId ?? '')
    } catch (err) {
      return { ok: true, wsId: '', dir, registered: false, why: `登记工作区失败：${String(err?.message ?? err).slice(0, 120)}` }
    }
  }
  return { ok: true, wsId, dir, registered: Boolean(wsId) }
}
