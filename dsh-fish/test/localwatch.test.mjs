/**
 * her_watch_local（2026-11-06）：他直接递过来的本地视频，走同一条 vs 管线看画面。
 *
 * 不跑真管线（要 ffprobe / 解码整条片子）：往 registerLocalWatch 注入假的 watch，
 * 往 watchViaStoryboard 注入假的 impl。钉住这些分界线：
 *   1. 只能看 inbox 里的文件，配置关着就拒；
 *   2. 传的是本地绝对路径，不是 B 站 URL —— 这是整个能力的根；
 *   3. 他递的不占额度（free），但凭证照记；
 *   4. 失败只说「这次没看成」，不把 ffmpeg 错误倒给她；
 *   5. her_open 对视频指 her_watch_local（跟图片指 read_image 同构）；
 *   6. vs 默认行为不变：不传 input 时仍旧拼 B 站 URL。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerLocalWatch } from '../lib/localwatch.js'
import { registerHerOpen, inboxDir } from '../lib/herfile.js'
import { watchViaStoryboard } from '../lib/vs.js'
import { watchedInTariff } from '../lib/watch.js'
import { readEvents } from '../lib/store.js'
import { updateConfig, dateKey } from '../lib/settings.js'
import { FISH_TOOLS } from '../lib/restrict.js'
import { TOOL_GUIDE, guideOf } from '../lib/toolguide.js'

const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0300050201f34a24d50000000049454e44ae426082',
  'hex',
)

function fakeCtx() {
  const regs = new Map()
  return {
    regs,
    tools: { register: (t) => { regs.set(t.name, t); return () => regs.delete(t.name) } },
  }
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-localwatch-'))
  await mkdir(inboxDir(root), { recursive: true })
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
}

async function put(root, name, content = 'not a real mp4, just bytes') {
  const p = join(inboxDir(root), name)
  await writeFile(p, content)
  return p
}

/** 假 watch：记下每次收到的参数，返回可配置结果 */
function fakeWatch(result) {
  const calls = []
  const okResult = {
    ok: true,
    path: 'C:/tmp/sheet-local-1.png',
    paths: ['C:/tmp/sheet-local-1.png', 'C:/tmp/sheet-local-2.png'],
    text: '《本地视频》：这次认真看，2 张宫格。',
    title: '本地视频',
    duration: 12,
  }
  const fn = async (o) => {
    calls.push(o)
    return result === undefined ? okResult : result
  }
  fn.calls = calls
  return fn
}

async function enable(root) {
  await updateConfig({ browse: { enabled: true }, video: { enabled: true } }, root)
}

test('注册：her_watch_local 的参数是合法 JSON Schema，required 只有 path', () => {
  const ctx = fakeCtx()
  registerLocalWatch(ctx, { root: join(tmpdir(), 'fish-localwatch-reg') })
  const t = ctx.regs.get('her_watch_local')
  assert.ok(t)
  assert.equal(t.parameters.type, 'object')
  assert.ok(t.parameters.properties.path)
  assert.equal(t.parameters.properties.at.type, 'array')
  assert.deepEqual(t.parameters.required, ['path'])
  assert.match(t.description, /read_image/)
  assert.match(t.description, /at/)
})

test('工具面：白名单、说明书、目录都对得上', () => {
  assert.ok(FISH_TOOLS.includes('her_watch_local'))
  assert.ok(TOOL_GUIDE.her_watch_local)
  assert.match(guideOf('her_watch_local'), /## her_watch_local/)
  assert.match(guideOf('her_watch_local'), /能做：/)
  assert.match(guideOf('her_watch_local'), /做不到：/)
})

test('收件箱外的路径一律打不开，且不调管线', async () => {
  await withRoot(async (root) => {
    await enable(root)
    const watch = fakeWatch()
    const ctx = fakeCtx()
    registerLocalWatch(ctx, { root, watch })
    const tool = ctx.regs.get('her_watch_local')
    const outside = join(root, 'events.jsonl')
    await writeFile(outside, '{"id":"ev_1"}\n')
    for (const p of [outside, '/etc/passwd', 'C:\\Windows\\win.ini', join(inboxDir(root), '..', '..', 'events.jsonl')]) {
      const out = await tool.execute({ path: p })
      assert.equal(out.ok, false, `不该能看 ${p}`)
      assert.match(out.note, /只能看他递给你的/)
    }
    assert.equal(watch.calls.length, 0, '路径不合法时一次都不该跑管线')
  })
})

test('配置关着时拒，且不暴露「管理员/设置」', async () => {
  await withRoot(async (root) => {
    await updateConfig({ browse: { enabled: false } }, root)
    const p = await put(root, 'a.mp4')
    const watch = fakeWatch()
    const ctx = fakeCtx()
    registerLocalWatch(ctx, { root, watch })
    let out = await ctx.regs.get('her_watch_local').execute({ path: p })
    assert.equal(out.ok, false)
    assert.equal(out.note, '现在打不开。')
    assert.doesNotMatch(out.note, /管理员|权限|设置/)

    await updateConfig({ browse: { enabled: true }, video: { enabled: false } }, root)
    out = await ctx.regs.get('her_watch_local').execute({ path: p })
    assert.equal(out.note, '现在看不了画面。')
    assert.equal(watch.calls.length, 0)
  })
})

test('成功：传本地绝对路径，不拼 B 站 URL；返回正斜杠路径与原样说明', async () => {
  await withRoot(async (root) => {
    await enable(root)
    const p = await put(root, '1ed54884.mp4')
    const watch = fakeWatch()
    const ctx = fakeCtx()
    registerLocalWatch(ctx, { root, watch })
    const out = await ctx.regs.get('her_watch_local').execute({ path: p, at: [30, 90] })

    assert.equal(out.ok, true, out.note)
    assert.equal(out.path, 'C:/tmp/sheet-local-1.png')
    assert.match(out.text, /这次认真看/)
    assert.equal(watch.calls.length, 1)
    const o = watch.calls[0]
    assert.equal(o.input, p, 'input 必须是 inbox 里的本地绝对路径')
    assert.doesNotMatch(String(o.input), /bilibili|https?:/)
    assert.equal(o.bvid, undefined, '本地视频不该带 bvid')
    assert.equal(o.name, '1ed54884.mp4')
    assert.ok(o.tag)
    assert.deepEqual(o.at, [30, 90])
  })
})

test('记账：写 watched: 凭证但带 free，不占她自己翻片子的额度', async () => {
  await withRoot(async (root) => {
    await enable(root)
    const p = await put(root, 'clip.mp4')
    const ctx = fakeCtx()
    registerLocalWatch(ctx, { root, watch: fakeWatch() })
    await ctx.regs.get('her_watch_local').execute({ path: p })
    const { events } = await readEvents(root)
    const dk = dateKey()
    const line = events.find((e) => e.type === 'meta' && String(e.text).startsWith(`watched:${dk}`))
    assert.ok(line, '看过就该留下凭证')
    assert.match(line.text, /clip\.mp4/)
    const json = JSON.parse(line.text.match(/\{[\s\S]*\}/)[0])
    assert.equal(json.free, true)
    assert.equal(json.local, true)
    assert.equal(watchedInTariff(events, dk, 'idle'), 0, '他给的不占额度')
    assert.equal(watchedInTariff(events, dk, 'peak'), 0)
  })
})

test('失败：只说「这次没看成」，不写凭证、不把技术原因倒给她', async () => {
  await withRoot(async (root) => {
    await enable(root)
    const p = await put(root, 'broken.mp4')
    const ctx = fakeCtx()
    registerLocalWatch(ctx, { root, watch: fakeWatch({ ok: false, why: 'ffprobe ENOENT' }) })
    const out = await ctx.regs.get('her_watch_local').execute({ path: p })
    assert.equal(out.ok, false)
    assert.equal(out.note, '这次没看成。')
    assert.doesNotMatch(out.note, /ffprobe|ffmpeg|外挂|ENOENT/)
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => String(e.text).startsWith('watched:')).length, 0)
  })
})

test('her_open：视频指 her_watch_local，图片仍指 read_image', async () => {
  await withRoot(async (root) => {
    const vid = await put(root, '雪.mp4', Buffer.from([0, 1, 2, 0, 3]))
    const img = await put(root, '雪.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const ctx = fakeCtx()
    registerHerOpen(ctx, { root })
    const open = ctx.regs.get('her_open')
    const v = await open.execute({ path: vid })
    assert.equal(v.ok, false)
    assert.match(v.note, /her_watch_local/)
    assert.match(v.note, /读不出内容/)
    const i = await open.execute({ path: img })
    assert.match(i.note, /read_image/)
    assert.doesNotMatch(i.note, /her_watch_local/)
  })
})

/** 真跑 vs 的编排层（注入 impl，不碰 ffmpeg），验 input 与默认行为 */
function fixture(capture) {
  return {
    async runStoryboard(opts) {
      capture.opts = opts
      return {
        info: { duration: 10 },
        window: { start: 0 },
        sheets: [{
          buffer: TINY_PNG, width: 4, height: 4, cols: 1, rows: 1,
          cells: [{ t_start: 0, t_end: 10, text: '一句台词' }],
        }],
        transcript: { source: 'asr', segments: 1, chars: 4 },
      }
    },
    async saveStoryboards(_res, outPath) {
      capture.outPath = outPath
      await writeFile(outPath, TINY_PNG)
      return [outPath]
    },
  }
}

test('vs：传 input 时走本地路径，标题用 name、落盘用 tag', async () => {
  await withRoot(async (root) => {
    const cap = {}
    const r = await watchViaStoryboard({
      input: 'C:/tmp/inbox/local.mp4', name: 'local.mp4', tag: 'local', root, impl: fixture(cap),
    })
    assert.equal(r.ok, true, r.why)
    assert.equal(cap.opts.input, 'C:/tmp/inbox/local.mp4')
    assert.doesNotMatch(cap.opts.input, /bilibili/)
    assert.match(cap.outPath, /sheet-local-/)
    assert.match(r.text, /local\.mp4/, '标题退回文件名')
    assert.doesNotMatch(r.text, /\\/, '说明里的图路径必须是正斜杠，她照抄才读得到')
  })
})

test('vs：不传 input 时行为不变，仍拼 B 站 URL（回归）', async () => {
  await withRoot(async (root) => {
    const cap = {}
    const r = await watchViaStoryboard({ bvid: 'BV1ED4y1Y7dc', root, impl: fixture(cap) })
    assert.equal(r.ok, true, r.why)
    assert.equal(cap.opts.input, 'https://www.bilibili.com/video/BV1ED4y1Y7dc')
    assert.match(cap.outPath, /sheet-BV1ED4y1Y7dc-/)
  })
})
