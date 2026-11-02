import test from 'node:test'
import assert from 'node:assert/strict'

import { extractBvid, parseWatchIntent, watchHint, handText, isHanded } from '../lib/intent.js'
import { renderSelfDoc } from '../lib/selfdoc.js'
import { deriveSelf } from '../lib/derive.js'

const BV = 'BV1ED4y1Y7dc'

test('抠得出 BV 号', () => {
  assert.equal(extractBvid(`你看这个 https://www.bilibili.com/video/${BV}`), BV)
  assert.equal(extractBvid(`就 ${BV} 这条`), BV)
  assert.equal(extractBvid('没有链接'), '')
})

test('没有视频就什么都不说', () => {
  const r = parseWatchIntent('今天好累')
  assert.equal(r.hasVideo, false)
  assert.equal(r.intent, 'none')
  assert.equal(watchHint(r), '')
})

test('明确要求 → must', () => {
  for (const s of [`必须看 ${BV}`, `帮我看一下 ${BV}`, `一定要看 ${BV}`, `你看一下这个 ${BV}`, `看完告诉我 ${BV}`]) {
    assert.equal(parseWatchIntent(s).intent, 'must', s)
  }
})

test('只是在问她 → maybe', () => {
  for (const s of [`可以看看 ${BV}`, `要不要看这个 ${BV}`, `有没有兴趣 ${BV}`, `你愿意看吗 ${BV}`]) {
    assert.equal(parseWatchIntent(s).intent, 'maybe', s)
  }
})

test('收回要求 → none', () => {
  for (const s of [`不用看了 ${BV}`, `算了别看了 ${BV}`, `没必要看 ${BV}`]) {
    const r = parseWatchIntent(s)
    assert.equal(r.intent, 'none', s)
    assert.equal(r.why, 'negated')
  }
})

test('只丢一条链接、什么都没说 → 不是要求', () => {
  const r = parseWatchIntent(`${BV}`)
  assert.equal(r.intent, 'maybe')
  assert.equal(r.why, 'bare')
})

test('短链认得出来，但不假装知道是哪条', () => {
  const r = parseWatchIntent('看看 https://b23.tv/abcd123')
  assert.equal(r.hasVideo, true)
  assert.equal(r.bvid, '')
  assert.equal(r.linkOnly, true)
})

test('递给她的那行：要求看 vs 可以自己定，措辞不同', () => {
  const must = watchHint(parseWatchIntent(`必须看 ${BV}`))
  assert.match(must, /先看，再回他/)
  assert.match(must, new RegExp(BV))

  const maybe = watchHint(parseWatchIntent(`可以看看 ${BV}`))
  assert.match(maybe, /没有一定让你看/)
  assert.match(maybe, /直接问他/)
  // 不能替他做决定
  assert.doesNotMatch(maybe, /先看，再回他/)
})

test('身份档里写着这两档的区别', () => {
  const model = deriveSelf([], { growthDays: 30 })
  const withBrowse = renderSelfDoc(model, { browse: true })
  assert.match(withBrowse, /他有时会丢一条视频给我/)
  assert.match(withBrowse, /那只是问我/)
  const noBrowse = renderSelfDoc(model, { browse: false })
  assert.doesNotMatch(noBrowse, /他有时会丢一条视频给我/)
})

// fork.20（2026-11-02，用户定案）：他发过来的那条不占看画面的额度。
// 判据只有账本里的 `hand:`——不认工具参数、不认她自己的说法。
test('handText 写出 whatseen 认得的形状：hand:<日期> <bvid>', async () => {
  assert.equal(handText('2026-11-02', BV), `hand:2026-11-02 ${BV}`)
  assert.equal(handText('2026-11-02', ` ${BV} `), `hand:2026-11-02 ${BV}`)
  // 与 whatseen.js 的 parseDated 同一形状（hand: 后面先日期再空格再 bvid）
  const { parseHandLine } = await import('../lib/whatseen.js')
  assert.deepEqual(parseHandLine(handText('2026-11-02', BV)), { dk: '2026-11-02', bvid: BV, info: null })
})

test('isHanded：只认 meta 里的 hand:，且只认那一条', () => {
  const events = [
    { type: 'meta', text: `hand:2026-11-02 ${BV}` },
    { type: 'meta', text: 'hand:2026-11-02 BV1aa411c7m1' },
    { type: 'utterance', text: `hand:2026-11-02 BV1bb411c7m2` }, // 她写的不算
    { type: 'meta', text: `watched:2026-11-02 BV1cc411c7m3` }, // 看过不等于他递的
  ]
  assert.equal(isHanded(events, BV), true)
  assert.equal(isHanded(events, 'BV1aa411c7m1'), true)
  assert.equal(isHanded(events, 'BV1bb411c7m2'), false, '她自己在正文里写的 hand: 不算数')
  assert.equal(isHanded(events, 'BV1cc411c7m3'), false, '看过不等于他递过来')
  assert.equal(isHanded(events, ''), false)
  assert.equal(isHanded([], BV), false)
  assert.equal(isHanded(null, BV), false)
})

test('isHanded：不带日期窗口——他递过一次，这条就一直是"他给的"', () => {
  const events = [{ type: 'meta', text: `hand:2026-10-01 ${BV}` }]
  assert.equal(isHanded(events, BV), true)
})
