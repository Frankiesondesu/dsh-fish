/**
 * ui.test.mjs —— 设置页的四处「看得见」的修正（2026-10-24 晚）
 *
 * 为什么单开一个文件：这四条都不是逻辑，是**界面上的坑**——
 * 数字框能打超出上下限的值、历史列表只给前 8 条、封面图永远 404、
 * 日志预览框高到把整页撑长。这些在 node 侧跑不出错，只能靠源码断言守住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')
const OBSERVE = join(HERE, '..', 'lib', 'observe.js')

test('数字框：打字超范围后离开输入框会收敛回上下限', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes("onBlur: (e) => o.onChange(clamp(e.target.value))"), '要有一个 onBlur 收敛')
  assert.ok(src.includes('Number.isFinite(v) ? v : o.min'), '清空/非数字要落到下限，不能显示 NaN')
})

test('封面：lazyCover 从 view() 的 data 里取 pic', async () => {
  const src = await readFile(OBSERVE, 'utf8')
  // view() 返回 { ok, code, data:{ pic } }；直接读 v.pic 永远是 undefined，
  // 于是 /dsh-fish/cover/<BV> 一路 404，被 <img onError> 静默藏掉。
  assert.ok(src.includes('v?.data?.pic || v?.pic'), '要从 data 里取 pic')

  // 第二个根因（2026-10-24）：lazyCover 里还动态 import 过 owner.js 的 readOwner，
  // 那个文件没有这个导出，一调就 TypeError 被外层 catch 吞掉 —— 封面同样 404。
  assert.ok(!src.includes("await import('./owner.js')"), 'owner.js 没有 readOwner，别再动态导入它')
})

test('观看历史：一天里的条目全部列出，不再只给前 8 条', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes('g.items.map('), '所有条目都要渲染')
  assert.ok(!src.includes('g.items.slice(0, 8)'), '旧的 slice(0, 8) 已经拿掉')
})

test('查看文件夹：悬停要说清「只复制路径，不弹窗口」', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes('点了只是把这个文件夹的路径复制到剪贴板'))
  assert.ok(src.includes('不会弹窗口'))
})

test('运行日志预览：4~5 行高 + 内部滚动', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes("maxHeight: '104px'"), '预览框只有 4~5 行高')
  assert.ok(!src.includes("maxHeight: '220px'"), '旧的高框已经拿掉')
})

test('关于卡：GitHub 商标小图 + 「GitHub」文字（2026-10-25 用户要求）', async () => {
  const src = await readFile(CLIENT, 'utf8')
  // 用户点名要「github 的商标小图 + "github" 的文字」，不是纯文字链接。
  assert.ok(src.includes('const ghMark'), '要有内联的 GitHub 商标 svg')
  assert.ok(src.includes("viewBox: '0 0 16 16'"), '商标用官方 16×16 视框')
  // 图标必须内联、不引外链：设置页不该为一个图标等网络，也不该一打开就往外发请求。
  assert.ok(!/src:\s*['"]https?:/.test(src), '图标不能是远程图片')
  assert.ok(!src.includes('github.com/ssamurias/dsh-fish/logo'), '不要引远程 logo')
  // 文字必须恰好是 GitHub（大小写按用户说的）
  assert.ok(/ghMark,\s*'GitHub'/.test(src), '图标后面要跟「GitHub」这几个字')
  // 链接指向仓库，新窗口打开且带 noopener
  assert.ok(src.includes('https://github.com/ssamurias/dsh-fish'), '要指向仓库地址')
  assert.ok(src.includes("rel: 'noopener noreferrer'"), '外链必须带 noopener')
})

test('关于卡：检查更新按钮只在点击时查，不自动轮询', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes("jget('/update?ms=8000')"), '检查更新走 /update 路由')
  // 关键：不能放进 load() 的 Promise.all（那样一打开设置就天天往 GitHub 发请求）
  const loadBody = src.match(/const load = useCallback\(async \(\) => \{([\s\S]*?)\n {6}\}, \[\]\)/)
  assert.ok(loadBody, '要能定位到 load()')
  assert.ok(!loadBody[1].includes('/update'), 'load() 里不该自动查更新')
  // 也不能有定时器
  assert.ok(!src.includes("setInterval(() => checkUpdate"), '不许自动定时查更新')
})

test('关于卡：读不到当前版本时不谎报「已是最新」', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes('upd.known === false'), 'known=false 要有单独一条文案')
  // 那句人话要如实承认判断不了，而不是直接说"已经是最新的"
  assert.ok(src.includes('读不到自己装的版本号'), '要如实说明读不到版本')
})
