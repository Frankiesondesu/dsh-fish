/**
 * fork.3（2026-11-01）：把她上下文里的技能目录摘掉。
 *
 * 真机形状：她那条会话里躺着两份 `<available_skills>`，共 11 万字（206 条），
 * 每轮重读。她的工具面已收窄、`skill` 根本不在发给模型的 19 个工具里，
 * 但宿主插件判断的是 `ctx.tools.get('skill', agent) === skillTool`（走注册表，
 * 不看收窄后的可见面），所以目录照塞。她只有 9 个工具、不写代码，
 * 这两百多个技能一个字都用不上。
 *
 * 这里只验插件自己那两道闸的行为，宿主那边没法在单测里跑。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerSkillCatalogGuard } from '../lib/skillcatalog.js'

const HER_DIR = 'X:\\fake\\home'
const herAgent = { session: { header: { cwd: HER_DIR } } }
const otherAgent = { session: { header: { cwd: 'X:\\fake\\elsewhere' } } }

/** 假 skills 服务：记下被问过几次、每次问的是谁 */
function fakeSkills() {
  const asked = []
  return {
    asked,
    async snapshot(opts = {}) {
      asked.push(opts?.scope)
      return { skills: [{ name: 'some-skill' }], complete: true }
    },
  }
}

test('她的会话：技能快照直接返回空，且不惊动真的快照', async () => {
  const skills = fakeSkills()
  const ctx = { get: (k) => (k === 'skills' ? skills : undefined) }
  const off = registerSkillCatalogGuard(ctx, { herDir: HER_DIR })

  const hers = await skills.snapshot({ scope: herAgent })
  assert.deepEqual(hers, { skills: [], complete: true }, '她的会话不该拿到任何技能')
  assert.equal(skills.asked.length, 0, '不该再去问真的快照')

  // 别人的会话照旧
  const other = await skills.snapshot({ scope: otherAgent })
  assert.equal(other.skills.length, 1, '别的会话必须原样保留技能目录')
  assert.equal(skills.asked.length, 1)

  // 没有 scope（冷读 / 界面）也照旧
  await skills.snapshot({})
  assert.equal(skills.asked.length, 2)

  off()
  // 注销之后恢复原样
  const after = await skills.snapshot({ scope: herAgent })
  assert.equal(after.skills.length, 1, '注销后不该继续拦')
})

test('她的会话：pre-step 兜底把 skill-catalog 消息摘掉，别的不动', async () => {
  const listeners = []
  const ctx = {
    get: () => undefined,
    on(evt, fn) {
      if (evt !== 'agent/pre-step') return () => {}
      listeners.push(fn)
      return () => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
  }
  const off = registerSkillCatalogGuard(ctx, { herDir: HER_DIR })
  assert.equal(listeners.length, 1)

  const decide = (agent, messages) => listeners[0]({ agent }, async () => ({ kind: 'enter', messages }))

  const catalog = { id: 'm-cat', source: { kind: 'skill-catalog' }, content: [] }
  const keep = { id: 'm-1', source: { kind: 'user' }, content: [] }

  const hers = await decide(herAgent, [catalog, keep])
  assert.deepEqual(hers.messages.map((m) => m.id), ['m-1'], '她的会话里目录要被摘掉')

  const other = await decide(otherAgent, [catalog, keep])
  assert.deepEqual(other.messages.map((m) => m.id), ['m-cat', 'm-1'], '别人会话原样')

  off()
  assert.equal(listeners.length, 0, '注销要真的摘掉监听')
})
