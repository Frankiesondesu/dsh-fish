/**
 * watch.test.mjs —— `bili_watch` 的计数与拒绝分支。
 *
 * 真的抽帧要联网 + 开 ffmpeg，这里不测；测的是她会踩到的那几条边界：
 * 开关关着、给的不是视频号、额度用完。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { watchedToday, watchedInTariff, registerWatch } from '../lib/watch.js'
import { logFile } from '../lib/log.js'
import { appendEvent, readEvents } from '../lib/store.js'
import { updateConfig } from '../lib/settings.js'

test('watchedToday 只数当天的 watched: 记录，昨天的不算', () => {
  const dk = '2026-10-23'
  const events = [
    { type: 'meta', text: `watched:${dk} BV1` },
    { type: 'meta', text: `watched:${dk} BV2` },
    { type: 'meta', text: 'watched:2026-10-22 BV3' },
    { type: 'utterance', text: 'watched:2026-10-23 不在 meta 里，不算' },
    { type: 'meta', text: 'browse:2026-10-23 BV4' },
  ]
  assert.equal(watchedToday(events, dk), 2)
  assert.equal(watchedToday([], dk), 0)
  assert.equal(watchedToday(null, dk), 0)
})

function fakeCtx() {
  const tools = []
  return {
    tools: { register: (t) => { tools.push(t); return { dispose() {} } } },
    _tools: tools,
  }
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fish-watch-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('registerWatch：注册一个叫 bili_watch 的工具，参数是合法 JSON Schema', () => {
  const ctx = fakeCtx()
  registerWatch(ctx, { root: join(tmpdir(), 'dsh-fish-watch-test') })
  assert.equal(ctx._tools.length, 1)
  const t = ctx._tools[0]
  assert.equal(t.name, 'bili_watch')
  assert.equal(t.parameters.type, 'object')
  assert.ok(t.parameters.properties.bvid)
  assert.deepEqual(t.parameters.required, ['bvid'])
  // 2026-11-01 用户 m02712：at 是可选的，不许挤进 required，否则老的调用全失败
  assert.equal(t.parameters.properties.at.type, 'array')
  assert.equal(t.parameters.properties.at.items.type, 'number')
  assert.match(t.description, /at/)
  assert.equal(t.output.render.length >= 0, true)
})

test('registerWatch：开关关着时拒，且不暴露"管理员不让看"', async () => {
  await withRoot(async (root) => {
    await updateConfig({ browse: { enabled: false } }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    const out = await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.equal(out.ok, false)
    assert.equal(out.note, '现在打不开。')
    assert.doesNotMatch(out.note, /管理员|权限|设置/)
  })
})

test('registerWatch：给的不是视频号就直说，不去联网', async () => {
  await withRoot(async (root) => {
    await updateConfig({ browse: { enabled: true }, video: { enabled: true } }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    const out = await ctx._tools[0].execute({ bvid: '不是视频号' })
    assert.equal(out.ok, false)
    assert.equal(out.note, '这不是一个视频号。')
  })
})

test('registerWatch：画面功能关掉时拒，理由与"打不开"分开', async () => {
  await withRoot(async (root) => {
    await updateConfig({ browse: { enabled: true }, video: { enabled: false } }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    const out = await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.equal(out.ok, false)
    assert.equal(out.note, '现在看不了画面。')
  })
})

test('registerWatch：额度已经用完时只说"不想看了"，不报数字', async () => {
  await withRoot(async (root) => {
    // fork.12：额度按峰谷分开算，测试不知道跑的时候是峰还是谷——
    // 两档各塞满一条，无论现在是什么时段，额度都是满的。
    await updateConfig({ browse: { enabled: true }, video: { enabled: true, perDay: 1, offPeakPerDay: 1 } }, root)
    const { dateKey } = await import('../lib/settings.js')
    const dk = dateKey()
    await appendEvent({ type: 'meta', text: `watched:${dk} BV1xx411c7mD ${JSON.stringify({ tariff: 'peak' })}` }, { source: 'system' }, root)
    await appendEvent({ type: 'meta', text: `watched:${dk} BV1yy411c7mE ${JSON.stringify({ tariff: 'idle' })}` }, { source: 'system' }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    const out = await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.equal(out.ok, false)
    // fork.13：拒绝话术改了——「你不想看」是对她欲望的假消息（她明明伸手了）。
    // 现在只说事实「今天看不成了」，照样不带任何数字（N2 保留）。
    assert.equal(out.note, '今天看不成了。')
    assert.doesNotMatch(out.note, /\d/)
  })
})

// fork.20（2026-11-02，用户定案）：他发过来的那条不占额度，她自己翻的才占。
// 额度管的是"她自己决定去看什么"，选择是他做的那次不该记在她头上。
test('watchedInTariff：带 free 标记的（他递过来的）不算额度，但照样在 watchedToday 里', () => {
  const dk = '2026-11-02'
  const events = [
    { type: 'meta', text: `watched:${dk} BV1aa411c7m1 ${JSON.stringify({ tariff: 'idle', free: true })}` },
    { type: 'meta', text: `watched:${dk} BV1bb411c7m2 ${JSON.stringify({ tariff: 'idle' })}` },
    // 老事件没有 tariff 字段 → 按 idle 算（fork.12 的规矩不变）
    { type: 'meta', text: `watched:${dk} BV1cc411c7m3` },
  ]
  assert.equal(watchedInTariff(events, dk, 'idle'), 2, 'free 那条不占额度')
  assert.equal(watchedInTariff(events, dk, 'peak'), 0)
  // 看没看过是另一回事：free 的照样算"看过"
  assert.equal(watchedToday(events, dk), 3)
})

// fork.22：lite 已删，引擎变成可注入（deps.watch）——单测不该真去下视频。
function fakeWatch(ok = true) {
  return async () =>
    ok
      ? {
        ok: true,
        path: 'C:/tmp/sheet-BV-test-1.png',
        paths: ['C:/tmp/sheet-BV-test-1.png', 'C:/tmp/sheet-BV-test-2.png'],
        text: '《测试视频》：这次认真看，2 张宫格。',
        title: '测试视频',
        up: '某UP',
        duration: 100,
      }
      : { ok: false, why: '外挂没装' }
}

test('bili_watch：额度满了，但他递过来的那条照样能看，账本里带 free', async () => {
  await withRoot(async (root) => {
    await updateConfig({ browse: { enabled: true }, video: { enabled: true, perDay: 1, offPeakPerDay: 1 } }, root)
    const { dateKey } = await import('../lib/settings.js')
    const dk = dateKey()
    // 两档各塞满一条：无论此刻是峰是谷，额度都满了
    await appendEvent({ type: 'meta', text: `watched:${dk} BV1xx411c7mD ${JSON.stringify({ tariff: 'peak' })}` }, { source: 'system' }, root)
    await appendEvent({ type: 'meta', text: `watched:${dk} BV1yy411c7mE ${JSON.stringify({ tariff: 'idle' })}` }, { source: 'system' }, root)
    // 他递过这一条
    await appendEvent({ type: 'meta', text: `hand:${dk} BV1ED4y1Y7dc` }, { source: 'system' }, root)

    const ctx = fakeCtx()
    registerWatch(ctx, { root, watch: fakeWatch(true) })
    const out = await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.equal(out.ok, true)
    const log = readLog(root)
    assert.doesNotMatch(log, /今日额度已满/, '他给的这条不该被额度挡下')
    assert.match(log, /他递过来的，不占额度/)

    // 看过就得留凭证，但标记 free——"看过"和"占额度"是两件事
    const ev = await readEvents(root)
    const w = ev.events.filter((e) => String(e.text ?? '').startsWith(`watched:${dk} BV1ED4y1Y7dc`))
    assert.equal(w.length, 1, '看成了就该记一条 watched:')
    assert.match(w[0].text, /"free":true/)
  })
})

test('bili_watch：额度满了，她自己翻到的另一条仍然被挡（免额度不扩散）', async () => {
  await withRoot(async (root) => {
    await updateConfig({ browse: { enabled: true }, video: { enabled: true, perDay: 1, offPeakPerDay: 1 } }, root)
    const { dateKey } = await import('../lib/settings.js')
    const dk = dateKey()
    await appendEvent({ type: 'meta', text: `watched:${dk} BV1xx411c7mD ${JSON.stringify({ tariff: 'peak' })}` }, { source: 'system' }, root)
    await appendEvent({ type: 'meta', text: `watched:${dk} BV1yy411c7mE ${JSON.stringify({ tariff: 'idle' })}` }, { source: 'system' }, root)
    // 他递过的是**别的**一条
    await appendEvent({ type: 'meta', text: `hand:${dk} BV1zz411c7mF` }, { source: 'system' }, root)

    const ctx = fakeCtx()
    registerWatch(ctx, { root, watch: fakeWatch(true) })
    const out = await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.equal(out.ok, false)
    assert.equal(out.note, '今天看不成了。')
  })
})

// fork.22：九帧兜底删掉之后，"看不成"必须如实说——不能拿九张均匀抽的图冒充看过。
test('bili_watch：vs 没走通就如实说没看成，且不记 watched:', async () => {
  await withRoot(async (root) => {
    await updateConfig({ browse: { enabled: true }, video: { enabled: true } }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root, watch: fakeWatch(false) })
    const out = await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.equal(out.ok, false)
    assert.equal(out.note, '这次没看成。')
    // 技术原因进日志，不进她的话
    assert.match(readLog(root), /看画面：vs 没走通 BV1ED4y1Y7dc/)
    assert.doesNotMatch(out.note, /外挂|管线|ffmpeg/)
    // 没看成就不该留"看过"的凭证
    const ev = await readEvents(root)
    assert.equal(ev.events.filter((e) => String(e.text ?? '').startsWith('watched:')).length, 0)
  })
})

// 下面四条盯的是「导出包能不能判案」：用户那边的机器上「看不到画面」，
// 导出包里必须能看出是被哪一条挡下的。日志里可以写数字（给人看的），
// 工具回复里仍然不能出现数字（那是给她看的）。
function readLog(root) {
  try {
    return readFileSync(logFile(root), 'utf8')
  } catch {
    return ''
  }
}

test('看画面被设置关掉时，日志里留下「关掉了看视频」', async () => {
  await withRoot(async (root) => {
    await updateConfig({ browse: { enabled: true }, video: { enabled: false } }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.match(readLog(root), /看画面：设置里关掉了看视频/)
  })
})

test('视频号不合法时，日志里留下「视频号不合法」和原样的入参', async () => {
  await withRoot(async (root) => {
    await updateConfig({ browse: { enabled: true }, video: { enabled: true } }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    await ctx._tools[0].execute({ bvid: '不是视频号' })
    const log = readLog(root)
    assert.match(log, /看画面：视频号不合法/)
    assert.match(log, /不是视频号/)
  })
})

test('额度用完时日志写数字（1/1），好追额度怎么用掉的', async () => {
  await withRoot(async (root) => {
    // fork.12：两档各塞满一条，见上一条测试的注释
    await updateConfig({ browse: { enabled: true }, video: { enabled: true, perDay: 1, offPeakPerDay: 1 } }, root)
    const { dateKey } = await import('../lib/settings.js')
    const dk = dateKey()
    await appendEvent({ type: 'meta', text: `watched:${dk} BV1xx411c7mD ${JSON.stringify({ tariff: 'peak' })}` }, { source: 'system' }, root)
    await appendEvent({ type: 'meta', text: `watched:${dk} BV1yy411c7mE ${JSON.stringify({ tariff: 'idle' })}` }, { source: 'system' }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.match(readLog(root), /看画面：今日额度已满 1\/1 BV1ED4y1Y7dc/)
  })
})

// fork.22：原来这条测的是"ffmpeg 不在 PATH → 抽帧失败"。lite 删掉之后没有抽帧了，
// 现在最值钱的一行是「vs 没走通 + 真实原因」——那条已在上面单独测过。

// issue #16 第二半（2026-11-01，用户 m03454）：看画面写的 watched: 也要认调用者。
test('bili_watch：不在这个家里的会话调不动它', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerWatch(ctx, { root, tenant: { herDir: join(root, 'her'), tenant: { ok: true } } })
    const away = { agent: { session: { id: 'session-other', header: { id: 'session-other', cwd: tmpdir() } } } }
    const out = await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' }, away)
    assert.equal(out.ok, false)
    assert.match(out.note, /另一个家|没有落盘/)
  })
})
