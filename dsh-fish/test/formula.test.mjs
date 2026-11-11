/**
 * her_formula（2026-11-09）：把「文字 + $公式$」排成一页 PNG。
 *
 * 分两层：切稿与参数校验是纯函数（快），真渲染要起一次无头 Edge（约 3 秒）。
 * 真渲染只放一条烟测——中文 + 行内公式 + aligned 多行推导，
 * 一趟把「公式段别被 <br> 打散」「中文照排」「尺寸量得出来」三件事一起验了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildHtmlBody,
  buildHtml,
  planFormula,
  renderFormula,
  registerFormula,
  browserPath,
  splitBlocks,
  formatBlockReport,
} from '../lib/formula.js'

// ── 切稿：哪些是公式、哪些是字 ─────────────────────────────

test('文字段的换行变 <br>（她写一行就是一行）', () => {
  assert.equal(buildHtmlBody('第一行\n第二行'), '第一行<br>第二行')
  assert.equal(buildHtmlBody('第一行\r\n第二行'), '第一行<br>第二行')
})

test('行内公式原样留给 MathJax，不被转义也不被换行', () => {
  const out = buildHtmlBody('求 $x^2 + 1$ 的值')
  assert.equal(out, '求 $x^2 + 1$ 的值')
})

test('$$…$$ 里写成多行，中间不插 <br>（第一版就这么散架的）', () => {
  const src = '解：\n$$\\begin{aligned}\nx &= 1 + 2 \\\\\ny &= 3\n\\end{aligned}$$\n完。'
  const out = buildHtmlBody(src)
  assert.ok(out.startsWith('解：$$'), '贴近公式的那个换行被吃掉（MathJax 自己会留白）')
  assert.ok(out.endsWith('完。'), '公式后的文字还在')
  const math = out.slice(out.indexOf('$$'), out.indexOf('$$', out.indexOf('$$') + 2) + 2)
  assert.ok(!math.includes('<br>'), `公式段里混进了 <br>：${math}`)
  assert.ok(math.includes('\\begin{aligned}'), 'aligned 原样保留')
})

test('独占一行的 $$：两侧那个换行不吃掉就会空出半屏（实测踩过）', () => {
  assert.equal(buildHtmlBody('求根公式：\n$$x=1$$\n代入得 1'), '求根公式：$$x=1$$代入得 1')
})

test('她自己空出来的空行要留着——那是她的排版意图', () => {
  assert.equal(buildHtmlBody('a\n\n$$x$$\n\nb'), 'a<br>$$x$$<br>b')
})

test('没配对的 $ 当普通文字（别把后半页吞进公式里）', () => {
  const out = buildHtmlBody('花了 5$ 买了个包子')
  assert.equal(out, '花了 5$ 买了个包子')
})

test('\\$ 是字面美元号，不算公式开头', () => {
  const out = buildHtmlBody('\\$x 不是公式')
  assert.equal(out, '$x 不是公式')
})

test('HTML 全段转义（她写的东西不该被浏览器当标签执行）', () => {
  const out = buildHtmlBody('a < b & c > d <script>alert(1)</script>')
  assert.ok(out.includes('&lt;'), '小于号要转义')
  assert.ok(out.includes('&amp;'), '& 要转义')
  assert.ok(out.includes('&gt;'), '大于号要转义')
  assert.ok(!out.includes('<script>'), '不能留可执行的标签')
})

test('公式里的 < 也转义——MathJax 从 textContent 读，转义过照样认得', () => {
  const out = buildHtmlBody('$a < b$')
  assert.equal(out, '$a &lt; b$')
})

// ── 参数：该拒的拒、该夹的夹 ───────────────────────────────

test('空稿子直接拒，并说清缺什么', () => {
  const r = planFormula({ content: '   \n  ' })
  assert.equal(r.ok, false)
  assert.match(r.why, /内容是空的/)
})

test('超 4000 字拒掉，回执里报实际字数', () => {
  const r = planFormula({ content: '字'.repeat(4001) })
  assert.equal(r.ok, false)
  assert.match(r.why, /4001 字/)
  assert.match(r.why, /拆成两页/)
})

test('4000 字整好能进（边界不能差一）', () => {
  assert.equal(planFormula({ content: '字'.repeat(4000) }).ok, true)
})

test('字号、宽度超范围就夹紧，不报错中断', () => {
  assert.equal(planFormula({ content: 'x', size: 999 }).plan.size, 48)
  assert.equal(planFormula({ content: 'x', size: 1 }).plan.size, 10)
  assert.equal(planFormula({ content: 'x', width: 100 }).plan.width, 320)
  assert.equal(planFormula({ content: 'x', width: 99999 }).plan.width, 1600)
})

test('不传就用默认值（30 号 / 900 宽 / 黑）', () => {
  const p = planFormula({ content: 'x' }).plan
  assert.equal(p.size, 30)
  assert.equal(p.width, 900)
  assert.equal(p.color, '#1a1a1a')
})

test('颜色名走 her_draw 那张表，不认识的退回默认', () => {
  assert.equal(planFormula({ content: 'x', color: '红' }).plan.color, '#d94040')
  assert.equal(planFormula({ content: 'x', color: '#123456' }).plan.color, '#123456')
  assert.equal(planFormula({ content: 'x', color: '荧光玫红' }).plan.color, '#1a1a1a')
})

// ── 那一页 HTML ────────────────────────────────────────────

test('生成的页面：引本地 MathJax、关字体缓存、尺寸写进 title', () => {
  const mathjax = join(tmpdir(), 'tex-svg.js')
  const html = buildHtml(planFormula({ content: '求 $x$', size: 24, width: 720 }).plan, { mathjax })
  assert.ok(html.includes(pathToFileURL(mathjax).href), '要用 file:// 引本地文件，别走网络')
  assert.ok(html.includes("fontCache: 'none'"), '无字体缓存，SVG 才自包含')
  assert.ok(html.includes('getBoundingClientRect'), '要量尺寸')
  assert.ok(html.includes('document.title'), '尺寸要写进 title 才读得回来')
  assert.ok(html.includes('font-size:24px'), '字号要落进样式')
  assert.ok(html.includes('width:720px'), '宽度要落进样式')
  assert.ok(html.includes("'textmacros'"), 'ams/textmacros 要带上，\\text{} 才认得中文')
})

// ── 随附资源（少了它渲染必然失败，得在单元层就红）────────────

test('MathJax 那个文件跟着插件走，且是完整构建', async () => {
  const p = new URL('../lib/assets/mathjax/tex-svg.js', import.meta.url)
  const st = await stat(p)
  assert.ok(st.size > 1_000_000, `tex-svg.js 只有 ${st.size} 字节，不像完整构建`)
  const head = (await readFile(p, 'utf8')).slice(0, 200)
  assert.ok(head.includes('webpack'), '内容要像打包好的 JS，不是空文件或错误页')
})

test('Apache-2.0 许可与声明一起分发（协议要求，不是可选）', async () => {
  const lic = new URL('../lib/assets/mathjax/LICENSE', import.meta.url)
  const txt = await readFile(lic, 'utf8')
  assert.match(txt, /Apache License/)
  assert.match(txt, /Version 2\.0/)
  const notices = await readFile(new URL('../THIRD-PARTY-NOTICES.md', import.meta.url), 'utf8')
  assert.match(notices, /MathJax/)
  assert.match(notices, /Apache License 2\.0/)
})

// ── 浏览器探测 ─────────────────────────────────────────────

test('找浏览器：给不存在的路径就往下找，最终返回字符串（找不到是空串，不抛）', () => {
  const p = browserPath({ FISH_DRAW_BROWSER: 'C:/nope/nope.exe', EDGE_PATH: 'C:/nope/edge.exe' })
  assert.equal(typeof p, 'string')
})

// ── 真渲染：一张烟测 ───────────────────────────────────────

test('真渲染：中文 + 行内公式 + aligned 多行推导，产出合法 PNG', { timeout: 90_000 }, async () => {
  const exe = browserPath()
  const root = await mkdtemp(join(tmpdir(), 'fish-formula-'))
  try {
    const registered = []
    const ctx = { tools: { register: (t) => registered.push(t) } }
    registerFormula(ctx, { root, log: () => {} })
    assert.equal(registered.length, 1)
    const def = registered[0]
    assert.equal(def.name, 'her_formula')

    if (!exe) {
      // 这台机器两个浏览器都没有：只能验到「如实说排不出来」，别假装通过
      const out = await def.execute({ content: '求 $x$' }, { session: {} })
      assert.equal(out.ok, false)
      assert.match(out.note, /Edge|Chrome/)
      return
    }

    const out = await def.execute(
      {
        content: '解：把 2x + 3 = 7 移项\n$$\\begin{aligned}\n2x &= 7 - 3 \\\\\nx &= 2\n\\end{aligned}$$\n所以 $x = 2$，代回原式成立。',
        size: 24,
        width: 640,
      },
      { session: {} },
    )
    assert.equal(out.ok, true, `应排成（note：${out.note}）`)
    assert.match(out.path, /media[\\/]formula[\\/]formula-\d{4}-\d{2}-\d{2}-\d{2}\.png$/)
    // 只存不发的定案：回执必须如实说「没有发给他」，并给可抄的路径与发图写法
    assert.match(out.note, /没有发给他/)
    assert.ok(out.note.includes(out.path.replace(/\\/g, '/')), '回执要给正斜杠的完整路径')
    assert.match(out.note, /!\[推导\]\(/, '回执要给发图写法')
    assert.match(out.note, /her_say/, '回执指向现成通路')
    // 量出来的尺寸要落在合理区间：排版宽就是她给的宽，高至少容得下三行
    const m = /排版 (\d+)×(\d+)，出图 (\d+)×(\d+)（2 倍/.exec(out.note)
    assert.ok(m, `回执里要有排版尺寸和实际出图像素：${out.note}`)
    assert.equal(Number(m[1]), 640, '排版宽度应等于 width')
    assert.ok(Number(m[2]) > 120, `高度太小，像是没排上内容（${m[2]}）`)
    assert.equal(Number(m[3]), 640 * 2, '出图宽要是 2 倍')
    assert.equal(Number(m[4]), Number(m[2]) * 2, '出图高要是 2 倍')

    const png = await readFile(out.path)
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG 魔数不对')
    assert.ok(png.length > 3000, `PNG 太小不像排了公式（${png.length}B）`)
  } finally {
    // Edge 的 profile 就在这个临时目录里，Windows 上可能还有句柄没放——
    // 删不掉就算了（系统自己清 tmp），别把一次成功的渲染判成失败
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

// ── 草稿模式（2026-11-10，用户定案：按空行切段 + 段 id + 自动预览 + 导出即删）──

test('splitBlocks：按空行切段，$$ 内部的空行不拆', () => {
  assert.deepEqual(splitBlocks('第一段\n\n第二段'), ['第一段', '第二段'])
  assert.deepEqual(splitBlocks('a\nb\n\nc'), ['a\nb', 'c'], '连续非空行是一段')
  const aligned = '$$\\begin{aligned}\na &= 1\n\nb &= 2\n\\end{aligned}$$'
  assert.deepEqual(splitBlocks(aligned), [aligned], '$$ 内部的空行不拆段')
  assert.deepEqual(splitBlocks('  \n\n '), [])
})

test('formatBlockReport：按段 id 列字数与开头', () => {
  const s = formatBlockReport([{ id: 'p1', text: '第一段' }, { id: 'p2', text: 'x'.repeat(80) }], { head: 10 })
  assert.match(s, /p1 3 字：第一段/)
  assert.match(s, /p2 80 字：xxxxxxxxxx…/, '长段要截断，回执不能变成长文')
})

test('公式草稿生命周期：增改自动预览，export 后删稿', { timeout: 180_000 }, async () => {
  const exe = browserPath()
  const root = await mkdtemp(join(tmpdir(), 'fish-formula-draft-'))
  try {
    const registered = []
    const ctx = { tools: { register: (t) => registered.push(t) } }
    registerFormula(ctx, { root, log: () => {} })
    const def = registered[0]
    const exec = { session: {} }

    const created = await def.execute({ action: 'create', content: '第一段 $a^2$\n\n第二段 $$b^2$$' }, exec)
    assert.equal(created.ok, true, created.note)
    assert.match(created.note, /d1/)
    assert.match(created.note, /切了 2 段/)
    assert.match(created.note, /p1/)
    assert.match(created.note, /p2/)
    assert.match(created.note, /整页变了是正常的/, '流式重排要说真')

    if (!exe) {
      // 没有浏览器：只能验到「如实说排不出来」，别假装通过
      const out = await def.execute({ action: 'export', draft: 'd1' }, exec)
      assert.equal(out.ok, false)
      assert.match(out.note, /Edge|Chrome/)
      return
    }

    const edited = await def.execute({ action: 'edit', draft: 'd1', block: 'p2', text: '改过的第二段 $c^2$' }, exec)
    assert.equal(edited.ok, true, edited.note)
    assert.match(edited.note, /改了 p2/)
    assert.match(edited.note, /预览（临时图，不是成品/)
    assert.match(edited.note, /media\/board\/f-d1-r\d+\.png/)

    const added = await def.execute({ action: 'add', draft: 'd1', content: '第三段 $\\frac{1}{2}$' }, exec)
    assert.equal(added.ok, true, added.note)
    assert.match(added.note, /p3/)

    const exported = await def.execute({ action: 'export', draft: 'd1' }, exec)
    assert.equal(exported.ok, true, exported.note)
    assert.match(exported.path, /media[\\/]formula[\\/]formula-\d{4}-\d{2}-\d{2}-\d{2}\.png$/)
    assert.match(exported.note, /已经删了，不能再改/)
    assert.match(exported.note, /没有发给他/)
    const png = await readFile(exported.path)
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])

    const gone = await def.execute({ action: 'edit', draft: 'd1', block: 'p1', text: 'x' }, exec)
    assert.equal(gone.ok, false)
    assert.match(gone.note, /没有 d1 这份草稿/, '导出后草稿真没了')
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
