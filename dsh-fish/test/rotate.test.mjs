/**
 * rotate.test.mjs —— 换会话的大小触发器（2026-11-09）。
 *
 * 背景：11-09 token 事故（会话 449 轮没换、上下文 3.3MB、一天 8700 万 tokens）
 * 暴露了 rotateAfter 只数轮数的盲区——一轮能调很多次工具，几轮就顶爆窗口。
 * 新增 chat.rotateWhenKB：量会话日志里「会进上下文的事件字节」，和轮数谁先到谁生效。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { surfaceBytesFromFile, sessionLogFile, shouldRotate, dropSurfaceCache } from '../lib/rotate.js'

test('shouldRotate：轮数触发', () => {
  assert.deepEqual(shouldRotate({ turns: 40, rotateAfter: 40 }), { rotate: true, why: 'turns', kb: 0 })
  assert.deepEqual(shouldRotate({ turns: 41, rotateAfter: 40 }), { rotate: true, why: 'turns', kb: 0 })
  assert.deepEqual(shouldRotate({ turns: 39, rotateAfter: 40, surfaceBytes: null, rotateWhenKB: 0 }).rotate, false)
})

test('shouldRotate：大小触发（KB 取整、量不到就不触发）', () => {
  const over = shouldRotate({ turns: 1, rotateAfter: 0, surfaceBytes: 2 * 1024 * 1024, rotateWhenKB: 800 })
  assert.equal(over.rotate, true)
  assert.equal(over.why, 'size')
  assert.equal(over.kb, 2048)
  assert.equal(shouldRotate({ surfaceBytes: 500 * 1024, rotateWhenKB: 800 }).rotate, false, '没到线不换')
  assert.equal(
    shouldRotate({ turns: 1, rotateAfter: 0, surfaceBytes: null, rotateWhenKB: 800 }).rotate,
    false,
    '量不到大小（文件缺失/解不动）不按大小换',
  )
  assert.equal(shouldRotate({ turns: 1, rotateAfter: 0, surfaceBytes: 5 * 1024 * 1024, rotateWhenKB: 0 }).rotate, false, '0 = 不看大小')
})

test('shouldRotate：两个都到线时轮数优先报告', () => {
  const d = shouldRotate({ turns: 99, rotateAfter: 40, surfaceBytes: 4 * 1024 * 1024, rotateWhenKB: 800 })
  assert.equal(d.rotate, true)
  assert.equal(d.why, 'turns', '换的动作一样，只是 meta 里写的原因不同')
})

test('surfaceBytesFromFile：多帧 zstd 解开、只数会进上下文的事件、mtime+size 缓存', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fish-rotate-'))
  try {
    const surface = (type, n) => JSON.stringify({ type, seq: n, data: { x: '内容'.repeat(10) } })
    const other = JSON.stringify({ type: 'session/title', seq: 0, data: { title: '不进上下文' } })
    // 两帧拼接：每帧各自是完整 zstd（compressSync 的输出自带 magic 头）
    const f1 = zstdCompressSync(Buffer.from(`${surface('user/message', 1)}\n${other}\n`, 'utf8'))
    const f2 = zstdCompressSync(Buffer.from(`${surface('assistant/message', 2)}\n${surface('tool/result', 3)}\n`, 'utf8'))
    const p = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(p, Buffer.concat([f1, f2]))

    const want =
      Buffer.byteLength(surface('user/message', 1)) +
      Buffer.byteLength(surface('assistant/message', 2)) +
      Buffer.byteLength(surface('tool/result', 3))
    const got = surfaceBytesFromFile(p)
    assert.equal(got, want, 'meta/标题类不进上下文，不计入')

    // 缓存：文件没变（mtime+size 一样）直接命中缓存——改回写一次同内容也返回同值
    assert.equal(surfaceBytesFromFile(p), want, '第二次调用走缓存，结果一致')

    // 文件变了（mtime 变化）重解：追加一帧
    const f3 = zstdCompressSync(Buffer.from(`${surface('system/message', 4)}\n`, 'utf8'))
    writeFileSync(p, Buffer.concat([f1, f2, f3]))
    utimesSync(p, new Date(2000, 0, 1), new Date())
    const want2 = want + Buffer.byteLength(surface('system/message', 4))
    assert.equal(surfaceBytesFromFile(p), want2, 'mtime 变了重解，新帧计入')

    // 不存在的文件 → null（调用方当「量不到」处理）
    assert.equal(surfaceBytesFromFile(join(dir, 'nope.zstd')), null)
  } finally {
    dropSurfaceCache(join(dir, 'session.v4.jsonl.zstd'))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('sessionLogFile：slug 算得对（[:\\\\]+ 整段替换）、找不到时按后缀兜底', () => {
  const base = mkdtempSync(join(tmpdir(), 'fish-rotlog-'))
  const fakeRoot = join(tmpdir(), 'fish-rotfake')
  try {
    const slug = join(fakeRoot, 'home').replace(/[:\\/]+/g, '-')
    const ok = join(base, `--${slug}--`, 'sess1', 'session.v4.jsonl.zstd')
    mkdirSync(join(base, `--${slug}--`, 'sess1'), { recursive: true })
    writeFileSync(ok, 'x')
    assert.equal(sessionLogFile(fakeRoot, 'sess1', base), ok)

    // 兜底：目录名前缀不同但后缀是 slug+'--'（宿主改编码规则时还有救）
    const alt = join(base, `weird-${slug}--`, 'sess2', 'session.v4.jsonl.zstd')
    mkdirSync(join(base, `weird-${slug}--`, 'sess2'), { recursive: true })
    writeFileSync(alt, 'x')
    assert.equal(sessionLogFile(fakeRoot, 'sess2', base), alt)

    // 逐字符替换会得到 --C--...（多一个横线）——钉住这个坑（viewer 踩过）
    assert.ok(!slug.includes('--'), '「冒号+反斜杠」两个字符只换出一个横线')
    assert.equal(sessionLogFile(fakeRoot, 'nope', base), null, '没有就是没有')
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
