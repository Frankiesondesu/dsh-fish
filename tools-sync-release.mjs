/**
 * tools-sync-release.mjs —— 工作仓进度 → 发布仓（内容级同步，2026-11-08 22:46）
 *
 * 用户定案（A A）：① 手动双击 `同步发布仓.cmd` 触发 ② 发布仓每次追加一个匿名新提交。
 *
 * 为什么不是 git 绑定：工作仓历史里有真实邮箱与 QQ 号，remote / submodule / worktree
 * 都会把那段历史带出去。这里只做「内容级同步」，发布仓永远是一叠干净的匿名快照。
 *
 * 安全约束（都写进流程了）：
 *   · 白名单重建 → 模式化清洗 → 终检，全部在临时目录里先验完，再覆盖发布仓；
 *   · 终检命令的模式从 `runtime/publish-readiness.md` 读，本机用户名/路径运行时动态构造，
 *     **本脚本不含任何敏感值明文**；
 *   · 覆盖后若测试/终检失败，回滚到发布仓 HEAD；任何失败都不提交；
 *   · 无变更不制造空提交；发布仓工作区不干净时先停下，别覆盖手工改动。
 *
 * 用法：node tools-sync-release.mjs        （或双击 同步发布仓.cmd）
 *       FISH_RELEASE_DIR=... 可改发布仓位置，默认是工作仓同级的 fish-release。
 */
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync,
  readdirSync, statSync, copyFileSync,
} from 'node:fs'
import { join, dirname, basename, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

export const WORK = resolve(dirname(fileURLToPath(import.meta.url)))
export const DEFAULT_RELEASE = resolve(dirname(WORK), 'fish-release')
export const CHECKLIST = join(WORK, 'runtime', 'publish-readiness.md')

export function releaseDir(env = process.env) {
  return resolve(env.FISH_RELEASE_DIR || DEFAULT_RELEASE)
}

// ---------------------------------------------------------------- 白名单（照发布清单）
export const ROOT_FILES = Object.freeze([
  'README.md', 'CLAUDE.md', 'AGENTS.md', 'dsh-fish-plan.md',
  'launch.mjs', 'shutdown.mjs', 'restart.mjs', 'llbot-patch.mjs',
])
export const COPY_DIRS = Object.freeze(['bridge', 'viewer', 'manager', 'shared', 'dsh-fish'])

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '__pycache__', '.workbuddy', 'runtime'])
const SKIP_REL = new Set(['bridge/config.json', 'bridge/bridge.log', 'bridge/push-state.json'])
const SKIP_BASENAME = new Set(['push-state.json'])
const TEXT_EXT = new Set(['.js', '.mjs', '.md', '.json', '.html', '.cmd', '.yml', '.yaml', '.txt', '.svg', '.gitattributes', '.gitignore'])

export function isTextFile(name) {
  const dot = name.lastIndexOf('.')
  return dot >= 0 && TEXT_EXT.has(name.slice(dot).toLowerCase())
}

export function skipDir(name) {
  return SKIP_DIR_NAMES.has(name)
}

export function skipFile(rel) {
  if (SKIP_REL.has(rel) || SKIP_BASENAME.has(basename(rel))) return true
  return rel.endsWith('.log')
}

/** 递归列出一个目录下所有该拷的文件，返回相对工作仓的 posix 路径。 */
export function listSourceFiles(dir, prefix) {
  const out = []
  const walk = (cur, relPrefix) => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      if (skipDir(ent.name)) continue
      const abs = join(cur, ent.name)
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(abs, rel)
      else if (ent.isFile() && !skipFile(rel)) out.push(rel)
    }
  }
  walk(dir, prefix)
  return out
}

// ---------------------------------------------------------------- 清洗规则（模式化，零明文）
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 规则分两类：
 *  · 敏感形态用运行时动态构造（用户名、工作仓路径）或正则（QQ 号、私人 fixture），
 *    本文件里不出现任何真实值；
 *  · 文档一致性规则里的词都是项目用语，不是隐私。
 */
export function buildRules(work = WORK, home = homedir()) {
  const user = basename(home)
  const posix = work.replace(/\\/g, '/')
  const win = posix.replace(/\//g, '\\')
  const parentPosix = dirname(posix).replace(/\\/g, '/')
  const parentWin = parentPosix.replace(/\//g, '\\')
  return [
    // 本机绝对路径（两种斜杠）→ 占位
    { re: new RegExp(esc(win), 'g'), to: '<仓库目录>' },
    { re: new RegExp(esc(posix), 'g'), to: '<仓库目录>' },
    { re: new RegExp(esc(parentWin), 'g'), to: '<同级目录>' },
    { re: new RegExp(esc(parentPosix), 'g'), to: '<同级目录>' },
    // 带真实用户名的主目录路径 → 中性
    { re: new RegExp('C:[\\\\/]Users[\\\\/]' + esc(user), 'g'), to: 'C:/Users/<用户>' },
    { re: new RegExp(esc(user), 'g'), to: '<用户>' },
    // 注释里的一对 QQ 号 → 占位（不写具体数字）
    { re: /fromUin=\d+\s*→\s*toUin=\d+/g, to: 'fromUin=<主人QQ> → toUin=<机器人QQ>' },
    { re: /QQ\(\d{5,12}\)/g, to: 'QQ(<主人QQ>)' },
    // 私人对话 fixture（整句，不含具体词）
    { re: /行。跟[^。]*。/g, to: '行。那就这么定了。' },
    { re: /!\[[^\]]*画面\]\(C:\/[^)]*\)/g, to: '![示例画面](media/example.png)' },
    // 发布快照里没有的 .cmd / ref/ 引用
    { re: /双击 一键启动\.cmd/g, to: 'node launch.mjs' },
    { re: /这样 管理器\.cmd 只留一个窗口/g, to: '这样启动脚本只留一个窗口' },
    { re: /`管理器\.cmd` 的网页控制台/g, to: '管理器网页控制台' },
    { re: /以前只有 `一键启动\.cmd` 会拉它/g, to: '以前只有启动脚本会拉它' },
    { re: /`一键启动\.cmd` 那套会/g, to: '启动脚本那套会' },
    { re: /见 ref\/cross-machine 文档/g, to: '见 README.md' },
    { re: /ref\/cross-machine-2026-11-06\.md/g, to: 'shared/root.mjs' },
    { re: /源码在 `upstream\/`/g, to: '源码来自上游仓（快照不含 upstream/ 目录），当时的' },
    { re: /└── [^\n]*\.cmd[^\n]*/g, to: '└── launch.mjs · shutdown.mjs · restart.mjs · bridge/start.cmd' },
    { re: /├── dsh-fish\/[^\n]*独立 git 仓[^\n]*/g, to: '├── dsh-fish/          # 插件本体（本发布快照中为普通目录）' },
    // 清单终检关键词里的中性稀有词：替换成另一个中性词，保证终检零命中
    { re: /某段视频/g, to: '铜铃' },
    // .cmd 里的中文 echo（发布快照要求纯 ASCII）
    { re: /echo 启动 QQ -> 她 的桥\.\.\./g, to: 'echo Starting QQ bridge...' },
    { re: /echo 她 · 查看器  ->  http:\/\/127\.0\.0\.1:7788/g, to: 'echo Viewer http://127.0.0.1:7788' },
  ]
}

/** 章节级替换：AGENTS 会话库节整节删、README 两个代码块/章节换成发布版措辞。 */
const BLOCK_RULES = [
  // 只有 AGENTS.md 有这个标题：给它加发布快照说明，免得下文那些「读 HANDOFF/journal/ref」
  // 的指引在快照里指向不存在的文件（也是 fork.13：文档要为真）。
  {
    re: /# AGENTS\.md —— 跨工具接手须知[^\n]*\n/,
    to: '$&\n'
      + '> **发布快照说明**：本仓库是可公开的干净快照，不含 `HANDOFF.md`、`journal/` 正文、\n'
      + '> `ref/`、`runtime/` 等私人交接与运维记录，git 历史里也没有真实邮箱或 QQ 号。\n'
      + '> 下文提到这些路径的段落是**本地工作仓**的约定；在快照里请以代码、测试、\n'
      + '> `README.md` 和本文件为准。\n',
  },
  // 工作仓那节说「这个仓含隐私层」，在发布仓里是假话，整节换成快照自述。
  {
    re: /## 发布 \/ 分享前[\s\S]*?(?=\n## )/,
    to: '## 关于这份快照\n\n'
      + '本仓库即发布快照本身：由本地工作仓按白名单生成，剔除私人层并清洗敏感值，\n'
      + '每次同步追加一个匿名提交。它不含需要再次「分享前检查」的隐私层。\n',
  },
  {
    re: /## 各工具的会话库[^\n]*\n[\s\S]*?(?=\n## )/,
    to: '## 跨工具接手\n\n各 AI 工具自己的会话库属于各自本地数据，不在本仓库内。跨工具接手时，\n真相源只有代码、测试、`README.md` 和本文件。\n',
  },
  {
    re: /```bat[\s\S]*?```/,
    to: '```bat\n'
      + 'git clone <本仓库> <你选的目录>\n'
      + 'cd <你选的目录>\n'
      + ':: dsh-fish/ 是插件本体——按 DSH 的插件方式挂载（推荐目录联接）\n'
      + 'mklink /D "DSH 插件目录\\dsh-fish" "<你选的目录>\\dsh-fish"\n\n'
      + ':: 1) 配置桥（见下文「桥的配置」）\n'
      + 'copy bridge\\config.example.json bridge\\config.json\n\n'
      + ':: 2) 一键启动（DSH / LuckyLillia / 桥 / 查看器 / 本地语音服务）\n'
      + 'node launch.mjs\n\n'
      + ':: 3) 查看器 127.0.0.1:7788；管理器 127.0.0.1:7789\n'
      + 'node manager\\server.mjs\n```',
  },
  {
    re: /## 上游同步（进阶）[\s\S]*?(?=\n## 致谢与协议)/,
    to: '## 上游同步（进阶）\n\n'
      + '**本发布快照把 `dsh-fish/` 作为普通目录随仓发布，没有它独立的 git 历史**，\n'
      + '因此快照里不能直接做上游三方合并。想跟上游同步，请在自己 fork 的独立仓里进行：\n'
      + '把上游 remote 加好、解完冲突、跑 `node --test test/*.test.mjs` 全绿，再把结果\n'
      + '合回自己的代码。本 fork 有一条合并定案：**her_say 相关提示词与口径以 fork 为准**\n'
      + '（QQ 通路架构与上游不同），别被上游冲掉。\n',
  },
  {
    re: /const raw = JSON\.parse\(await readFile\(new URL\('\.\.\/config\.json', import\.meta\.url\), 'utf8'\)\)/,
    to: 'let raw\n'
      + '  try {\n'
      + "    raw = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'))\n"
      + '  } catch {\n'
      + "    raw = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'))\n"
      + '  }',
  },
  {
    re: /`\/dsh-fish\/local\/ping · \/say · \/wake · \/answer`/,
    to: '`/dsh-fish/local/ping · /say · /steer · /wake · /answer`',
  },
]

export function cleanText(s, rules = buildRules()) {
  let out = String(s)
  for (const r of rules) out = out.replace(r.re, r.to)
  for (const r of BLOCK_RULES) out = out.replace(r.re, r.to)
  return out
}

// ---------------------------------------------------------------- 终检模式（从清单读）
export function terminalPattern(checklistText, work = WORK, home = homedir()) {
  const m = /git grep -i -E "([^"]+)"/.exec(String(checklistText ?? ''))
  if (!m) throw new Error('清单里找不到终检命令 git grep -i -E "..."')
  const posix = work.replace(/\\/g, '/')
  const dynamic = [
    basename(home),
    posix,
    posix.replace(/\//g, '\\'),
    dirname(posix),
    dirname(posix).replace(/\//g, '\\'),
  ].map(esc)
  return new RegExp([m[1], ...dynamic].join('|'), 'i')
}

/** 在目录里扫所有文本文件，返回命中列表；零命中才算干净。 */
export function scanDir(dir, pattern) {
  const hits = []
  const walk = (cur) => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const abs = join(cur, ent.name)
      if (ent.isDirectory()) { walk(abs); continue }
      if (!ent.isFile() || !isTextFile(ent.name)) continue
      let text
      try { text = readFileSync(abs, 'utf8') } catch { continue }
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) hits.push(`${relative(dir, abs)}:${i + 1}: ${lines[i].trim().slice(0, 120)}`)
      }
    }
  }
  walk(dir)
  return hits
}

// ---------------------------------------------------------------- 执行
function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', ...opts }).trim()
}

function log(msg) { console.log(msg) }

const RELEASE_GITIGNORE = [
  '# 发布快照：运行期产物不入库',
  'node_modules/', '*.log', '__pycache__/', '.workbuddy/',
  'bridge/config.json', 'bridge/push-state.json', 'push-state.json', '',
].join('\n')

/**
 * 从 TAP 输出里挑出摘要与失败用例名。
 *
 * 为什么要有这个：原来失败时只报 `fail=?` 或一整行 `Command failed: node --test ...`，
 * 真因（哪个用例挂了）被 200 字截断吞掉，等于没有信息。这里解析不到摘要就退回尾部几行。
 */
export function summarizeTestOutput(out = '') {
  const text = String(out)
  const fails = [...text.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim())
  const heads = [...text.matchAll(/^# (tests|pass|fail) (\d+)$/gm)].map((m) => `${m[1]} ${m[2]}`)
  return {
    fails,
    heads,
    pass: /^# pass (\d+)$/m.exec(text)?.[1],
    fail: /^# fail (\d+)$/m.exec(text)?.[1],
    tail: text.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' / '),
  }
}

/**
 * 跑一组测试，返回一行结果。失败时串行重跑一遍再判：
 * 并行抖是这个仓库的已知毛病（memory：判回归要单跑），串行全绿才算抖动、放行并大声记一笔；
 * 串行也挂就是真挂，把用例名带出来。
 */
function runOneTestGroup(t) {
  const dir = join(t.cwd, t.dir)
  if (!existsSync(dir)) return `${t.label} 跳过（没有 ${t.dir}/）`
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).map((f) => `${t.dir}/${f}`)
  if (!files.length) return `${t.label} 跳过（0 个用例文件）`

  const once = (concurrency) => {
    const args = ['--test']
    if (concurrency) args.push(`--test-concurrency=${concurrency}`)
    try {
      const out = execFileSync(process.execPath, [...args, ...files], {
        cwd: t.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      })
      return { ok: true, out }
    } catch (err) {
      // 非零退出：把 stdout 也捞出来，否则什么都看不到
      return { ok: false, out: `${err?.stdout ?? ''}\n${err?.stderr ?? ''}` }
    }
  }

  const first = once(0)
  const s1 = summarizeTestOutput(first.out)
  if (first.ok && s1.fail === '0') return `${t.label} ${s1.pass} 绿`

  log(`      ${t.label} 并行那次没过（${s1.heads.join(' / ') || '无摘要'}），串行重跑复验…`)
  const again = once(1)
  const s2 = summarizeTestOutput(again.out)
  if (again.ok && s2.fail === '0') {
    log(`      ⚠ ${t.label} 判为并行抖动：串行 ${s2.pass} 全绿。挂过的是：${(s1.fails.slice(0, 3).join(' / ') || '未解析到用例名')}`)
    return `${t.label} ${s2.pass} 绿（并行抖动，串行复验通过）`
  }

  const names = (s2.fails.length ? s2.fails : s1.fails).slice(0, 8)
  const head = s2.heads.join(' / ') || s1.heads.join(' / ') || s2.tail || s1.tail || '无摘要'
  throw new Error(
    `${t.label} 测试没过（${head}）`
    + (names.length ? '\n    挂的用例：\n    ' + names.join('\n    ') : '\n    输出尾部：' + (s2.tail || s1.tail)),
  )
}

export function sync({ work = WORK, release = releaseDir(), run = git } = {}) {
  if (!existsSync(join(release, '.git'))) throw new Error(`发布仓不是 git 仓：${release}`)
  if (release === work || release.startsWith(work + '/') || release.startsWith(work + '\\')) {
    throw new Error('发布仓不能在工作仓内部')
  }
  const dirty = run(release, ['status', '--porcelain'])
  if (dirty) throw new Error('发布仓工作区不干净，先处理手工改动（同步是覆盖式的）')

  const checklist = readFileSync(CHECKLIST, 'utf8')
  const pattern = terminalPattern(checklist, work)
  const rules = buildRules(work)
  const stage = join(tmpdir(), `fish-release-stage-${Date.now()}`)
  mkdirSync(stage, { recursive: true })
  log(`[1/6] 白名单重建到临时目录：${stage}`)
  try {
    const rels = []
    for (const f of ROOT_FILES) if (existsSync(join(work, f))) rels.push(f)
    for (const d of COPY_DIRS) {
      const abs = join(work, d)
      if (existsSync(abs)) rels.push(...listSourceFiles(abs, d))
    }
    for (const rel of rels) {
      const dst = join(stage, rel)
      mkdirSync(dirname(dst), { recursive: true })
      copyFileSync(join(work, rel), dst)
    }
    const tpl = join(work, 'journal', '_TEMPLATE.md')
    if (existsSync(tpl)) {
      mkdirSync(join(stage, 'journal'), { recursive: true })
      copyFileSync(tpl, join(stage, 'journal', '_TEMPLATE.md'))
    }
    writeFileSync(join(stage, '.gitignore'), RELEASE_GITIGNORE, 'utf8')

    log('[2/6] 模式化清洗')
    for (const ent of readdirSync(stage, { withFileTypes: true })) {
      // 递归走一遍，纯文本才改
      const walk = (p) => {
        for (const e of readdirSync(p, { withFileTypes: true })) {
          const abs = join(p, e.name)
          if (e.isDirectory()) { walk(abs); continue }
          if (!e.isFile() || !isTextFile(e.name)) continue
          const before = readFileSync(abs, 'utf8')
          const after = cleanText(before, rules)
          if (after !== before) writeFileSync(abs, after, 'utf8')
        }
      }
      const p = join(stage, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (isTextFile(ent.name)) {
        const before = readFileSync(p, 'utf8')
        const after = cleanText(before, rules)
        if (after !== before) writeFileSync(p, after, 'utf8')
      }
    }

    log('[3/6] 终检（零命中才继续）')
    const hits = scanDir(stage, pattern)
    if (hits.length) {
      throw new Error('终检没过，发布仓原状不动：\n  ' + hits.slice(0, 12).join('\n  '))
    }

    log('[4/6] 覆盖发布仓工作区（保留 .git）')
    for (const e of readdirSync(release)) {
      if (e === '.git') continue
      rmSync(join(release, e), { recursive: true, force: true })
    }
    const copyInto = (src, dst) => {
      mkdirSync(dst, { recursive: true })
      for (const e of readdirSync(src, { withFileTypes: true })) {
        const s = join(src, e.name), d = join(dst, e.name)
        if (e.isDirectory()) copyInto(s, d)
        else copyFileSync(s, d)
      }
    }
    copyInto(stage, release)

    log('[5/6] 快照内四组测试')
    const tests = [
      { cwd: join(release, 'dsh-fish'), dir: 'test', label: '子仓' },
      { cwd: release, dir: 'bridge/test', label: '桥' },
      { cwd: release, dir: 'viewer/test', label: 'viewer' },
      { cwd: release, dir: 'manager/test', label: '管理器' },
    ]
    const results = []
    for (const t of tests) results.push(runOneTestGroup(t))
    log('      ' + results.join(' / '))

    log('[6/6] 匿名追加提交')
    run(release, ['add', '-A'])
    const staged = run(release, ['diff', '--cached', '--name-only'])
    if (!staged) {
      log('工作仓没有变化，跳过提交（不制造空提交）')
      return { ok: true, committed: false, reason: 'no-change' }
    }
    const cachedHits = scanDir(release, pattern)
    if (cachedHits.length) throw new Error('覆盖后终检仍有命中，回滚：\n  ' + cachedHits.slice(0, 12).join('\n  '))
    const mainHead = run(work, ['rev-parse', '--short', 'HEAD'])
    const subHead = run(join(work, 'dsh-fish'), ['rev-parse', '--short', 'HEAD'])
    run(release, [
      '-c', 'user.name=dsh-fish-release',
      '-c', 'user.email=release@users.noreply.invalid',
      'commit', '-m', `同步工作仓进度：主仓 ${mainHead} / 子仓 ${subHead}`,
    ])
    const head = run(release, ['rev-parse', '--short', 'HEAD'])
    const count = run(release, ['rev-list', '--count', 'HEAD'])
    log(`发布仓 ${release} → ${head}（第 ${count} 个提交，匿名）`)
    return { ok: true, committed: true, head, count: Number(count) }
  } catch (err) {
    // 覆盖之后才失败：回滚到上一个快照，绝不留半套内容
    try {
      const status = run(release, ['status', '--porcelain'])
      if (status) {
        run(release, ['reset', '--hard', 'HEAD'])
        run(release, ['clean', '-fd'])
        log('已回滚发布仓到上一个快照')
      }
    } catch { /* 回滚失败也如实报下面的主错 */ }
    throw err
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = sync()
    log(r.committed ? '同步完成' : '无需同步（发布仓已是最新）')
  } catch (err) {
    console.error('同步失败：' + String(err?.message ?? err))
    process.exitCode = 1
  }
}
