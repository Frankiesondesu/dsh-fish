/**
 * observe.mjs 的数据层与动作（2026-11-07 迁移配套测试）。
 *
 * 用 DSH_FISH_HOME 指到临时目录再动态 import——observe.mjs 在模块加载时就解析 ROOT，
 * 所以环境变量必须先设。临时 root 是空账本：各节应该 ok:true 且数字为 0，
 * 动作（标已读/结申请/裁决/备份）应该各自给出结构化结果，不许抛。
 * 真机数据的形状不在这里测——smoke 时对真实账本跑过（runtime/ob.json）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('observe.mjs：空账本各节 ok、动作结构化，写入事件后计数跟上', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-observe-'))
  process.env.DSH_FISH_HOME = root
  try {
    // 事件流文件不存在时 readEvents 应该兜住——但 loadConfig 需要一个可写的目录
    const ob = await import('../observe.mjs')
    assert.equal(ob.ROOT, root, 'ROOT 必须认 DSH_FISH_HOME，不能落到默认家')

    let d = await ob.observeData()
    for (const k of ['state', 'away', 'asks', 'inbox', 'bili', 'memory', 'data']) {
      assert.equal(d[k]?.ok, true, `${k} 节要 ok:true（实际：${JSON.stringify(d[k]?.why ?? '')}）`)
    }
    assert.equal(d.state.counts.total, 0, '空账本她说的事是 0')
    assert.deepEqual(d.asks.pending, [])
    assert.equal(d.inbox.box.total, 0)
    assert.equal(d.bili.history.groups.length, 0)

    // 动作：没有待裁决时 decide 如实拒绝
    const noOffer = await ob.decideOffer({ verdict: 'approve' })
    assert.equal(noOffer.ok, false)
    assert.match(noOffer.error, /没有待裁决/)

    // 结申请：askId 不存在也是结构化结果，不是异常
    const noAsk = await ob.settleAsk({ askId: 'ev_none', verdict: 'approve' })
    assert.equal(noAsk.ok, false)

    // 标已读：空信箱也要成功并返回读点
    const mr = await ob.markInboxRead()
    assert.ok(mr.lastReadId === null || typeof mr.lastReadId === 'string')

    // 备份：能出 bundle（空家也有一份空档案）
    const b = await ob.backupBundle()
    assert.ok(b && typeof b === 'object')
    assert.match(String(b.fileName ?? ''), /\.json$/)

    // 报告：日期格式不对要拒
    const bad = await ob.reportFor('not-a-date')
    assert.equal(bad.ok, false)

    // 写入事件（手写两行，不 import 插件的 appendEvent——它要 ensureHer 等全家桶，
    // 这里只验证 viewer 的聚合，不验证插件的写盘）后，同一个进程里再拉一次，
    // readEvents 的 mtime 戳会失效重读，计数必须跟上。
    const lines = [
      JSON.stringify({ id: 'ev_a', type: 'seed', text: '起点。', ts: new Date().toISOString(), day: 1, stage: 1, source: 'system' }),
      JSON.stringify({ id: 'ev_b', type: 'utterance', text: '（她说）在。', ts: new Date().toISOString(), day: 1, stage: 1, source: 'tool' }),
    ]
    await writeFile(join(root, 'events.jsonl'), lines.join('\n') + '\n', 'utf8')
    await new Promise((r) => setTimeout(r, 20))   // 保证 mtime 变化
    d = await ob.observeData()
    assert.equal(d.state.ok, true)
    assert.equal(d.state.counts.utterance, 1)
    assert.equal(d.state.counts.total, 2, 'seed + 她记的一句都是「她的事」')
  } finally {
    delete process.env.DSH_FISH_HOME
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
