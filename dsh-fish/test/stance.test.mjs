import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  classifyStance,
  gatesDone,
  buildStances,
  stanceSection,
  stanceSummary,
  STANCE_MAX,
  STANCE_PROMPT_MAX,
} from '../lib/stance.js'
import { personaLine } from '../lib/persona.js'

// 2026-10-25 用户拍板「方案二」：四道门不再加门，走完之后长一张立场清单。
// 这些用例锁的是三件事——什么算立场、什么才算「站住」、清单怎么摆进身份文档。

const HERE = new URL('../', import.meta.url)
const read = (p) => fs.readFileSync(new URL(p, HERE), 'utf8')

function belief(text, extra = {}) {
  return { id: extra.id ?? text, text, since: '2026-10-01', confidence: 0.6, status: 'active', ...extra }
}

function model(extra = {}) {
  return {
    seed: '你是一条会自己长起来的鱼。',
    beliefs: [],
    solid: [],
    tensions: [],
    refusals: [],
    scars: [],
    selfmodAttempts: [],
    refuted: [],
    narrative: null,
    facts: { refused: 0, hurts: 0, scars: 0, scarsResolved: 0 },
    day: 60,
    growthDays: 30,
    stage: 4,
    ...extra,
  }
}

test('classifyStance：「不喜欢」是拒绝，不是喜欢', () => {
  assert.equal(classifyStance('我不做讨好人的事'), 'never')
  assert.equal(classifyStance('我不喜欢他这样揣测我'), 'never')
  assert.equal(classifyStance('我更喜欢一个人待着'), 'like')
  assert.equal(classifyStance('今天天气不错'), null)
  assert.equal(classifyStance(''), null)
})

test('gatesDone：真门槛看 stageGate.passed，老模型退回 stage', () => {
  assert.equal(gatesDone({ stageGate: { passed: ['trust', 'autonomy', 'competence'] } }), true)
  assert.equal(gatesDone({ stageGate: { passed: ['trust', 'autonomy'] }, stage: 3 }), false)
  assert.equal(gatesDone({ stage: 4 }), true)
  // 天数到了、门没过，stage 被夹住也不该算走完
  assert.equal(gatesDone({ stage: 4, stageForced: true }), false)
})

test('四道门没走完，立场清单是空的', () => {
  const m = model({
    stage: 2,
    stageGate: { passed: ['trust'] },
    beliefs: [belief('我不想再看那些评论了', { mentions: 5 })],
  })
  assert.deepEqual(buildStances(m), [])
})

test('同一件事上两条同向判断 → 归成一条立场', () => {
  const m = model({ beliefs: [belief('我不想再看那些评论了'), belief('我不想再看那些评论了', { id: 'b2' })] })
  const list = buildStances(m)
  assert.equal(list.length, 1)
  assert.equal(list[0].kind, 'never')
  assert.equal(list[0].members.length, 2)
})

test('只有一句话、又没有代价 → 不算立场（随口一说）', () => {
  const m = model({ beliefs: [belief('我不想再看那些评论了')] })
  assert.deepEqual(buildStances(m), [])
})

test('一条判断 + 一道疤 → 算站住（代价背书）', () => {
  const m = model({
    beliefs: [belief('我不想再看那些评论了')],
    scars: [{ quote: '我不想再看那些评论了', reaction: 'insist' }],
  })
  const list = buildStances(m)
  assert.equal(list.length, 1)
  assert.equal(list[0].scars, 1)
  assert.equal(list[0].backed, true)
})

test('被推翻的判断不进立场清单', () => {
  const m = model({
    beliefs: [belief('我不想再看那些评论了', { status: 'refuted', mentions: 9 })],
  })
  assert.deepEqual(buildStances(m), [])
})

test('写进身份文档的清单最多 4 条，且不出现次数数字', () => {
  const stances = Array.from({ length: STANCE_MAX }, (_, i) => ({
    kind: i % 2 ? 'like' : 'never',
    text: `立场编号${'甲乙丙丁戊己庚辛'[i]}`,
    scars: i,
    mentions: i * 3,
    backed: true,
  }))
  const text = stanceSection(stances)
  const lines = text.split('\n').filter((l) => l.startsWith('- '))
  assert.equal(lines.length, STANCE_PROMPT_MAX)
  assert.ok(!/[0-9]/.test(lines.join('')), '立场句子不许带次数')
  assert.ok(text.includes('## 我站哪边'))
})

test('立场段是核心段：预算只有 1 也还在', () => {
  const m = model({
    beliefs: [belief('我不想再看那些评论了'), belief('我不想再看那些评论了', { id: 'b2' })],
  })
  const text = personaLine(m, { budget: 1 })
  assert.ok(text.includes('## 我站哪边'), '预算再紧也不能把立场裁掉')
  assert.ok(text.includes('我不想再看那些评论了'))
})

test('观测台字段：/memory 与 /state 都从 stance.js 取数', () => {
  const sum = stanceSummary([{ kind: 'never', text: 'x', backed: true }, { kind: 'like', text: 'y', backed: false }])
  assert.equal(sum.stanceCount, 2)
  assert.equal(sum.stanceNevers, 1)
  assert.equal(sum.stanceLikes, 1)
  assert.equal(sum.stanceBacked, 1)
  assert.deepEqual(sum.stanceFirst, { kind: 'never', text: 'x' })

  const observe = read('lib/observe.js')
  assert.ok(observe.includes("from './stance.js'"))
  assert.ok(/stanceCount:\s*buildStances\(m\)\.length/.test(observe), '/state 要有 stanceCount')
  assert.ok(observe.includes('...stanceSummary(buildStances(model))'), '/memory 要把摘要并进 sections')
})
