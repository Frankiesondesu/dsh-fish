/**
 * 工具定义的结构守卫（2026-11-04 真机踩的）。
 *
 * 症状：她调 her_alarm / her_help，宿主回 `unknown tool`；
 * 日志里两行 warn：
 *   [warn] 工具注册失败 tool "her_alarm" must declare output { schema, render, presentationMeta? }
 *
 * 原因是我把 `render` 写在了 defineTool 的顶层，没包进 `output`。
 * 宿主的注册直接用 try/catch 吞掉，只留一行 warn——**插件照跑，工具却不在**。
 * 她的判断很准：「名字挂在清单上（HER_TOOLS 里有），我伸手去够，回我 unknown tool。
 * 要么还没接上，要么只接了一半。」
 *
 * 这条测试就是防这个：每个工具注册出来必须带 output.schema + output.render。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerAlarm } from '../lib/alarm.js'
import { registerHelp } from '../lib/help.js'

function capture(reg, deps = { root: '/tmp/fish-test-root' }) {
  const out = []
  const ctx = { tools: { register: (def) => out.push(def) }, on() {} }
  reg(ctx, deps)
  return out
}

const CASES = [
  ['her_alarm', registerAlarm],
  ['her_help', registerHelp],
]

for (const [name, reg] of CASES) {
  test(`${name}：注册出来的定义必须带 output（否则宿主拒收）`, () => {
    const defs = capture(reg)
    assert.equal(defs.length, 1, `${name} 应该只注册一个工具`)
    const d = defs[0]
    assert.equal(d.name, name)
    assert.ok(d.description && d.description.length > 4, '说明不能空')
    assert.ok(d.parameters, '缺 parameters')
    assert.ok(d.output, '缺 output —— 宿主会报 "must declare output" 然后静默不注册')
    assert.ok(d.output.schema, '缺 output.schema')
    assert.equal(typeof d.output.render, 'function', '缺 output.render')
    assert.equal(typeof d.execute, 'function', '缺 execute')
  })
}
