/**
 * 他的语音（2026-11-05）。
 *
 * QQ 语音消息在桥这里原来被当空消息丢掉——`readMessage` 只认
 * text / at / image / mface / file / forward。她能看图、看文件、看视频，
 * 唯独他说一句语音，她那边什么都没有。
 *
 * 走本机听写（~/.dsh/asr.json → 18765，funasr paraformer），不引云端——
 * 语音内容不该出这台机器。
 *
 * 这里守的是"读不到配置时不许瞎猜"：没有 asr.json、没有启动命令、
 * 可执行文件不存在，三种都要给出明确的话，而不是静默失败。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAsrConfig, ping, ensureServer, transcribe } from '../asr.mjs'

/** 造一个假的 home，里面按需放 .dsh/asr.json */
function fakeHome(json) {
  const home = mkdtempSync(join(tmpdir(), 'fishasr-'))
  mkdirSync(join(home, '.dsh'), { recursive: true })
  if (json) writeFileSync(join(home, '.dsh', 'asr.json'), JSON.stringify(json), 'utf8')
  return home
}

test('没有 asr.json：返回 null，不是抛错（这台机器就是没装听写）', () => {
  const home = fakeHome(null)
  assert.equal(readAsrConfig(home), null)
})

test('读配置：去掉 baseUrl 末尾斜杠，缺项给默认', () => {
  const home = fakeHome({ baseUrl: 'http://127.0.0.1:18765/v1/' })
  const c = readAsrConfig(home)
  assert.equal(c.baseUrl, 'http://127.0.0.1:18765/v1')
  assert.equal(c.model, 'paraformer-zh')
  assert.equal(c.language, 'zh')
})

test('坏 JSON 不炸，当没有', () => {
  const home = fakeHome(null)
  writeFileSync(join(home, '.dsh', 'asr.json'), '{ 这不是 json', 'utf8')
  assert.equal(readAsrConfig(home), null)
})

test('ping：连不上的端口给 false，不抛', async () => {
  assert.equal(await ping('http://127.0.0.1:1/v1', { timeoutMs: 300 }), false)
  assert.equal(await ping('', {}), false, '空地址也不抛')
})

test('ensureServer：没配置 → 说清是没装听写', async () => {
  const r = await ensureServer(null)
  assert.equal(r.ok, false)
  assert.match(r.why, /没装听写/)
})

test('ensureServer：有配置但没写启动命令 → 说清是"没开且不会自己起"', async () => {
  const home = fakeHome({ baseUrl: 'http://127.0.0.1:1/v1' })
  const cfg = readAsrConfig(home)
  const r = await ensureServer(cfg, { waitMs: 0 })
  assert.equal(r.ok, false)
  assert.match(r.why, /没开/)
  assert.match(r.why, /启动命令/)
})

test('ensureServer：启动命令里的可执行文件不存在 → 指出是哪一条不成立', async () => {
  const home = fakeHome({
    baseUrl: 'http://127.0.0.1:1/v1',
    manage: { start: ['C:\\根本不存在的\\python.exe', 'server.py'] },
  })
  const cfg = readAsrConfig(home)
  const r = await ensureServer(cfg, { waitMs: 0 })
  assert.equal(r.ok, false)
  assert.match(r.why, /不存在/)
})

test('transcribe：没有配置/空音频都直接说不行', async () => {
  assert.equal((await transcribe(Buffer.from('x'), null)).ok, false)
  const r = await transcribe(Buffer.alloc(0), { baseUrl: 'http://127.0.0.1:1/v1', model: 'm', language: 'zh' })
  assert.equal(r.ok, false)
  assert.match(r.why, /空的/)
})

test('桥真的接上了：认 record 段、失败要说"听不了"', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../bridge.mjs', import.meta.url), 'utf8')
  assert.match(src, /s\?\.type === 'record'/, 'readMessage 要收语音段')
  assert.match(src, /sendAction\('get_record', \{ file: id, out_format: 'mp3' \}\)/, 'silk 要转 mp3')
  assert.match(src, /我这边听不了/, '听不了要直说，不许猜她听到了什么')
  assert.match(src, /说的是：「\$\{tr\.text\}」/, '听出来了要标明是语音说的')
})
