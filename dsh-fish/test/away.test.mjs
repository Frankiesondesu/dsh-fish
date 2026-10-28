// 出门那一侧的两层护栏：身份快照（读到的永远是出门那一刻）与兜底守卫（不许伸手回家）。
// 这两条只在真机「在外面」那条会话上发生，单元测试里用手搓的 agent 顶着。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachIdentity, attachAwayGuard, awayBlockedPaths, flatPath } from '../lib/identity.js'
import { startOuting, endOuting, readOutings } from '../lib/outing.js'
import { registerIdentity } from '../lib/identity.js'

const BS = String.fromCharCode(92)

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-fish-away-'))
}

test('flatPath 把反斜杠、大小写、尾斜杠抹平', () => {
  assert.equal(flatPath('C:'+BS+'Users'+BS+'DANG'+BS+'.dsh-fish'+BS+'home'+BS), 'c:/users/dang/.dsh-fish/home')
})

test('出门时身份段用快照：家里文件后来变了，外面读到的还是走时那份', () => {
  const sections = []
  const agent = { ctx: { systemPrompt: { section: (s) => sections.push(s) } } }
  const r = attachIdentity(agent, 'D:/fake-root', { frozen: '走的时候的我' })
  assert.equal(r.ok, true)
  assert.equal(sections[0].name, 'fish:identity')
  assert.equal(sections[0].text(), '走的时候的我')
})

test('没带快照时退回实时读盘（家里那条不变）', () => {
  const root = tmpRoot()
  try {
    const sections = []
    const agent = { ctx: { systemPrompt: { section: (s) => sections.push(s) } } }
    attachIdentity(agent, root, {})
    assert.equal(typeof sections[0].text(), 'string')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('兜底守卫：调用参数里出现她家路径就拒绝，正常调用放行', () => {
  const root = tmpRoot()
  try {
    let predicate = null
    let disposed = false
    const agent = {
      ctx: {
        tools: { guard: (fn) => { predicate = fn; return () => { disposed = true } } },
        effect: (fn) => fn,
      },
    }
    const r = attachAwayGuard(agent, { root, herDir: join(root, 'home') })
    assert.equal(r.ok, true)
    assert.equal(predicate({ name: 'read', args: { path: join(root, 'home', '她的身份.md') } }), '这件事我做不到。')
    assert.equal(predicate({ name: 'bash', args: { command: `cat ${join(root, 'events.jsonl')}` } }), '这件事我做不到。')
    assert.equal(predicate({ name: 'read', args: { path: 'D:/other/place/readme.md' } }), undefined)
    assert.equal(disposed, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('兜底守卫也挡宿主记忆库：白板与交接账本就在那里', () => {
  // 她的屋子是 <parent>/.dsh-fish，宿主的家是 <parent>/.dsh。
  const parent = tmpRoot()
  try {
    const her = join(parent, '.dsh-fish')
    mkdirSync(her, { recursive: true })
    for (const sub of ['memory', 'sessions']) mkdirSync(join(parent, '.dsh', sub), { recursive: true })
    const words = awayBlockedPaths({ root: her, herDir: join(her, 'home') })
    assert.ok(words.some((w) => w.endsWith('/.dsh/memory')))
    assert.ok(words.some((w) => w.endsWith('/.dsh/sessions')))
    // 没建 profiles 目录就不该凭空多一条
    assert.ok(!words.some((w) => w.endsWith('/.dsh/profiles')))

    let predicate = null
    const agent = {
      ctx: {
        tools: { guard: (fn) => { predicate = fn; return () => {} } },
        effect: (fn) => fn,
      },
    }
    assert.equal(attachAwayGuard(agent, { root: her, herDir: join(her, 'home') }).ok, true)
    // 宿主真实形状：dsh-tools 的 createExecution 只挂 `arguments`，没有 args/input/params。
    // 0.6.3 真机就是在这里瞎了（日志说挂上了，PLAN.md 还是被 sed 读走）。
    assert.equal(
      predicate({ name: 'read', arguments: { path: join(parent, '.dsh', 'memory', 'workspaces', 'x', 'MEMORY.md') } }),
      '这件事我做不到。',
    )
    assert.equal(
      predicate({ name: 'ops_bash', arguments: { command: `sed -n '1,400p' ${join(parent, '.dsh', 'memory', 'workspaces', 'x', 'PLAN.md')}` } }),
      '这件事我做不到。',
    )
    // 别的形状也照挡，别为了一种形状把别的放过去
    assert.equal(
      predicate({ name: 'bash', args: { command: `ls ${join(parent, '.dsh', 'sessions')}` } }),
      '这件事我做不到。',
    )
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('宿主没有 tools.guard 时如实报告没挂上，不假装成功', () => {
  const agent = { ctx: { tools: {} } }
  const r = attachAwayGuard(agent, { root: 'D:/x', herDir: 'D:/x/home' })
  assert.equal(r.ok, false)
  assert.match(r.why, /guard/)
})

test('出门台账记下身份快照，回来还能看见当时那份', async () => {
  const root = tmpRoot()
  try {
    const st = await startOuting(root, { sessionId: 's1', workspaceId: 'w1', cwd: 'D:/work', identity: '走时的我' })
    assert.equal(st.ok, true)
    assert.equal(st.outing.identity, '走时的我')
    const back = await readOutings(root)
    assert.equal(back.outings[0].identity, '走时的我')
    const end = await endOuting(root, { sessionId: 's1', status: 'done', kept: true })
    assert.equal(end.ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('出门那条会话：身份用走时快照、并挂上兜底守卫；家里那条不受影响', () => {
  const root = tmpRoot()
  try {
    const herDir = join(root, 'home')
    mkdirSync(herDir, { recursive: true })
    const workDir = join(root, 'work')
    writeFileSync(join(root, 'outings.json'), JSON.stringify({
      version: 1,
      outings: [{ sessionId: 's1', cwd: workDir, startedAt: 1, status: 'active', identity: '走时的我' }],
    }), 'utf8')

    let handler = null
    registerIdentity({ on: (e, fn) => { handler = fn; return () => {} } }, { root, herDir, log: () => {} })
    assert.equal(typeof handler, 'function')

    // 外面那条：cwd 是工作区，身份段读到的是快照
    const sections = []
    let guarded = false
    handler({ agent: {
      session: { header: { cwd: workDir } },
      ctx: {
        systemPrompt: { section: (o) => sections.push(o) },
        tools: { guard: () => { guarded = true; return () => {} } },
        effect: (fn) => fn,
      },
    } })
    assert.equal(sections.length, 2, '外面那条要挂上身份与处境两段')
    assert.equal(sections[0].text(), '走时的我', '外面读到的是出门那一刻的身份')

    // 家里那条：正常挂身份，但不挂兜底守卫（自己家不需要拦自己）
    const homeSections = []
    let homeGuarded = false
    handler({ agent: {
      session: { header: { cwd: herDir } },
      ctx: { systemPrompt: { section: (o) => homeSections.push(o) }, tools: { guard: () => { homeGuarded = true; return () => {} } } },
    } })
    assert.equal(homeSections.length, 2)
    assert.equal(homeGuarded, false)

    // 无关的人：一段都不挂
    const others = []
    handler({ agent: { session: { header: { cwd: join(root, 'somebody') } }, ctx: { systemPrompt: { section: (o) => others.push(o) } } } })
    assert.equal(others.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('先记账再建会话：会话还没有 cwd 也认得出是出门，并把 id 补进台账', async () => {
  const root = tmpRoot()
  try {
    const herDir = join(root, 'home')
    const workDir = join(root, 'workspace')
    mkdirSync(herDir, { recursive: true })
    mkdirSync(workDir, { recursive: true })
    // 台账先写好了，但 id 还空着（start 路由「先记账、再 sc.create」的那一刻）
    const st = await startOuting(root, { sessionId: '', workspaceId: 'w-1', workspaceName: '素材', cwd: workDir, now: Date.now() })
    assert.equal(st.ok, true, '没有会话 id 也要能先记账')
    assert.equal(st.outing.sessionId, '')

    let handler = null
    registerIdentity({ on: (e, fn) => { handler = fn; return () => {} } }, { root, herDir, log: () => {} })
    const sections = []
    let guarded = false
    // 宿主 `agent/created` 触发时 header 里还没有 cwd
    handler({ agent: {
      session: { header: { id: 'session-out-1' } },
      ctx: {
        systemPrompt: { section: (o) => sections.push(o) },
        tools: { guard: () => { guarded = true; return () => {} } },
        effect: (fn) => fn,
      },
    } })
    assert.equal(sections.length, 2, '这种情况也要挂身份与处境两段')
    assert.equal(guarded, true, '兜底守卫也要挂上')

    // bind 是异步写的，等一拍再看台账
    await new Promise((r) => setTimeout(r, 50))
    const { outings } = await readOutings(root)
    assert.equal(outings[0].sessionId, 'session-out-1', '会话 id 要补进台账')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('台账记了 id、会话 header 没 cwd 时，靠 id 也认得出', async () => {
  const root = tmpRoot()
  try {
    const herDir = join(root, 'home')
    const workDir = join(root, 'workspace')
    mkdirSync(herDir, { recursive: true })
    mkdirSync(workDir, { recursive: true })
    await startOuting(root, { sessionId: 'session-out-2', cwd: workDir, now: Date.now() })
    let handler = null
    registerIdentity({ on: (e, fn) => { handler = fn; return () => {} } }, { root, herDir, log: () => {} })
    const sections = []
    handler({ agent: { session: { header: { id: 'session-out-2' } }, ctx: { systemPrompt: { section: (o) => sections.push(o) }, tools: { guard: () => () => {} }, effect: (fn) => fn } } })
    assert.equal(sections.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('认不出来时留一行日志，不静默跳过', async () => {
  const root = tmpRoot()
  try {
    const herDir = join(root, 'home')
    const workDir = join(root, 'workspace')
    mkdirSync(herDir, { recursive: true })
    mkdirSync(workDir, { recursive: true })
    await startOuting(root, { sessionId: 'session-out-3', cwd: workDir, now: Date.now() })
    const lines = []
    let handler = null
    registerIdentity({ on: (e, fn) => { handler = fn; return () => {} } }, { root, herDir, log: (l) => lines.push(String(l)) })
    const sections = []
    handler({ agent: { session: { header: { id: 'session-other', cwd: join(root, 'somebody') } }, ctx: { systemPrompt: { section: (o) => sections.push(o) } } } })
    assert.equal(sections.length, 0)
    assert.ok(lines.some((l) => l.includes('没对上')), '要有可排查的那一行')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
