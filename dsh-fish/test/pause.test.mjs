/**
 * PAUSE 开关（fork.49，2026-11-05）。
 *
 * 要她安静，之前只有两条路：改 config.proactive.enabled=false（持久，容易忘）
 * 或关 devMode（会带走 her_say / her_dream）。她需要的是**临时**状态。
 *
 * 测试守四件事：
 *   文件在 = 暂停，文件删 = 恢复，读数不抛；
 *   理由只取第一行（后面写多少都不影响判断）；
 *   mute-alarm 要能被识别（默认闹钟照响）；
 *   scheduler 真的调了它——这条最容易在以后重构时被删掉。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPause, setPause, isPaused, pauseLine, pausePath, MUTE_ALARM_HINT } from '../lib/pause.js'

const mk = () => mkdtempSync(join(tmpdir(), 'fishpause-'))

test('没有文件 = 没暂停，不抛', async () => {
  const root = mk()
  const p = await readPause(root)
  assert.equal(p.paused, false)
  assert.equal(p.muteAlarm, false)
  assert.equal(await isPaused(root), false)
})

test('开 → 暂停；关 → 恢复；关两次不报错', async () => {
  const root = mk()
  await setPause(root, { on: true, reason: '开会' })
  assert.equal(await isPaused(root), true)
  const p = await readPause(root)
  assert.equal(p.reason, '开会')
  assert.equal(p.muteAlarm, false, '默认不静音闹钟')
  await setPause(root, { on: false })
  assert.equal(await isPaused(root), false)
  await setPause(root, { on: false }) // 幂等
  assert.equal(await isPaused(root), false)
})

test('mute-alarm：写进文件就连闹钟一起静音（大小写不敏感）', async () => {
  const root = mk()
  await setPause(root, { on: true, reason: `录音 ${MUTE_ALARM_HINT}` })
  const p = await readPause(root)
  assert.equal(p.muteAlarm, true)
  await fs.writeFile(pausePath(root), 'MUTE-ALARM\n第二行不算', 'utf8')
  assert.equal((await readPause(root)).muteAlarm, true)
})

test('理由只取第一行，且截断到 80 字', async () => {
  const root = mk()
  await setPause(root, { on: true, reason: 'x'.repeat(200) })
  const p = await readPause(root)
  assert.equal(p.reason.length, 80, '不能因为她写长了就把日志刷爆')
  await fs.writeFile(pausePath(root), '第一行\n第二行\n', 'utf8')
  assert.equal((await readPause(root)).reason, '第一行')
})

test('pauseLine：三种状态说人话', async () => {
  assert.equal(pauseLine({ paused: false }), '未暂停')
  assert.match(pauseLine({ paused: true, reason: '开会', muteAlarm: false }), /开会.*闹钟照响/)
  assert.match(pauseLine({ paused: true, reason: '', muteAlarm: true }), /闹钟也静音/)
})

test('scheduler 真的接上了（重构时最容易掉的一根线）', async () => {
  const src = await fs.readFile(new URL('../lib/scheduler.js', import.meta.url), 'utf8')
  assert.match(src, /import \{ readPause \} from '\.\/pause\.js'/, '要 import readPause')
  assert.match(src, /const pause = await readPause\(root\)/, 'maybeProactive 里要真读一次')
  assert.match(src, /pause\.paused && \(!forced \|\| pause\.muteAlarm\)/, '闹钟默认照响，mute-alarm 才静音')
  assert.match(src, /PAUSE 一删就恢复/, '日志要说清"不是被关掉"')
})
