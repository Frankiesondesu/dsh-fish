/**
 * outing-route.test.mjs —— 出门页那两条 HTTP 接口，端到端跑一遍（0.6.32）。
 *
 * 之前只有库层测试：`pendingOf` / `settlePending` 都对，但「点完按钮什么都没发生」
 * 恰恰是**接口与界面**之间的问题。所以这里不测函数，测路由：
 *   1. 出门中 → GET 不带 pendingReview
 *   2. 把事件流截短 → POST end → 200 且台账变 pending（不是直接 done）
 *   3. GET → pendingReview 在，okNow=false，reason 说清了为什么
 *   4. 还没还原就 POST review → 409，而且台账**仍然**是 pending
 *   5. 还原 → POST review → 200 且变 done，endedAt 还是原来那一刻
 *   6. 再 POST review → 409「没有等复核的那趟」
 *
 * 用的是假 ctx + 假 req/res，不碰真实家目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { registerObserve } from '../lib/observe.js'
import { snapshotEvents, startOuting, readOutings } from '../lib/outing.js'

function harness(root) {
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name === 'connection') return { requestRejection: () => null }
      if (name === 'webServer') {
        return {
          register(ex) {
            routes.set(ex.path, ex.handler)
            return () => {}
          },
        }
      }
      return undefined
    },
  }
  registerObserve(ctx, { root })
  const handler = routes.get('/dsh-fish/outing')
  assert.ok(handler, '出门路由要注册上')

  async function call(method, body) {
    const req = method === 'POST'
      ? Object.assign(Readable.from([Buffer.from(JSON.stringify(body ?? {}), 'utf8')]), { method, headers: {} })
      : Object.assign(Readable.from([]), { method, headers: {} })
    let status = 0
    let text = ''
    const res = {
      writableEnded: false,
      writeHead(code) { status = code },
      end(chunk) { text = String(chunk ?? ''); res.writableEnded = true },
    }
    await handler(req, res)
    return { status, json: text ? JSON.parse(text) : null }
  }

  return { call }
}

test('/outing 复核：接口层把 pending 从「死路」走通（0.6.32）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-outing-route-'))
  try {
    const eventsFile = join(root, 'events.jsonl')
    const original = '{"type":"utterance","seq":1,"ts":"2026-10-29T00:00:00.000Z","data":{"text":"在家"}}\n'
    writeFileSync(eventsFile, original)
    const baseline = snapshotEvents(eventsFile)
    const startedAt = Date.parse('2026-10-29T00:10:00.000Z')
    await startOuting(root, {
      sessionId: 'session-r1',
      workspaceId: 'w1',
      workspaceName: '素材',
      cwd: join(root, 'ws'),
      baseline,
      identity: '',
      now: startedAt,
    })
    const { call } = harness(root)

    // 1. 出门中：没有等复核的
    const before = await call('GET')
    assert.equal(before.status, 200)
    assert.equal(before.json.pendingReview, null, '还在外面时不该有 pendingReview')
    assert.equal(before.json.away?.sessionShort, 'r1', 'GET 要把会话短号带上')
    assert.equal(before.json.away?.tripNo, 1)

    // 2. 截短事件流，再点「这趟收下」
    truncateSync(eventsFile, Math.max(0, statSync(eventsFile).size - 20))
    const ended = await call('POST', { action: 'end', kept: true })
    assert.equal(ended.status, 200)
    assert.equal(ended.json.tampered, true, '变小必须判成对不上')
    assert.equal(ended.json.outing.status, 'pending', '不许直接 done')

    // 3. GET 现在要把原因与「还不能复核」告诉界面
    const mid = await call('GET')
    assert.ok(mid.json.pendingReview, 'pending 之后 GET 必须带回 pendingReview')
    assert.equal(mid.json.pendingReview.sessionId, 'session-r1')
    assert.equal(mid.json.pendingReview.okNow, false)
    assert.match(String(mid.json.pendingReview.reason), /变小/)
    assert.equal(mid.json.away?.kind, null, 'pending 之后不再是 active，界面要按 kind 判「在家」')

    // 4. 还没还原就点「复核一次」：拒绝，而且台账不能被动
    const refused = await call('POST', { action: 'review' })
    assert.equal(refused.status, 409)
    assert.match(String(refused.json.why), /变小/)
    const stillPending = (await readOutings(root)).outings.at(-1)
    assert.equal(stillPending.status, 'pending', '复核没过不能偷偷改台账')

    // 5. 还原 → 复核通过 → 收下，结束时间仍是真正回家的那一刻
    writeFileSync(eventsFile, original)
    const ok = await call('POST', { action: 'review' })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.outing.status, 'done')
    assert.equal(ok.json.outing.kept, true)
    assert.equal(ok.json.outing.endedAt, ended.json.outing.endedAt, 'endedAt 不能被复核时间覆盖')

    // 6. 再点一次：没有等复核的了
    const again = await call('POST', { action: 'review' })
    assert.equal(again.status, 409)
    assert.match(String(again.json.why), /没有等复核/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('/outing 复核：GET 的 warning 能指出「这趟没挂上装备」（0.6.26 幽灵出门的可见性）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-outing-route-'))
  try {
    const eventsFile = join(root, 'events.jsonl')
    writeFileSync(eventsFile, '')
    await startOuting(root, {
      sessionId: 'session-r2',
      workspaceId: 'w1',
      workspaceName: '素材',
      cwd: join(root, 'ws'),
      baseline: snapshotEvents(eventsFile),
      identity: '',
      now: Date.now(),
    })
    const { call } = harness(root)
    const got = await call('GET')
    assert.equal(got.status, 200)
    // 假 ctx 里没有活的 agent，所以「没挂装备」要说出来，别让人以为一切正常
    assert.equal(got.json.away?.equipped, false)
    assert.match(String(got.json.away?.warning), /没挂上装备/)
    assert.equal(readFileSync(eventsFile, 'utf8'), '', 'GET 只读，不该写事件流')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
