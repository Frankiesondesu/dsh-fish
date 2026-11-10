import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logExchange, TALK_SNIPPET } from '../lib/talklog.js'
import { readEvents } from '../lib/store.js'

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'fish-talklog-'))
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => rmSync(root, { recursive: true, force: true }))
}

const lastTalk = async (root) => {
  const { events } = await readEvents(root)
  return events.filter((e) => String(e.text ?? '').startsWith('talk:')).at(-1)
}

test('talk: 一行原话：他说/我答都留，sessionId 原样写进去', () =>
  withRoot(async (root) => {
    const ok = await logExchange(root, { me: '在吗', her: '在。', day: 1, stage: 1, sessionId: 's-house' })
    assert.equal(ok, true)
    const ev = await lastTalk(root)
    assert.ok(ev, '账本里应该有 talk: 行')
    assert.equal(ev.type, 'meta')
    assert.equal(ev.source, 'system')
    assert.match(ev.text, /^talk:\d{4}-\d{2}-\d{2} 他说「在吗」／我答「在。」$/)
    assert.equal(ev.sessionId, 's-house')
  }))

// fork.18 的回归：say.js 曾经把没 await 的 talkSessionId(ctx) 传进来，
// 账本里于是留下 `"sessionId":"[object Promise]"`。账本只增不改，擦不掉。
test('忘了 await 的 Promise 不会被写成 [object Promise]', () =>
  withRoot(async (root) => {
    await logExchange(root, { me: '喂', her: '嗯', sessionId: Promise.resolve('s-house') })
    const ev = await lastTalk(root)
    assert.ok(ev)
    assert.equal(ev.sessionId, undefined, '认不出来的 sessionId 宁可不写')
    assert.ok(!JSON.stringify(ev).includes('Promise'))
  }))

test('对象/数组之类也不写进 sessionId', () =>
  withRoot(async (root) => {
    await logExchange(root, { me: 'a', her: 'b', sessionId: { id: 'x' } })
    assert.equal((await lastTalk(root)).sessionId, undefined)
  }))

test('两边都空就不写（不落空行）', () =>
  withRoot(async (root) => {
    assert.equal(await logExchange(root, { me: '   ', her: '' }), false)
    assert.equal(await lastTalk(root), undefined)
  }))

test('一句话超长截到 180 字，带省略号', () =>
  withRoot(async (root) => {
    await logExchange(root, { me: 'x'.repeat(400), her: '' })
    const ev = await lastTalk(root)
    const said = ev.text.slice(ev.text.indexOf('他说「') + 3, -1)
    assert.equal(said.length, TALK_SNIPPET)
    assert.ok(said.endsWith('…'))
  }))

// 结构守卫：调用点不能又把 async 函数当值传。没有全链路集成测试能罩到 say.js，
// 就在源码层面钉住这一处（本仓已有按源码精确断言的先例，见 client.test.mjs）。
test('say.js 的调用点传的是 await 过的 sessionId，不是 talkSessionId(ctx)', () => {
  const src = readFileSync(new URL('../lib/say.js', import.meta.url), 'utf8')
  assert.ok(!/sessionId:\s*talkSessionId\(/.test(src), 'talkSessionId 是 async，不能直接当值传')
  assert.match(src, /^\s*sessionId,\s*$/m, '调用点应传已 await 的 sessionId')
})
