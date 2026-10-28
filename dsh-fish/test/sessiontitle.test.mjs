// 对话的名字（2026-10-29，用户 m00761）：请神下拉里原来显示的是一串会话 id。
//
// 宿主把名字写成 `session/title` 事件，header 里没有；这里锁三层来源的先后顺序，
// 免得以后有人又改回「读 header.title → 空 → 甩 id 尾巴」。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { titleOfSession, titleOfAgent, clipTitle } from '../lib/sessiontitle.js'

const withEvents = (events) => ({ snapshotEvents: () => events })
const titleEvent = (title, seq = 1) => ({ type: 'session/title', seq, time: 0, data: { title, messageSeqs: [], source: { kind: 'agent' } } })

test('名字优先问宿主的 sessionTitle 服务', () => {
  const session = withEvents([titleEvent('事件流里的旧名字')])
  const ctx = { get: (name) => (name === 'sessionTitle' ? { get: () => ({ title: '服务里的新名字' }) } : undefined) }
  assert.equal(titleOfSession(ctx, session), '服务里的新名字')
})

test('没有这个服务就自己折事件流，取最后一个 session/title', () => {
  const session = withEvents([titleEvent('旧名字', 1), { type: 'user/message', seq: 2, data: {} }, titleEvent('新名字', 3)])
  assert.equal(titleOfSession({ get: () => undefined }, session), '新名字')
  assert.equal(titleOfSession(undefined, session), '新名字')
})

test('事件流里还没有标题时给空字符串，不编', () => {
  const session = withEvents([{ type: 'user/message', seq: 1, data: {} }])
  assert.equal(titleOfSession({}, session), '')
  assert.equal(titleOfSession({}, { snapshotEvents: () => { throw new Error('读不出来') } }), '')
  assert.equal(titleOfSession({}, null), '')
})

test('header 里的 title 只是旧版本退路，排在事件流后面', () => {
  const agent = { session: { header: { id: 'session-abc', title: 'header 里的名字' } } }
  assert.equal(titleOfAgent({}, agent), 'header 里的名字')
  const agent2 = {
    session: {
      header: { id: 'session-abc', title: 'header 里的旧名字' },
      snapshotEvents: () => [titleEvent('事件流里的名字')],
    },
  }
  assert.equal(titleOfAgent({}, agent2), '事件流里的名字')
  assert.equal(titleOfAgent({}, undefined), '')
})

test('名字太长就截断，别把下拉撑破', () => {
  assert.equal(clipTitle('短的'), '短的')
  const long = '很长'.repeat(60)
  const cut = clipTitle(long, 20)
  assert.equal(cut.length, 20)
  assert.ok(cut.endsWith('…'))
  assert.equal(clipTitle('', 20), '')
})

test('请神下拉的标签不再回退到会话 id 尾巴', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(!client.includes('s.title || s.sessionId.slice(-8)'), '下拉里不能再拿 id 尾巴当名字')
  assert.ok(client.includes('possessName(s)'), '下拉应该走 possessName()')
  assert.ok(client.includes('还没起名字的对话'), '没名字时要说人话')
  assert.ok(!client.includes('现在上身：${possessActive.title || possessActive.sessionId}'), '现在上身也不能甩 id')

  const observe = readFileSync(new URL('../lib/observe.js', import.meta.url), 'utf8')
  assert.ok(observe.includes("from './sessiontitle.js'"), '服务端要复用同一个取名函数')
  assert.ok(observe.includes('titleOfAgent(ctx, a)'), '/possession 返回的名字来自 session/title')

  const possess = readFileSync(new URL('../lib/possess.js', import.meta.url), 'utf8')
  assert.ok(possess.includes('titleOfAgent(ctx, agent)'), '请神台账里也存真名字')
})
