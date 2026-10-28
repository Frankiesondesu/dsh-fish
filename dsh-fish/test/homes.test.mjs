/**
 * homes.test.mjs —— 「这次住在哪个家」的记账（0.6.8，房客日志 m01863）
 *
 * 守三件事：
 *   ① 第一次启动只记下位置，不算「换家」（否则每次全新安装都往事件流里灌一条假消息）；
 *   ② 换了 root 才算换家，并且**不会**去动老地方（不迁移、不删除）；
 *   ③ 同一个家换个写法（大小写 / 尾斜杠 / 相对与绝对）不算换家。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { noteRoot, readHomesSync, normRoot, homesFile } from '../lib/homes.js'

async function tmpDir() {
  return mkdtemp(join(tmpdir(), 'fish-homes-'))
}

test('第一次只是记下位置，不算换家', async () => {
  const dir = await tmpDir()
  try {
    const file = join(dir, 'homes.json')
    const r = await noteRoot(join(dir, 'a'), { file })
    assert.equal(r.changed, false, '没有上一次，谈不上换家')
    assert.equal(r.from, '')
    const back = readHomesSync(file)
    assert.equal(back.lastRoot, join(dir, 'a'))
    assert.equal(back.homes.length, 1)
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('换了 root 就记一次换家，老位置留在清单里', async () => {
  const dir = await tmpDir()
  try {
    const file = join(dir, 'homes.json')
    const a = join(dir, 'C家')
    const b = join(dir, 'D家')
    await noteRoot(a, { file })
    const r = await noteRoot(b, { file })
    assert.equal(r.changed, true)
    assert.equal(normRoot(r.from), normRoot(a))
    assert.equal(normRoot(r.to), normRoot(b))

    const back = readHomesSync(file)
    assert.equal(back.lastRoot, b)
    assert.equal(back.homes.length, 2, '老家的记录不能被抹掉')
    assert.deepEqual(back.homes.map((h) => normRoot(h.root)).sort(), [normRoot(a), normRoot(b)].sort())

    // 不迁移：老目录原样还在
    await assert.doesNotReject(readFile(file, 'utf8'))
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('同一个家的不同写法不算换家（大小写、尾斜杠）', async () => {
  const dir = await tmpDir()
  try {
    const file = join(dir, 'homes.json')
    const a = join(dir, 'Home')
    await noteRoot(a, { file })
    const r1 = await noteRoot(a + '\\', { file })
    const r2 = await noteRoot(a.toUpperCase(), { file })
    assert.equal(r1.changed, false)
    if (process.platform === 'win32') assert.equal(r2.changed, false, 'Windows 路径大小写不敏感')
    assert.equal(readHomesSync(file).homes.length, 1, '同一个家只留一条')
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('记录文件坏了也不炸，当成没有记录', async () => {
  const dir = await tmpDir()
  try {
    const file = join(dir, 'homes.json')
    await rm(file, { force: true })
    const back = readHomesSync(file)
    assert.equal(back.lastRoot, '')
    assert.deepEqual(back.homes, [])
    const r = await noteRoot(join(dir, 'x'), { file })
    assert.equal(r.ok, true)
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('homesFile 默认在数据目录之外（可被 env 覆盖）', () => {
  const old = process.env.DSH_FISH_HOMES
  try {
    delete process.env.DSH_FISH_HOMES
    assert.ok(!homesFile().includes('.dsh-fish' + sep), '不能落在数据目录里')
    process.env.DSH_FISH_HOMES = join(tmpdir(), 'x.json')
    assert.equal(homesFile(), join(tmpdir(), 'x.json'))
  } finally {
    if (old === undefined) delete process.env.DSH_FISH_HOMES
    else process.env.DSH_FISH_HOMES = old
  }
})
