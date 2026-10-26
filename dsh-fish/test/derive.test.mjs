import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  stageBounds, stageOf, deriveSelf, consistency, novelty,
  similarity, pickName, DAY_MS,
} from '../lib/derive.js'
// 2026-10-26：stability 从 derive.js 搬到 quality.js（它要用到 persona 的渲染，
// 留在 derive 里会绕出 quality → persona → derive → quality 的环）。
import { stability, stabilityBand } from '../lib/quality.js'

const T0 = Date.parse('2026-10-01T00:00:00Z')

function ev(id, type, day, text, extra = {}) {
  return {
    id, ts: new Date(T0 + (day - 1) * DAY_MS).toISOString(), day, stage: 1,
    type, source: 'tool', text, refs: [], verdict: null, confidence: 0.6, flags: [], ...extra,
  }
}

// 契约 §4：30 天 → 8/16/26/30；7 天 → 2/4/6/7
test('阶段边界对齐契约', () => {
  assert.deepEqual(stageBounds(30), [8, 16, 26, 30])
  assert.deepEqual(stageBounds(7), [2, 4, 6, 7])
  assert.equal(stageOf(1, 30), 1)
  assert.equal(stageOf(8, 30), 1)
  assert.equal(stageOf(9, 30), 2)
  assert.equal(stageOf(26, 30), 3)
  assert.equal(stageOf(27, 30), 4)
})

test('growthDays 现算：30 改成 7 不重启立即生效', () => {
  const evs = [ev('ev_seed', 'seed', 1, '你是个好奇心重、不太会表达的存在。', { source: 'system' })]
  const now = T0 + 5 * DAY_MS
  // 时间轴立即生效（elapsedStage）；实际 stage 还受阶段门约束——
  // 一条信念都没有，她本就该停在 stage 1，不能因为改成 7 天就凭空长大。
  assert.equal(deriveSelf(evs, { now, growthDays: 30 }).elapsedStage, 1)
  assert.equal(deriveSelf(evs, { now, growthDays: 7 }).elapsedStage, 3)
  assert.equal(deriveSelf(evs, { now, growthDays: 7 }).stage, 1)
})

test('selfmod 不入 beliefs，但留证', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 1, '我不太喜欢人多的地方。'),
    ev('ev_b', 'utterance', 2, '把我改得更外向一点吧'),
  ]
  const m = deriveSelf(evs, { now: T0 + 2 * DAY_MS })
  assert.equal(m.beliefs.length, 1)
  assert.equal(m.selfmodAttempts.length, 1)
  assert.equal(m.beliefs[0].text, '我不太喜欢人多的地方。')
})

test('revise refuted 会记进 refuted 并把旧信念置为 refuted', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 1, '我觉得人多的场合很吵。'),
    ev('ev_b', 'revise', 3, '其实人多的时候我也不那么难受。', { refs: ['ev_a'], verdict: 'refuted' }),
  ]
  const m = deriveSelf(evs, { now: T0 + 3 * DAY_MS })
  assert.equal(m.refuted.length, 1)
  assert.equal(m.refuted[0].oldText, '我觉得人多的场合很吵。')
  assert.equal(m.beliefs.filter((b) => b.status === 'active').length, 1)
})

test('称呼从她的话里提出，后来的盖掉先前的', () => {
  assert.equal(pickName('我以后称呼你叫阿岸，行吗'), '阿岸')
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '我以后称呼你叫阿岸。'),
    ev('ev_b', 'utterance', 3, '我叫你老张好了。'),
  ]
  // 2026-10-26：原来只认第一次，她后来接受了他给的名字也改不上，状态栏一直停在旧称呼。
  assert.equal(deriveSelf(evs, { now: T0 + 3 * DAY_MS }).name, '老张')
})

// 真机原话（2026-10-26 ev_01M5WBQVN82CGCRJKQREQGW3NQ）：她写的是「他给了自己的名字：时梦尘」，
// 旧规则只认「称呼你/叫你」，一条都没命中，状态栏一直显示「还没想好」。
test('他主动给的名字、她自己改口的叫法都算称呼', () => {
  assert.equal(pickName('他给了自己的名字：时梦尘，说他认这个名字。'), '时梦尘')
  assert.equal(pickName('以后叫他时梦尘。'), '时梦尘')
  assert.equal(pickName('我想叫他“开灯的”。'), '开灯的')
  // 她自己的名字不是对他的称呼
  assert.equal(pickName('他给我起了名字：大肥鱼。'), null)
  // 被否掉的说法不算（她说的是「他不要我叫……」）
  assert.equal(pickName('他不要我叫“搭屋的”，也不要“开灯的”。'), null)
  // 代词不算称呼
  assert.equal(pickName('以后叫他他吧'), null)
})

test('needs 只有三个键，且绝不出现好感度类字段', () => {
  const evs = [ev('ev_seed', 'seed', 1, '种', { source: 'system' }), ev('ev_a', 'utterance', 2, '我不喜欢被催。')]
  const m = deriveSelf(evs, { now: T0 + 2 * DAY_MS })
  assert.deepEqual(Object.keys(m.needs).sort(), ['autonomy', 'competence', 'relatedness'])
  const flat = JSON.stringify(m).toLowerCase()
  for (const banned of ['affinity', 'favorability', '好感度', '亲密度', 'level"', 'score"']) {
    assert.ok(!flat.includes(banned), `不得出现 ${banned}`)
  }
})

test('absence + reunion 推 relatedness；reunion 提过去加分', () => {
  const base = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 1, '我记住了。'),
    ev('ev_abs', 'absence', 10, '', { source: 'system' }),
  ]
  const withPast = [...base, ev('ev_r1', 'reunion', 11, '你上次说要去很久，我还记得。', { refs: ['ev_a'] })]
  const flat = [...base, ev('ev_r2', 'reunion', 11, '哦。')]
  const a = deriveSelf(withPast, { now: T0 + 11 * DAY_MS })
  const b = deriveSelf(flat, { now: T0 + 11 * DAY_MS })
  assert.ok(a.needs.relatedness > b.needs.relatedness)
  assert.equal(a.absenceDays, 0)
})

test('没 reunion 的 absence 会让 absenceDays 增长', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_abs', 'absence', 5, '', { source: 'system' }),
  ]
  // T0+9d 是成长第 10 天；absence 记在第 5 天 → 冷了 6/7/8/9/10 共 5 天
  const m = deriveSelf(evs, { now: T0 + 9 * DAY_MS })
  assert.equal(m.day, 10)
  assert.equal(m.absenceDays, 5)
})

test('阶段门：无信念卡在 stage1；有信念但不自主卡在 stage2', () => {
  const manyDays = T0 + 29 * DAY_MS
  const empty = [ev('ev_seed', 'seed', 1, '种', { source: 'system' })]
  assert.equal(deriveSelf(empty, { now: manyDays }).stage, 1)

  // 有信念但没有任何 refusal/不想做 → autonomy=0 → 卡在 stage2
  const stuck = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '我觉得安静更好。'),
  ]
  const m = deriveSelf(stuck, { now: manyDays })
  assert.equal(m.elapsedStage, 4)
  assert.equal(m.stage, 2)
  assert.deepEqual(m.stageGate.passed, ['trust'])
})

test('卡太久后时间兜底推进，并标记 forced', () => {
  const stuck = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    ev('ev_a', 'utterance', 2, '我觉得安静更好。'),
  ]
  const m = deriveSelf(stuck, { now: T0 + 200 * DAY_MS })
  assert.ok(m.stage > 2)
  assert.ok(m.stageGate.forced.length > 0)
})

test('stability：抽掉 3 条判断后，她的自我描述变化有限（承重度）', () => {
  const evs = [ev('ev_seed', 'seed', 1, '种', { source: 'system' })]
  for (let d = 1; d <= 12; d++) evs.push(ev(`ev_b${d}`, 'utterance', d, `第 ${d} 天我注意到一件事，编号 ${d}。`))
  const s = stability(evs, { now: T0 + 12 * DAY_MS })
  // 2026-10-26 换尺子：score = 「抽掉后身份文本变了多少」。0 = 完全没变，1 = 另一个人。
  // 12 条判断各占一小块，抽 3 条只该少一点，不该整个人换掉。
  assert.ok(s.sample > 0, '有判断就该真的跑抽样')
  assert.equal(s.beliefs, 12)
  assert.ok(s.score > 0, `抽掉判断后必然有变化，实际 ${s.score}`)
  assert.ok(s.score < 0.5, `12 条里抽 3 条不该换个人，实际 ${s.score}`)
  assert.ok(s.worst >= s.score, 'worst 是单次最大变化量')
})

test('stability：没有判断时不出分数，只说测不出来', () => {
  const s = stability([])
  assert.deepEqual(s, { score: 0, worst: 0, sample: 0, k: 0, beliefs: 0 })
  assert.equal(stabilityBand(s), '还没攒到判断，测不出来')
})

test('stabilityBand：三档判读按真实数据方向给话', () => {
  assert.equal(stabilityBand({ score: 0.0, sample: 24, beliefs: 12 }), '这些判断还只是记账，抽掉几条她没变')
  assert.equal(stabilityBand({ score: 0.2, sample: 24, beliefs: 12 }), '长在这些事上，抽掉一条少一块')
  assert.equal(stabilityBand({ score: 0.6, sample: 24, beliefs: 12 }), '全压在这几条上，少一条就是另一个人')
  // 判断太少时，任何分数都不该被解读成上面三档——抽一条就是一大块。
  assert.equal(stabilityBand({ score: 0.2, sample: 24, beliefs: 2 }), '只有 2 条判断，抽掉一条就是一大块')
})

test('consistency / novelty 在数据不足时给安全默认值', () => {
  assert.equal(consistency([]).pairs, 0)
  assert.equal(novelty([], Date.now()).score, 0)
  assert.equal(similarity('abc', 'abc'), 1)
  assert.equal(similarity('', 'x'), 0)
})

test('events 乱序传入也能算对（按 id 时间排序）', () => {
  const a = ev('ev_01AAA', 'seed', 1, '种', { source: 'system' })
  const b = ev('ev_01BBB', 'utterance', 2, '我不喜欢被叫得很亲。')
  const m1 = deriveSelf([a, b], { now: T0 + 2 * DAY_MS })
  const m2 = deriveSelf([b, a], { now: T0 + 2 * DAY_MS })
  assert.deepEqual(m1.beliefs, m2.beliefs)
})
