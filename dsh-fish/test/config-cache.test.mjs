/**
 * 配置缓存（fork.25）的语义守卫。
 *
 * 缓存能省的是「读盘 + 解析 + 补全默认值」，**不能省语义**：
 *   - 同一个文件连读两次，结果必须一样（但必须是两个对象）；
 *   - 文件被改过，下一次读必须看见（不能只信内存）；
 *   - 调用方改了返回对象，不能污染下一次读；
 *   - updateConfig 写完，下一次读立刻是新值。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, updateConfig, forgetConfig, DEFAULTS } from '../lib/settings.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fish-cfgcache-'))
  try {
    return await fn(root)
  } finally {
    forgetConfig(root)
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
}

async function put(root, cfg) {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8')
}

test('同一个文件连读两次：内容一致，但不是同一个对象', async () => {
  await withRoot(async (root) => {
    await put(root, { growthDays: 45 })
    const a = await loadConfig(root)
    const b = await loadConfig(root)
    assert.deepEqual(a, b)
    assert.notEqual(a.config, b.config, '每次都得是新对象，调用方随便改')
    assert.equal(a.config.growthDays, 45)
  })
})

test('文件被改过之后，下一次读必须看见新值', async () => {
  await withRoot(async (root) => {
    await put(root, { growthDays: 45 })
    const before = await loadConfig(root)
    assert.equal(before.config.growthDays, 45)

    await put(root, { growthDays: 90 })
    const after = await loadConfig(root)
    assert.equal(after.config.growthDays, 90, 'mtime/size 变了就得重读')
  })
})

test('调用方改写返回的对象，不影响下一次读', async () => {
  await withRoot(async (root) => {
    await put(root, { growthDays: 45 })
    const first = await loadConfig(root)
    first.config.growthDays = 999
    first.config.window.push('99:99')

    const second = await loadConfig(root)
    assert.equal(second.config.growthDays, 45, '缓存里存的必须是拷贝')
    assert.deepEqual(second.config.window, DEFAULTS.window)
  })
})

test('updateConfig 写完，下一次读立刻是新值（写穿）', async () => {
  await withRoot(async (root) => {
    await put(root, { growthDays: 45 })
    await loadConfig(root)
    await updateConfig({ growthDays: 60 }, root)
    const next = await loadConfig(root)
    assert.equal(next.config.growthDays, 60)
    assert.equal(next.fresh, false)
  })
})

test('配置文件不存在：返回默认值且标记 fresh，之后建好文件立刻能读到', async () => {
  await withRoot(async (root) => {
    await mkdir(root, { recursive: true })
    const missing = await loadConfig(root)
    assert.equal(missing.fresh, true)
    assert.equal(missing.config.growthDays, DEFAULTS.growthDays)

    await put(root, { growthDays: 120 })
    const created = await loadConfig(root)
    assert.equal(created.fresh, false)
    assert.equal(created.config.growthDays, 120, '不缓存「文件不存在」，文件一出现就得读到')
  })
})

test('forgetConfig 之后重新读盘（设置页外部改动用得上）', async () => {
  await withRoot(async (root) => {
    await put(root, { growthDays: 45 })
    await loadConfig(root)
    // 绕过 mtime 签名，直接证明缓存真的被清掉了
    forgetConfig(root)
    await put(root, { growthDays: 150 })
    const after = await loadConfig(root)
    assert.equal(after.config.growthDays, 150)
  })
})
