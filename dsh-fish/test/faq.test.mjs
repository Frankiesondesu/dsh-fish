/**
 * faq.test.mjs —— 设置 → 反馈页那个「常见问题解答」按钮背后的那一页。
 *
 * 三件事要守住：
 *   1. 正文和作者给的《常见问题解答.doc》一致（条数、顺序、原话），不能被改写。
 *   2. 页面是自包含的 UTF-8 HTML，内容一律转义（它只是个纯文本说明书）。
 *   3. `/dsh-fish/faq` 路由真的吐 HTML，且反馈页里确实有这个按钮。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FAQ, FAQ_TITLE, escapeHtml, renderFaqPage } from '../lib/faq.js'
import { registerObserve } from '../lib/observe.js'

const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url))

test('常见问题：条数与首尾都对得上原文档', () => {
  assert.equal(FAQ.length, 12)
  assert.match(FAQ[0].q, /怎么没有各种权限/)
  assert.match(FAQ[10].q, /能不能额外加各种功能/)
  assert.match(FAQ[11].q, /还有XXX问题/)
  // 原话里的关键结论不能被顺手改写
  assert.equal(FAQ[4].a[0], '对话认知条数越多，就等于她能记得的认知就会越多，在条数没有满之前，不会被新认知替代')
  assert.match(FAQ[2].a[0], /默认40轮换一次窗口/)
})

test('页面把每一条问题与正文都写进去了', () => {
  const html = renderFaqPage()
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /<meta charset="utf-8">/)
  assert.match(html, /lang="zh-CN"/)
  assert.ok(html.includes(FAQ_TITLE), '标题要在页面里')
  FAQ.forEach((it, i) => {
    assert.ok(html.includes(escapeHtml(it.q)), `第 ${i + 1} 条问题没进页面：${it.q}`)
    for (const p of it.a) assert.ok(html.includes(escapeHtml(p)), `第 ${i + 1} 条的正文没进页面`)
  })
  // 不引外部资源：断网也能看
  assert.doesNotMatch(html, /<script/i)
  assert.doesNotMatch(html, /<img/i)
  assert.doesNotMatch(html, /https?:\/\//i)
})

test('正文里的尖括号与 & 一律被转义（这一页没有一处该当成标签）', () => {
  const html = renderFaqPage([{ q: '<b>粗</b> & "引号"', a: ["a & b < c > d 'e'"] }], 'T')
  assert.ok(html.includes('&lt;b&gt;粗&lt;/b&gt; &amp; &quot;引号&quot;'))
  assert.ok(html.includes('a &amp; b &lt; c &gt; d &#39;e&#39;'))
  assert.doesNotMatch(html, /<b>粗/)
})

test('GET /dsh-fish/faq 直接吐 HTML，且是新窗口能打开的整页', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-faq-'))
  try {
    const routes = []
    const ctx = {
      get: (k) => (k === 'connection'
        ? { requestRejection: () => null }
        : k === 'webServer'
          ? { register: (def) => { routes.push(def); return () => {} } }
          : undefined),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }
    registerObserve(ctx, { root })
    const route = routes.find((r) => String(r.path || '').endsWith('/faq'))
    assert.ok(route, '必须有 /faq 路由')

    let status = 0
    let headers = null
    let body = ''
    const res = {
      writeHead: (s, h) => { status = s; headers = h },
      end: (s) => { body = String(s ?? '') },
      setHeader: () => {},
    }
    await route.handler({ method: 'GET', url: '/dsh-fish/faq', headers: {} }, res)

    assert.equal(status, 200)
    assert.match(String(headers?.['content-type'] ?? ''), /text\/html; charset=utf-8/)
    assert.equal(Number(headers?.['content-length']), Buffer.byteLength(body), 'content-length 要按字节算，中文不能按字符数')
    assert.ok(body.includes('常见问题解答'))
    assert.ok(body.includes(escapeHtml(FAQ[0].q)))
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('GET /dsh-fish/faq.data 吐 JSON，给设置页的面板就地展开（2026-10-28 晚）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-faq-'))
  try {
    const routes = []
    const ctx = {
      get: (k) => (k === 'connection'
        ? { requestRejection: () => null }
        : k === 'webServer'
          ? { register: (def) => { routes.push(def); return () => {} } }
          : undefined),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }
    registerObserve(ctx, { root })
    const route = routes.find((r) => String(r.path || '').endsWith('/faq.data'))
    assert.ok(route, '必须有 /faq.data 路由')

    let status = 0
    let headers = null
    let body = ''
    const res = {
      writeHead: (s, h) => { status = s; headers = h },
      end: (s) => { body = String(s ?? '') },
      setHeader: () => {},
    }
    await route.handler({ method: 'GET', url: '/dsh-fish/faq.data', headers: {} }, res)

    assert.equal(status, 200)
    assert.match(String(headers?.['content-type'] ?? ''), /application\/json; charset=utf-8/)
    assert.equal(Number(headers?.['content-length']), Buffer.byteLength(body), 'content-length 按字节算')
    const d = JSON.parse(body)
    assert.equal(d.ok, true)
    assert.equal(d.title, FAQ_TITLE)
    assert.equal(d.items.length, FAQ.length)
    assert.deepEqual(d.items[0], FAQ[0], '面板看到的正文必须与页面同源')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('反馈页里的按钮是「就地展开」：button + 面板，不再开新窗口', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes('faq-btn'), '样式类要在')
  assert.ok(src.includes("jget('/faq.data')"), '要点按钮取 JSON，而不是让浏览器新开一页')
  assert.ok(src.includes("className: 'faq-panel'"), '要有就地展开的面板')
  assert.ok(src.includes('faqOpenNow'), '要有开合状态')
  const at = src.indexOf("className: 'faq-btn'")
  assert.ok(at >= 0, '按钮要在反馈页里')
  assert.doesNotMatch(src.slice(at, at + 200), /target: '_blank'/, '按钮不该再是 target=_blank（新标签页会被宿主的信任栅栏拦成 403）')
  assert.ok(src.includes('常见问题解答'), '按钮文字要在')
})
