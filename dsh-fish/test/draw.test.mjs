/**
 * her_draw（2026-11-08）：白板画笔。
 *
 * planDrawing 是纯校验（快），renderJob 要起 PowerShell（慢，约 1 秒）——
 * 真渲染只放一条烟测：文字 + 矩形 + 箭头 + 圆画一张，断言 PNG 魔数与体积。
 * 「只存不发」是定案：这里没有任何推送标记的断言反面——它压根不产生 meta。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planDrawing, registerDraw } from '../lib/draw.js'
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
