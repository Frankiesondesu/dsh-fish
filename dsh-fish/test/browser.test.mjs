/**
 * browser.js 的浏览器探测（2026-11-13）。
 *
 * 钉住三个真渲染用例的根因：系统 Edge 在用户已经开着浏览器时，会把无头请求
 * 转交给已有实例，--dump-dom 的 stdout 全空、--screenshot 也不落盘。修法是
 * 优先用专用无头二进制。测试用临时目录造假浏览器，不依赖这台机器装了什么。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserPath, browserArgs } from '../lib/browser.js'

function fakeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'fish-pw-'))
  const dir = join(root, 'chromium_headless_shell-9999', 'chrome-headless-shell-win64')
  mkdirSync(dir, { recursive: true })
  const exe = join(dir, 'chrome-headless-shell.exe')
  writeFileSync(exe, 'fake')
  return { root, exe }
}

test('专用无头 shell 会被找到，且排在系统浏览器前面', () => {
  const { root, exe } = fakeRoot()
  try {
    assert.equal(browserPath({ PLAYWRIGHT_BROWSERS_PATH: root }), exe)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('部署者显式指定的浏览器仍然最优先', () => {
  const { root, exe } = fakeRoot()
  try {
    const own = join(root, 'my-own-browser.exe')
    writeFileSync(own, 'fake')
    assert.equal(browserPath({ PLAYWRIGHT_BROWSERS_PATH: root, FISH_DRAW_BROWSER: own }), own)
    assert.equal(browserPath({ PLAYWRIGHT_BROWSERS_PATH: root, EDGE_PATH: own }), own)
    assert.equal(browserPath({ PLAYWRIGHT_BROWSERS_PATH: root, CHROME_PATH: own }), own)
    assert.equal(browserPath({ PLAYWRIGHT_BROWSERS_PATH: root }), exe, '不给覆盖时回落到专用 shell')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('缓存里多个版本时取最新的那份', () => {
  const { root } = fakeRoot()
  try {
    const dir = join(root, 'chromium_headless_shell-10000', 'chrome-headless-shell-win64')
    mkdirSync(dir, { recursive: true })
    const newer = join(dir, 'chrome-headless-shell.exe')
    writeFileSync(newer, 'fake')
    assert.equal(browserPath({ PLAYWRIGHT_BROWSERS_PATH: root }), newer)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('缓存目录不存在或没有 shell 时不抛、照旧返回字符串', () => {
  const empty = mkdtempSync(join(tmpdir(), 'fish-pw-empty-'))
  try {
    assert.equal(typeof browserPath({ PLAYWRIGHT_BROWSERS_PATH: join(empty, 'nope') }), 'string')
    assert.equal(typeof browserPath({ PLAYWRIGHT_BROWSERS_PATH: empty }), 'string')
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('无头参数只有一套：专用 shell 与系统浏览器共用，不分叉', () => {
  const args = browserArgs(join(tmpdir(), 'fish-prof'))
  assert.ok(args.includes('--headless=new'), '系统浏览器还需要它；headless shell 实测忽略也不出错')
  assert.ok(args.includes('--disable-gpu'))
  assert.ok(args.some((a) => a.startsWith('--user-data-dir=')))
})
