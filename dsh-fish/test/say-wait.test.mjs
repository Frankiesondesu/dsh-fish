/**
 * say.js 的「等她说完」计时（fork.23，2026-11-02 真机）。
 *
 * 事是这么出的：他在 QQ 里一条消息丢了两条视频，她要下整条片子看，
 * 80 秒还没说完。原来的死线是 75 秒，say 判她「没说话」、桥什么都不发——
 * 而她的回话 8 秒后就落盘了，DSH 里看得见，QQ 里没有。
 *
 * 现在死线量的是**她停了多久**：期间只要还有事件就重开计时，另有硬上限兜底。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { waitTurnEnd } from '../lib/say.js'

function fakeBus(sid) {
  const fns = []
  return {
    ctx: { on: (_name, fn) => { fns.push(fn); return () => { const i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1) } } },
    emit: (type, id = sid) => fns.slice().forEach((f) => f({ id }, { type })),
  }
}

test('waitTurnEnd：她在动就不算说完——中途有事件就把死线顺延', async () => {
  const sid = 's1'
  const { ctx, emit } = fakeBus(sid)
  const t0 = Date.now()
  // 死线 60ms；40ms / 80ms 各来一条事件，120ms 才 turn/end
  setTimeout(() => emit('assistant/message'), 40)
  setTimeout(() => emit('assistant/message'), 80)
  setTimeout(() => emit('turn/end'), 120)
  await waitTurnEnd(ctx, sid, 60, { maxMs: 2_000 })
  const dt = Date.now() - t0
  assert.ok(dt >= 100, `不该在 60ms 就放手（真机就是这里判她没说话的）：${dt}ms`)
  assert.ok(dt < 600, `turn/end 一到就该返回：${dt}ms`)
})

test('waitTurnEnd：turn/end 直接结束，不用等满', async () => {
  const sid = 's2'
  const { ctx, emit } = fakeBus(sid)
  const t0 = Date.now()
  setTimeout(() => emit('turn/end'), 30)
  await waitTurnEnd(ctx, sid, 5_000, { maxMs: 5_000 })
  assert.ok(Date.now() - t0 < 400, '收到 turn/end 要立刻返回')
})

test('waitTurnEnd：一直在动也有硬上限，不会无限等下去', async () => {
  const sid = 's3'
  const { ctx, emit } = fakeBus(sid)
  const t0 = Date.now()
  const tick = setInterval(() => emit('assistant/message'), 15)
  await waitTurnEnd(ctx, sid, 50, { maxMs: 200 })
  clearInterval(tick)
  const dt = Date.now() - t0
  assert.ok(dt >= 150, `硬上限之前不该放手：${dt}ms`)
  assert.ok(dt < 800, `到了硬上限必须放手：${dt}ms`)
})

test('waitTurnEnd：别的会话的事件不算数', async () => {
  const sid = 's4'
  const { ctx, emit } = fakeBus(sid)
  const t0 = Date.now()
  const tick = setInterval(() => emit('assistant/message', 'other'), 15)
  await waitTurnEnd(ctx, sid, 80, { maxMs: 2_000 })
  clearInterval(tick)
  assert.ok(Date.now() - t0 < 500, '别的会话在动不该拖住这一轮')
})
