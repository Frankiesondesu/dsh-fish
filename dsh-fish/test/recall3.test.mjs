/**
 * fork.11（2026-11-02）：稀有度打分、遗忘半衰期、对话存档。
 *
 * 三条都来自那份 B 站笔记里的实测经验：
 *   「本地中文词表按词稀有度打分，召回精确度 43% → 91%」
 *   「按重要度决定遗忘半衰期，只变难想起、不删除」
 *   「压缩前把这一轮全部对话保存下来」
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { searchEvents, renderRecall } from '../lib/recall.js'
import { logExchange } from '../lib/talklog.js'
import { readEvents } from '../lib/store.js'

const NOW = Date.parse('2026-11-02T12:00:00.000Z')
const DAY = 86400000

const ev = (id, text, daysAgo = 0, type = 'utterance') => ({
  id,
  v: 1,
  ts: new Date(NOW - daysAgo * DAY).toISOString(),
  day: 1,
  stage: 1,
  type,
  source: type === 'meta' ? 'system' : 'her',
  text,
  refs: [],
  verdict: null,
  confidence: 0.5,
  flags: [],
})

test('稀有度：只有一处出现的词，比到处都有的词更能捞出旧事', () => {
  const events = []
  // 十条都提到"视频"——这个词到处都是，信息量低
  for (let i = 0; i < 10; i++) events.push(ev(`ev_v${i}`, `我看了一条视频，第 ${i} 条。`))
  // 只有这一条提到"皮影"
  events.push(ev('ev_k', '视频里最想看的是《皮影》，因为屏风才是那个艺术。'))

  const { rows } = searchEvents(events, '视频 皮影', { now: NOW })
  assert.equal(rows[0].id, 'ev_k', '稀有词命中的那条要排第一')
})

test('遗忘：越久越难想起，但翻得到', () => {
  const events = [
    ev('ev_new', '关于屏风的那件事，我后来想明白了。', 1),
    ev('ev_old', '关于屏风的那件事，我后来想明白了。', 200),
  ]
  const { rows } = searchEvents(events, '屏风', { now: NOW, limit: 5 })
  assert.equal(rows.length, 2, '旧的那条不能被删')
  assert.equal(rows[0].id, 'ev_new', '新的要排在旧的前面')
  // 半衰期到底也不会归零：最久的那条仍然翻得到
  assert.ok(rows.some((r) => r.id === 'ev_old'))
})

test('对话存档：说过的原话能被翻到', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-talklog-'))
  try {
    const ok = await logExchange(root, {
      me: '你还记得那个变戏法的视频吗',
      her: '记得。那个没有屏风的《皮影》，我最想看的就是它。',
      day: 1,
      stage: 1,
    })
    assert.equal(ok, true)

    const { events } = await readEvents(root)
    const line = events.find((e) => String(e.text ?? '').startsWith('talk:'))
    assert.ok(line, '要写进账本')
    assert.equal(line.source, 'system', '系统侧写，她伪造不了')

    const { rows } = searchEvents(events, '皮影', { now: Date.now() })
    assert.equal(rows.length, 1)
    // 她读的是 renderRecall 的输出，不是 rows[].text —— 前缀在那里去掉
    const shown = renderRecall(rows)
    assert.ok(!shown.includes('talk:'), '她读到的不该带前缀：' + shown)
    assert.ok(shown.includes('他说「'), '要能看出这是谁说的：' + shown)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('对话存档：两句话都空就不写空行', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-talklog-'))
  try {
    assert.equal(await logExchange(root, { me: '', her: '' }), false)
    const { events } = await readEvents(root)
    assert.equal(events.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
