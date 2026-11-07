/**
 * ui.html 的前端脚本真的跑一遍（2026-11-07）。
 *
 * 为什么要有：ui.html 是 500 行无构建的模板脚本，`node --check` 只查语法——
 * 而「引用了还没初始化的 const」这种 **TDZ 运行时错**编译期一声不响（11-07 真踩过：
 * render() 里 gridBusy 在声明前被用，卡片永远画不出来，界面上只剩「连不上管理器」，
 * 因为 render 抛错被 refresh 的 catch 吞了）。
 *
 * 这里用 node:vm + 最小 DOM 桩把整段脚本执行一遍，喂一条假探测数据，
 * 断言卡片真的渲染出来、按钮状态正确。DOM 桩只实现脚本真用到的面。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

function makeEl(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    disabled: false,
    dataset: {},
    style: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener() {},
    appendChild() {},
    remove() {},
    scrollTo() {},
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
  }
}

const SERVICES_FIXTURE = [
  { key: 'dsh', name: 'DSH', tag: '宿主', desc: 'd', warn: '', managed: true, up: true, pid: 1, stale: true, unknownStart: false, staleFile: 'observe.js', startAt: 1 },
  { key: 'viewer', name: '查看器', tag: ':7788', desc: 'd', warn: '', managed: true, up: false, pid: 0, stale: false, unknownStart: false, staleFile: '', startAt: 0 },
  { key: 'asr', name: 'ASR 听写', tag: ':18765', desc: 'd', warn: '', managed: false, up: false, pid: 0, stale: false, unknownStart: false, staleFile: '', startAt: 0 },
]

test('ui.html 脚本可执行：render 真跑通，卡片与待重启按钮都画出来', async () => {
  const html = await readFile(new URL('../ui.html', import.meta.url), 'utf8')
  const code = /<script>([\s\S]*)<\/script>/.exec(html)[1]
  assert.ok(code.includes('function render'), '脚本要抽对')

  const els = new Map()
  const doc = {
    getElementById: (id) => {
      if (!els.has(id)) els.set(id, makeEl(id))
      return els.get(id)
    },
    querySelector: () => makeEl('q'),
    querySelectorAll: () => [],
    createElement: () => makeEl('c'),
    addEventListener() {},
    hidden: false,
    body: makeEl('body'),
  }
  const sandbox = {
    document: doc,
    fetch: async () => ({ ok: true, json: async () => ({ at: Date.now(), busy: '', services: SERVICES_FIXTURE }) }),
    confirm: () => true,
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    requestAnimationFrame: (fn) => fn(),
    console,
  }
  vm.createContext(sandbox)
  // 顶层执行：拿元素、挂监听器、首拉 refresh()（异步）
  vm.runInContext(code, sandbox)
  // 等异步链走完（fetch 桩 + microtask）
  await new Promise((r) => setTimeout(r, 50))

  const grid = els.get('grid')
  assert.match(String(grid.innerHTML), /data-key="dsh"/, 'DSH 卡片要渲染出来')
  assert.match(String(grid.innerHTML), /data-key="asr"/, '只读服务也要显示')
  assert.match(String(grid.innerHTML), /需要重启/, 'stale 的卡片要有待重启标记')

  const btn = els.get('stalebtn')
  assert.match(String(btn.textContent), /重启待重启（1）/, '按钮要带实时数量')
  assert.equal(btn.disabled, false, '有目标时必须可点')
  assert.match(String(els.get('summary').innerHTML), /个待重启/, '摘要也要带上')
})

test('ui.html 脚本：没有待重启时按钮禁用、文案变化', async () => {
  const html = await readFile(new URL('../ui.html', import.meta.url), 'utf8')
  const code = /<script>([\s\S]*)<\/script>/.exec(html)[1]
  const els = new Map()
  const doc = {
    getElementById: (id) => {
      if (!els.has(id)) els.set(id, makeEl(id))
      return els.get(id)
    },
    querySelector: () => makeEl('q'),
    querySelectorAll: () => [],
    createElement: () => makeEl('c'),
    addEventListener() {},
    hidden: false,
    body: makeEl('body'),
  }
  const none = SERVICES_FIXTURE.map((s) => ({ ...s, stale: false }))
  const sandbox = {
    document: doc,
    fetch: async () => ({ ok: true, json: async () => ({ at: Date.now(), busy: '', services: none }) }),
    confirm: () => true,
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    requestAnimationFrame: (fn) => fn(),
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  await new Promise((r) => setTimeout(r, 50))
  const btn = els.get('stalebtn')
  assert.match(String(btn.textContent), /没有待重启/)
  assert.equal(btn.disabled, true, '没目标时必须禁用')
})
