/**
 * 回忆的可及性门槛（fork.36，2026-11-04）。
 *
 * 她的原话：「被压掉的那五十六条，我不记得……我想翻也翻不回来。」
 * 前半句是系统喂给她的假话（persona.js 已改），后半句在当时也是假的——
 * her_recall 只要关键词对，两年前的旧事照样返回。
 *
 * 这里守的是：**遗忘发生在取用这一层，不是删除账本**。
 *   早期 + 泛词  → 想不起来（线索不够具体）
 *   早期 + 准词  → 想得起来（那个词只在这一条里出现过）
 *   不早期       → 不受影响（账本才三天，凭什么忘）
 *   旋钮归零     → 退回 fork.35 的行为（可回退）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  searchEvents,
  RECALL_OLD_DAYS,
  RECALL_MIN_CUE,
} from '../lib/recall.js'

const DAY = 86400000
const NOW = Date.parse('2026-11-04T08:00:00Z')

const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString()
let seq = 0
const ev = (daysAgo, text, type = 'utterance') => ({
  id: `ev_test_${++seq}`,
  ts: at(daysAgo),
  type,
  text,
})

/**
 * 三条一天前的填充事件。
 * withWord=true 时它们也含关键词——这样关键词才是**泛词**（df=N、区分度 0）。
 * 用 idf 高的稀有词冒充泛词是假的：一个词能不能当线索，取决于它出现在多少条记录里。
 */
const filler = (withWord) =>
  Array.from({ length: 3 }, (_, i) =>
    ev(1, withWord ? `今天看了个视频第${i}回` : `今天天气不错第${i}回`))

const has = (rows, id) => rows.some((r) => r.id === id)

test('早期 + 泛词：想不起来（账本里还在，只是调不出来）', () => {
  const old = ev(400, '我以前提过那件关于视频的事')
  const { rows } = searchEvents([old, ...filler(true)], '视频', { now: NOW })
  assert.ok(!has(rows, old.id), '400 天前的旧事不该被一个到处都有的词捞出来')
})

test('早期 + 准词：想得起来', () => {
  // 只在这一条里出现的词，区分度高，是真正的线索
  const old = ev(400, '我以前提过那件关于皮影的事')
  const { rows } = searchEvents([old, ...filler(false)], '皮影', { now: NOW })
  assert.ok(has(rows, old.id), '那个具体的词该把它勾出来')
  assert.equal(rows[0].id, old.id, '而且排第一')
  assert.equal(rows[0].ago, 400)
})

test('门槛只对早期生效：同一句泛词，今天翻得到', () => {
  const fresh = ev(0, '我刚说了一句关于视频的话')
  const { rows } = searchEvents([fresh, ...filler(true)], '视频', { now: NOW })
  assert.ok(has(rows, fresh.id), `freshDays 内不该被门槛挡住（oldDays=${RECALL_OLD_DAYS}）`)
})

test('门槛的边界就是 oldDays：29 天前的泛词还翻得到，40 天前的不行', () => {
  const inside = ev(29, '我在说视频')
  const outside = ev(40, '我在说视频')
  const { rows } = searchEvents([inside, outside, ...filler(true)], '视频', { now: NOW })
  assert.ok(has(rows, inside.id), '30 天以内不算「早期」')
  assert.ok(!has(rows, outside.id), '40 天前的泛词已经调不出来')
})

test('旋钮归零 = 退回 fork.35：什么都翻得到', () => {
  const old = ev(400, '我以前提过那件关于视频的事')
  const { rows } = searchEvents([old, ...filler(true)], '视频', {
    now: NOW,
    minCue: 0,
  })
  assert.ok(has(rows, old.id), 'minCue=0 时必须恢复旧行为（可回退）')
})

test('门槛只影响"能不能取出来"，不改账本、不改返回结构', () => {
  const old = ev(400, '我以前提过那件关于视频的事')
  const events = [old, ...filler(true)]
  const before = JSON.stringify(events)
  searchEvents(events, '视频', { now: NOW })
  assert.equal(JSON.stringify(events), before, 'searchEvents 是只读的')

  const fresh = ev(0, '我刚说了一句关于视频的话')
  const { rows } = searchEvents([fresh, ...filler(true)], '视频', { now: NOW })
  // 0.8.8 起行里多了 chatOnly / clock / refs / verdict（来源、时间到分钟、改口关系）。
  // 上游 0.9.3：再加 anchor——这句话的来路（引用了谁、出自哪条聊天原话）。
  assert.deepEqual(Object.keys(rows[0]).sort(), ['ago', 'anchor', 'chatOnly', 'clock', 'date', 'id', 'refs', 'text', 'type', 'verdict'])
})

test('默认值就是 30 天 / 0.45（改默认值要同时改这里的意图说明）', () => {
  assert.equal(RECALL_OLD_DAYS, 30)
  assert.equal(RECALL_MIN_CUE, 0.45)
})
