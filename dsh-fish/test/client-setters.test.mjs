/**
 * client.js 的 setter 守卫（2026-11-03 加）。
 *
 * 为什么需要：`client.js` 是给浏览器 ModuleLoader 的单文件脚本，没有构建、
 * 也没法在 node 里 render。fork.22 删掉设置页四个视频控件时，`useState` 的定义
 * 删了、**加载配置时的调用没删**——页面一打开就 `setVideoSubs is not defined`，
 * 而且那个异常会让它后面的所有 setter 都不执行（时段、冷落天数、睡眠周期全停在默认值）。
 * 这种错全量测试一条都抓不到，只有打开设置页才看得见。
 *
 * 规则：源码里出现的每个 `setXxx(` 调用，必须能在同一文件里找到 `, setXxx]`
 * 这样的 useState 解构定义。不是 useState 的少数几个名字走白名单。
 *
 * 白名单只有四类，加新名字前先想清楚是不是真的该加：
 *   - setTimeout / setInterval：JS 全局
 *   - setFrom / setTo：`timeRow` 这个局部辅助函数的参数（见 client.js 的 timeRow）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const ALLOWED = new Set(['setTimeout', 'setInterval', 'setFrom', 'setTo'])

test('client.js 里每个 setXxx 调用都必须有 useState 的定义', async () => {
  const src = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 前面不能是 `.` 或标识符字符（排除 obj.setFoo( 与 mysetFoo( ）
  const calls = new Set([...src.matchAll(/(?<![.\w$])(set[A-Z]\w*)\s*\(/g)].map((m) => m[1]))
  const defs = new Set([...src.matchAll(/,\s*(set[A-Z]\w*)\s*\]/g)].map((m) => m[1]))

  assert.ok(calls.size > 50, `只扫到 ${calls.size} 个 setter，正则大概失效了`)

  const missing = [...calls].filter((n) => !defs.has(n) && !ALLOWED.has(n)).sort()
  assert.deepEqual(
    missing,
    [],
    `这些 setter 被调用了但没有定义（删控件时漏删调用会在这里红）：${missing.join(', ')}`,
  )
})

test('删掉的视频控件不该再被调用（fork.22 的四个）', async () => {
  const src = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const dead of ['setVideoSubs', 'setVideoAsr', 'setVideoEngine', 'setVideoFrames']) {
    assert.ok(
      !new RegExp(`(?<![.\\w$])${dead}\\s*\\(`).test(src),
      `${dead} 对应的控件已经在 fork.22 删掉了，这里不该再调用它`,
    )
  }
})

/**
 * 载入失败时不许保存（2026-11-03 踩过）。
 *
 * `setVideoSubs is not defined` 让载入在配置段的中间抛了异常，表单停在默认值；
 * 而设置页是**整表提交**——下一次自动保存就把默认值写进了 config.json，
 * 他的唤醒时段从 18:00 变成 20:00，界面上只有一行红字，没有任何"我改了你的设置"的提示。
 *
 * 所以两条保存路径（手动 save / 700ms 自动保存）都必须先看 cfgLoaded。
 */
test('配置没读出来时，两条保存路径都要拒绝写盘', async () => {
  const src = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(src, /const cfgLoaded = useRef\(false\)/, '标记本身没了')
  assert.match(src, /cfgLoaded\.current = true/, '载入成功后要把它置真')
  const guards = (src.match(/if \(!cfgLoaded\.current\)/g) || []).length
  assert.ok(guards >= 2, `手动保存与自动保存都要挡（现在只有 ${guards} 处）`)
})

