/**
 * 缓存清理（fork.52，2026-11-05）。
 *
 * 用户问「发给她的文件不会一直存在我电脑里吧」，查下来：会。
 * `media.js` 里早有 `sweepMedia` 和 3 天 TTL，**但没有任何地方调用它**；
 * `home/inbox/` 和 `voice/` 连期限都没有。四天 40MB。
 *
 * 测试守四件事：
 *   过期的删、没过期的留；
 *   子目录一概不碰（她屋里以后长出别的东西，不该被清理函数带走）；
 *   期限填 0 = 关掉这一项，不是「立刻全删」；
 *   目录不存在不报错（新装的机器没有这些目录）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sweepCaches, retentionOf, retentionLine, RETENTION_DEFAULTS } from '../lib/sweep.js'

const DAY = 86_400_000
const NOW = new Date(2026, 10, 5, 12, 0, 0).getTime()

function mkRoot() {
  const root = mkdtempSync(join(tmpdir(), 'fishsweep-'))
  for (const d of ['media', join('home', 'inbox'), 'voice']) {
    mkdirSync(join(root, d), { recursive: true })
  }
  return root
}

/** 造一个 n 天前改过的文件 */
function put(root, rel, daysAgo, text = 'x') {
  const p = join(root, rel)
  writeFileSync(p, text)
  const t = (NOW - daysAgo * DAY) / 1000
  utimesSync(p, t, t)
  return p
}

test('retentionOf：默认值，缺项补齐，乱填夹紧', () => {
  assert.deepEqual(retentionOf({}), RETENTION_DEFAULTS)
  const r = retentionOf({ retention: { mediaDays: 10 } })
  assert.equal(r.mediaDays, 10)
  assert.equal(r.inboxDays, RETENTION_DEFAULTS.inboxDays, '没填的用默认')
  assert.equal(retentionOf({ retention: { mediaDays: -5 } }).mediaDays, 0, '负数夹到 0（= 关掉）')
  assert.equal(retentionOf({ retention: { mediaDays: 9999 } }).mediaDays, 365, '上限一年')
  assert.equal(retentionOf({ retention: { mediaDays: 'abc' } }).mediaDays, RETENTION_DEFAULTS.mediaDays, '乱填用默认')
})

test('三个目录各按自己的期限：图 3 天、文件 7 天、语音 3 天', async () => {
  const root = mkRoot()
  put(root, 'media/him-old.jpg', 4)        // 超过 3 天 → 删
  put(root, 'media/him-new.jpg', 1)        // 留着
  put(root, 'home/inbox/日历.ics', 5)      // 5 天 < 7 → 留着
  put(root, 'home/inbox/聊天记录.txt', 8)  // 超过 7 天 → 删
  put(root, 'voice/v-old.mp3', 4)          // 超过 3 天 → 删

  const r = await sweepCaches(root, { now: NOW, config: {} })
  assert.equal(r.media.removed, 1)
  assert.equal(r.inbox.removed, 1)
  assert.equal(r.voice.removed, 1)
  assert.equal(r.removed, 3)
  assert.ok(!existsSync(join(root, 'media/him-old.jpg')))
  assert.ok(existsSync(join(root, 'media/him-new.jpg')))
  assert.ok(existsSync(join(root, 'home/inbox/日历.ics')), '文件留 7 天，5 天的不能被删')
  assert.ok(!existsSync(join(root, 'home/inbox/聊天记录.txt')))
  assert.ok(!existsSync(join(root, 'voice/v-old.mp3')))
})

test('期限填 0 = 关掉这一项，不是立刻全删', async () => {
  const root = mkRoot()
  put(root, 'media/him-old.jpg', 30)
  put(root, 'voice/v-old.mp3', 30)
  const r = await sweepCaches(root, { now: NOW, config: { retention: { mediaDays: 0, voiceDays: 0 } } })
  assert.equal(r.media.removed, 0)
  assert.equal(r.voice.removed, 0)
  assert.ok(existsSync(join(root, 'media/him-old.jpg')), '关掉之后一个都不许删')
})

test('子目录一概不碰', async () => {
  const root = mkRoot()
  mkdirSync(join(root, 'home', 'inbox', '子目录'), { recursive: true })
  const f = join(root, 'home', 'inbox', '子目录', 'a.txt')
  writeFileSync(f, 'x')
  const old = (NOW - 99 * DAY) / 1000
  utimesSync(f, old, old)
  await sweepCaches(root, { now: NOW, config: {} })
  assert.ok(existsSync(f), '只删普通文件，子目录里的东西不动')
})

test('目录不存在不报错（新装的机器）', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'fishbare-'))
  const r = await sweepCaches(bare, { now: NOW, config: {} })
  assert.equal(r.removed, 0)
})

test('什么都没删时不打日志（别每小时刷一行）', async () => {
  const root = mkRoot()
  put(root, 'media/him-new.jpg', 1)
  const lines = []
  await sweepCaches(root, { now: NOW, config: {}, log: (m) => lines.push(m) })
  assert.equal(lines.length, 0)
})

test('retentionLine 说人话', () => {
  assert.equal(retentionLine({}), '图 3 天 · 文件 7 天 · 语音 3 天')
  assert.equal(retentionLine({ retention: { mediaDays: 0 } }), '图 不清 · 文件 7 天 · 语音 3 天')
})
