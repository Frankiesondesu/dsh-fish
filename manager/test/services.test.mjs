/**
 * GUI 管理器（2026-11-06）：服务清单的完整性检查。
 *
 * 这个模块本身很薄，它最容易出的错不是算错，是**漏配**——
 * 加了一个新服务、忘了在 STOP_NAME 里给停止名，于是界面上「停止」按钮
 * 一点就报「没有给 x 配停止名」。这种错不会在开发时暴露，只会被用户碰到。
 * 下面几条就是钉这个的。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SERVICES, STOP_NAME, serviceOf, portOpen } from '../services.mjs'

test('服务 key 唯一（重复了界面会渲染出两张同 key 的卡，点谁都点不对）', () => {
  const keys = SERVICES.map((s) => s.key)
  assert.equal(new Set(keys).size, keys.length, '有重复的 key：' + keys.join(','))
})

test('每个可管理的服务都在 STOP_NAME 里有停止名', () => {
  const missing = SERVICES.filter((s) => s.managed !== false && !STOP_NAME[s.key]).map((s) => s.key)
  assert.deepEqual(missing, [], '这些服务没有配 STOP_NAME，点「停止」会报错：' + missing.join(','))
})

test('STOP_NAME 里没有多余项（删了服务忘了删停止名，会一直骗人）', () => {
  const known = new Set(SERVICES.map((s) => s.key))
  const extra = Object.keys(STOP_NAME).filter((k) => !known.has(k))
  assert.deepEqual(extra, [], 'STOP_NAME 里有多余的 key：' + extra.join(','))
})

test('探测方式定义完整：port 型必须有端口，process 型必须有进程名', () => {
  for (const s of SERVICES) {
    assert.ok(s.probe, s.key + ' 没有 probe')
    if (s.probe.type === 'port') {
      assert.ok(Number(s.probe.port) > 0, s.key + ' 是 port 型但没有 port')
    } else if (s.probe.type === 'process') {
      assert.ok(s.probe.image, s.key + ' 是 process 型但没有 image')
    } else {
      assert.fail(s.key + ' 的 probe.type 不认识：' + s.probe.type)
    }
  }
})

test('ASR 是只读的：它归用户自己的 vs 管线管，这个 GUI 不该动它', () => {
  const asr = serviceOf('asr')
  assert.ok(asr, '找不到 asr')
  assert.equal(asr.managed, false)
})

test('serviceOf 不挑大小写和空格', () => {
  assert.equal(serviceOf('BRIDGE').key, 'bridge')
  assert.equal(serviceOf('  Bridge  ').key, 'bridge')
  assert.equal(serviceOf('没有这个'), null)
})

test('portOpen：一个肯定没人听的端口要返回 false（别抛、别挂住）', async () => {
  // 1 号端口在 Windows 上不会被普通程序占，探它是安全的
  const r = await portOpen(1, 500)
  assert.equal(r, false)
})

test('七项里至少要有她自己那几样（防止有人把清单删空还觉得没事）', () => {
  const keys = SERVICES.map((s) => s.key)
  for (const k of ['dsh', 'll', 'turn', 'duplex', 'bridge', 'viewer']) {
    assert.ok(keys.includes(k), '清单里少了 ' + k)
  }
})

// ---------------------------------------------------------------- 变更检测（2026-11-07）

test('newestCode：不被运行时 json 骗到（桥每推一条就写 push-state.json）', async () => {
  const { newestCode } = await import('../services.mjs')
  const { mkdtemp, writeFile, utimes, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = await mkdtemp(join(tmpdir(), 'fish-stale-'))
  try {
    const code = join(dir, 'a.mjs')
    const state = join(dir, 'push-state.json')
    const cfg = join(dir, 'config.json')
    await writeFile(code, 'x')
    await writeFile(state, '{}')
    await writeFile(cfg, '{}')
    // 代码：旧；运行时状态：最新；配置：中等
    await utimes(code, new Date(1000), new Date(1000))
    await utimes(cfg, new Date(2000), new Date(2000))
    await utimes(state, new Date(9999), new Date(9999))

    const r = newestCode([dir])
    // config.json 算代码（改它要重启桥），push-state.json 不算
    assert.ok(r.file.endsWith('config.json'), '应该取 config.json，实际：' + r.file)
    assert.equal(r.ms, 2000)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('newestCode：paths 里有不存在的路径也不抛（换机后 turn-taking 可能没搬）', async () => {
  const { newestCode } = await import('../services.mjs')
  const r = newestCode(['D:/绝对不存在的路径/xyz'])
  assert.deepEqual(r, { ms: 0, file: '' })
})
