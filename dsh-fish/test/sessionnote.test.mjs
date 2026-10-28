/**
 * sessionnote.js —— 往会话里补一句人话（0.6.16），以及 2026-10-29 修的那个 bug：
 * `deliverQueued` 写好了却没有人调用，排队的话永远躺在那份文件里。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendNote, queueNote, takeNotes, deliverQueued } from '../lib/sessionnote.js'
import { registerIdentity } from '../lib/identity.js'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'fish-note-'))
}

/** 一条活着的会话：append 记下来，别的不管。 */
function fakeAgent({ id = 'session-home', cwd = '' } = {}) {
  const written = []
  return {
    written,
    session: {
      header: { id, cwd },
      append: (type, data, opts) => {
        written.push({ type, data, opts })
        return { ok: true }
      },
      snapshotEvents: () => [],
    },
    ctx: {
      systemPrompt: { section: () => () => {} },
      effect: (fn) => fn,
      tools: { guard: () => () => {} },
    },
  }
}

test('appendNote：写的是 user/message，带 surfaceOp，id 有前缀', () => {
  const agent = fakeAgent()
  const r = appendNote(agent, '（大肥鱼回去了，这条对话还给你。）', { now: 1700000000000 })
  assert.equal(r.ok, true)
  assert.equal(agent.written.length, 1)
  const ev = agent.written[0]
  assert.equal(ev.type, 'user/message')
  assert.equal(ev.opts.surfaceOp, 'append')
  assert.equal(ev.data.role, 'user')
  assert.equal(ev.data.source.kind, 'user')
  assert.ok(String(ev.data.id).startsWith('fish-note-1700000000000-'))
  assert.ok(Array.isArray(ev.data.content))
  assert.match(ev.data.content[0].text, /这条对话还给你/)
})

test('appendNote：空白、没有会话都不抛，只回一句为什么', () => {
  assert.equal(appendNote(fakeAgent(), '   ').ok, false)
  const r = appendNote({ session: null }, '随便一句')
  assert.equal(r.ok, false)
  assert.match(r.why, /没开着/)
})

test('queueNote / takeNotes：排进去，取走就清空（不重复投递）', async () => {
  const root = tmp()
  try {
    const q = await queueNote(root, '这趟里我不认这几条：…')
    assert.equal(q.ok, true)
    assert.equal(q.queued, 1)
    assert.ok(existsSync(join(root, 'session-notes.json')))

    const first = await takeNotes(root)
    assert.equal(first.length, 1)
    assert.match(first[0].text, /不认这几条/)

    const second = await takeNotes(root)
    assert.equal(second.length, 0)
    const raw = JSON.parse(readFileSync(join(root, 'session-notes.json'), 'utf8'))
    assert.deepEqual(raw.notes, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('queueNote：最多留 50 句，旧的先被挤出去', async () => {
  const root = tmp()
  try {
    for (let i = 1; i <= 55; i += 1) await queueNote(root, `第 ${i} 句`)
    const raw = JSON.parse(readFileSync(join(root, 'session-notes.json'), 'utf8'))
    assert.equal(raw.notes.length, 50)
    assert.match(raw.notes[0].text, /第 6 句/)
    assert.match(raw.notes[49].text, /第 55 句/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('deliverQueued：把排队的话补进会话，补完清空', async () => {
  const root = tmp()
  try {
    await queueNote(root, '第一句')
    await queueNote(root, '第二句')
    const agent = fakeAgent()
    const r = await deliverQueued(agent, root)
    assert.equal(r.delivered, 2)
    assert.equal(agent.written.length, 2)
    assert.match(agent.written[0].data.content[0].text, /第一句/)
    assert.equal((await takeNotes(root)).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('registerIdentity：她家那条会话一起来，就把排队的话补进去（2026-10-29 修的那个 bug）', async () => {
  const root = tmp()
  try {
    const herDir = join(root, 'home')
    await queueNote(root, '这趟里我不认这几条：「随手写的一句」 / 它们不算你，别的算。')

    let handler = null
    const ctx = {
      on: (name, fn) => {
        if (name === 'agent/created') handler = fn
        return () => {}
      },
      get: () => undefined,
      effect: (fn) => fn,
    }
    const un = registerIdentity(ctx, { root, herDir, log: () => {} })
    assert.equal(typeof handler, 'function')

    const agent = fakeAgent({ id: 'session-home', cwd: herDir })
    handler({ agent })
    // deliverQueued 是 void 的，等一拍让它跑完
    await new Promise((r) => setTimeout(r, 30))

    const texts = agent.written
      .filter((w) => w.type === 'user/message')
      .map((w) => w.data.content[0].text)
    assert.ok(texts.some((t) => /不认这几条/.test(t)), '排队的那句话要真的补进她的会话')
    assert.equal(existsSync(join(root, 'session-notes.json')) ? (await takeNotes(root)).length : 0, 0)
    if (typeof un === 'function') un()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('identity.js 里真的调了 deliverQueued（防止它再变回死代码）', () => {
  const src = readFileSync(new URL('../lib/identity.js', import.meta.url), 'utf8')
  assert.match(src, /import \{ deliverQueued \} from '\.\/sessionnote\.js'/)
  assert.match(src, /deliverQueued\(agent, root\)/)
})
