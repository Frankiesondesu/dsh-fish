/**
 * fork.16：接 dsh-video-storyboard 外挂听写。
 *
 * 不 import 真插件——测试里现场生成两个"假的 vs 模块"（owned / not-owned 两种），
 * 指给 vsPath，验证桥接层的职责边界：自启交外挂、关停只关自己的、失败一律 []。
 * 音频与 /health 用本机起的 http 服务，不碰外网。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { transcribeViaVs, downloadAudio } from '../lib/asr.js'

// 手工构造一段合法的 wav（PCM16 单声道 16kHz，0.5 秒静音）
function makeWav() {
  const data = Buffer.alloc(16000)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  data.copy(header, 44)
  return Buffer.concat([header, data])
}

/** 生成一对假的 vs 模块。owned=false 时 ensureAsr 返回不拥有、isOwned 为 false */
function makeFixtureVs(dir, { owned }) {
  writeFileSync(
    join(dir, 'asr-lifecycle.js'),
    `export const calls = { stops: [] }
    export async function ensureAsr() {
      return ${owned ? '{ owned: true, started: true }' : '{ owned: false, started: false }'}
    }
    export function isOwned() { return ${owned ? 'true' : 'false'} }
    export async function stopViaHttp(baseUrl) { calls.stops.push(baseUrl); return { ok: true } }
    export async function probeEndpoint() { return { ok: true } }`,
  )
  writeFileSync(
    join(dir, 'asr.js'),
    `export async function transcribe({ start = 0, end } = {}) {
      return { segments: [{ from: start + 0.2, to: end ?? start + 1, text: 'seg@' + start }] }
    }`,
  )
  return dir
}

function startServer({ wav, health }) {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: health ?? 'ready' }))
      return
    }
    if (req.url === '/a.m4a') {
      res.writeHead(200, { 'content-type': 'audio/wav' })
      res.end(wav)
      return
    }
    if (req.url === '/shutdown') {
      res.writeHead(200)
      res.end('bye')
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

test('owned：自启的实例，看完要优雅关停', async () => {
  const wav = makeWav()
  const server = await startServer({ wav })
  const fx = makeFixtureVs(mkdtempSync(join(tmpdir(), 'fish-fx-')), { owned: true })
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    const cfg = { baseUrl: `${url}/v1`, manage: { healthPath: '/health', waitMs: 3000 } }
    const dl = await downloadAudio(`${url}/a.m4a`, {})
    assert.ok(dl?.file, '音频要先下载下来')

    const lines = await transcribeViaVs({
      audioFile: dl.file,
      duration: 1,
      vsPath: fx,
      asrJson: cfg,
      chunkSec: 55,
      budgetMs: 15000,
    })
    assert.equal(lines.length, 1)
    assert.equal(lines[0].text, 'seg@0')
    assert.equal(Math.round(lines[0].t * 10) / 10, 0.2)

    const state = JSON.parse(readFileSync(join(fx, 'asr-lifecycle.js'), 'utf8') ? '{"x":1}' : '{}') // 占位
    // 关停断言：读回 fixture 的 calls（通过再 import 一次同一份文件拿不到状态，直接看文件里那段）
    assert.ok(true)
    rmSync(dl.dir, { recursive: true, force: true })
    // 真正的关停验证：单独 import fixture 模块拿 calls
    const mod = await import('file://' + join(fx, 'asr-lifecycle.js').replace(/\\/g, '/'))
    assert.ok(mod.calls.stops.includes(cfg.baseUrl), '自己拉起的要自己关')
  } finally {
    server.close()
    rmSync(fx, { recursive: true, force: true })
  }
})

test('not-owned：服务本来就在，别替别人关', async () => {
  const wav = makeWav()
  const server = await startServer({ wav })
  const fx = makeFixtureVs(mkdtempSync(join(tmpdir(), 'fish-fx-')), { owned: false })
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    const cfg = { baseUrl: `${url}/v1`, manage: { healthPath: '/health', waitMs: 3000 } }
    const dl = await downloadAudio(`${url}/a.m4a`, {})
    const lines = await transcribeViaVs({
      audioFile: dl.file,
      duration: 1,
      vsPath: fx,
      asrJson: cfg,
      budgetMs: 15000,
    })
    assert.equal(lines.length, 1)
    const mod = await import('file://' + join(fx, 'asr-lifecycle.js').replace(/\\/g, '/'))
    assert.equal(mod.calls.stops.length, 0, '不是自己的实例不许关')
    rmSync(dl.dir, { recursive: true, force: true })
  } finally {
    server.close()
    rmSync(fx, { recursive: true, force: true })
  }
})

test('模型一直没就绪 → 返回 []，owned 仍要收尾', async () => {
  const wav = makeWav()
  const server = await startServer({ wav, health: 'loading' })
  const fx = makeFixtureVs(mkdtempSync(join(tmpdir(), 'fish-fx-')), { owned: true })
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    const cfg = { baseUrl: `${url}/v1`, manage: { healthPath: '/health', waitMs: 2000 } }
    const dl = await downloadAudio(`${url}/a.m4a`, {})
    const lines = await transcribeViaVs({ audioFile: dl.file, duration: 1, vsPath: fx, asrJson: cfg })
    assert.deepEqual(lines, [])
    const mod = await import('file://' + join(fx, 'asr-lifecycle.js').replace(/\\/g, '/'))
    assert.ok(mod.calls.stops.includes(cfg.baseUrl), '自己拉起的没就绪也要关掉')
    rmSync(dl.dir, { recursive: true, force: true })
  } finally {
    server.close()
    rmSync(fx, { recursive: true, force: true })
  }
})

test('外挂不存在 → []', async () => {
  const lines = await transcribeViaVs({
    audioFile: 'whatever.m4a',
    duration: 1,
    vsPath: join(tmpdir(), 'fish-fx-not-exist'),
    asrJson: { baseUrl: 'http://127.0.0.1:1/v1' },
  })
  assert.deepEqual(lines, [])
})

test('downloadAudio：下载成功 / 404 / 空地址', async () => {
  const wav = makeWav()
  const server = await startServer({ wav })
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    const dl = await downloadAudio(`${url}/a.m4a`, {})
    assert.ok(dl?.file, '成功要有文件')
    rmSync(dl.dir, { recursive: true, force: true })

    const bad = await downloadAudio(`${url}/nope`, {})
    assert.equal(bad, null, '404 要返回 null')

    assert.equal(await downloadAudio('', {}), null, '空地址返回 null')
  } finally {
    server.close()
  }
})
