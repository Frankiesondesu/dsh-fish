/**
 * 2026-11-12 真机事故：管理器（7789）点「全部关闭」，界面一直转圈。
 *
 * 原因有两层，必须两层都钉住：
 *   1. server.mjs 调 shutdown.mjs 时**漏了 --yes**，于是它停下来问 [y/N]；
 *   2. 而它没有终端（stdin 是管理器给的管道，没人写也不会关），
 *      readline 就永远等一个不可能来的回车 —— 网页端没有输入通道。
 *
 * 这里第一条用真进程复现（stdin 开着、不写、不关），第二条做源码守卫。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MANAGER = fileURLToPath(new URL('..', import.meta.url))
const REPO = join(MANAGER, '..')

test('stdin 开着却没人写时，shutdown 不许卡住（复现真机那次转圈）', async () => {
  const p = spawn(process.execPath, [join(REPO, 'shutdown.mjs')], {
    cwd: REPO,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  p.stdout.on('data', (d) => { out += String(d) })
  p.stderr.on('data', (d) => { out += String(d) })

  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 12000)
    p.on('exit', () => { clearTimeout(t); resolve(true) })
  })
  if (!exited) p.kill('SIGKILL')

  assert.equal(exited, true, '不能等一个永远不会来的回车：网页端没有输入通道')
  assert.match(out, /没有可交互的终端/, '要说明为什么没问，别默默退出')
  // 没确认就当「不关」——绝不能因为问不到就默默全关
  assert.match(out, /没关，什么都没动|不会替你决定/)
})

test('全部关闭必须带 --yes（server.mjs），否则又会停下来问', () => {
  const src = readFileSync(join(MANAGER, 'server.mjs'), 'utf8')
  const calls = [...src.matchAll(/\[join\(ROOT, 'shutdown\.mjs'\)?([^\]]*)\]/g)]
  assert.ok(calls.length > 0, '要能找到调 shutdown.mjs 的地方')
  for (const c of calls) {
    assert.match(c[1] ?? '', /--yes/, `调用缺 --yes：${c[0]}`)
  }
})

test('单项关闭也必须带 --yes（services.mjs）', () => {
  const src = readFileSync(join(MANAGER, 'services.mjs'), 'utf8')
  const calls = [...src.matchAll(/\[join\(ROOT, 'shutdown\.mjs'\)([^\]]*)\]/g)]
  assert.ok(calls.length > 0, '要能找到单项关闭的调用点')
  for (const c of calls) {
    assert.match(c[1] ?? '', /--yes/, `调用缺 --yes：${c[0]}`)
  }
})
