import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name, inject } from '../lib/index.js'
import { readEvents, paths, writeConfig, appendEvent } from '../lib/store.js'
import { normalizeConfig } from '../lib/settings.js'
import { deriveSelf } from '../lib/derive.js'
import { startScheduler, wakeNow } from '../lib/scheduler.js'
import { rememberKnownTools } from '../lib/restrict.js'
import { dateKey } from '../lib/settings.js'
import { writeSelfDoc } from '../lib/selfdoc.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-boot-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** 假宿主：tools / webServer / connection / sessionController / logger 全套 */
function fakeCtx({ allow = true, promptImpl } = {}) {
  const tools = new Map()
  const routes = []
  const prompts = []
  const sessions = new Set()
  const creates = []
  const ctx = {
    tools: { register: (spec) => { tools.set(spec.name, spec); return () => tools.delete(spec.name) } },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    connection: { requestRejection: () => (allow ? null : { status: 403, message: 'blocked' }) },
    sessionController: {
      async create({ sessionId, cwd }) { creates.push({ sessionId, cwd }); if (sessions.has(sessionId)) throw new Error('exists'); sessions.add(sessionId) },
      async prompt(payload) { prompts.push(payload); if (promptImpl) await promptImpl(payload) },
    },
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    get(key) { return ctx[key] },
  }
  return { ctx, tools, routes, prompts, sessions, creates }
}

test('插件元信息：名字与 inject', () => {
  assert.equal(name, 'dsh-fish')
  assert.ok(Array.isArray(inject), 'inject 必须是数组（写成对象会让 sessionController 静默丢失）')
  for (const k of ['sessionController', 'tools', 'webServer', 'connection']) assert.ok(inject.includes(k), `缺 ${k}`)
})

test('首次启动会播种，且只播一次', async () => {
  await withRoot(async (root) => {
    const { ctx } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    let { events } = await readEvents(root)
    const seeds = events.filter((e) => e.type === 'seed')
    assert.equal(seeds.length, 1)
    assert.ok(seeds[0].text.length > 20, '种子文本不能是空壳')
    assert.equal(seeds[0].source, 'system')

    // 再来一次（模拟重启）
    const h2 = apply(fakeCtx().ctx, { root })
    await new Promise((r) => setTimeout(r, 120))
    ;({ events } = await readEvents(root))
    assert.equal(events.filter((e) => e.type === 'seed').length, 1, '重启不能重复播种')

    h.dispose?.(); h2.dispose?.()
  })
})

test('注册了 growth_commit 与观测台路由', async () => {
  await withRoot(async (root) => {
    const { ctx, tools, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    assert.ok(tools.has('growth_commit'))
    const paths_ = routes.map((r) => r.path)
    assert.ok(paths_.includes('/dsh-fish'), '首页要注册')
    assert.ok(paths_.includes('/dsh-fish/state'))
    assert.ok(paths_.includes('/dsh-fish/config'))
    h.dispose?.()
  })
})

test('信任栅栏 fail-closed：connection 拒绝时 403', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx({ allow: false })
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const route = routes.find((r) => r.path === '/dsh-fish/state')
    const res = fakeRes()
    await route.handler({ url: '/dsh-fish/state', method: 'GET' }, res)
    assert.equal(res.code, 403)

    h.dispose?.()
  })
})

test('观测台 /state 不泄露 needs 数值', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const route = routes.find((r) => r.path === '/dsh-fish/state')
    const res = fakeRes()
    await route.handler({ url: '/dsh-fish/state', method: 'GET' }, res)
    assert.equal(res.code, 200)
    const dumped = res.body.toLowerCase()
    for (const leak of ['autonomy', 'competence', 'relatedness', 'needs', 'affinity']) {
      assert.ok(!dumped.includes(leak), `观测台不应返回 ${leak}`)
    }
    assert.ok(res.json.stageName)

    h.dispose?.()
  })
})

test('/state 与 /memory 把「对不上」和「记得很牢」报出来（2026-10-24 P0）', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    // 两句极性相反、剥掉否定后是同一件事 → 她心里对不上
    // 注意：正面那句不能带「别 / 没 / 无」——那些字本身就算否定词，两句会同极性而被跳过。
    await appendEvent({ type: 'utterance', source: 'tool', text: '它是在看我。' }, {}, root)
    await appendEvent({ type: 'utterance', source: 'tool', text: '它不是在看我。' }, {}, root)

    const stateRoute = routes.find((r) => r.path === '/dsh-fish/state')
    const sres = fakeRes()
    await stateRoute.handler({ url: '/dsh-fish/state', method: 'GET' }, sres)
    assert.equal(sres.code, 200)
    assert.ok(sres.json.tension, '对不上要在 /state 里露出来')
    assert.equal(sres.json.tension.count, 1)
    assert.ok(sres.json.tension.a && sres.json.tension.b, '两句原话都要给，界面才能显示')
    assert.equal(typeof sres.json.solidCount, 'number')

    const memRoute = routes.find((r) => r.path === '/dsh-fish/memory')
    const mres = fakeRes()
    await memRoute.handler({ url: '/dsh-fish/memory', method: 'GET' }, mres)
    assert.equal(mres.code, 200)
    assert.equal(mres.json.sections.tensions, 1)
    assert.ok(mres.json.sections.tensionFirst)
    assert.equal(typeof mres.json.sections.solid, 'number')
    // 界面说的「在眼前」必须和真正注入的条数一致（曾出现 8 vs 3 的虚报）
    assert.ok(mres.json.sections.beliefsShown <= 3)

    h.dispose?.()
  })
})

test('config POST 白名单挡住指向她本人的键', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const route = routes.find((r) => r.path === '/dsh-fish/config')
    const bad = fakeRes()
    await route.handler(reqWithBody('POST', JSON.stringify({ personality: { clingy: 0.9 } })), bad)
    assert.equal(bad.code, 400, '改人格的键必须被拒')

    const good = fakeRes()
    await route.handler(reqWithBody('POST', JSON.stringify({ daily: { questions: 3 } })), good)
    assert.equal(good.code, 200)
    assert.equal(good.json.config.daily.questions, 3)

    // 客户端（settings.section）会提交的两项环境配置，必须都能过
    const env = fakeRes()
    await route.handler(reqWithBody('POST', JSON.stringify({
      absenceAfterDays: 4,
      wakesPerDay: 2,
      diary: { visible: true, enabled: true },
      avoid: { keywords: ['恐怖', '血腥', '新的一个'] },
    })), env)
    assert.equal(env.code, 200, `环境配置必须能保存：${env.body}`)
    assert.equal(env.json.config.absenceAfterDays, 4)
    assert.equal(env.json.config.wakesPerDay, 2)
    assert.equal(env.json.config.diary.visible, true)
    assert.deepEqual(env.json.config.avoid.keywords, ['恐怖', '血腥', '新的一个'])

    h.dispose?.()
  })
})

test('请求体里的中文即使被 TCP 切断也要完整还原（跨 chunk 的多字节）', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const route = routes.find((r) => r.path === '/dsh-fish/config')

    // 真机病史（2026-10-23）：她回「传过来的字是碎的，我认不出」。
    // 根因是 readBody 用 `data += chunk`，Buffer 隐式 toString 按 latin1 逐字节拆中文
    // → 送进去的是 \ufffd 一串替换符。这条测试就是钉死它：切点故意落在汉字中间。
    const payload = JSON.stringify({ avoid: { keywords: ['恐怖片', '血腥'] } })
    const bytes = Buffer.from(payload, 'utf8')
    const parts = []
    for (let i = 0; i < bytes.length; i += 4) parts.push(bytes.subarray(i, i + 4))

    const res = fakeRes()
    await route.handler({
      method: 'POST',
      url: '/dsh-fish/config',
      on(ev, cb) {
        if (ev === 'data') for (const p of parts) cb(p)
        if (ev === 'end') cb()
        return this
      },
      destroy() {},
    }, res)

    assert.equal(res.code, 200, `中文配置必须能存：${res.body}`)
    assert.deepEqual(res.json.config.avoid.keywords, ['恐怖片', '血腥'])
    assert.ok(!res.body.includes('\uFFFD'), '响应里不该出现替换符（说明解码坏了）')

    h.dispose?.()
  })
})

test('/dsh-fish 不再吐单页观测台，而是给一句"搬走了"', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const route = routes.find((r) => r.path === '/dsh-fish')
    const res = fakeRes()
    await route.handler({ url: '/dsh-fish', method: 'GET' }, res)
    assert.equal(res.code, 200)
    assert.ok(res.body.includes('设置'), '要告诉人去设置里看')
    assert.ok(!res.body.includes('现在叫醒她'), '旧页面不该还在（它打不开，留着就是死代码）')

    h.dispose?.()
  })
})

test('日记默认不可见：只给日期，不给正文', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({}), root)
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    // 手工放一篇日记
    const { writeDaily } = await import('../lib/store.js')
    await writeDaily('diaryDir', '2026-10-20', '今天没人来。', root)

    const route = routes.find((r) => r.path === '/dsh-fish/diary')
    const res = fakeRes()
    await route.handler({ url: '/dsh-fish/diary', method: 'GET' }, res)
    assert.equal(res.json.visible, false)
    assert.deepEqual(res.json.lockedDates, ['2026-10-20'])
    assert.ok(!JSON.stringify(res.json).includes('今天没人来'), '不可见时正文绝不能出现在响应里')

    h.dispose?.()
  })
})

test('dispose 之后不再有后台活动（定时器真的停了）', async () => {
  await withRoot(async (root) => {
    const { ctx } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))
    h.dispose?.()

    const before = (await readEvents(root)).events.length
    await new Promise((r) => setTimeout(r, 200))
    const after = (await readEvents(root)).events.length
    assert.equal(after, before)
  })
})

test('scheduler.tick 在时间窗外不唤醒', async () => {
  await withRoot(async (root) => {
    // 窗口设成一个必然不含"现在"的区间（当前分钟往后推 3 小时开，1 分钟后关）
    const now = new Date()
    const h1 = (now.getHours() + 3) % 24
    await writeConfig(normalizeConfig({ window: [`${String(h1).padStart(2, '0')}:00`, `${String((h1 + 1) % 24).padStart(2, '0')}:00`] }), root)

    const { ctx, prompts } = fakeCtx()
    const s = startScheduler(ctx, { root, log: () => {} })
    await s.tick()
    assert.equal(prompts.length, 0, '时间窗外不该唤醒')
    s.dispose()
  })
})

// 回归（2026-10-23 用户报「她会话里有一大块隐藏提示词」）：
// 唤醒消息会作为一条 user message 留在她的会话里，用户点开就看得见。
// 所以它**只许说她这一次的处境**；身份、工具说明、四条禁令一律走
// `home/她的身份.md` → `systemPrompt.section`（system 角色、不进对话历史）。
test('唤醒消息只有这一次的处境，不再重复身份段与工具说明', async () => {
  await withRoot(async (root) => {
    // 关掉刷站，这两条测试才不会去打真接口（慢且不确定）。
    await writeConfig(normalizeConfig({ browse: { enabled: false } }), root)
    const { ctx, prompts } = fakeCtx()
    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(prompts.length, 1)
    const text = prompts[0].content[0].text

    // 不许再出现的：身份段、禁令、工具手册
    assert.ok(!text.includes('## 你是谁'), '身份段不该出现在会话消息里')
    assert.ok(!text.includes('## 不能做的'), '禁令段不该出现在会话消息里')
    assert.ok(!text.includes('撒娇'), '禁令正文不该出现在会话消息里')
    assert.ok(!text.includes('autonomy'), '不能泄露字段名')

    // 必须仍然出现的：这一次的处境
    assert.ok(text.includes('第 1 天') || text.includes('醒'), '要留下这一次的处境')

    // 而且短：上千字的提示词就是用户看到的那一大坨
    assert.ok(text.length < 600, `唤醒消息过长：${text.length} 字`)

    // 身份必须还在落盘副本里（真通道是 systemPrompt 段，见 test/identity.test.mjs）
    await writeSelfDoc(root)
    const doc = await readFile(join(paths(root).root, 'home', '她的身份.md'), 'utf8')
    assert.ok(doc.includes('## 你是谁'))
    assert.ok(doc.includes('撒娇'), 'N1 禁令要在身份文档里')
    assert.ok(doc.includes('好感度'), 'N2 禁令要在身份文档里')
    assert.ok(doc.includes('growth_commit'), '工具说明要在身份文档里')
  })
})

// 回归：手动唤醒的 dateKey 必须是纯日期。
// 以前写成 `${dk}-manual`，这个后缀会一路跟着进 browse 记账、日记文件名、
// 报告文件名和会话 id；报告按 `2026-10-23` 去查，记账却写在
// `2026-10-23-manual` 里 → 报告"看了什么"永远显示"今天没看"。
// 区分手动只允许体现在 sessionId 上。
test('回归：手动唤醒的 dateKey 是纯日期，不污染 browse/日记/报告', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({}), root)
    const { ctx, sessions } = fakeCtx()
    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, true, JSON.stringify(r))
    const dk = dateKey()

    // 会话 id 允许带 -manual（那正是"这是一次手动唤醒"的标记，也是避开
    // 「同一天复用 id → create 抛已存在 → cwd 不更新」的办法），但它必须以
    // 纯日期开头，不能把后缀混进日期本身。
    for (const id of sessions) {
      assert.ok(id.startsWith(`fish-wake-${dk}`), `会话 id 应以纯日期开头：${id}`)
    }

    // 真正的防线在落盘产物上：记账的日期键必须是纯日期。
    const { events } = await readEvents(root)
    const browse = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('browse:'))
    for (const e of browse) {
      const key = String(e.text).slice('browse:'.length).split(' ')[0]
      assert.equal(key, dk, `browse 记账键必须等于纯日期，实际是 ${key}`)
    }
    const wakeMeta = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('wake:'))
    for (const e of wakeMeta) {
      const key = String(e.text).slice('wake:'.length).split(' ')[0]
      assert.equal(key, dk, `wake 记账键必须等于纯日期，实际是 ${key}`)
    }
  })
})

test('她的会话 cwd 是她自己的空房间，不是状态库根目录', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({}), root)
    const { ctx, creates } = fakeCtx()
    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(creates.length, 1)
    const { cwd } = creates[0]
    assert.equal(cwd, paths(root).herDir, 'cwd 必须指向 herDir')
    assert.notEqual(cwd, root, 'cwd 不能就是状态库根——否则她 cat 一下就读到全部历史')
    // 真建出来了，不是个虚假路径
    const st = await stat(cwd)
    assert.ok(st.isDirectory())
    // 房间里没有事件流与配置
    const inRoom = await readdir(cwd)
    assert.ok(!inRoom.includes('events.jsonl'))
    assert.ok(!inRoom.includes('config.json'))
  })
})

test('整条链路：她说一句 → 判断数 +1 → 阶段门仍卡着（不跳级）', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ growthDays: 30 }), root)
    const { ctx, tools } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const tool = tools.get('growth_commit')
    await tool.execute({ type: 'utterance', text: '我不太确定自己喜不喜欢安静。', confidence: 0.3 })

    const { events } = await readEvents(root)
    const m = deriveSelf(events, { growthDays: 30 })
    assert.equal(m.beliefCount, 1)
    assert.equal(m.stage, 1, '只过 trust 门、没过 autonomy 门，不该到 stage 2')
    assert.equal(m.stageGate.pending, 'autonomy')

    h.dispose?.()
  })
})

function fakeRes() {
  const res = {
    code: 200,
    body: '',
    headers: {},
    writableEnded: false,
    writeHead(code, headers) { res.code = code; Object.assign(res.headers, headers || {}); return res },
    end(chunk) { if (chunk) res.body += String(chunk); res.writableEnded = true; return res },
    get json() { try { return JSON.parse(res.body) } catch { return null } },
  }
  return res
}

function reqWithBody(method, body) {
  const chunks = [Buffer.from(body, 'utf8')]
  return {
    method,
    url: '/dsh-fish/config',
    on(ev, cb) {
      if (ev === 'data') for (const c of chunks) cb(c)
      if (ev === 'end') cb()
      return this
    },
    destroy() {},
  }
}

test('工具面白名单：拼错的名字不许保存，合法名字按全角逗号/空格存成数组', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    // 真机上这份快照在 agent/created 时从她的全局视角取到；测试里直接塞
    rememberKnownTools(['web_search', 'read_image', 'skill'])
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const route = routes.find((r) => r.path === '/dsh-fish/config')

    // 拼错一个字母：形状合法、名单里没有 —— 存进去就会让整条收窄失效，必须 400
    const typo = fakeRes()
    await route.handler(reqWithBody('POST', JSON.stringify({ tools: { restrict: true, allow: ['web_serch'] } })), typo)
    assert.equal(typo.code, 400, '拼错的名字必须被拒')
    assert.ok(typo.body.includes('web_serch'), '要说出是哪个名字不对')

    // 合法名字：全角逗号也认，落盘是干净的数组
    const okRes = fakeRes()
    await route.handler(reqWithBody('POST', JSON.stringify({ tools: { restrict: true, allow: ['skill，read_image'] } })), okRes)
    assert.equal(okRes.code, 200, okRes.body)
    assert.deepEqual(okRes.json.config.tools.allow, ['skill', 'read_image'])

    // /tools 把名字给界面（只给名字，不给定义）
    const toolsRoute = routes.find((r) => r.path === '/dsh-fish/tools')
    const listRes = fakeRes()
    await toolsRoute.handler({ url: '/dsh-fish/tools', method: 'GET' }, listRes)
    assert.equal(listRes.code, 200)
    assert.equal(listRes.json.ok, true)
    assert.deepEqual(listRes.json.known, ['read_image', 'skill', 'web_search'])

    h.dispose?.()
  })
})
