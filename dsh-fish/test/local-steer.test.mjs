/**
 * /local/steer（2026-11-08，用户选 A）：她这一轮没跑完时，把他后发的一条插进同一回合。
 * 只测纯逻辑与守卫，不碰 home.json、不真的启动她一轮。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { steerMessage } from '../lib/observe.js'
import { FISH_STEER_KIND } from '../lib/deliver.js'

test('插话：正文原样递给 agent.steer，来源单独起 kind', () => {
  const calls = []
  const agent = { steer: (m) => calls.push(m) }
  const text = '（这条消息从 QQ 发来）\n\n这是他后发的第二条'
  const r = steerMessage(agent, text, { rpcId: 'steer-unit' })
  assert.equal(r.ok, true)
  assert.equal(r.steered, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].content[0].text, text, '一个字都不改写')
  assert.equal(calls[0].role, 'user')
  assert.equal(calls[0].source.kind, FISH_STEER_KIND)
  assert.equal(calls[0].source.rpcId, 'steer-unit')
  assert.ok(calls[0].id, '宿主收件箱要求消息自带 id')
})

test('宿主没有 steer → 如实失败，不假装插进去了', () => {
  const r = steerMessage({}, '你好')
  assert.equal(r.ok, false)
  assert.match(r.note, /没有 steer/)
})

test('steer 抛错 → 如实失败，桥会据此退回排队', () => {
  const agent = { steer: () => { throw new Error('宿主炸了') } }
  const r = steerMessage(agent, '你好')
  assert.equal(r.ok, false)
  assert.match(r.note, /宿主炸了/)
})

test('守卫：路由过 localOnly，且 fish-steer 进了 MACHINE_KINDS', async () => {
  const observe = await readFile(new URL('../lib/observe.js', import.meta.url), 'utf8')
  const turns = await readFile(new URL('../lib/turns.js', import.meta.url), 'utf8')
  assert.match(observe, /\['\/local\/steer', handleSteer\]/, '路由要注册')
  assert.match(observe, /handler: localOnly\(h\)/, '必须过本地密钥')
  assert.match(observe, /async function handleSteer/)
  assert.match(turns, /'fish-steer'/, '漏了会把插话记成「他又来过」，污染轮数与冷落天数')
})

test('守卫：插话不写 seen / talk 记账，也不加系统旁白', async () => {
  const src = await readFile(new URL('../lib/observe.js', import.meta.url), 'utf8')
  const body = /export async function steerToHer[\s\S]*?\n}\n/.exec(src)?.[0] ?? ''
  assert.ok(body, '要能找到 steerToHer')
  assert.ok(!body.includes('seen:'), '① 已经记过他来过，② 不该重复记一轮')
  assert.ok(!body.includes('talk:'), '插话没有独立的一轮回复，不写 talk')
  assert.match(body, /steerMessage\(agent, text\)/, '投递交给纯函数，正文原样')
  assert.match(body, /ctx\?\.get\?\.\('agents'\)/, '先拿活 agent，避开回合在跑时的 writer-held')
  const sender = /export function steerMessage[\s\S]*?\n}\n/.exec(src)?.[0] ?? ''
  assert.match(sender, /fishMessage/, '消息本身到达就是通知')
  assert.ok(!sender.includes('他又发了一条'), '不写系统旁白：会被她读成有人对她说了这句话')
})
