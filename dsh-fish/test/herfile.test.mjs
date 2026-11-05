/**
 * her_open（fork.47）：他 QQ 递过来的文件，她自己去开。
 *
 * 这组用例钉住四条边界——每一条都是「替她判断」和「让她自己判断」的分界线：
 *   1. 收件箱里的文本能读到，截断要说清；
 *   2. 收件箱外面的路径一律打不开（`..` 也不行）——她不能拿它翻账本；
 *   3. 二进制直说「读不出来」，不吐乱码；
 *   4. 图片指路 read_image，不假装能读。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerHerOpen, saveIncoming, insideInbox, looksBinary, inboxDir } from '../lib/herfile.js'

function fakeCtx() {
  const regs = new Map()
  return {
    regs,
    tools: { register: (t) => { regs.set(t.name, t); return () => regs.delete(t.name) } },
  }
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-open-'))
  await mkdir(inboxDir(root), { recursive: true })
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
}

async function put(root, name, content) {
  const p = join(inboxDir(root), name)
  await writeFile(p, content)
  return p
}

test('收件箱里的文本读得到', async () => {
  await withRoot(async (root) => {
    const p = await put(root, 'note.txt', '他说了三个字：别熬了。\n')
    const ctx = fakeCtx()
    registerHerOpen(ctx, { root })
    const out = await ctx.regs.get('her_open').execute({ path: p })
    assert.equal(out.ok, true, out.note)
    assert.match(out.text, /别熬了/)
    assert.equal(out.truncated, false)
  })
})

test('收件箱外面的路径打不开（含 .. 逃逸）', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerHerOpen(ctx, { root })
    const tool = ctx.regs.get('her_open')
    const outside = join(root, 'events.jsonl')
    await writeFile(outside, '{"id":"ev_1"}\n')
    for (const p of [outside, join(inboxDir(root), '..', '..', 'events.jsonl'), '/etc/passwd', 'C:\\Windows\\win.ini']) {
      const out = await tool.execute({ path: p })
      assert.equal(out.ok, false, `不该能打开 ${p}`)
      assert.match(out.note, /只能打开他发给你的/)
    }
  })
})

test('二进制直说读不出来，不吐乱码', async () => {
  await withRoot(async (root) => {
    const p = await put(root, 'x.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01, 0x02]))
    const ctx = fakeCtx()
    registerHerOpen(ctx, { root })
    const out = await ctx.regs.get('her_open').execute({ path: p })
    assert.equal(out.ok, false)
    assert.match(out.note, /二进制/)
    assert.equal(out.text, '')
  })
})

test('图片指路 read_image', async () => {
  await withRoot(async (root) => {
    const p = await put(root, 'a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const ctx = fakeCtx()
    registerHerOpen(ctx, { root })
    const out = await ctx.regs.get('her_open').execute({ path: p })
    assert.equal(out.ok, false)
    assert.match(out.note, /read_image/)
  })
})

test('太大只读前面一段，并说清截断了', async () => {
  await withRoot(async (root) => {
    const big = 'A'.repeat(600 * 1024)
    const p = await put(root, 'big.txt', big)
    const ctx = fakeCtx()
    registerHerOpen(ctx, { root })
    const out = await ctx.regs.get('her_open').execute({ path: p })
    assert.equal(out.ok, true)
    assert.equal(out.truncated, true)
    assert.match(out.note, /只读了前面/)
    assert.ok(out.chars <= 512 * 1024, '不该整份读进来')
  })
})

test('空文件说「是空的」', async () => {
  await withRoot(async (root) => {
    const p = await put(root, 'empty.txt', '')
    const ctx = fakeCtx()
    registerHerOpen(ctx, { root })
    const out = await ctx.regs.get('her_open').execute({ path: p })
    assert.equal(out.ok, false)
    assert.match(out.note, /空的/)
  })
})

test('saveIncoming：清洗名字、重名不覆盖', async () => {
  await withRoot(async (root) => {
    const a = await saveIncoming(root, { name: '../../evil/name.txt', buf: Buffer.from('one') })
    assert.equal(a.name, 'name.txt', '路径分隔符要被剥掉')
    const b = await saveIncoming(root, { name: 'name.txt', buf: Buffer.from('two') })
    assert.notEqual(a.path, b.path, '重名要另起一个')
    const files = await readdir(inboxDir(root))
    assert.equal(files.length, 2)
  })
})

test('insideInbox / looksBinary 的基本判定', () => {
  const root = 'C:\\tmp\\fish-root'
  assert.ok(insideInbox(root, 'C:\\tmp\\fish-root\\home\\inbox\\a.txt'))
  assert.equal(insideInbox(root, 'C:\\tmp\\fish-root\\config.json'), null)
  assert.equal(insideInbox(root, 'C:\\tmp\\fish-root\\home\\inbox\\..\\x'), null)
  assert.equal(looksBinary(Buffer.from([0x61, 0x00, 0x62])), true)
  assert.equal(looksBinary(Buffer.from('纯文本', 'utf8')), false)
})
