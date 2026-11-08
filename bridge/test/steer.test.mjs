/**
 * 插话判定（2026-11-08，用户选 A）。
 * shouldSteer 是纯函数；其余用静态守卫钉住桥里的降级路径，避免「试过插话就把消息弄丢」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { shouldSteer, QQ_NOTE } from '../steer.mjs'

const batch = (o = {}) => ({
  texts: ['后发的第二条'], files: [], forwards: [], audios: [], images: [], ...o,
})

test('她在想（/local/say 还在飞）+ 纯文字 → 插话，不排队', () => {
  assert.equal(shouldSteer(1, batch()), true)
})

test('没有在飞的轮次 → 照旧走合批 / 排队', () => {
  assert.equal(shouldSteer(0, batch()), false)
  assert.equal(shouldSteer(-1, batch()), false)
})

test('带附件 / 语音 / 转发 / 图 → 不插话（文件事实不能只带文字吞掉）', () => {
  assert.equal(shouldSteer(1, batch({ files: [{}] })), false)
  assert.equal(shouldSteer(1, batch({ audios: [{}] })), false)
  assert.equal(shouldSteer(1, batch({ forwards: [{}] })), false)
  assert.equal(shouldSteer(1, batch({ images: [{}] })), false)
})

test('没有文字或只有空白 → 不插话', () => {
  assert.equal(shouldSteer(1, batch({ texts: [] })), false)
  assert.equal(shouldSteer(1, batch({ texts: ['  ', '\n'] })), false)
  assert.equal(shouldSteer(1, null), false)
})

test('连发几句合成一条插话，QQ 来源标注与 /local/say 同一份', () => {
  assert.equal(shouldSteer(1, batch({ texts: ['甲', '乙'] })), true)
  assert.match(QQ_NOTE, /这条消息从 QQ 发来/)
})

test('守卫：桥里插不进去要退回排队，在飞计数要成对', async () => {
  const src = await readFile(new URL('../bridge.mjs', import.meta.url), 'utf8')
  assert.match(src, /\/dsh-fish\/local\/steer/, '要真的调新通路')
  assert.match(src, /sayInFlight\+\+/)
  assert.match(src, /sayInFlight--/)
  assert.match(src, /插话没成/, '失败要记日志')
  assert.match(src, /void flush\(p\)/, '失败必须退回原队列，不能把消息吞掉')
  assert.match(src, /shouldSteer\(sayInFlight, p\)/, '到点要重新判一次')
})
