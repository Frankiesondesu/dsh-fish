/**
 * outing-start.test.mjs —— `/outing` 的 start 分支与 `/possession` 路由，端到端跑一遍。
 *
 * 缺口来由（2026-10-29，用户 m01086 批准补）：
 * `/outing` 的 start 分支约 120 行，此前**只有源码字符串断言**（`src.includes(...)`），
 * grep 绿不等于行为对；而历史上最贵的三次事故全长在这段：
 *   - 0.6.3  顺序错：先建会话再记账 → `agent/created` 钩子看不到出门记录，身份段一段没挂
 *   - 0.6.25 幽灵出门：建会话失败后台账留在 active，她在门外、家里调度一直暂停
 *   - 0.6.27 点「接回上次那趟」500：宿主没有 `sc.resume`，得走 `resolveAgent`
 * `/possession` 路由此前**一条路由级测试都没有**（库层 13 条测不到「找活 agent 出错就静默」）。
 *
 * 假 ctx + 假 req/res，不碰真实家目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { registerObserve } from '../lib/observe.js'
import { attachIdentity } from '../lib/identity.js'
import { readOutings, readPossessions, snapshotEvents, startOuting, endOuting, startPossession } from '../lib/outing.js'

function fakeAgent(id, cwd) {
  const sections = []
  const guards = []
  const appended = []
  return {
    session: {
      header: { id, cwd },
      append: (type, payload) => { appended.push({ type, payload }) },
    },
    ctx: {
      systemPrompt: {
        section: (s) => { sections.push(s); return () => { s.disposed = true } },
      },
      tools: {
        guard: (fn) => {
          guards.push(fn)
          return () => {
            const i = guards.indexOf(fn)
            if (i >= 0) guards.splice(i, 1)
          }
        },
      },
      effect: () => () => {},
    },
    sections,
    guards,
    appended,
  }
}

/**
 * @param {string} root
 * @param {{ create?: Function, registry?: object[], agents?: object[] }} opts
 *   `create` 模拟宿主的 `sessionController.create`：返回一条 agent（或抛错）。
 */
function harness(root, { create = async () => fakeAgent('session-new', root), registry = [], agents = [] } = {}) {
  const routes = new Map()
  const prompts = []
  const created = []
  const agentMap = new Map(agents.map((a) => [String(a.session?.header?.id ?? ''), a]))
  const ctx = {
    get(name) {
      if (name === 'connection') return { requestRejection: () => null }
      if (name === 'webServer') {
        return {
          register(ex) {
            routes.set(ex.path, ex.handler)
            return () => {}
          },
        }
      }
      if (name === 'sessionController') {
        return {
          async create(opts) {
            created.push(opts)
            const a = await create(opts)
            agentMap.set(String(a.session?.header?.id ?? ''), a)
            return { sessionId: a.session?.header?.id }
          },
          async prompt(req, signal) {
            prompts.push({ ...req, signal })
            return { ok: true }
          },
        }
      }
      if (name === 'workspaceRegistry') return { list: () => registry }
      if (name === 'agents') {
        return {
          get: (id) => agentMap.get(String(id ?? '')) ?? null,
          list: () => [...agentMap.values()],
        }
      }
      return undefined
    },
  }
  registerObserve(ctx, { root })

  async function call(method, body, path = '/dsh-fish/outing') {
    const handler = routes.get(path)
    assert.ok(handler, `路由 ${path} 要注册上`)
    const req = method === 'POST'
      ? Object.assign(Readable.from([Buffer.from(JSON.stringify(body ?? {}), 'utf8')]), { method, headers: {} })
      : Object.assign(Readable.from([]), { method, headers: {} })
    let status = 0
    let text = ''
    const res = {
      writableEnded: false,
      writeHead(code) { status = code },
      end(chunk) { text = String(chunk ?? ''); res.writableEnded = true },
    }
    await handler(req, res)
    return { status, json: text ? JSON.parse(text) : null }
  }

  return { call, prompts, created, agentMap }
}

const line = (id, ts, type = 'utterance', text = '在家') =>
  JSON.stringify({ id, v: 1, ts, day: 1, stage: 1, type, source: 'her', text, refs: [], verdict: null, confidence: 0.5, flags: [] }) + '\n'

test('/outing start：建会话、绑台账、记身份快照、递首轮，一个都不能少', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-outing-start-'))
  try {
    mkdirSync(join(root, 'home'), { recursive: true })
    writeFileSync(join(root, 'home', '她的身份.md'), '我是大肥鱼。\n')
    const wsPath = join(root, 'ws1')
    mkdirSync(wsPath, { recursive: true })
    writeFileSync(join(root, 'events.jsonl'), line('ev_before', '2026-10-29T00:00:00.000Z'))

    const agent = fakeAgent('session-new', wsPath)
    const h = harness(root, {
      registry: [{ id: 'w1', path: wsPath, title: '素材' }],
      // 宿主建完会话会同步触发 `agent/created`，identity.js 的钩子在那时挂装备。
      create: async () => {
        attachIdentity(agent, root, { herDir: join(root, 'home') })
        return agent
      },
    })

    const r = await h.call('POST', { action: 'start', workspaceId: 'w1' })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.ok, true)
    assert.equal(r.json.sessionId, 'session-new', '会话 id 要回给界面')
    assert.equal(r.json.reused, false, '新开一条不是接回')
    assert.equal(r.json.tripNo, 1)
    assert.equal(r.json.equipped, true, '装备挂上了就不该报「一段都没挂上」')

    const { outings } = await readOutings(root)
    assert.equal(outings.length, 1)
    assert.equal(outings[0].status, 'active')
    assert.equal(outings[0].sessionId, 'session-new', 'bindOutingSession 必须把 id 补进台账')
    assert.equal(outings[0].cwd, wsPath, '台账里记的是那个工作区的路径')
    assert.ok(outings[0].baseline && outings[0].baseline.size > 0, '出门前要留事件流基线')
    assert.equal(outings[0].identity, '我是大肥鱼。\n', '要带走出门那一刻的身份快照')

    assert.equal(h.prompts.length, 1, '首轮必须递话，否则她冷启动不知道自己出门了')
    assert.equal(h.prompts[0].sessionId, 'session-new')
    assert.equal(h.prompts[0].mode, 'queue')
    assert.match(String(h.prompts[0].content[0].text), /你出门了/)
    assert.ok(h.prompts[0].signal, '宿主必填 signal（issue #1）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('/outing start：装配失败要把这趟撤干净，不留幽灵出门', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-outing-start-'))
  try {
    mkdirSync(join(root, 'home'), { recursive: true })
    const wsPath = join(root, 'ws1')
    mkdirSync(wsPath, { recursive: true })
    writeFileSync(join(root, 'events.jsonl'), line('ev_before', '2026-10-29T00:00:00.000Z'))

    const h = harness(root, {
      registry: [{ id: 'w1', path: wsPath, title: '素材' }],
      create: async () => { throw new Error('宿主拒绝建会话') },
    })

    const r = await h.call('POST', { action: 'start', workspaceId: 'w1' })
    assert.equal(r.status, 500, JSON.stringify(r.json))
    assert.match(String(r.json.why), /已经撤掉这趟/, '把失败原因说清楚，别只说 500')
    assert.match(String(r.json.why), /宿主拒绝建会话/)

    // 真正的验收：台账里一条都不能留。留着她就「挂在门外」，家里调度一直暂停。
    const { outings } = await readOutings(root)
    assert.equal(outings.length, 0, '装配失败必须把空壳记录撤掉')
    assert.equal(h.prompts.length, 0, '会话都没建出来，不该递话')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('/possession：出门中不许请神；结束时交接句真的写进那条对话', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-possess-route-'))
  try {
    mkdirSync(join(root, 'home'), { recursive: true })
    const wsPath = join(root, 'ws1')
    mkdirSync(wsPath, { recursive: true })
    writeFileSync(join(root, 'events.jsonl'), line('ev_before', '2026-10-29T00:00:00.000Z'))

    const talk = fakeAgent('session-talk', join(root, 'other'))
    const h = harness(root, { agents: [talk] })

    // a) 她正在出门 → 请神必须拒，且理由是人话（不能让她同时出现在两处）
    await startOuting(root, {
      sessionId: 'session-out',
      workspaceId: 'w1',
      workspaceName: '素材',
      cwd: wsPath,
      baseline: snapshotEvents(join(root, 'events.jsonl')),
      identity: '',
      now: Date.parse('2026-10-29T00:10:00.000Z'),
    })
    const blocked = await h.call('POST', { action: 'start', sessionId: 'session-talk' }, '/dsh-fish/possession')
    assert.equal(blocked.status, 409, JSON.stringify(blocked.json))
    assert.match(String(blocked.json.why), /正在出门/)
    assert.equal(readPossessions && (await readPossessions(root)).possessions.length, 0, '被拒时台账不能留下请神记录')

    // b) 出门收掉之后才请得成；结束时那条对话必须收到交接句
    await endOuting(root, { sessionId: 'session-out', status: 'done', kept: true, now: Date.parse('2026-10-29T00:20:00.000Z') })
    await startPossession(root, {
      sessionId: 'session-talk',
      title: '一个对话',
      cwd: join(root, 'other'),
      identity: '',
      now: Date.parse('2026-10-29T00:30:00.000Z'),
    })

    const ended = await h.call('POST', { action: 'end', sessionId: 'session-talk' }, '/dsh-fish/possession')
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    assert.equal(ended.json.ok, true)
    assert.equal(talk.appended.length, 1, 'history 是 append-only，只能补一条交接句')
    assert.equal(talk.appended[0].type, 'user/message')
    assert.equal(talk.appended[0].payload.role, 'user')
    const said = String(talk.appended[0].payload.content[0].text)
    assert.match(said, /大肥鱼回去了/, '得让她下一轮读到「已经还给你了」，不然她会顺着自己上一句续戏')
    assert.match(said, /开一条新对话最稳/)

    const { possessions } = await readPossessions(root)
    assert.equal(possessions[0].status, 'done', '台账要收尾')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2026-10-29（用户 m01581，真机）：出门口袋里她拒绝用 growth_commit 记东西。
//
// 病根不是功能坏了——tenant.checkCaller 对出门会话是放行的、路径守卫只看参数里的
// 路径字符串、growth_commit 的参数里没有路径。她的拒绝来自提示词：出门首轮说
// 「你自己的屋子里的东西不要动」，工具手册说「上面这几样是你自己的屋子里的东西」，
// 她据此判定 growth_commit 属于屋子、这趟不该碰，整趟一条没写。
//
// 这条用例钉住三件事：① 出门首轮必须把「文件与记录」和「工具」分开；
// ② 工具手册不许再把工具说成屋子里的东西；③ 不许再出现那句引发误解的原话。
// ---------------------------------------------------------------------------
test('出门首轮要说清：不许碰的是屋子里的文件和记录，不是工具（m01581）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-outing-wake-'))
  try {
    const wsPath = join(root, 'elsewhere')
    mkdirSync(join(root, 'home'), { recursive: true })
    mkdirSync(wsPath, { recursive: true })
    writeFileSync(join(root, 'home', '她的身份.md'), '我是大肥鱼。\n', 'utf8')

    const h = harness(root, {
      registry: [{ id: 'w1', path: wsPath, title: '素材' }],
      create: async () => {
        const agent = fakeAgent('session-wake', wsPath)
        attachIdentity(agent, root, { herDir: join(root, 'home') })
        return agent
      },
    })

    const r = await h.call('POST', { action: 'start', workspaceId: 'w1' })
    assert.equal(r.status, 200, JSON.stringify(r.json))

    const wake = String(h.prompts[0].content[0].text)
    // ① 禁的是「文件和记录」，原话必须点明这两个词
    assert.match(wake, /文件和记录不要动/, '要禁的对象必须是文件和记录，不能只说「屋子里的东西」')
    // ② 工具被显式排除在外，并且写清「用它记东西不算越界」
    assert.match(wake, /工具不是屋子里的东西/, '必须显式把工具从「屋子里的东西」里摘出来')
    assert.match(wake, /记在我自己的账上|应该的/, '要告诉她用工具写下的东西落在自己账上是应该的')
    // ③ 那句真机上把她带偏的原话不许再出现
    assert.ok(!wake.includes('你自己的屋子里的东西不要动'), '原来那句「你自己的屋子里的东西不要动」必须消失')
    // ④ 原有三件事不能因此丢掉
    assert.match(wake, /你出门了/)
    assert.match(wake, /等家里人叫你回去/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('工具手册不许把工具说成「屋子里的东西」（m01581）', async () => {
  const { toolBrief } = await import('../lib/persona.js')
  const txt = toolBrief(['ops_bash'])
  assert.ok(!txt.includes('上面这几样是你自己的屋子里的东西'), '原来那句会被身份快照原样带出门，必须改掉')
  assert.match(txt, /跟着我走|不是屋子里的东西/, '要把「工具跟着她走」说清楚')
  assert.match(txt, /growth_commit/, '工具名照旧要念给她听')
  assert.match(txt, /ops_bash/, '额外放行的工具名照旧要念')
})

// 2026-10-30（用户 m03179）：请神结束那条对话没开着时，交接句要排队补投，不能丢。
test('/possession 结束：那条对话没开着时，交接句排进队列', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-possess-'))
  try {
    mkdirSync(join(root, 'home'), { recursive: true })
    writeFileSync(join(root, 'events.jsonl'), line('ev_before', '2026-10-29T00:00:00.000Z'))
    await startPossession(root, {
      sessionId: 'session-away',
      title: '一个对话',
      cwd: join(root, 'other'),
      identity: '',
      now: Date.parse('2026-10-29T00:10:00.000Z'),
    })
    const h = harness(root, { agents: [] })
    const ended = await h.call('POST', { action: 'end', sessionId: 'session-away' }, '/dsh-fish/possession')
    assert.equal(ended.status, 200, JSON.stringify(ended.json))
    assert.equal(ended.json.note?.queued, true)
    const saved = JSON.parse(readFileSync(join(root, 'session-notes.json'), 'utf8'))
    assert.equal(saved.notes.length, 1)
    assert.match(String(saved.notes[0].text), /还给你/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
