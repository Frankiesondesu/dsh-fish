// 请神：把一条正在用的对话临时交给她。
// 关键不是「提示词写得好」，而是段名对得上、能撤、冷会话能补挂、拒绝理由是人话。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attachPossession,
  detachPossession,
  livePossessions,
  possessionText,
  registerPossession,
  activePossessionSync,
  PERSONA_PREFIX_SECTION,
  POSSESS_SECTION,
} from '../lib/possess.js'
import { readPossessions, startPossession, endPossession } from '../lib/outing.js'

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-fish-possess-'))
}

function fakeAgent(id = 'session-abc') {
  const sections = []
  const guards = []
  const effects = []
  return {
    session: { header: { id, cwd: 'D:/work' } },
    ctx: {
      systemPrompt: {
        section: (s) => { sections.push(s); return () => { s.disposed = true } },
      },
      tools: { guard: (fn) => { guards.push(fn); return () => { guards.splice(guards.indexOf(fn), 1) } } },
      effect: (fn) => effects.push(fn),
    },
    sections,
    guards,
    effects,
  }
}

test('请神正文带着走时的自己，并说清楚此刻在谁的地盘', () => {
  const text = possessionText('D:/fake-root', { identity: '我是她。', title: '一个对话' })
  assert.ok(text.startsWith('我是她。'))
  assert.ok(text.includes('此刻你在「一个对话」里说话'))
  assert.ok(text.includes('你的屋子照旧别去动'))
})

test('先按宿主自己的段名覆盖人格（同名才叫换人）', () => {
  const agent = fakeAgent()
  const r = attachPossession(agent, { root: 'D:/fake-root', herDir: 'D:/fake-root/home', rec: { identity: '走时的我', title: 'T' } })
  assert.equal(r.ok, true)
  assert.equal(agent.sections[0].name, PERSONA_PREFIX_SECTION)
  assert.equal(agent.sections[0].order, 10100)
  assert.equal(agent.sections[0].text(), possessionText('D:/fake-root', { identity: '走时的我', title: 'T' }))
  assert.ok(agent.guards.length >= 1, '要挂兜底守卫')
  assert.ok(livePossessions().includes('session-abc'))
  detachPossession('session-abc')
  assert.ok(!livePossessions().includes('session-abc'))
})

test('覆盖不上就退到自己的段名，并在日志里说清楚（不静默失效）', () => {
  const logs = []
  const agent = fakeAgent()
  agent.ctx.systemPrompt.section = (s) => {
    if (s.name === PERSONA_PREFIX_SECTION) throw new Error('already registered')
    agent.sections.push(s)
    return () => {}
  }
  const r = attachPossession(agent, {
    root: 'D:/fake-root',
    herDir: 'D:/fake-root/home',
    rec: { identity: '走时的我' },
    log: (m) => logs.push(m),
  })
  assert.equal(r.ok, true)
  assert.equal(r.section, POSSESS_SECTION)
  assert.ok(logs.some((m) => m.includes('没覆盖上')))
  detachPossession('session-abc')
})

test('宿主没有 systemPrompt.section 时如实报错，不假装成功', () => {
  const agent = { ctx: {} }
  const r = attachPossession(agent, { root: 'D:/fake-root', herDir: 'D:/fake-root/home' })
  assert.equal(r.ok, false)
  assert.ok(r.why.includes('systemPrompt.section'))
})

test('冷会话补挂：名单里那条 id 对上了才挂', () => {
  const root = tmpRoot()
  const agent = fakeAgent('session-cold')
  let handler = null
  const ctx = { on: (evt, fn) => { if (evt === 'agent/created') handler = fn; return () => { handler = null } } }
  registerPossession(ctx, { root, herDir: join(root, 'home') })
  assert.equal(typeof handler, 'function')
  // 名单里没有 → 不挂
  handler({ agent })
  assert.equal(agent.sections.length, 0)
  writeFileSync(join(root, 'possessions.json'), JSON.stringify({
    version: 1,
    possessions: [{ sessionId: 'session-cold', title: '冷', status: 'active', startedAt: 1 }],
  }))
  handler({ agent })
  // 两段：人格前缀换成她，人格后缀清空（宿主自己的后缀留着会和「此刻在别处」打架）
  assert.equal(agent.sections.length, 2)
  assert.equal(agent.sections[0].name, PERSONA_PREFIX_SECTION)
  assert.equal(agent.sections[1].text(), '')
  detachPossession('session-cold')
  rmSync(root, { recursive: true, force: true })
})

test('activePossessionSync 只认 active（坏档当没有）', () => {
  const root = tmpRoot()
  assert.equal(activePossessionSync(root), null)
  writeFileSync(join(root, 'possessions.json'), '{ 坏档')
  assert.equal(activePossessionSync(root), null)
  writeFileSync(join(root, 'possessions.json'), JSON.stringify({
    possessions: [{ sessionId: 'a', status: 'done' }, { sessionId: 'b', status: 'active' }],
  }))
  assert.equal(activePossessionSync(root).sessionId, 'b')
  rmSync(root, { recursive: true, force: true })
})

test('请神台账存一份身份快照（回来的路上也不读家里的活文件）', async () => {
  const root = tmpRoot()
  const r = await startPossession(root, { sessionId: 's1', title: 'T', identity: '走时的我' })
  assert.equal(r.ok, true)
  assert.equal(r.possession.identity, '走时的我')
  const { possessions } = await readPossessions(root)
  assert.equal(possessions[0].identity, '走时的我')
  await endPossession(root, { sessionId: 's1' })
  const after = await readPossessions(root)
  assert.equal(after.possessions[0].status, 'done')
  rmSync(root, { recursive: true, force: true })
})

test('请神与出门不能同时开（出门那条占着就不能请）', async () => {
  const root = tmpRoot()
  writeFileSync(join(root, 'outings.json'), JSON.stringify({
    version: 1,
    outings: [{ sessionId: 'o1', cwd: 'D:/x', status: 'active', startedAt: 1 }],
  }))
  const r = await startPossession(root, { sessionId: 's1' })
  assert.equal(r.ok, false)
  assert.ok(r.why.includes('出门'))
  rmSync(root, { recursive: true, force: true })
})
