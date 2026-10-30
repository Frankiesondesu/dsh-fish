/**
 * 宿主版本自检（2026-10-30 m03193）
 *
 * 市场惯例（扫本机 ~/.dsh/profiles/*\/node_modules 得出）：插件在 package.json 里写
 *   "engines": { "dsh": ">=0.2.0-rc.1 <0.3.0-0" }
 * 宿主安装/检查时读这个键，把不满足的项按 `engines.dsh` 报出来。这里的常量必须和
 * package.json 里那条**一字不差**，test/hostver.test.mjs 会盯着它们不分叉。
 *
 * 运行时再对一次账：宿主版本不在范围内时只留话、不拒绝启动——旧版本里大部分功能
 * 仍然能用，硬拒会把人挡在门外，而这条信息本来就该由人自己判断。
 *
 * 零依赖：只用 node:fs / node:path / node:url，加上同目录的版本比较。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersion } from './upgrade.js'

/** 支持范围。改这里必须同步改 package.json 的 engines.dsh。 */
export const SUPPORTED_RANGE = '>=0.2.0-rc.1 <0.3.0-0'

/** 宿主包名：桌面版是 dsh-desktop-runtime，Web/headless 是 dsh。 */
const HOST_PKGS = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-runtime']

/**
 * 从插件自己的位置往上找宿主的 package.json。
 * 插件装在 profile 的 node_modules 下，宿主也在同一棵树里；桌面版则挂在 app.asar 内，
 * 这种情况找不到——返回 null，按 unknown 处理，不报错。
 *
 * @param {{start?: string, exists?: Function, read?: Function, pkgNames?: string[]}} [opts]
 * @returns {{version: string, pkg: string, file: string} | null}
 */
export function readHostVersion({ start, exists = existsSync, read = readFileSync, pkgNames = HOST_PKGS } = {}) {
  let dir
  try {
    dir = resolve(start ?? dirname(fileURLToPath(import.meta.url)))
  } catch {
    return null
  }
  for (let i = 0; i < 8; i += 1) {
    for (const pkg of pkgNames) {
      const file = join(dir, 'node_modules', pkg, 'package.json')
      if (!exists(file)) continue
      try {
        const j = JSON.parse(read(file, 'utf8'))
        if (typeof j?.version === 'string' && j.version.trim()) {
          return { version: j.version.trim(), pkg, file }
        }
      } catch {
        // 坏 json：继续往上找，不因为一个坏文件判死
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 只认 `>=X <Y` 这种两头写法（我们自己发射的范围就是这个形状），
 * 解析不出来就给空串，交给 checkHost 当 unknown。
 *
 * @param {string} range
 * @returns {{min: string, max: string}}
 */
export function parseRange(range) {
  const s = String(range ?? '')
  const VER = 'v?(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)'
  const minM = new RegExp(`>=\\s*${VER}`).exec(s) ?? new RegExp(`\\^\\s*${VER}`).exec(s)
  const maxM = new RegExp(`<\\s*${VER}`).exec(s)
  return { min: minM ? minM[1] : '', max: maxM ? maxM[1] : '' }
}

/**
 * 判定宿主版本是否在我们声明过的范围里。
 *
 * status：supported / older / newer / unknown。ok 只在 supported 时为真。
 *
 * @param {{version?: string, range?: string}} [opts]
 * @returns {{ok: boolean, status: string, version: string, range: string, why: string}}
 */
export function checkHost({ version, range = SUPPORTED_RANGE } = {}) {
  const v = String(version ?? '').trim()
  if (!v) {
    return { ok: false, status: 'unknown', version: '', range, why: '没找到宿主版本号（桌面版把宿主装进 app.asar，读不到）' }
  }
  if (!/^\d+\.\d+\.\d+/.test(v)) {
    return { ok: false, status: 'unknown', version: v, range, why: `宿主版本号看不懂：${v}` }
  }
  const { min, max } = parseRange(range)
  if (min && compareVersion(v, min) < 0) {
    return { ok: false, status: 'older', version: v, range, why: `这个宿主（${v}）比支持的下限 ${min} 还旧` }
  }
  if (max && compareVersion(v, max) >= 0) {
    return { ok: false, status: 'newer', version: v, range, why: `这个宿主（${v}）超出了支持的上限 ${max}` }
  }
  if (!min && !max) {
    return { ok: false, status: 'unknown', version: v, range, why: `支持范围看不懂：${range}` }
  }
  return { ok: true, status: 'supported', version: v, range, why: '' }
}
