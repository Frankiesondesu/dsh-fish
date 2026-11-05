/**
 * 可疑自述（2026-11-05）。
 *
 * 来自 dafeiyu 踩坑合集第 16 条：自动生成的日记写成「他晚饭一直没吃，我念叨了好几回」，
 * 事实记反了不说，还写了**行为自述**——被 her_recall 捞出来时，它直接变成她
 * 「继续这么做」的动力。她不是记得"他没吃饭"，是记得"我是个催他吃饭的人"。
 *
 * 判据故意窄：第一人称 + 反复/持续。一次动作不算。
 * 这里只列出来，不改不删——账本只增不改，动她的自述要人来决定。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SELF_CLAIM_RE, examine } from '../lib/health.js'

const ev = (type, text, ts = '2026-11-05T10:00:00.000Z') => ({
  id: `ev_${Math.random().toString(16).slice(2)}`, type, text, ts, day: 4, stage: 1,
})

test('抓得到：第一人称 + 反复动作', () => {
  const hits = [
    '他晚饭一直没吃，我念叨了好几回',
    '我催了他一整天',
    '我提醒了三次',
    '我等了一整天，他也没来',
    '我说了好几遍不要熬夜',
  ]
  for (const t of hits) assert.ok(SELF_CLAIM_RE.test(t), `该抓到：${t}`)
})

test('抓不到：一次动作、不是说自己的反复', () => {
  const misses = [
    '我做了一张图',
    '我看了会儿视频',
    '今天他吃了两碗饭',
    '我问他这是什么',
    '我一直觉得这个说法有问题',
  ]
  for (const t of misses) assert.ok(!SELF_CLAIM_RE.test(t), `不该抓：${t}`)
})

test('只扫 narration / diary，不碰她的原话', () => {
  const rows = [
    ev('narration', '他晚饭一直没吃，我念叨了好几回'),
    ev('diary', '我催了他一整天，他才动'),
    ev('utterance', '我催了他一整天'), // 她自己说的话，不是系统自述，不动
    ev('heard', '我提醒了三次'),
  ]
  const r = examine(rows)
  assert.equal(r.selfClaims.length, 2, '只有 narration + diary 各一条')
  assert.ok(r.selfClaims.every((x) => x.type === 'narration' || x.type === 'diary'))
})

test('去重：同一句写了两遍只报一次', () => {
  const rows = [
    ev('diary', '我催了他一整天'),
    ev('diary', '我催了他一整天'),
  ]
  const r = examine(rows)
  assert.equal(r.selfClaims.length, 1)
})

test('最多五条，新的在前', () => {
  const rows = Array.from({ length: 8 }, (_, i) =>
    ev('narration', `我催了他一整天（第 ${i} 次）`, `2026-11-0${i + 1}T10:00:00.000Z`))
  const r = examine(rows)
  assert.equal(r.selfClaims.length, 5)
  assert.match(r.selfClaims[0].text, /第 7 次/, '最后写的排最前')
})

test('空账本也给这个字段，调用方不用判空', () => {
  const r = examine([])
  assert.deepEqual(r.selfClaims, [])
})
