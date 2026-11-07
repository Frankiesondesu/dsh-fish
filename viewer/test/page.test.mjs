/**
 * viewer 页面内嵌脚本的守卫（2026-11-07）。
 *
 * 为什么要有：viewer.mjs 的 PAGE 是模板字符串，`node --check viewer.mjs` 只查外层，
 * 里面的 JS 语法错了它一声不响——页面打开就是「读取中」永远转下去（11-07 真踩了两次：
 * observe 块一次、said 块一次，都是多一个右括号）。这条测试把模板里的 <script>
 * 抽出来真编译一遍，语法错在测试期就炸。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('PAGE 内嵌脚本必须能编译（模板字符串 node --check 管不到它）', async () => {
  const src = await readFile(new URL('../viewer.mjs', import.meta.url), 'utf8')
  const page = /const PAGE = String\.raw`([\s\S]*)`\n/.exec(src)
  assert.ok(page, 'viewer.mjs 里要能找到 PAGE 模板（它挪位置了就改这条）')
  const code = /<script>([\s\S]*)<\/script>/.exec(page[1])
  assert.ok(code, 'PAGE 里要能找到 <script>')
  assert.ok(code[1].includes('function render'), '抽出来的得是渲染脚本本体')
  // 真编译：语法错当场抛
  new Function(code[1])
})

/** 页面脚本真用到的 DOM 面（够 render 跑一遍即可）。 */
function makeEl(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    disabled: false,
    dataset: {},
    style: {},
    value: '',
    checked: false,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener() {},
    appendChild() {},
    remove() {},
    scrollIntoView() {},
    scrollTo() {},
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
    closest: () => null,
    onclick: null,
    oninput: null,
    onchange: null,
  }
}

test('PAGE 脚本可执行：首拉数据后 tabs 与默认页真渲染出来', async () => {
  const src = await readFile(new URL('../viewer.mjs', import.meta.url), 'utf8')
  const page = /const PAGE = String\.raw`([\s\S]*)`\n/.exec(src)[1]
  const code = /<script>([\s\S]*)<\/script>/.exec(page)[1]

  const els = new Map()
  const doc = {
    getElementById: (id) => {
      if (!els.has(id)) els.set(id, makeEl(id))
      return els.get(id)
    },
    querySelectorAll: () => [],
    createElement: () => makeEl('c'),
    addEventListener() {},
    hidden: false,
    body: makeEl('body'),
  }
  const vm = await import('node:vm')
  const sandbox = {
    document: doc,
    fetch: async (url) => {
      if (String(url).includes('/api/data')) {
        return {
          ok: true,
          json: async () => ({
            now: Date.now(),
            home: { turns: 3 },
            config: {},
            sessions: [],
            model: { day: 6, stage: 1, beliefs: [], needs: {} },
            events: [],
            actions: [],
            spoken: [{ at: Date.now(), turn: 1, text: '窗口里说的' }],
            qqSaid: [{ at: Date.now() - 1000, id: 'ev_1', text: 'QQ 上说的' }],
            userSaid: [],
          }),
        }
      }
      return { ok: true, json: async () => ({}) }
    },
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    Audio: function () { this.play = () => {} },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  await new Promise((r) => setTimeout(r, 50))

  const tabs = els.get('tabs')
  assert.match(String(tabs.innerHTML), /她说的话/, 'tab 栏要渲染出来')
  assert.match(String(tabs.innerHTML), /观测台/, '新四页的 tab 也要在')
  assert.match(String(els.get('main').innerHTML), /三种需要/, '默认页（人格数据）要画出来')
})
