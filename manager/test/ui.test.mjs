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

test('记忆面板：三条泳道的节点与连线要画出来（2026-11-12 树状图）', async () => {
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

  const MEM = {
    at: '2026-11-12T13:00:00.000Z',
    local: {
      dirBytes: 86000000,
      files: 40,
      ledger: { ok: true, lines: 3286, bytes: 1078000, mtime: '2026-11-12T12:02:56.000Z', recent: [{ ts: '2026-11-12T12:02:56.000Z', type: 'talk', text: '他说了句什么' }] },
      lastSync: { decision: 'same', at: '2026-11-12T10:41:27.000Z' },
      fingerprint: { fileAt: '2026-11-12T10:41:27.000Z' },
    },
    cloud: {
      ok: true,
      pkgBytes: 83386240,
      localMain: { sha: '4b0bd08abcdef', at: '2026-11-12T18:41:27+08:00', subject: 'encrypted snapshot 2026-11-12 18:41:27' },
      history: [{ sha: '4b0bd08', at: '2026-11-12T18:41:27+08:00', subject: 'encrypted snapshot 2026-11-12 18:41:27' }],
      // 打包时间与快照只差 27 秒 → 应该连一条虚线
      uploads: [{ at: '2026-11-12T18:41:00+08:00', device: 'pc', ledger: 3286, bytes: 83386240 }],
    },
    phone: { ok: true, lines: 3286, mtime: '2026-11-12T20:02:56+08:00', lastSync: { decision: 'same' } },
    verdict: { kind: 'local-newer', note: '账本在上次备份之后又写过 —— 本机有新记忆还没上去' },
    byDay: [{ day: '2026-11-12', count: 204, lastAt: '2026-11-12T12:02:56.000Z', types: ['meta', 'talk'] }],
  }

  const sandbox = {
    document: doc,
    fetch: async (u) => ({
      ok: true,
      json: async () => (String(u).startsWith('/api/memory') ? MEM : { at: Date.now(), busy: '', services: SERVICES_FIXTURE }),
    }),
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
  await new Promise((r) => setTimeout(r, 60))

  const tree = String(els.get('memtree').innerHTML)
  assert.match(tree, /<svg/, '要真的画出 SVG')
  for (const lane of ['手机', '本机', '云端']) {
    assert.ok(tree.includes(`>${lane}</text>`), `三条泳道之一缺了：${lane}`)
  }
  assert.match(tree, /电脑打包/, '打包节点要标出设备端')
  assert.match(tree, /3286 条/, '打包节点要带条数')
  assert.match(tree, /快照 4b0bd08/, '云端泳道要有快照节点')
  assert.match(tree, /stroke-dasharray/, '打包与快照之间要有连线')

  // 卡片区同样要有数
  assert.match(String(els.get('memlocal').innerHTML), /3286/, '本机卡片要显示条数')
  assert.match(String(els.get('memverdict').innerHTML), /还没上去/, '判定条要照实说')
})

test('记忆面板：手机没探过时不许拿假数据凑数', async () => {
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
  const MEM = {
    at: '2026-11-12T13:00:00.000Z',
    local: { dirBytes: 1, files: 1, ledger: { ok: true, lines: 10, mtime: '', recent: [] }, lastSync: null, fingerprint: null },
    cloud: { ok: true, pkgBytes: 0, localMain: null, history: [], uploads: [] },
    phone: null,
    verdict: { kind: 'unknown', note: '没有本机备份记录' },
    byDay: [],
  }
  const sandbox = {
    document: doc,
    fetch: async (u) => ({ ok: true, json: async () => (String(u).startsWith('/api/memory') ? MEM : { at: Date.now(), busy: '', services: SERVICES_FIXTURE }) }),
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
  await new Promise((r) => setTimeout(r, 60))

  const tree = String(els.get('memtree').innerHTML)
  assert.doesNotMatch(tree, /手机账本/, '没探过就不许编一个手机节点')
  assert.match(tree, /未探测/, '要写明未探测')
})
