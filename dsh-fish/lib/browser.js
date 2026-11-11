/**
 * browser.js —— 找一个能无头渲染的本机浏览器（2026-11-11，Linux 部署）
 *
 * her_formula 从 2026-11-09 起就靠无头浏览器把一页 HTML 截成 PNG；
 * her_draw 在 Windows 上走 PowerShell + GDI，在 Linux 上没有 GDI，
 * 改成同一套浏览器通路（画到 canvas 再导出 PNG）。两处共用这一份候选表，
 * 别再各写一份——路径会漂，漂了就是「这台机器画不出来」。
 *
 * 只做两件事：找路径、给无头参数。不 import 任何依赖。
 */

import { existsSync } from 'node:fs'

/**
 * 按优先级找浏览器。返回可执行文件路径；找不到返回空串（不抛）。
 * 环境变量（FISH_DRAW_BROWSER / EDGE_PATH / CHROME_PATH）优先，
 * 方便装在非常规目录或容器里。
 */
export function browserPath(env = process.env) {
  const cands = [
    env.FISH_DRAW_BROWSER,
    env.EDGE_PATH,
    env.CHROME_PATH,
    // Windows
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    // macOS
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // Linux（Debian/Ubuntu 常见包名；snap 单独列）
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].filter(Boolean)
  return cands.find((p) => { try { return existsSync(p) } catch { return false } }) ?? ''
}

/** 无头浏览器的公共参数。profile 固定可复用，冷启动快很多。 */
export function browserArgs(profile) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    `--user-data-dir=${profile}`,
  ]
  if (process.platform === 'linux') {
    // 服务器/容器里 Chromium 常因命名空间限制起不来；这里渲染的是本机生成的
    // 可信页面（她的绘图指令 / 公式稿），不加载外部网页，关沙箱的边界是清楚的。
    args.push('--no-sandbox', '--disable-dev-shm-usage')
  }
  return args
}
