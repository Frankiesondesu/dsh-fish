import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { looksLikeRework, taskMeta, capabilityOf, CAPABILITY_MIN_TASKS } from '../lib/capability.js'

// 2026-10-25 用户拍板「方案二 · 横向能力」：不看夸不夸她，只看他说「重做」的次数有没有变少。
// 这些用例锁三件事：什么算返工、事件流里只落 0/1、样本不够时不报百分比。

const HERE = new URL('../', import.meta.url)
const read = (p) => fs.readFileSync(new URL(p, HERE), 'utf8')

function meta(text, ts = '2026-10-20T10:00:00.000Z') {
  return { type: 'meta', text, ts, id: text + ts }
}

test('返工判据：催同一件事才算，闲聊不算', () => {
  assert.equal(looksLikeRework('不对，重做'), true)
  assert.equal(looksLikeRework('不是这个，我说的是右上角那个'), true)
  assert.equal(looksLikeRework('再来一遍'), true)
  assert.equal(looksLikeRework('今天天气不错'), false)
  assert.equal(looksLikeRework(''), false)
  // 一整段在讲一件事，不像在催上一句
  assert.equal(looksLikeRework('不对'.repeat(80)), false)
})

test('落进事件流的只有 0/1，没有他的话', () => {
  assert.equal(taskMeta(true), 'task:1')
  assert.equal(taskMeta(false), 'task:0')
  assert.ok(!taskMeta(true).includes('不对'))
})

test('算能力：任务数、返工数、采纳率', () => {
  const events = [
    meta('task:0'),
    meta('task:0', '2026-10-20T11:00:00.000Z'),
    meta('task:1', '2026-10-21T11:00:00.000Z'),
    meta('task:0', '2026-10-21T12:00:00.000Z'),
    meta('task:1', '2026-10-22T12:00:00.000Z'),
    meta('task:0', '2026-10-22T13:00:00.000Z'),
  ]
  const c = capabilityOf(events)
  assert.equal(c.tasks, 6)
  assert.equal(c.reworks, 2)
  assert.equal(c.adoption, 0.67)
  assert.equal(c.enough, true)
  assert.equal(c.since, '2026-10-20T10:00:00.000Z')
  assert.equal(c.lastAt, '2026-10-22T13:00:00.000Z')
})

test('样本不够时不报百分比', () => {
  assert.equal(capabilityOf([]).adoption, null)
  assert.equal(capabilityOf([meta('task:0')]).adoption, null, '第一次任务没有上一轮，不进分母')
  const four = capabilityOf([meta('task:0'), meta('task:0'), meta('task:1'), meta('task:0')])
  assert.equal(four.tasks, 4)
  assert.equal(four.enough, false)
  assert.ok(CAPABILITY_MIN_TASKS === 5)
})

test('只认 task 那一条 meta，别的 meta 不掺进来', () => {
  const events = [meta('react:ev_1:insist'), meta('wake:2026-10-20 test_first'), meta('task:0'), meta('task:0')]
  const c = capabilityOf(events)
  assert.equal(c.tasks, 2)
  assert.equal(c.reworks, 0)
})

test('接线：他在 /say 说话时落任务，/state 报能力，界面有那一行', () => {
  const say = read('lib/say.js')
  assert.ok(say.includes("from './capability.js'"))
  assert.ok(say.includes('taskMeta(looksLikeRework(body))'))

  const observe = read('lib/observe.js')
  assert.ok(observe.includes('capability: capabilityOf(events)'))

  const client = read('lib/client.js')
  assert.ok(client.includes("rowTip('回应采纳'"))
  assert.ok(client.includes('还没攒够'))
  assert.ok(!client.includes('能力值'), '能力不是数值，不许出现这种词')
})
