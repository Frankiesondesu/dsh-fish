/**
 * 合批窗口（2026-11-05）。
 *
 * 用户的习惯：**先发图片，再发对话**。原来的规则是「带图就压 8 秒、每来一条
 * 就重新计时」，于是连发三张图要等 24 秒，而他补的那句话反而没被算进去。
 *
 * 现在：
 *   · 从**第一张图**开始算 10 秒（连发几张不重置）
 *   · 文字一到就**立刻发**（0 秒），不等满窗口
 *   · 没补文字，窗口自然到期再发
 *   · 纯文字仍压 1.5 秒（那是"等他打完字"，跟图无关）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { batchWait, DEFAULT_IMAGE_HOLD_MS } from '../batch-wait.mjs'
import { readFile } from 'node:fs/promises'

const HOLD = 10_000
const MERGE = 1_500

test('默认带图窗口就是 10 秒', () => {
  assert.equal(DEFAULT_IMAGE_HOLD_MS, 10_000)
})

test('只发一张图、没有文字：等满 10 秒', () => {
  const t0 = 1_000_000
  assert.equal(batchWait({ hasImage: true, hasText: false, imageAt: t0, now: t0, mergeMs: MERGE, imageHoldMs: HOLD }), HOLD)
})

test('图之后补了文字：立刻发，不等窗口', () => {
  const t0 = 1_000_000
  assert.equal(batchWait({ hasImage: true, hasText: true, imageAt: t0, now: t0 + 2_000, mergeMs: MERGE, imageHoldMs: HOLD }), 0)
})

test('连发几张图不重置：第二张到达时只剩 8 秒', () => {
  const t0 = 1_000_000
  const wait = batchWait({ hasImage: true, hasText: false, imageAt: t0, now: t0 + 2_000, mergeMs: MERGE, imageHoldMs: HOLD })
  assert.equal(wait, 8_000, '从第一张算，不是从第二张')
})

test('窗口已经过了：立刻发，不返回负数', () => {
  const t0 = 1_000_000
  assert.equal(batchWait({ hasImage: true, hasText: false, imageAt: t0, now: t0 + 99_000, mergeMs: MERGE, imageHoldMs: HOLD }), 0)
})

test('纯文字：还是 1.5 秒（跟图无关）', () => {
  assert.equal(batchWait({ hasImage: false, hasText: true, imageAt: 0, now: 5, mergeMs: MERGE, imageHoldMs: HOLD }), MERGE)
})

test('关掉合批（窗口都是 0）：立刻发', () => {
  assert.equal(batchWait({ hasImage: true, hasText: false, imageAt: 1, now: 1, mergeMs: 0, imageHoldMs: 0 }), 0)
  assert.equal(batchWait({ hasImage: false, hasText: true, imageAt: 0, now: 1, mergeMs: 0, imageHoldMs: 0 }), 0)
})

test('桥真的用上了这个纯函数，而且起点是第一个附件', async () => {
  const src = await readFile(new URL('../bridge.mjs', import.meta.url), 'utf8')
  assert.match(src, /const wait = batchWait\(\{/, '不算白写')
  // 11-06：图也归到 files 了，窗口起点泛化成「第一个附件」，语义没变
  assert.match(src, /if \(!p\.attachAt\) p\.attachAt = now/, '起点记第一个附件，后面的不覆盖')
  assert.match(src, /imageHoldMs: 10000/, '默认值就是 10 秒')
})

test('配置文件也改成 10 秒（不然代码默认值白改）', async () => {
  const raw = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'))
  assert.equal(raw.imageHoldMs, 10_000)
})
