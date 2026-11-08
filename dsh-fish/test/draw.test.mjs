/**
 * her_draw（2026-11-08）：白板画笔。
 *
 * planDrawing 是纯校验（快），renderJob 要起 PowerShell（慢，约 1 秒）——
 * 真渲染只放一条烟测：文字 + 矩形 + 箭头 + 圆画一张，断言 PNG 魔数与体积。
 * 「只存不发」是定案：这里没有任何推送标记的断言反面——它压根不产生 meta。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planDrawing, registerDraw, formatMeasureReport } from '../lib/draw.js'
import { FISH_TOOLS } from '../lib/restrict.js'

test('planDrawing：空画布、不认识的笔、字数超限都拒绝', () => {
  assert.match(planDrawing({ items: [] }).why, /什么都没有/)
  assert.match(planDrawing({ items: [{ type: 'unicorn', x: 1, y: 1 }] }).why, /不认识/)
  const big = { items: [{ type: 'text', text: '字'.repeat(500) }] }
  assert.match(planDrawing(big).why, /单个文本最多/)
})

test('planDrawing：坐标夹进画布、中文名调色板映射、未知颜色退默认不报错', () => {
  const r = planDrawing({
    canvas: { w: 5000, h: 999999, bg: '浅灰' },
    items: [
      { type: 'text', x: 99999, y: -5, text: '出界了', color: '红' },
      { type: 'rect', x: 10, y: 10, w: 100, h: 40, fill: '#FFEECC' },
      { type: 'circle', cx: 50, cy: 50, r: 20, color: '随便写的' },
    ],
  })
  assert.equal(r.ok, true)
  assert.equal(r.job.w, 1024, '画布夹到上限')
  assert.equal(r.job.h, 1024)
  assert.equal(r.job.bg, '#c8c8c8', '浅灰映射成 hex')
  assert.equal(r.job.items[0].color, '#d94040', '红')
  assert.equal(r.job.items[0].x, 1024, '坐标夹进画布')
  assert.equal(r.job.items[2].color, '#1a1a1a', '不认识的颜色退默认，不中断')
})

test('her_draw 在 FISH_TOOLS 里（她在收窄后的工具面上看得见）', () => {
  assert.ok(FISH_TOOLS.includes('her_draw'))
})

test('frac：分子分母可以是文字、{text,size}，也可以再套分数线', () => {
  const r = planDrawing({
    items: [
      { type: 'frac', x: 10, y: 20, num: 'ln a - ln a', den: '0', size: 18 },
      { type: 'frac', x: 200, y: 20, num: { text: 'x', size: 22 }, den: 'a' },
      { type: 'frac', x: 300, y: 20, num: { type: 'frac', num: '1', den: '2' }, den: { type: 'frac', num: '3', den: '4' } },
    ],
  })
  assert.equal(r.ok, true, r.why)
  assert.equal(r.job.items.length, 3)
  assert.equal(r.job.items[0].t, 'frac')
  assert.equal(r.job.items[0].num.t, 'text')
  assert.equal(r.job.items[0].den.text, '0')
  assert.equal(r.job.items[1].num.size, 22, '分子自己带 size 就用它')
  assert.equal(r.job.items[2].num.t, 'frac', '分子里能再套一个分数')
  assert.equal(r.job.items[2].den.num.text, '3', '嵌套结构完整传下去')
})

test('frac：空分子、超字数、套超过 3 层都拒绝（并说明为什么）', () => {
  assert.match(planDrawing({ items: [{ type: 'frac', num: '', den: 'a' }] }).why, /空的/)
  assert.match(planDrawing({ items: [{ type: 'frac', num: '字'.repeat(61), den: 'a' }] }).why, /分数里这一行/)
  const deep = (n) => (n <= 0 ? 'a' : { type: 'frac', num: deep(n - 1), den: 'b' })
  assert.equal(planDrawing({ items: [{ type: 'frac', num: deep(2), den: 'c' }] }).ok, true, '3 层是允许的')
  assert.match(planDrawing({ items: [{ type: 'frac', num: deep(3), den: 'c' }] }).why, /最多套 3 层/)
})

test('frac 的字也计入总字数预算（别绕开 400 字上限）', () => {
  // 六条 60 字 = 360，再用分数加 41 字 → 401，越过 400 的合计上限
  const items = Array.from({ length: 6 }, (_, i) => ({ type: 'text', x: 10, y: 10 + i * 20, text: '字'.repeat(60), size: 12 }))
  assert.equal(planDrawing({ items }).ok, true, '360 字还没超')
  items.push({ type: 'frac', num: '字'.repeat(38), den: '字'.repeat(3) })
  assert.match(planDrawing({ items }).why, /字太多了/)
})

test('formatMeasureReport：列字的宽高、整体外接框、出界提醒；无线框圆（她自己知道坐标）', () => {
  const report = {
    canvas: { w: 480, h: 360 },
    items: [
      { i: 1, t: 'text', x: 16, y: 16, w: 192.4, h: 22.1 },
      { i: 2, t: 'rect', x: 10, y: 10, w: 100, h: 40 },
      { i: 3, t: 'frac', x: 220, y: 10, w: 48, h: 56 },
    ],
    bbox: { x1: 10, y1: 10, x2: 268, y2: 66 },
    clipped: [3],
  }
  const s = formatMeasureReport(report)
  assert.match(s, /画布 480×360/)
  assert.match(s, /1字@16,16 192×22/, '字要带左上与宽高（四舍五入）')
  assert.match(s, /3分数@220,10 48×56/, '分数也要列')
  assert.ok(!s.includes('2rect'), '线框圆不列：坐标是她自己给的')
  assert.match(s, /10,10 → 268,66/)
  assert.match(s, /第 3 笔超出画布/)
})

test('formatMeasureReport：拿不到报告就返回空串（不能让回执变成 null/undefined）', () => {
  assert.equal(formatMeasureReport(null), '')
  assert.equal(formatMeasureReport({}), '')
  assert.equal(formatMeasureReport({ items: [] }), '')
})

test('画失败时把真因带进回执（以前只回「这次没画成。」，她没法自己修）', async () => {
  // 造一个必然失败的屋子：把文件当成目录用，mkdir 会 ENOTDIR。
  // 不依赖具体错误文案——测的是「任何失败都要把原因带回给她」这件事本身。
  const base = await mkdtemp(join(tmpdir(), 'fish-draw-bad-'))
  try {
    const blocker = join(base, 'not-a-dir')
    await writeFile(blocker, 'x')
    const registered = []
    registerDraw({ tools: { register: (t) => registered.push(t) } }, { root: join(blocker, 'sub'), log: () => {} })
    const out = await registered[0].execute(
      { items: [{ type: 'text', x: 10, y: 10, text: 'hi' }] },
      { session: {} },
    )
    assert.equal(out.ok, false)
    assert.notEqual(out.note, '这次没画成。', '哑巴回执不能回来')
    assert.match(out.note, /这次没画成：\S/, '原因要跟在冒号后面')
    assert.ok(out.note.length > '这次没画成：'.length + 3, `原因太短，不像真因：${out.note}`)
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {})
  }
})

test('真渲染：一张带字、框、箭头、圆的画，产出合法 PNG', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-draw-'))
  try {
    const registered = []
    const ctx = { tools: { register: (t) => registered.push(t) } }
    registerDraw(ctx, { root, log: () => {} })
    assert.equal(registered.length, 1)
    const def = registered[0]
    assert.equal(def.name, 'her_draw')

    // 传参加法与她的用法完全一致（原始指令形状，不是内部 job）
    const out = await def.execute(
      {
        canvas: { w: 480, h: 360 },
        items: [
          { type: 'rect', x: 40, y: 40, w: 200, h: 80, color: '蓝', fill: '#EAF0FF' },
          { type: 'text', x: 56, y: 66, text: '解： 3(x²+1) = 15', size: 18 },
          { type: 'text', x: 60, y: 96, text: 'x = ±2', size: 16, color: '灰' },
          { type: 'arrow', x1: 240, y1: 80, x2: 330, y2: 80, color: '红' },
          { type: 'circle', cx: 380, cy: 80, r: 36, color: '橙' },
        ],
      },
      { session: {} },
    )
    assert.equal(out.ok, true, `应画成（note：${out.note}）`)
    assert.match(out.path, /media[\\/]draw[\\/]draw-\d{4}-\d{2}-\d{2}-\d{2}\.png$/)
    // 11-08 fork.13：只写「存在 media/draw/」她拿不到可抄的路径，就会以为只能绕表情库。
    const shown = out.path.replace(/\\/g, '/')
    assert.match(out.note, /没有发给他/, '只存不发仍是定案')
    assert.ok(out.note.includes(shown), '回执要给正斜杠的完整路径')
    assert.match(out.note, /!\[白板\]\(/, '回执要给发图写法')
    assert.match(out.note, /her_say/, '回执指向现成通路')
    const png = await readFile(out.path)
    // PNG 魔数：89 50 4E 47
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
    assert.ok(png.length > 1500, `PNG 太小不像画（${png.length}B）`)
    // 只存不发的定案：回执必须如实说「没有发给他」
    assert.match(out.note, /没有发给他/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('真渲染：分数线（含嵌套）画出来，回执带实测几何', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-draw-'))
  try {
    const registered = []
    registerDraw({ tools: { register: (t) => registered.push(t) } }, { root, log: () => {} })
    const def = registered[0]
    const out = await def.execute(
      {
        canvas: { w: 480, h: 260 },
        items: [
          { type: 'text', x: 16, y: 16, text: '① 代入 x = 0', size: 16 },
          { type: 'frac', x: 160, y: 10, num: 'ln a - ln a', den: '0', size: 16 },
          { type: 'frac', x: 160, y: 90, num: { type: 'frac', num: 'x', den: 'a' }, den: '2', size: 16 },
        ],
      },
      { session: {} },
    )
    assert.equal(out.ok, true, `应画成（note：${out.note}）`)
    // A 档：回执必须告诉她量出来多大，不然她还是只能画三回
    assert.match(out.note, /实测（画布 480×260/)
    assert.match(out.note, /2分数@/, '分数要列进实测')
    assert.match(out.note, /整张画占/)
    // 只存不发仍是定案
    assert.match(out.note, /没有发给他/)
    const png = await readFile(out.path)
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
    assert.ok(png.length > 1500, `PNG 太小不像画（${png.length}B）`)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
