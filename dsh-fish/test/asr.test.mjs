/**
 * fork.14：本地听写外挂（lib/asr.js）。
 *
 * 全部用本机起的服务测，不碰外网：
 *   /v1/models → 200（健康检查）
 *   /a.m4a → 一段手工构造的 wav
 *   /v1/audio/transcriptions → 固定返回一个 segment
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { asrHealthy, transcribeViaLocalAsr } from '../lib/asr.js'

// 手工构造一段合法的 wav（PCM16 单声道 16kHz，0.5 秒静音）——ffprobe 认得出就行
function makeWav() {
  const sampleRate = 16000
  const seconds = 0.5
  const data = Buffer.alloc(sampleRate * seconds * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  data.copy(header, 44)
  return Buffer.concat([header, data])
}

function startServer({ wav, failDownload = false, dead = false } = {}) {
  const server = createServer((req, res) => {
    if (dead) {
      res.destroy()
      return
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"data":[]}')
      return
    }
    if (req.method === 'GET' && req.url === '/a.m4a') {
      if (failDownload) {
        res.writeHead(404)
        res.end('no')
        return
      }
      res.writeHead(200, { 'content-type': 'audio/wav' })
      res.end(wav)
      return
    }
    if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
      req.resume() // 把上传吃掉，别挂住
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ segments: [{ start: 0, end: 0.4, text: '你好' }] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function ffmpegPaths() {
  const bin = process.env.DSH_FISH_FFMPEG ?? ''
  if (!bin) return null
  const ffprobe = bin.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
  return { ffmpeg: bin, ffprobe }
}

test('健康检查：在线 true，死端口 false', async () => {
  const server = await startServer({})
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    assert.equal(await asrHealthy(url), true)
    assert.equal(await asrHealthy('http://127.0.0.1:1'), false, '死端口要安静返回 false')
    assert.equal(await asrHealthy(''), false, '空地址也是 false')
  } finally {
    server.close()
  }
})

test('完整链路：下载音频 → 切块听写 → 带时间码的台词', async (t) => {
  const ff = ffmpegPaths()
  if (!ff) return t.skip('这台机器没配 DSH_FISH_FFMPEG')
  const wav = makeWav()
  const server = await startServer({ wav })
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    const lines = await transcribeViaLocalAsr({
      asrUrl: url,
      audioUrl: `${url}/a.m4a`,
      ffmpeg: ff.ffmpeg,
      ffprobe: ff.ffprobe,
      budgetMs: 15000,
    })
    assert.equal(lines.length, 1)
    assert.equal(lines[0].text, '你好')
    assert.equal(lines[0].t, 0)
  } finally {
    server.close()
  }
})

test('音频下载失败 → 返回 []，不抛', async (t) => {
  const ff = ffmpegPaths()
  if (!ff) return t.skip('这台机器没配 DSH_FISH_FFMPEG')
  const server = await startServer({ wav: makeWav(), failDownload: true })
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    const lines = await transcribeViaLocalAsr({
      asrUrl: url,
      audioUrl: `${url}/a.m4a`,
      ffmpeg: ff.ffmpeg,
      ffprobe: ff.ffprobe,
      budgetMs: 15000,
    })
    assert.deepEqual(lines, [])
  } finally {
    server.close()
  }
})

test('服务没开 → 快速返回 []', async () => {
  const ff = ffmpegPaths()
  if (!ff) return t.skip('这台机器没配 DSH_FISH_FFMPEG')
  const t0 = Date.now()
  const lines = await transcribeViaLocalAsr({
    asrUrl: 'http://127.0.0.1:1',
    audioUrl: 'http://127.0.0.1:1/a.m4a',
    ffmpeg: ff.ffmpeg,
    ffprobe: ff.ffprobe,
  })
  assert.deepEqual(lines, [])
  assert.ok(Date.now() - t0 < 10000, '要在健康检查这层就退出来，别磨蹭')
})
