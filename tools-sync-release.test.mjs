/**
 * 内容级同步的守卫测试（2026-11-08 22:46）。
 * 重点：规则文件本身不含敏感明文；动态用户名/路径能抹掉；终检从清单解析。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'

import {
  WORK, DEFAULT_RELEASE, CHECKLIST, releaseDir,
  skipDir, skipFile, isTextFile, buildRules, cleanText,
  terminalPattern, scanDir, summarizeTestOutput,
} from './tools-sync-release.mjs'

test('发布仓默认与工作仓同级，绝不在工作仓内部', () => {
  assert.equal(dirname(DEFAULT_RELEASE), dirname(WORK), '同级')
  assert.ok(!DEFAULT_RELEASE.startsWith(WORK + '/'))
  assert.ok(!DEFAULT_RELEASE.startsWith(WORK + '\\'))
  assert.notEqual(DEFAULT_RELEASE, WORK)
})

test('FISH_RELEASE_DIR 可覆盖发布仓位置', () => {
  assert.equal(releaseDir({ FISH_RELEASE_DIR: 'X:/pub' }), resolve('X:/pub'))
  assert.equal(releaseDir({}), DEFAULT_RELEASE)
})

test('白名单排除：私层配置 / 日志 / node_modules / .git', () => {
  assert.equal(skipDir('node_modules'), true)
  assert.equal(skipDir('.git'), true)
  assert.equal(skipDir('runtime'), true)
  assert.equal(skipDir('viewer'), false)
  assert.equal(skipFile('bridge/config.json'), true)
  assert.equal(skipFile('bridge/bridge.log'), true)
  assert.equal(skipFile('bridge/push-state.json'), true)
  assert.equal(skipFile('viewer/viewer.mjs'), false)
  assert.equal(isTextFile('README.md'), true)
  assert.equal(isTextFile('viewer.mjs'), true)
  assert.equal(isTextFile('a.png'), false)
})

test('动态构造：真实用户名与本机路径都被抹掉，规则里不写明文', () => {
  const user = basename(homedir())
  const posix = WORK.replace(/\\/g, '/')
  const src = `C:\\Users\\${user}\\.dsh-fish 与 ${posix} 与 ${posix.replace(/\//g, '\\')}`
  const out = cleanText(src)
  assert.ok(!out.includes(user), '真实用户名不能留')
  assert.ok(!out.includes(posix), '本机路径不能留')
  assert.ok(!out.includes(posix.replace(/\//g, '\\')))
})

test('私人 fixture 清洗后不再命中终检（不内联真值，拿真文件验）', () => {
  const p = terminalPattern(readFileSync(CHECKLIST, 'utf8'))
  // 这几个文件里确实躺着私人对话 fixture 与稀有词；清洗后必须干净。
  for (const f of ['viewer/test/said.test.mjs', 'bridge/bridge.mjs']) {
    const out = cleanText(readFileSync(join(WORK, f), 'utf8'))
    assert.ok(!p.test(out), `${f} 清洗后仍命中终检`)
  }
})

test('逐句 fixture：私人对话被替换成中性句', () => {
  // 用规则形状而不是真句做样本：`行。跟……。` 这一段会被整句换掉
  const out = cleanText('她说：行。跟某某一起去。然后没了。')
  assert.ok(!out.includes('跟某某'), '私人对话整句要换掉')
  assert.match(out, /那就这么定了/)
})

test('失效引用与 .cmd 中文 echo 都被改写', () => {
  const out = cleanText([
    '见 ref/cross-machine 文档',
    '双击 一键启动.cmd',
    'echo 启动 QQ -> 她 的桥...',
  ].join('\n'))
  assert.match(out, /README\.md/)
  assert.match(out, /node launch\.mjs/)
  assert.match(out, /echo Starting QQ bridge\.\.\./)
})

test('一对 QQ 号与本地图片 markdown 都换成占位（样本用假号）', () => {
  const out = cleanText([
    '解出 fromUin=1234567890 → toUin=9876543210',
    '她 QQ(1357924680) 收到了',
    '![某画面](C:/x/y.png)',
  ].join('\n'))
  assert.ok(!/\d{7,}/.test(out), 'QQ 号不能留')
  assert.match(out, /fromUin=<主人QQ> → toUin=<机器人QQ>/)
  assert.match(out, /QQ\(<主人QQ>\)/)
  assert.match(out, /!\[示例画面\]\(media\/example\.png\)/)
})

/**
 * 从清单的终检命令里拆出关键词。
 * 测试本身**不许**写任何真值做字面量——那等于把要抹掉的东西又抄一份进仓库。
 */
function checklistTokens(text = readFileSync(CHECKLIST, 'utf8')) {
  const m = /git grep -i -E "([^"]+)"/.exec(text)
  assert.ok(m, '清单里应该有终检命令')
  return m[1].split('|').map((s) => s.trim()).filter(Boolean)
}

test('终检模式从 runtime 清单解析，清单里每个关键词都能命中', () => {
  const p = terminalPattern(readFileSync(CHECKLIST, 'utf8'))
  const tokens = checklistTokens()
  assert.ok(tokens.length >= 5, '清单关键词太少，可能解析错了')
  for (const t of tokens) assert.ok(p.test(t), `清单关键词没被终检模式覆盖：${t}`)
  assert.ok(!p.test('一段完全中性的工程说明文字'))
  assert.throws(() => terminalPattern('没有终检命令'), /找不到终检命令/)
})

test('本测试文件自己不含真值字面量（防止测试反过来泄密）', () => {
  const self = readFileSync(new URL(import.meta.url), 'utf8')
  const tokens = checklistTokens()
  // 只盯「属于人」的值：纯数字（QQ/通路号）、含中文且不是文件名（地名/稀有词/fixture 词）。
  // 路径类关键词（ref/cross-machine、*.cmd）不算隐私，允许出现在样本里。
  const personal = tokens.filter(
    (t) => /^\d{6,}$/.test(t) || (/[\u4e00-\u9fa5]/.test(t) && !/\./.test(t)),
  )
  assert.ok(personal.length > 0, '清单里应该能认出至少一个身份类关键词')
  self.split('\n').forEach((line, i) => {
    for (const t of personal) assert.ok(!line.includes(t), `第 ${i + 1} 行抄了真值：${t}`)
  })
  // 本机用户名与路径也不许写进测试
  const user = basename(homedir())
  assert.ok(!self.toLowerCase().includes(user.toLowerCase()), '不许写本机用户名')
  assert.ok(!self.includes(WORK.replace(/\\/g, '/')), '不许写本机路径')
})

test('章节级替换：AGENTS 会话库节删掉、README 快速开始换成占位路径', () => {
  const agents = cleanText(readFileSync(join(WORK, 'AGENTS.md'), 'utf8'))
  assert.ok(!agents.includes('各工具的会话库'))
  assert.match(agents, /跨工具接手/)
  assert.match(agents, /发布快照说明/, '快照里要交代私层不在本仓')
  assert.ok(!agents.includes('这个仓**含隐私层**'), '工作仓那句在快照里是假话，必须换掉')
  const readme = cleanText(readFileSync(join(WORK, 'README.md'), 'utf8'))
  assert.ok(!readme.includes(WORK.replace(/\\/g, '/')))
  assert.match(readme, /<你选的目录>/)
  assert.ok(!readme.includes('一键启动.cmd'))
})

test('summarizeTestOutput：解析得到用例名与摘要，不再只报 fail=?', () => {
  const tap = [
    'ok 1 - 甲',
    'not ok 2 - 乙：某个用例挂了',
    '  ---',
    '  error: boom',
    '  ...',
    '1..2',
    '# tests 2',
    '# pass 1',
    '# fail 1',
  ].join('\n')
  const s = summarizeTestOutput(tap)
  assert.equal(s.pass, '1')
  assert.equal(s.fail, '1')
  assert.deepEqual(s.fails, ['乙：某个用例挂了'])
  assert.deepEqual(s.heads, ['tests 2', 'pass 1', 'fail 1'])
})

test('summarizeTestOutput：输出里没有摘要时退回尾部，不能返回空', () => {
  const crashed = 'node:internal/modules/cjs/loader:1234\nError: Cannot find module "x"\n    at ...'
  const s = summarizeTestOutput(crashed)
  assert.equal(s.fail, undefined)
  assert.deepEqual(s.fails, [])
  assert.match(s.tail, /Cannot find module/)
})

test('summarizeTestOutput：空输出也不抛', () => {
  const s = summarizeTestOutput('')
  assert.equal(s.pass, undefined)
  assert.equal(s.tail, '')
})

test('scanDir：有命中就报出来，干净目录零命中', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fish-synctest-'))
  try {
    const p = terminalPattern(readFileSync(CHECKLIST, 'utf8'))
    const probe = checklistTokens()[0]
    writeFileSync(join(dir, 'a.md'), `中性一行\n这里写了 ${probe}\n`, 'utf8')
    const hits = scanDir(dir, p)
    assert.ok(hits.some((h) => h.includes('a.md:2')))
    writeFileSync(join(dir, 'a.md'), '中性一行\n另一行中性\n', 'utf8')
    assert.deepEqual(scanDir(dir, p), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
