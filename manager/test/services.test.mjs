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

// ---------------------------------------------------------------- 一键重启待重启（2026-11-07）

test('一键重启待重启：路由与编排都在（源码形状守卫）', async () => {
  const { readFile } = await import('node:fs/promises')
  const here = new URL('.', import.meta.url)
  const svc = await readFile(new URL('../services.mjs', import.meta.url), 'utf8')
  const srv = await readFile(new URL('../server.mjs', import.meta.url), 'utf8')

  // 编排必须走 restartOne（它有「等真退干净再拉起」的流程）——
  // 在这里另写一套关起逻辑，就是 11-06「只关不起」那个坑的重演
  assert.match(svc, /export async function restartStale\(\)/, 'restartStale 要存在')
  assert.match(svc, /await restartOne\(s\.key\)/, '逐项重启必须复用 restartOne')
  // 只动 stale 且 managed 的；unknownStart（手动起的）不进目标
  assert.match(svc, /s\.stale && s\.managed/, '目标筛选必须是 stale && managed')
  // 一项失败不挡后面
  assert.match(svc, /results\.push\(\{ key: s\.key, name: s\.name, ok: false/, '失败要记录并继续')

  assert.match(srv, /\/api\/restart-stale/, 'server 要有这条路由')
  assert.match(srv, /restartStale\(\)/, '路由要调 restartStale')
  assert.match(srv, /没有需要重启的服务/, '没目标时要给人话，不是 500')
})

test('一键重启待重启：目标清单里不该有 ASR 和 LuckyLillia（它们没有我们改得动的代码）', async () => {
  const { SERVICES } = await import('../services.mjs')
  // WATCH 为空的项永远 stale 不了——一键重启永远不会替用户重启 QQ 客户端
  for (const s of SERVICES.filter((x) => !(x.watch || []).length)) {
    // watch 不在 SERVICES 上，在模块内的 WATCH 表里；这里用 managed + 探测方式反推：
    // asr（managed:false）本来就不进目标；ll 的 WATCH 是空数组
    if (s.key === 'asr') assert.equal(s.managed, false, 'asr 必须保持只读')
  }
  // 直接核 WATCH 表：ll 和 asr 的 watch 必须为空，否则「全部重启待重启」会动到 QQ 客户端
  const svc = await import('node:fs/promises').then((m) => m.readFile(new URL('../services.mjs', import.meta.url), 'utf8'))
  assert.match(svc, /ll: \[\]/, 'LuckyLillia 的 WATCH 必须为空——QQ 客户端不是我们改得动的')
  assert.match(svc, /asr: \[\]/, 'ASR 的 WATCH 必须为空——它归 vs 管线管')
})
