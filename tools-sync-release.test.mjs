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
  terminalPattern, scanDir,
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

test('QQ 号、私人 fixture、稀有词、失效引用都清成中性', () => {
  const out = cleanText([
    'fromUin=1234567890 → toUin=9876543210',
    '（她说）行。跟某某一起吃。',
    '见 ref/cross-machine 文档',
    '![某段视频的画面](C:/x.png)',
    '双击 一键启动.cmd',
  ].join('\n'))
  assert.ok(!/\d{9,}/.test(out), 'QQ 号不能留')
  assert.match(out, /那就这么定了/)
  assert.match(out, /README\.md/)
  assert.match(out, /示例画面/)
  assert.match(out, /node launch\.mjs/)
  assert.ok(!out.includes('某段视频'))
})

test('终检模式从 runtime 清单解析，能命中清单关键词', () => {
  const text = readFileSync(CHECKLIST, 'utf8')
  const p = terminalPattern(text)
  assert.ok(p.test('旧的 <主人QQ> 串'))
  assert.ok(p.test('杭州'))
  assert.ok(p.test('<主人QQ>'))
  assert.ok(!p.test('一段完全中性的工程说明文字'))
  assert.throws(() => terminalPattern('没有终检命令'), /找不到终检命令/)
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

test('scanDir：有命中就报出来，干净目录零命中', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fish-synctest-'))
  try {
    const p = terminalPattern(readFileSync(CHECKLIST, 'utf8'))
    writeFileSync(join(dir, 'a.md'), '中性一行\n这里写了 <主人QQ>\n', 'utf8')
    const hits = scanDir(dir, p)
    assert.ok(hits.some((h) => h.includes('a.md:2')))
    writeFileSync(join(dir, 'a.md'), '中性一行\n另一行中性\n', 'utf8')
    assert.deepEqual(scanDir(dir, p), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
