import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { inspectProfile, parseFileDep, readDep, countJs, versionOf } from '../tools/check-install.mjs'

// 2026-10-30（m02961）：房客那次「升级失败」的真因是 node_modules 里落了空副本——
// 插件自己这时候根本没跑，所以只能从外面查。这个脚本就是那把外面的尺子。

function tmp(prefix = 'fish-install-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

const normalize = (p) => String(p).replace(/\\/g, '/').toLowerCase()

function writePkg(dir, obj) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(obj, null, 2))
}

function fillJs(dir, n) {
  mkdirSync(join(dir, 'lib'), { recursive: true })
  for (let i = 0; i < n; i += 1) writeFileSync(join(dir, 'lib', `m${i}.js`), '// x\n')
}

test('依赖写法：只认 file:，link: 与 npm 版本号都不算副本', () => {
  // 返回的是 resolve 过的绝对路径，Windows 上是反斜杠，所以按「规范化后相等」比。
  assert.equal(normalize(parseFileDep('file:D:/DSH/plugins-src/dsh-fish', 'C:/p')), 'd:/dsh/plugins-src/dsh-fish')
  assert.equal(normalize(parseFileDep('file:../src/fish', 'C:/p/desktop')), 'c:/p/src/fish')
  assert.equal(parseFileDep('link:D:/x', 'C:/p'), '')
  assert.equal(parseFileDep('^0.8.1', 'C:/p'), '')
  assert.equal(parseFileDep(undefined, 'C:/p'), '')
})

test('readDep：坏 JSON 返回 null，没有这个包返回空串', () => {
  assert.equal(readDep('{oops'), null)
  assert.equal(readDep('{"dependencies":{"other":"1"}}'), '')
  assert.equal(readDep('{"devDependencies":{"dsh-fish":"file:D:/x"}}'), 'file:D:/x')
})

test('副本与源目录版本一致、文件数相当 → ok', () => {
  const root = tmp()
  const src = join(root, 'src')
  const profile = join(root, 'profiles', 'desktop')
  writePkg(src, { name: 'dsh-fish', version: '0.8.1' })
  fillJs(src, 10)
  writePkg(profile, { name: 'p', dependencies: { 'dsh-fish': `file:${src}` } })
  writePkg(join(profile, 'node_modules', 'dsh-fish'), { name: 'dsh-fish', version: '0.8.1' })
  fillJs(join(profile, 'node_modules', 'dsh-fish'), 10)

  const r = inspectProfile(profile)
  assert.equal(r.verdict, 'ok')
  assert.equal(r.copyVersion, '0.8.1')
  assert.equal(countJs(r.source), 10)
  assert.equal(versionOf(r.copy), '0.8.1')
})

test('node_modules 里只有个空目录 → empty-copy，并给出修法依据', () => {
  const root = tmp()
  const src = join(root, 'src')
  const profile = join(root, 'profiles', 'desktop')
  writePkg(src, { name: 'dsh-fish', version: '0.8.1' })
  fillJs(src, 10)
  writePkg(profile, { name: 'p', dependencies: { 'dsh-fish': `file:${src}` } })
  mkdirSync(join(profile, 'node_modules', 'dsh-fish'), { recursive: true })

  const r = inspectProfile(profile)
  assert.equal(r.verdict, 'empty-copy')
  assert.match(r.why, /空的|一半/)
  assert.equal(r.sourceVersion, '0.8.1')
})

test('副本只落了一半文件（版本号还在）→ 仍判 empty-copy', () => {
  const root = tmp()
  const src = join(root, 'src')
  const profile = join(root, 'profiles', 'desktop')
  writePkg(src, { name: 'dsh-fish', version: '0.8.1' })
  fillJs(src, 20)
  writePkg(profile, { name: 'p', dependencies: { 'dsh-fish': `file:${src}` } })
  writePkg(join(profile, 'node_modules', 'dsh-fish'), { name: 'dsh-fish', version: '0.8.1' })
  fillJs(join(profile, 'node_modules', 'dsh-fish'), 3)

  const r = inspectProfile(profile)
  assert.equal(r.verdict, 'empty-copy')
  assert.equal(r.copyJs, 3)
})

test('源目录换了新版、副本还是旧的 → stale-copy', () => {
  const root = tmp()
  const src = join(root, 'src')
  const profile = join(root, 'profiles', 'desktop')
  writePkg(src, { name: 'dsh-fish', version: '0.8.1' })
  fillJs(src, 10)
  writePkg(profile, { name: 'p', dependencies: { 'dsh-fish': `file:${src}` } })
  writePkg(join(profile, 'node_modules', 'dsh-fish'), { name: 'dsh-fish', version: '0.7.2' })
  fillJs(join(profile, 'node_modules', 'dsh-fish'), 10)

  const r = inspectProfile(profile)
  assert.equal(r.verdict, 'stale-copy')
  assert.match(r.why, /0\.7\.2/)
})

test('link: 安装不判坏（没有副本这回事）', () => {
  const root = tmp()
  const profile = join(root, 'profiles', 'desktop')
  writePkg(profile, { name: 'p', dependencies: { 'dsh-fish': 'link:D:/x' } })

  const r = inspectProfile(profile)
  assert.equal(r.verdict, 'no-dep')
  assert.match(r.why, /软链/)
})

test('profile 里没这个包 / 没有 package.json → 不炸', () => {
  const root = tmp()
  const p1 = join(root, 'a')
  writePkg(p1, { name: 'p', dependencies: {} })
  assert.equal(inspectProfile(p1).verdict, 'no-dep')

  const p2 = join(root, 'b')
  mkdirSync(p2, { recursive: true })
  assert.equal(inspectProfile(p2).verdict, 'no-profile')
})
