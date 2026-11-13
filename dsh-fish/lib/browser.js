/**
 * browser.js —— 找一个能无头渲染的本机浏览器（2026-11-11，Linux 部署）
 *
 * her_formula 从 2026-11-09 起就靠无头浏览器把一页 HTML 截成 PNG；
 * her_draw 在 Windows 上走 PowerShell + GDI，在 Linux 上没有 GDI，
 * 改成同一套浏览器通路（画到 canvas 再导出 PNG）。两处共用这一份候选表，
 * 别再各写一份——路径会漂，漂了就是「这台机器画不出来」。
 *
 * 只做两件事：找路径、给无头参数。不 import 任何依赖。
 *
 * 2026-11-13：系统 Edge/Chrome 在「用户已经开着浏览器」时，会把无头
 * --dump-dom / --screenshot 请求转交给已有实例，新进程立刻退出，stdout 全空、
 * 截图也不落盘（Edge 152 实测，her_draw / her_formula 三条真渲染因此全挂）。
 * 所以候选表里把专用无头二进制 chrome-headless-shell（不抢单实例锁）排在
 * 系统浏览器前面。路径一律从环境变量推导，源码里不写任何本机用户名或绝对路径。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 找 Playwright 缓存里的 chrome-headless-shell。目录名带版本号，取最新的那份。
 * 只认目录名模式，不认具体机器——换机器、换用户、换盘符都能用。
 */
function playwrightShells(env) {
  const roots = []
  if (env.PLAYWRIGHT_BROWSERS_PATH) roots.push(env.PLAYWRIGHT_BROWSERS_PATH)
  else {
    if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, 'ms-playwright'))
    if (env.XDG_CACHE_HOME) roots.push(join(env.XDG_CACHE_HOME, 'ms-playwright'))
    if (env.HOME) roots.push(join(env.HOME, '.cache', 'ms-playwright'))
  }
  const layouts = [
    ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'],
    ['chrome-headless-shell-win32', 'chrome-headless-shell.exe'],
    ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
    ['chrome-headless-shell-linux-arm64', 'chrome-headless-shell'],
    ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'],
    ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'],
  ]
  // 版本号按数值倒序，不能按字典序：9999 与 10000 拼字符串会排反。
  const versionOf = (n) => {
    const m = /^chromium_headless_shell-(\d+)/.exec(n)
    return m ? Number(m[1]) : -1
  }
  const out = []
  for (const root of roots) {
    let names
    try { names = readdirSync(root) } catch { continue }
    const dirs = names.filter((n) => versionOf(n) >= 0).sort((a, b) => versionOf(b) - versionOf(a))
    for (const dir of dirs) {
      for (const [sub, bin] of layouts) {
        const p = join(root, dir, sub, bin)
        if (existsSync(p)) out.push(p)
      }
    }
  }
  return out
}

/**
 * 按优先级找浏览器。返回可执行文件路径；找不到返回空串（不抛）。
 * 环境变量（FISH_DRAW_BROWSER / EDGE_PATH / CHROME_PATH）最优先，
 * 方便装在非常规目录或容器里；其次是专用无头 shell，最后才是系统浏览器。
 */
export function browserPath(env = process.env) {
  const cands = [
    env.FISH_DRAW_BROWSER,
    env.EDGE_PATH,
    env.CHROME_PATH,
    ...playwrightShells(env),
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
