/**
 * vs-patch.mjs —— 给 dsh-video-storyboard 打两处补丁（2026-11-03）
 *
 * 为什么需要它：
 *   vs 是用户自己找来改的外挂，装在自己的 profile 里（不是我们的包），
 *   升级会整份覆盖 —— 手改的东西一升级就没了。跟 llbot 那次一样，
 *   做成幂等补丁，launch.mjs 每次启动兜一次。
 *
 * 补丁一：`ocr-subs.js` 的 changes 上限 5 → 64
 *   原来只回前 5 条「听写被字幕改过」的记录。我们想把她看到的台词里
 *   那些「按字幕改过」的行标出来（她的原话：「哪几句它拿不准，标出来」），
 *   5 条根本不够（一次最多抽 16 条做对照）。
 *
 * 补丁二：`pipeline.js` 的 OCR 校正条件放宽到 B 站 AI 字幕
 *   实测（2026-11-03，三条片子）：她看的片子几乎全是 `source=subtitle`、
 *   `model=site-cc:ai-zh` —— B 站自己生成的**机器字幕**，错字（大飞鱼/趣味方法）
 *   就是它带来的。而 vs 只在 `source==='asr'` 时才拿画面硬字幕去校正，
 *   于是这条路一次都没跑过，`res.ocr` 永远是 undefined。
 *   放宽之后：有硬字幕的片子能把这些错字改回来，并标「改自」。
 *   代价：多 3 秒字幕带检测 + 0.26 秒 × 最多 16 条；没硬字幕的片子 3 秒就退。
 *
 * 用法：
 *   node vs-patch.mjs          缺就补，有就跳过
 *   node vs-patch.mjs --check  只报告，不改文件
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-video-storyboard', 'src')

const MARK = 'fish 补丁 2026-11-03'

/** 补丁一：changes 上限 */
const P1 = {
  file: join(SRC, 'storyboard', 'ocr-subs.js'),
  needle: '      changes: applied.changes.slice(0, 5),',
  replace: `      // [${MARK}] 原来只给前 5 条，调用方想把「改过的行」标出来根本不够
      // （一次最多抽 16 条对照）。这里全给，上限仍留着防清单膨胀。
      changes: applied.changes.slice(0, 64),`,
}

/** 补丁二：OCR 校正也覆盖 B 站 AI 字幕 */
const P2 = {
  file: join(SRC, 'storyboard', 'pipeline.js'),
  needle: "  if (ocr && transcriptInfo?.source === 'asr' && (transcriptInfo.segments?.length ?? 0) > 0) {",
  replace: `  // [${MARK}] B 站自己的 AI 字幕（site-cc:ai-zh）也是机器听写，错字是它带来的。
  // 原来只在 source==='asr' 时拿画面硬字幕校正，于是她看的片子一次都没校正过。
  const aiSiteCc = transcriptInfo?.source === 'subtitle' && /:ai/i.test(String(transcriptInfo?.model ?? ''));
  if (ocr && (transcriptInfo?.source === 'asr' || aiSiteCc) && (transcriptInfo.segments?.length ?? 0) > 0) {`,
}

function applyOne(p, { write = true } = {}) {
  if (!existsSync(p.file)) return { state: 'nofile', file: p.file }
  const src = readFileSync(p.file, 'utf8')
  if (src.includes(MARK)) return { state: 'patched', file: p.file }
  const at = src.indexOf(p.needle)
  if (at < 0) return { state: 'unknown', file: p.file, detail: '找不到要改的那一行（插件版本变了？）' }
  if (!write) return { state: 'missing', file: p.file }
  const backup = p.file + '.orig'
  if (!existsSync(backup)) copyFileSync(p.file, backup)
  writeFileSync(p.file, src.slice(0, at) + p.replace + src.slice(at + p.needle.length), 'utf8')
  return { state: 'applied', file: p.file }
}

export function ensureVsPatch({ write = true } = {}) {
  return [applyOne(P1, { write }), applyOne(P2, { write })]
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const check = process.argv.includes('--check')
  const res = ensureVsPatch({ write: !check })
  for (const r of res) {
    const name = r.file.split(/[\\/]/).slice(-2).join('/')
    const label = {
      patched: '已打过',
      applied: '刚补上',
      missing: '缺补丁',
      nofile: '文件不在（插件没装？）',
      unknown: '认不出来',
    }[r.state] ?? r.state
    console.log(`${label.padEnd(6)} ${name}${r.detail ? ` — ${r.detail}` : ''}`)
  }
  if (check) process.exit(res.some((r) => r.state === 'missing' || r.state === 'unknown') ? 1 : 0)
}
