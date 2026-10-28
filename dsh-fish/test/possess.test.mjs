// 请神：把一条正在用的对话临时交给她。
// 关键不是「提示词写得好」，而是段名对得上、能撤、冷会话能补挂、拒绝理由是人话。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attachPossession,
  detachPossession,
  livePossessions,
  possessionText,
  registerPossession,
  activePossessionSync,
  releaseNoteText,
  appendReleaseNote,
  releasePossession,
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

// 2026-10-29 用户 m00924 真机发现：请走之后那条对话还自称是大肥鱼。
// 根因不是提示词污染（请神段确实撤了），而是历史 append-only——她说过的话留在里面。
// 对策：结束的瞬间往那条对话补一条可见的「已经还给你了」，让下一轮读到交接事实。
test('交接句说清楚她已经回去，并明说历史留在上面', () => {
  const plain = releaseNoteText()
  assert.ok(plain.includes('大肥鱼回去了，这条对话还给你。'))
  assert.ok(plain.includes('想完全干净'))
  // 2026-10-29 用户 m02381：不再接受「临走留言」参数，交接句只有固定两句。
  assert.equal(plain, '（大肥鱼回去了，这条对话还给你。）\n请神期间她说过的话仍留在上面的历史里；想完全干净，开一条新对话最稳。')
})

test('交接句是一条合法的 user/message（带 surfaceOp:append，宿主才收）', () => {
  const written = []
  const agent = {
    session: { append: (type, data, opts) => written.push({ type, data, opts }) },
  }
  const r = appendReleaseNote(agent)
  assert.equal(r.ok, true)
  assert.equal(written.length, 1)
  const ev = written[0]
  assert.equal(ev.type, 'user/message')
  assert.equal(ev.data.role, 'user')
  assert.equal(ev.data.source.kind, 'user')
  assert.ok(ev.data.id && ev.data.id.startsWith('fish-release-'))
  assert.equal(ev.data.content[0].type, 'text')
  assert.ok(ev.data.content[0].text.includes('这条对话还给你'))
  assert.equal(ev.opts.surfaceOp, 'append')
})

test('写不进去不抛：那条对话收起来了，请神照样算结束', () => {
  const r = appendReleaseNote({})
  assert.equal(r.ok, false)
  assert.ok(r.why.includes('写不进去'))
  const broken = appendReleaseNote({ session: { append: () => { throw new Error('session closed') } } })
  assert.equal(broken.ok, false)
  assert.ok(broken.why.includes('session closed'))
})

test('releasePossession 先撤挂载，再补交接句，两件事互不连坐', async () => {
  const root = tmpRoot()
  await startPossession(root, { sessionId: 's9', title: '一个对话', identity: '我' })
  const written = []
  const agent = { session: { append: (type, data, opts) => written.push({ type, data, opts }) } }
  const r = await releasePossession(root, { sessionId: 's9', agent })
  assert.equal(r.ok, true)
  assert.equal(r.possession.status, 'done')
  assert.equal(r.note.ok, true)
  assert.equal(written.length, 1)
  assert.ok(written[0].data.content[0].text.includes('这条对话还给你'))
  // 没有活 agent 时照旧结束，只是 note 说明写不进去
  await startPossession(root, { sessionId: 's10', title: '另一条' })
  const r2 = await releasePossession(root, { sessionId: 's10' })
  assert.equal(r2.ok, true)
  assert.equal(r2.note.ok, false)
  assert.ok(r2.note.why.includes('没开着'))
  rmSync(root, { recursive: true, force: true })
})

test('结束请神只补标准交接句：路由不传 farewell，界面也没有那句输入框', () => {
  const src = readFileSync(new URL('../lib/observe.js', import.meta.url), 'utf8')
  assert.ok(!src.includes('farewell'))
  assert.ok(src.includes('note: r.note'))
  assert.ok(src.includes("ctx.get?.('agents')"))
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(!client.includes('possessFarewell'))
  assert.ok(!client.includes('临走留一句'))
  assert.ok(client.includes('想完全干净'))
  assert.ok(client.includes("{ action: 'end' }"))
})
