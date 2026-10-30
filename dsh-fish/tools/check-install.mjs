#!/usr/bin/env node
// 安装自查：插件没跑起来的时候用这个。
//
// 为什么需要它：DSH 加载的是 node_modules 里那份**副本**，不是 profile 里写的那条源目录；
// 而 pnpm 装到一半失败时，副本可能是个空目录。插件自己这时候根本没被执行，
// 所以它「自检」看不见自己没装进来——只能从外面查。
//
// 用法（零依赖，node 18+ 就能跑，不需要插件已加载）：
//   node check-install.mjs
//   node check-install.mjs --home D:/DSH --profile desktop
//
// 退出码：0 = 看着没问题；1 = 查到不对劲；2 = 参数/环境问题。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const PKG_NAME = 'dsh-fish'
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies']

/** `file:D:/x` / `file:/d/x` / `file:../../x` → 绝对路径；`link:` 和其它协议返回 ''。 */
export function parseFileDep(spec, profileDir) {
  if (typeof spec !== 'string') return ''
  const m = /^file:(.+)$/.exec(spec.trim())
  if (!m) return ''
  const raw = m[1].trim()
  if (!raw) return ''
  return resolve(profileDir, raw)
}

/** 从 package.json 文本里取 dsh-fish 的依赖写法；坏 JSON 返回 null。 */
export function readDep(text) {
  let pkg
  try {
    pkg = JSON.parse(text)
  } catch {
    return null
  }
  for (const f of DEP_FIELDS) {
    const v = pkg?.[f]?.[PKG_NAME]
    if (typeof v === 'string') return v
  }
  return ''
}

/** 读一个目录里 package.json 的版本号；读不到返回 ''。 */
export function versionOf(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))?.version ?? ''
  } catch {
    return ''
  }
}

/** 数一个目录里 .js 文件的个数（副本是空的 / 只落了一半，这个数字会明显偏低）。 */
export function countJs(dir) {
  let n = 0
  const walk = (d, depth) => {
    if (depth > 3) return
    let items = []
    try {
      items = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const it of items) {
      if (it.name === 'node_modules') continue
      if (it.isDirectory()) walk(join(d, it.name), depth + 1)
      else if (it.name.endsWith('.js') || it.name.endsWith('.mjs')) n += 1
    }
  }
  walk(dir, 0)
  return n
}

/**
 * 查一个 profile。
 * 返回 {profile, source, sourceVersion, copy, copyVersion, sourceJs, copyJs, verdict, why}
 * verdict: ok | empty-copy | stale-copy | no-dep | no-profile
 */
export function inspectProfile(profileDir) {
  const pkgFile = join(profileDir, 'package.json')
  const out = {
    profile: profileDir,
    source: '',
    sourceVersion: '',
    copy: join(profileDir, 'node_modules', PKG_NAME),
    copyVersion: '',
    sourceJs: 0,
    copyJs: 0,
    verdict: 'no-profile',
    why: '',
  }
  if (!existsSync(pkgFile)) {
    out.why = '这个 profile 里没有 package.json'
    return out
  }
  let text
  try {
    text = readFileSync(pkgFile, 'utf8')
  } catch (err) {
    out.why = `package.json 读不了：${err?.message ?? err}`
    return out
  }
  const dep = readDep(text)
  if (dep === null) {
    out.why = 'package.json 不是合法 JSON'
    return out
  }
  if (!dep) {
    out.verdict = 'no-dep'
    out.why = 'profile 的 dependencies 里没有 dsh-fish'
    return out
  }
  out.verdict = 'no-dep'
  out.why = `依赖写法是 ${dep}`
  if (dep.startsWith('link:')) {
    out.why = `依赖写法是 ${dep}（软链安装，没有副本，不需要比对）`
    return out
  }

  out.source = parseFileDep(dep, profileDir)
  if (!out.source) {
    out.why = `依赖写法是 ${dep}（不是 file:，没法定位源目录）`
    return out
  }
  out.sourceVersion = versionOf(out.source)
  out.copyVersion = versionOf(out.copy)
  out.sourceJs = countJs(out.source)
  out.copyJs = countJs(out.copy)

  if (!existsSync(out.copy)) {
    out.verdict = 'empty-copy'
    out.why = 'node_modules 里没有 dsh-fish：pnpm 根本没装成功'
  } else if (!out.copyVersion) {
    out.verdict = 'empty-copy'
    out.why = 'node_modules/dsh-fish 里没有能读的 package.json：副本是空的或只落了一半'
  } else if (out.copyJs < out.sourceJs * 0.8) {
    out.verdict = 'empty-copy'
    out.why = `副本只有 ${out.copyJs} 个 js 文件，源目录有 ${out.sourceJs} 个：装了一半`
  } else if (out.copyVersion !== out.sourceVersion) {
    out.verdict = 'stale-copy'
    out.why = `源目录是 ${out.sourceVersion || '?'}，跑的是 ${out.copyVersion}（副本没跟上）`
  } else {
    out.verdict = 'ok'
    out.why = `副本与源目录都是 ${out.copyVersion}（${out.copyJs} 个 js 文件）`
  }
  return out
}

/** 找出一个 DSH_HOME 下所有装过 dsh-fish 的 profile。 */
export function findProfiles(home = join(homedir(), '.dsh')) {
  const root = join(home, 'profiles')
  if (!existsSync(root)) return []
  const out = []
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    if (!existsSync(join(dir, 'package.json'))) continue
    const dep = readDep(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (dep) out.push(dir)
  }
  return out
}

const LABEL = {
  ok: '正常',
  'stale-copy': '装的是旧副本',
  'empty-copy': '副本空的/装了一半',
  'no-dep': '不是这套装法',
  'no-profile': '没找到 profile',
}

export function main(argv = process.argv.slice(2)) {
  const arg = (name, dflt = '') => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
  }
  const home = arg('home', join(homedir(), '.dsh'))
  const only = arg('profile', '').toLowerCase()
  let dirs = findProfiles(home)
  if (only) {
    dirs = dirs.filter((d) => d.split(/[\\/]/).pop().toLowerCase() === only)
    if (!dirs.length) {
      console.error(`在 ${home} 里没找到 profile「${only}」，或者它没装 dsh-fish`)
      return 2
    }
  }
  if (!dirs.length) {
    console.error(`在 ${home}\\profiles 里没找到任何装过 dsh-fish 的 profile`)
    return 2
  }

  let bad = 0
  for (const dir of dirs) {
    const r = inspectProfile(dir)
    const name = dir.split(/[\\/]/).pop()
    console.log(`\n[${name}] ${LABEL[r.verdict] ?? r.verdict}`)
    if (r.source) console.log(`  源目录  ${r.source}`)
    if (r.copy) console.log(`  实际跑  ${r.copy}`)
    console.log(`  说明    ${r.why}`)
    if (r.verdict === 'empty-copy' || r.verdict === 'stale-copy') {
      bad += 1
      console.log('  修法    关掉 DSH → 在 profile 目录里 pnpm install --force（或删掉 node_modules/dsh-fish）→ 再启动')
    }
  }
  console.log(bad ? '\n有问题：上面标出来的那几条按「修法」重装一次。' : '\n看着没问题。')
  return bad ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('check-install.mjs')) {
  process.exitCode = main()
}
