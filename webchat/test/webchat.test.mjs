/**
 * webchat 测试（2026-11-12；同日补全完整聊天功能后重写）。
 *
 * 两类：
 *   1. 单测：webchat.mjs 的纯函数 + bridge/push.mjs 的 parsePushLine（网页端本来就
 *      复用桥的解析器，不养第二份账本真相）。import 无副作用（main 有守卫）。
 *   2. 集成：mock DSH（http）+ 子进程起 webchat + ws/fetch 把
 *      auth / chat / 图片 / 上传 / 申请卡 / 媒体鉴权 / 账本推送走一遍。
 *      pusher 的行为细节归 bridge/test/push.test.mjs 管，这里只验「接得上」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { parsePushLine } from '../../bridge/push.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const {
  WEB_NOTE, isLoopback, authAllowed, loadConfig,
  presentItem, fileNoteFor, safeName,
} = await import('../webchat.mjs')

// ---------------------------------------------------------------- 单测

test('来源标注必须说破这是网页（fork.13）', () => {
  assert.match(WEB_NOTE, /网页/)
  assert.match(WEB_NOTE, /\n\n$/, '标注后要空一行，正文接在后面')
})

test('isLoopback：127.x / ::1 / IPv6 映射都算本机，局域网不算', () => {
  assert.equal(isLoopback('127.0.0.1'), true)
  assert.equal(isLoopback('127.0.0.9'), true)
  assert.equal(isLoopback('::1'), true)
  assert.equal(isLoopback('::ffff:127.0.0.1'), true)
  assert.equal(isLoopback('192.168.137.2'), false)
  assert.equal(isLoopback(''), false)
})

test('authAllowed：本机免密；非本机要设了密码且发对（查看器 7788 口径）', () => {
  assert.equal(authAllowed(true, '', ''), true, '本机免密')
  assert.equal(authAllowed(true, '随便什么', ''), true)
  assert.equal(authAllowed(false, 'pw123', 'pw123'), true)
  assert.equal(authAllowed(false, 'wrong', 'pw123'), false, '错密码拒')
  assert.equal(authAllowed(false, '', 'pw123'), false, '没发密码拒')
  assert.equal(authAllowed(false, 'pw123', ''), false, '服务端没设密码时非本机一律不放')
})

test('账本→网页：三种标记认，标记前缀剥掉（复用桥的 parsePushLine）', () => {
  const now = new Date().toISOString()
  const toWeb = (text) => presentItem(parsePushLine(JSON.stringify(
    { type: 'utterance', source: 'tool', text, ts: now },
  )))
  assert.deepEqual(toWeb('（她说）今晚吃什么呢'),
    { type: 'say', kind: 'say', text: '今晚吃什么呢', ts: now })
  assert.deepEqual(toWeb('（她主动说）刚看到一个好玩的'),
    { type: 'say', kind: 'proactive', text: '刚看到一个好玩的', ts: now })
  assert.deepEqual(toWeb('（陪你看）这集真不错'),
    { type: 'say', kind: 'watch', text: '这集真不错', ts: now })
})

test('账本→网页：内心活动、别的事件、坏行都不算开口（fork.7 教训）', () => {
  const now = new Date().toISOString()
  // source 不是 tool 的（growth_commit 记的判断）不能推——发出去就是替她说话
  assert.equal(parsePushLine(JSON.stringify(
    { type: 'utterance', source: 'growth_commit', text: '（她说）假的', ts: now },
  )), null)
  assert.equal(parsePushLine(JSON.stringify({ type: 'meta', text: '（她说）假的', ts: now })), null)
  assert.equal(parsePushLine(JSON.stringify(
    { type: 'utterance', source: 'tool', text: '没有标记的普通话', ts: now },
  )), null)
  assert.equal(parsePushLine('这不是JSON'), null)
  assert.equal(parsePushLine(''), null)
})

test('申请卡：问题剥掉前缀、选项原样留、多行问题不丢原话', () => {
  const now = new Date().toISOString()
  const item = parsePushLine(JSON.stringify({
    type: 'ask', id: 'ask-1', text: '今晚吃什么？\n要不出去吃',
    ask: { options: ['火锅', '随便'] }, ts: now,
  }))
  const m = presentItem(item)
  assert.equal(m.type, 'ask')
  assert.equal(m.askId, 'ask-1')
  assert.equal(m.question, '今晚吃什么？\n要不出去吃', '问题本体一行不删')
  assert.deepEqual(m.options, ['火锅', '随便'], '选项交给前端做按钮')
  assert.doesNotMatch(m.question, /回数字|去 7788/, 'QQ 那套提示不进网页的问题正文')
})

test('语音/表情走媒体路径，信走文字（与桥同一种 push 条目）', () => {
  const now = new Date().toISOString()
  assert.deepEqual(presentItem(parsePushLine(JSON.stringify(
    { type: 'meta', text: 'voice:/data/a.wav|她说的话', ts: now },
  ))), { type: 'media', kind: 'voice', path: '/data/a.wav', ts: now })
  assert.deepEqual(presentItem(parsePushLine(JSON.stringify(
    { type: 'meta', text: 'meme:/data/m.png', ts: now },
  ))), { type: 'media', kind: 'meme', path: '/data/m.png', ts: now })
  // letter 需要同一 state 里的前一条 utterance 配对
  const state = {}
  parsePushLine(JSON.stringify(
    { type: 'utterance', source: 'tool', id: 'u1', text: '留给你的一句话', ts: now },
  ), state)
  const letter = presentItem(parsePushLine(JSON.stringify(
    { type: 'meta', text: 'letter:2026-11-12:u1', ts: now },
  ), state))
  assert.equal(letter.type, 'say')
  assert.equal(letter.kind, 'letter')
  assert.equal(letter.text, '留给你的一句话')
})

test('文件事实话术：只报名字/大小/路径，0 字节不编成 1KB（fork.13）', () => {
  const saved = { name: 'a.txt', bytes: 0, path: '/data/home/inbox/a.txt' }
  const note = fileNoteFor(saved)
  assert.match(note, /a\.txt/)
  assert.match(note, /0KB/, '0 字节就是 0KB，别四舍五入成 1KB')
  assert.match(note, /\/data\/home\/inbox\/a\.txt/)
  assert.match(note, /看不看、怎么处理，你自己定/, '判断权留给她')
  assert.doesNotMatch(note, /能打开|可以打开|帮你打开/, '不承诺工具能打开')
  assert.match(fileNoteFor({ name: 'b.mp4', bytes: 2048, path: '/p' }), /2KB/)
})

test('safeName：路径穿越与非法字符都净化', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd')
  assert.equal(safeName('dir\\sub\\a.mp4'), 'a.mp4')
  assert.equal(safeName('a:b*c?"d.txt'), 'a_b_c__d.txt')
  assert.equal(safeName(''), 'file')
})

test('定位只报坐标事实，不承诺能打开什么', () => {
  const src = readFileSync(join(ROOT, 'static', 'app.js'), 'utf8')
  assert.match(src, /navigator\.geolocation\.getCurrentPosition/)
  assert.match(src, /经纬度/)
  assert.match(src, /大概 ±/, '精度是事实，要带上')
  assert.match(src, /uri\.amap\.com\/marker\?position=/, '只给地图链接，不替她说地点名')
  assert.doesNotMatch(src, /能打开|帮你打开|我可以看/)
})

test('loadConfig：文件值盖默认值，坏文件退默认值不炸', () => {
  const dir = mkdtempSync(join(tmpdir(), 'webchat-cfg-'))
  const good = join(dir, 'good.json')
  writeFileSync(good, JSON.stringify({ port: 6299, password: 'x' }))
  const cfg = loadConfig(good)
  assert.equal(cfg.port, 6299)
  assert.equal(cfg.password, 'x')
  assert.equal(cfg.pollMs, 1500, '没写的键取默认值')
  assert.equal(cfg.host, '127.0.0.1', '默认只绑本机')

  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{not json')
  assert.equal(loadConfig(bad).port, 6210, '坏配置退默认端口')
})

// ---------------------------------------------------------------- 集成

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

/** 收消息的小信箱：按条件取，先到的先落队列，避免多个等待互相抢监听 */
function makeInbox(ws) {
  const queue = []
  const waiters = []
  ws.on('message', (data) => {
    let m
    try { m = JSON.parse(String(data)) } catch { return }
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].pred(m)) {
        const w = waiters.splice(i, 1)[0]
        clearTimeout(w.timer)
        w.resolve(m)
        return
      }
    }
    queue.push(m)
  })
  return (pred, ms = 6000) => new Promise((resolve, reject) => {
    const i = queue.findIndex(pred)
    if (i >= 0) return resolve(queue.splice(i, 1)[0])
    const w = { pred, resolve }
    w.timer = setTimeout(() => {
      const j = waiters.indexOf(w)
      if (j >= 0) waiters.splice(j, 1)
      reject(new Error('等消息超时（队列里：' + queue.map((x) => x.type).join(',') + '）'))
    }, ms)
    waiters.push(w)
  })
}

test('集成：auth / 递话 / 图片 / 上传 / 申请卡 / 媒体鉴权 / 账本推送', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'webchat-it-'))
  const home = join(tmp, 'home')      // 模拟 fishRoot（~/.dsh-fish）
  const inbox = join(home, 'home', 'inbox') // 她的收件箱：fishRoot/home/inbox
  mkdirSync(home)
  // 密钥与一条不构成推送的旧事件（pusher 首跑从末尾起算，旧事件不该被推）
  writeFileSync(join(home, 'local.key'), 'test-key-123')
  writeFileSync(join(home, 'events.jsonl'),
    JSON.stringify({ type: 'utterance', source: 'local', text: '（开场白）不是她说的', ts: new Date().toISOString() }) + '\n')
  writeFileSync(join(tmp, 'outside.txt'), 'outside')

  // mock DSH：ping / say / steer / answer 都记下来
  const seen = []
  const mock = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ url: req.url, key: req.headers['x-fish-key'], body })
      const ok = { 'content-type': 'application/json' }
      if (req.url === '/dsh-fish/local/ping') {
        res.writeHead(200, ok); return res.end('{"ok":true}')
      }
      if (req.url === '/dsh-fish/local/say' || req.url === '/dsh-fish/local/answer') {
        res.writeHead(200, ok); return res.end('{"ok":true,"note":"mock 收到"}')
      }
      if (req.url === '/dsh-fish/local/steer') {
        res.writeHead(200, ok); return res.end('{"ok":false,"note":"这轮没在跑"}')
      }
      res.writeHead(404); res.end('{}')
    })
  })
  await new Promise((r) => mock.listen(0, '127.0.0.1', r))
  const mockPort = mock.address().port

  const cfgPath = join(tmp, 'config.json')
  const port = await freePort()
  writeFileSync(cfgPath, JSON.stringify({
    port,
    host: '127.0.0.1',
    password: 'pw123',
    fishPort: mockPort,
    fishRoot: home,
    pollMs: 60,
    sayTimeoutMs: 5000,
    historyLines: 50,
    fileMaxBytes: 1024,
  }))

  const child = spawn(process.execPath, [join(ROOT, 'webchat.mjs')], {
    env: { ...process.env, WEBCHAT_CONFIG_PATH: cfgPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { out += c })

  const waitFor = async (fn, ms = 6000, step = 100) => {
    for (let t = 0; t < ms; t += step) {
      try { if (await fn()) return true } catch { /* 再等 */ }
      await delay(step)
    }
    return false
  }
  const url = `http://127.0.0.1:${port}`
  let ws
  let next
  let TOKEN = ''

  try {
    await t.test('服务起来，静态页带广播式说明', async () => {
      assert.equal(await waitFor(async () => {
        const r = await fetch(url + '/')
        const html = r.ok ? await r.text() : ''
        return html.includes('广播式') && html.includes('/app.js')
      }), true, 'webchat 没起来：' + out.slice(-400))
    })

    await t.test('本机免密，auth-ok 带 token 与历史', async () => {
      ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      next = makeInbox(ws)
      await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
      ws.send(JSON.stringify({ type: 'auth', password: 'wrong' }))
      const okLocal = await next((m) => m.type === 'auth-ok')
      assert.equal(Array.isArray(okLocal.history), true)
      assert.ok(okLocal.token, '媒体 token 要发下来')
      TOKEN = okLocal.token
    })

    await t.test('纯文字递话：带来源标注、密钥、原样正文', async () => {
      ws.send(JSON.stringify({ type: 'chat', text: '网页这边能听到吗' }))
      const sent = await next((m) => m.type === 'sent')
      assert.equal(sent.ok, true, '递话应该成功：' + JSON.stringify(sent))
      const sayCall = seen.find((s) => s.url === '/dsh-fish/local/say')
      assert.ok(sayCall, 'mock DSH 应该收到 say')
      assert.equal(sayCall.key, 'test-key-123', 'x-fish-key 要带上')
      const parsed = JSON.parse(sayCall.body)
      assert.match(parsed.text, /这条消息从网页发来/, '来源标注必须在（fork.13）')
      assert.match(parsed.text, /网页这边能听到吗$/, '正文要原样接在标注后')
    })

    await t.test('图片：data URL 原样进 /local/say 的 image 字段', async () => {
      const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
      ws.send(JSON.stringify({ type: 'chat', text: '看图', image: dataUrl }))
      const sent = await next((m) => m.type === 'sent')
      assert.equal(sent.ok, true)
      const calls = seen.filter((s) => s.url === '/dsh-fish/local/say')
      const parsed = JSON.parse(calls.at(-1).body)
      assert.equal(parsed.image, dataUrl, 'decodeBase64Image 认 data: 前缀，别在这层改写')
      assert.match(parsed.text, /这条消息从网页发来/)
    })

    await t.test('上传：落 home/inbox，递给她的是文件事实且只递一次', async () => {
      assert.ok(TOKEN, 'auth-ok 的 token 要留着给 /upload 与 /media 用')
      const up = await fetch(`${url}/upload?token=${encodeURIComponent(TOKEN)}&name=hello.txt`,
        { method: 'POST', body: 'hello' })
      assert.equal(up.status, 200)
      const j = await up.json()
      assert.equal(j.ok, true)
      assert.equal(j.name, 'hello.txt')
      assert.equal(j.bytes, 5)
      assert.equal(readFileSync(join(inbox, 'hello.txt'), 'utf8'), 'hello', '文件真落收件箱')

      ws.send(JSON.stringify({ type: 'chat', text: '帮你看看', uploadId: j.uploadId }))
      const sent = await next((m) => m.type === 'sent')
      assert.equal(sent.ok, true)
      const parsed = JSON.parse(seen.filter((s) => s.url === '/dsh-fish/local/say').at(-1).body)
      assert.match(parsed.text, /这条消息从网页发来/)
      assert.match(parsed.text, /hello\.txt/)
      assert.match(parsed.text, /0KB/, '5 字节按桥口径就是 0KB，不编成 1KB')
      assert.match(parsed.text, /inbox[\\/]hello\.txt|看不看、怎么处理/)
      assert.doesNotMatch(parsed.text, /能打开|帮你打开/)

      // 同一个 uploadId 不能重复递话
      ws.send(JSON.stringify({ type: 'chat', text: '再来一次', uploadId: j.uploadId }))
      const again = await next((m) => m.type === 'sent')
      assert.equal(again.ok, false)
      assert.match(again.note, /附件没找到/)
    })

    await t.test('/media：无 token 401、越界 403、目录内文件可读', async () => {
      const mediaPath = join(inbox, 'hello.txt')
      const no = await fetch(`${url}/media?path=${encodeURIComponent(mediaPath)}`)
      assert.equal(no.status, 401)
      const outside = await fetch(`${url}/media?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(join(tmp, 'outside.txt'))}`)
      assert.equal(outside.status, 403, '数据目录外的文件一律不给')
      const ok = await fetch(`${url}/media?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(mediaPath)}`)
      assert.equal(ok.status, 200)
      assert.equal(await ok.text(), 'hello')
    })

    await t.test('申请卡：账本推成卡片，点选项走 /local/answer 结算', async () => {
      const ts = new Date().toISOString()
      appendFileSync(join(home, 'events.jsonl'), JSON.stringify({
        type: 'ask', id: 'ask-evt-1', text: '今晚吃什么？',
        ask: { options: ['火锅', '随便'] }, ts,
      }) + '\n')
      const card = await next((m) => m.type === 'ask', 8000)
      assert.equal(card.askId, 'ask-evt-1')
      assert.equal(card.question, '今晚吃什么？')
      assert.deepEqual(card.options, ['火锅', '随便'])

      ws.send(JSON.stringify({ type: 'answer', askId: 'ask-evt-1', selected: '火锅' }))
      const result = await next((m) => m.type === 'answer-result')
      assert.equal(result.ok, true, '结算失败：' + JSON.stringify(result))
      assert.equal(result.selected, '火锅')
      const ans = seen.filter((s) => s.url === '/dsh-fish/local/answer').at(-1)
      assert.ok(ans, '要走 /local/answer（与 DSH 卡片同一条 answerCard）')
      assert.deepEqual(JSON.parse(ans.body), { id: 'ask:ask-evt-1', selected: ['火锅'] })
    })

    await t.test('她在账本里开口 → 推回浏览器', async () => {
      appendFileSync(join(home, 'events.jsonl'), JSON.stringify({
        type: 'utterance', source: 'tool', text: '（她说）听到了，晚上好', ts: new Date().toISOString(),
      }) + '\n')
      const push = await next((m) => m.type === 'say', 8000)
      assert.equal(push.kind, 'say')
      assert.equal(push.text, '听到了，晚上好', '标记前缀要剥掉再给前端')
    })
  } finally {
    if (ws) ws.close()
    child.kill()
    mock.close()
  }
})

test('静态前端 JS 要能过 node --check（模板字符串踩过的坑，别再踩）', async () => {
  const { execFileSync } = await import('node:child_process')
  for (const f of ['app.js', 'webchat.mjs']) {
    execFileSync(process.execPath, ['--check', join(ROOT, f === 'app.js' ? 'static' : '.', f)],
      { stdio: 'pipe' })
  }
})
