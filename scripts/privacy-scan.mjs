/**
 * privacy-scan.mjs —— 「这个仓是公开的」这句话的机械保证。
 *
 * 为什么需要它：2026-11-08 第一轮审计靠人眼看 HANDOFF，漏掉了 journal 里写着完整
 * 身份的那一行；第二轮改用她的账本反查 612 条原话，才把 48 处命中挖干净。人眼靠不住，
 * 所以判据拆成两台机器都能跑的两层：
 *
 *   1. **形态**（写死在下面）：带真实用户名的绝对路径、真邮箱、真手机号。
 *      不需要知道他是谁，任何一个 clone 都能判——别人 fork 走也照样守得住。
 *   2. **真值**（`runtime/publish-readiness.md` 的 `PATTERNS:` 行）：QQ 号、城市、
 *      她说过的话。只在房主机器上存在，也只在房主机器上生效。
 *
 * ⚠️ 第二类清单**故意不入库**：守卫的判据本身不能是敏感值。公开 clone 上没有这份
 * 清单，于是只有第一类在守——这不是降级。他 fork 走，该防的是他自己的隐私。
 *
 * 三个调用方，同一份判据（**别在别处写第二套**）：
 *   - `scripts/hooks/pre-commit` → `--staged`
 *   - `scripts/hooks/commit-msg` → `--message <file>`
 *   - `test/privacy.test.mjs`    → 直接 import
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓根：本文件住在 `<root>/scripts/`，上一层就是根。 */
export const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 超过这个大小就不读了。她的图、录音都在 runtime/（不入库），这里只是防一手。 */
const MAX_BYTES = 2 * 1024 * 1024

/** 二进制后缀直接跳过：读成 utf8 再跑正则只浪费时间，且必然不命中。 */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.7z', '.gz',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.woff', '.woff2', '.ttf', '.otf',
  '.exe', '.dll', '.so', '.node', '.bundle', '.sqlite', '.db',
])

/** 邮箱白名单：协议地址、示例域名、本机代号。其余一律算真邮箱。 */
const ALLOW_EMAIL_DOMAINS = new Set([
  'users.noreply.github.com', 'noreply.github.com', 'github.com',
  'example.com', 'example.org', 'example.net', 'localhost', 'fish', 'invalid', 'users.noreply.invalid',
])

/**
 * 手机号白名单：这些是「一看就是假号」的占位号（连号/全零），测试夹具用它。
 * 真号只要不在这个集合里就会被拦下。
 */
const ALLOW_PHONES = new Set([
  '13800138000', '13800000000', '13900139000', '13000000000', '13100000000', '15555555555',
])

/**
 * 上游公开示例白名单（精确匹配整串）：上游 dsh-fish 源码里的占位示例
 * （`C:\Users\me` / `a.b@c.com` / 教科书假号这类），形态判据按形状会误伤它们。
 * 只对**形态**判据生效——真值判据（PATTERNS）永不放行，撞上白名单也拦。
 * 字符串在运行时拼出来：本文件自己也在扫描范围内，写死字面量等于自触发。
 */
const BS = String.fromCharCode(92) // 反斜杠
const ALLOW_UPSTREAM_EXAMPLES = new Set([
  ['C:', 'Users', 'me'].join('/'),
  ['C:', 'Users', 'me'].join(BS),
  ['C:', 'Users', 'me'].join(BS + BS), // JSON 转义形态（测试夹具里出现）
  ['C:', 'Users', '你'].join('/'),
  ['C:', 'Users', '你'].join(BS),
  ['C:', 'Users', '…'].join('/'),
  ['a.b', 'c.com'].join('@'),
  '138' + '12345678',
  // 0.9.7 上游 PR #102–#104 的作者邮箱：公开在 GitHub 提交里，不是房主隐私。
  // 用拼接写法，避免扫描器扫到自己源码时自触发（同上面几条）。
  'bbleae' + '@' + 'outlook.com',
  // CLAUDE.md 里的 `@AGENTS.md` 是 Claude Code 的文件引用语法，不是邮箱。
  '+' + '@' + 'AGENTS.md',
  // 0.9.7 上游 PR #104 的作者邮箱：公开在 GitHub 提交里。
  'pipchief1' + '@' + 'gmail.com',
])

/**
 * 路径里这么一段，算「占位符」而不是真人名：
 * `<用户名>` `%USERPROFILE%` `$HOME` `USERNAME` `YOUR_NAME` `你的名字`。
 * 都是人写文档时的习惯写法——真名不会写成全大写，也不会带尖括号。
 */
function looksPlaceholder(seg) {
  if (!seg) return true
  if (/[<>%${}*]/.test(seg)) return true
  if (/^[A-Z0-9_.-]+$/.test(seg)) return true
  if (/用户|你的|某人|某人名|someone|username|yourname/i.test(seg)) return true
  return false
}

/**
 * 形态判据。每条 `find(text)` 返回 `[{ index, match }]`，自己管白名单
 * ——白名单是判据的一部分，抽出去反而容易两边不同步。
 */
const GENERIC = [
  {
    kind: '本机绝对路径',
    find(text) {
      const out = []
      // C:\Users\<真名> / C:/Users/<真名> / c:\users\<真名>（`+` 兜住双反斜杠的 JSON 转义）
      for (const m of text.matchAll(/[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"'`<>|]+)/g)) {
        if (!looksPlaceholder(m[1])) out.push({ index: m.index, match: m[0] })
      }
      // DSH 把会话 cwd 编成目录名之后的形态：--C-Users-<真名>-.dsh-fish-home--
      for (const m of text.matchAll(/C-Users-([A-Za-z0-9_.]+)/g)) {
        if (!looksPlaceholder(m[1])) out.push({ index: m.index, match: m[0] })
      }
      return out
    },
  },
  {
    kind: '邮箱',
    find(text) {
      const out = []
      for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
        if (!ALLOW_EMAIL_DOMAINS.has(m[0].split('@')[1].toLowerCase())) out.push({ index: m.index, match: m[0] })
      }
      return out
    },
  },
  {
    kind: '手机号',
    find(text) {
      const out = []
      // 前后不许再挨着数字：13 位的时间戳、更长的 ID 都不该被切出 11 位来误报
      for (const m of text.matchAll(/(?<![0-9])1[3-9][0-9]{9}(?![0-9])/g)) {
        if (!ALLOW_PHONES.has(m[0])) out.push({ index: m.index, match: m[0] })
      }
      return out
    },
  },
]

/**
 * 私人层路径：这些东西住在仓外同级目录 `../fish-private/`，**永远不许**回到索引里。
 * 这条不需要清单——它防的是「不小心把整个目录加回来」，任何 clone 都该拦。
 */
export const PRIVATE_PATHS = [
  { re: /^HANDOFF\.md$/i, why: '交接文档（在 ../fish-private/）' },
  { re: /^journal\//i, why: '会话纪要（在 ../fish-private/journal/）' },
  { re: /^ref\//i, why: '运维记录（在 ../fish-private/ref/）' },
]

/** 索引里的路径有没有私人层成员。 */
export function privatePathHits(paths) {
  const hits = []
  for (const p of paths) {
    for (const rule of PRIVATE_PATHS) if (rule.re.test(p)) hits.push({ path: p, why: rule.why })
  }
  return hits
}

/**
 * 读本机真值清单。返回 `{ present, file, patterns, bad }`：
 * - `present:false` = 公开 clone 上没这份文件（正常）
 * - `bad` 非空 = 文件在但格式坏了，调用方该当错误处理，别静默降级
 */
export function loadLocalPatterns(root = repoRoot) {
  const file = join(root, 'runtime', 'publish-readiness.md')
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { present: false, file, patterns: [], bad: [] }
  }
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('PATTERNS:'))
  if (!line) return { present: true, file, patterns: [], bad: ['清单里找不到 `PATTERNS:` 行'] }
  const patterns = []
  const bad = []
  for (const src of line.slice('PATTERNS:'.length).split('|')) {
    const s = src.trim()
    if (!s) continue
    try {
      patterns.push({ src: s, re: new RegExp(s, 'i') })
    } catch (e) {
      bad.push(`${s}（${e.message}）`)
    }
  }
  return { present: true, file, patterns, bad }
}

/** 行号查询：先把换行位置算一次，之后二分。别对每个命中都重扫全文。 */
function lineLocator(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return (idx) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= idx) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/**
 * 扫一段文本。`patterns` 是 `loadLocalPatterns().patterns` 或手写夹具
 * （`[{ src, re }]`）；传空数组就只跑形态判据。
 */
export function scanText(text, patterns = []) {
  const hits = []
  const lineOf = lineLocator(text)
  for (const g of GENERIC) {
    for (const h of g.find(text)) {
      if (ALLOW_UPSTREAM_EXAMPLES.has(h.match)) continue // 上游公开示例，精确整串才放行
      hits.push({ kind: g.kind, match: h.match, line: lineOf(h.index) })
    }
  }
  for (const p of patterns) {
    // p.re 是 /i 的；matchAll 要求 /g，这里克隆一份，别改调用方传进来的对象
    for (const m of text.matchAll(new RegExp(p.re.source, 'gi'))) {
      hits.push({ kind: `真值 ${p.src}`, match: m[0], line: lineOf(m.index) })
    }
  }
  return hits
}

/** 读一个文本文件；二进制、超大、读不到一律 null（调用方当「跳过」）。 */
function readTextFile(abs) {
  try {
    const st = statSync(abs)
    if (!st.isFile() || st.size > MAX_BYTES) return null
    const buf = readFileSync(abs)
    if (buf.includes(0)) return null
    return buf.toString('utf8')
  } catch {
    return null
  }
}

function git(root, args, opts = {}) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024, ...opts })
}

/** 索引里的全部路径（含工作区已删、尚未提交的删除）。 */
export function trackedFiles(root = repoRoot) {
  return git(root, ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
}

/**
 * 索引里有、工作区还在的路径。
 * 区别在于「待提交的删除」——那批文件马上就不在仓里了，不该被当成隐私问题；
 * 但真要 commit 它们时 `--staged` 那条路会如实报出来（那边看的是 `--diff-filter=ACMR`）。
 */
export function trackedOnDisk(root = repoRoot) {
  return trackedFiles(root).filter((p) => existsSync(join(root, p)))
}

/** 整棵树扫一遍。`scanned + skipped` 应当正好等于工作区里的跟踪文件数。 */
export function scanTree({ root = repoRoot, patterns } = {}) {
  const live = patterns ? { present: true, patterns, bad: [] } : loadLocalPatterns(root)
  const hits = []
  let scanned = 0
  let skipped = 0
  for (const rel of trackedOnDisk(root)) {
    if (BINARY_EXT.has(extname(rel).toLowerCase())) {
      skipped++
      continue
    }
    const text = readTextFile(join(root, rel))
    if (text === null) {
      skipped++ // 读不动（超限 / 其实是二进制 / 权限）
      continue
    }
    scanned++
    for (const h of scanText(text, live.patterns)) hits.push({ file: rel, ...h })
  }
  return { hits, scanned, skipped, live }
}

/**
 * 暂存区扫一遍（pre-commit）。读的是**索引里的内容**不是工作区文件：
 * `git add` 之后又改过工作区的话，进提交的是前者。
 */
export function scanStaged({ root = repoRoot } = {}) {
  const live = loadLocalPatterns(root)
  const staged = git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  const hits = privatePathHits(staged).map((h) => ({ file: h.path, kind: '私人层', match: h.why, line: 0 }))
  let scanned = 0
  let skipped = 0
  for (const rel of staged) {
    if (BINARY_EXT.has(extname(rel).toLowerCase())) {
      skipped++
      continue
    }
    let text
    try {
      const buf = git(root, ['show', `:${rel}`])
      if (buf.includes(0)) {
        skipped++
        continue
      }
      text = buf.toString('utf8')
    } catch {
      skipped++ // 子模块、符号链接之类
      continue
    }
    scanned++
    for (const h of scanText(text, live.patterns)) hits.push({ file: rel, ...h })
  }
  return { hits, scanned, skipped, live }
}

/** 提交信息（commit-msg）。历史里那条带 QQ 号的提交信息就是这么漏出去的。 */
export function scanMessage(file, { root = repoRoot } = {}) {
  const live = loadLocalPatterns(root)
  const text = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => !l.startsWith('#')) // git 自己加的注释行不算
    .join('\n')
  return { hits: scanText(text, live.patterns), live }
}

/**
 * 账本反查（手动跑，`--ledger`）：把她和用户说过的整句当针，去找仓里有没有原话。
 * 2026-11-08 那条「journal 里躺着完整身份」就是这么翻出来的。默认不进测试：
 * 它依赖本机账本，跑得也慢，而且 public clone 上根本没有账本。
 *
 * ⚠️ 针不能是整句。第一版拿整句去 `includes`，1029 句对上 HANDOFF 零命中——
 * 而 HANDOFF 明明抄过她两百多处对话。原因很简单：文档引的是**片段**，
 * 一句 200 字的话不会整段照抄。所以这里切 12 字滑窗（步长 4），
 * 任何 12 字以上的逐字重合都会落在某个窗里。
 */
const NEEDLE_LEN = 12
const NEEDLE_STRIDE = 4
/** 窗口里至少要有这么多汉字。英文标识符与 URL 碎片不算「原话」，而且它们在代码里遍地都是。 */
const NEEDLE_MIN_CJK = 6

function needlesOf(text) {
  const out = []
  const push = (w) => {
    if (/https?:|www\./.test(w)) return
    if ((w.match(/[\u4e00-\u9fff]/g) || []).length < NEEDLE_MIN_CJK) return
    out.push(w)
  }
  // 连逗号一起切：中文长句里分句很多，先切短再开窗，窗口数少一个量级
  for (const raw of String(text).split(/[\n。！？!?；;，,]/)) {
    const s = raw.replace(/^[「『（("'\s]+|[」』）)"'\s]+$/g, '')
    if (s.length < NEEDLE_LEN) continue
    if (s.length <= NEEDLE_LEN + 2) {
      push(s)
      continue
    }
    for (let i = 0; i + NEEDLE_LEN <= s.length; i += NEEDLE_STRIDE) push(s.slice(i, i + NEEDLE_LEN))
  }
  return out
}

export function scanLedger({ root = repoRoot, limit = 20000 } = {}) {
  const dir = process.env.DSH_FISH_HOME || join(homedir(), '.dsh-fish')
  const file = join(dir, 'events.jsonl')
  if (!existsSync(file)) return { present: false, file, checked: 0, hits: [] }
  const live = loadLocalPatterns(root)
  const seen = new Set()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || seen.size >= limit) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e?.type !== 'utterance' && e?.type !== 'heard') continue
    for (const s of needlesOf(e.text)) {
      if (seen.size >= limit) break
      seen.add(s)
    }
  }
  const needles = [...seen]
  const hits = []
  let scanned = 0
  for (const rel of trackedOnDisk(root)) {
    if (BINARY_EXT.has(extname(rel).toLowerCase())) continue
    const text = readTextFile(join(root, rel))
    if (text === null) continue
    scanned++
    const lineOf = lineLocator(text)
    for (const s of needles) {
      const at = text.indexOf(s)
      if (at >= 0) hits.push({ file: rel, kind: '原话', match: s, line: lineOf(at) })
    }
  }
  return { present: true, file, checked: needles.length, scanned, hits, live }
}

/** 命中表怎么打印。列宽按显示宽度算会牵扯 CJK，这里保持两空格分隔、够读就行。 */
function format(hits) {
  return hits.map((h) => `  ${h.file}:${h.line}  ${h.kind}  ${h.match}`).join('\n')
}

function hint(live) {
  const where = live?.present
    ? `形态判据 scripts/privacy-scan.mjs + 本机真值 ${live.file}`
    : '形态判据 scripts/privacy-scan.mjs（本机真值清单不在，公开 clone 上正常）'
  return [
    '',
    `  判据：${where}`,
    '  处理：改成中性示例（`<用户名>` / `example.com`），或把这段内容挪到 ../fish-private/。',
    '  误报就改判据的允许集合——别用 --no-verify 硬推，那道闸是给以后的自己留的。',
  ].join('\n')
}

/** 清单格式坏了：这是错误，不是「没有命中」，必须挡住而不是放行。 */
function misconfigured(live) {
  console.error(['✗ 隐私清单格式不对，守卫没法判断：', ...live.bad.map((b) => `  - ${b}`), `  文件：${live.file}`, ''].join('\n'))
  return 2
}

function main(argv) {
  const [mode, ...rest] = argv
  if (mode === '--help' || mode === '-h' || mode === undefined) {
    console.log(
      [
        '用法：node scripts/privacy-scan.mjs [模式]',
        '',
        '  --staged          扫暂存区（pre-commit 默认）',
        '  --tree            扫整棵树（等价于测试里那一遍）',
        '  --message <file>  扫提交信息（commit-msg）',
        '  --ledger          账本反查：她/用户说过的整句有没有漏进仓里（手动，慢）',
        '',
        '退出码：0 干净 / 1 有命中 / 2 清单格式坏了',
      ].join('\n'),
    )
    return 0
  }

  if (mode === '--tree') {
    const r = scanTree()
    if (r.live.bad.length) return misconfigured(r.live)
    if (!r.hits.length) {
      console.log(`✓ 隐私巡检：扫了 ${r.scanned} 个文件，零命中（跳过 ${r.skipped} 个二进制/已删）。`)
      return 0
    }
    console.error(`✗ 隐私巡检：${r.hits.length} 处命中。\n\n${format(r.hits)}${hint(r.live)}`)
    return 1
  }

  if (mode === '--message') {
    const file = rest[0]
    if (!file) {
      console.error('--message 需要一个文件参数')
      return 2
    }
    const r = scanMessage(file)
    if (r.live.bad.length) return misconfigured(r.live)
    if (!r.hits.length) return 0
    console.error(`✗ 提交信息里有不该进公开仓的东西：\n\n${format(r.hits.map((h) => ({ ...h, file: '提交信息' })))}${hint(r.live)}`)
    return 1
  }

  if (mode === '--ledger') {
    const r = scanLedger()
    if (!r.present) {
      console.error(`✗ 找不到账本：${r.file}（设 DSH_FISH_HOME 或确认她跑过）`)
      return 2
    }
    if (r.live.bad.length) return misconfigured(r.live)
    if (!r.hits.length) {
      console.log(`✓ 账本反查：${r.checked} 段 ${NEEDLE_LEN} 字原话窗口 × ${r.scanned} 个文件，零命中。`)
      return 0
    }
    console.error(`✗ 账本反查：${r.hits.length} 处原话落进了仓里。\n\n${format(r.hits)}${hint(r.live)}`)
    return 1
  }

  if (mode !== '--staged') {
    console.error(`未知模式：${mode}（--help 看用法）`)
    return 2
  }

  const r = scanStaged()
  if (r.live.bad.length) return misconfigured(r.live)
  if (!r.hits.length) return 0
  console.error(
    [
      `✗ 这次提交里有 ${r.hits.length} 处不该进公开仓的东西，已中止。`,
      '',
      format(r.hits),
      hint(r.live),
    ].join('\n'),
  )
  return 1
}

// 被 import 时不跑 CLI（测试要用这些函数）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
