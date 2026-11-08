import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPusher, parsePushLine, PUSH_MARKERS } from '../push.mjs'

const T0 = Date.parse('2026-11-02T17:00:00.000Z')

function withPusher(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'fish-push-'))
  const file = join(dir, 'events.jsonl')
  const statePath = join(dir, 'push-state.json')
  const sent = []
  let failNext = 0
  const pusher = createPusher({
    file,
    statePath,
    deliver: async (item) => {
      if (failNext > 0) {
        failNext -= 1
        throw new Error('QQ 没连着')
      }
      sent.push(item)
    },
    log: () => {},
    now: () => T0,
  })
  const api = {
    pusher,
    sent,
    file,
    statePath,
    fail: (n = 1) => { failNext = n },
    write: (text) => appendFileSync(file, text),
    event: (over = {}) =>
      JSON.stringify({
        id: 'ev_1',
        type: 'utterance',
        source: 'tool',
        ts: new Date(T0).toISOString(),
        text: '（她主动说）今天风大。',
        ...over,
      }) + '\n',
  }
  return Promise.resolve()
    .then(() => fn(api))
    .finally(() => rmSync(dir, { recursive: true, force: true }))
}

// ---------------------------------------------------------------- 认标记

test('只认带标记的 utterance，别的都不推', () => {
  assert.equal(parsePushLine('不是 json'), null)
  assert.equal(parsePushLine(''), null)
  // growth_commit 记下的判断也是 utterance/source=tool，但不是她说出口的话
  assert.equal(parsePushLine(JSON.stringify({ type: 'utterance', source: 'tool', text: '我原来那句说重了' })), null)
  // 系统写的不算
  assert.equal(parsePushLine(JSON.stringify({ type: 'utterance', source: 'system', text: '（她主动说）喂' })), null)
  // 别的类型不算
  assert.equal(parsePushLine(JSON.stringify({ type: 'narration', source: 'tool', text: '（她主动说）喂' })), null)
  // 只有标记、没有正文不算
  assert.equal(parsePushLine(JSON.stringify({ type: 'utterance', source: 'tool', text: '（她主动说）' })), null)

  const one = parsePushLine(JSON.stringify({ id: 'ev_9', type: 'utterance', source: 'tool', ts: '2026-11-02T09:00:00.000Z', text: '（她主动说）今天风大。' }))
  assert.deepEqual(one, { id: 'ev_9', kind: 'proactive', text: '今天风大。', ts: '2026-11-02T09:00:00.000Z' })
})

test('标记表里每一类都认得出来（陪看将来直接可用）', () => {
  for (const m of PUSH_MARKERS) {
    const got = parsePushLine(JSON.stringify({ type: 'utterance', source: 'tool', text: `${m.tag}嗯。` }))
    assert.equal(got?.kind, m.kind)
    assert.equal(got?.text, '嗯。')
  }
  assert.equal(parsePushLine(JSON.stringify({ type: 'utterance', source: 'tool', text: '（陪你看）这段笑了。' }))?.kind, 'watch')
})

test('表情和语音同一种形状：meta + 文件路径，按前缀分 kind', () => {
  const v = parsePushLine(JSON.stringify({ type: 'meta', text: 'voice:C:////a////v.mp3|她说的话' }))
  assert.equal(v?.kind, 'voice')
  assert.equal(v?.text, 'C:////a////v.mp3')

  const m = parsePushLine(JSON.stringify({ type: 'meta', text: 'meme:C:////a////无语.png|无语' }))
  assert.equal(m?.kind, 'meme')
  assert.equal(m?.text, 'C:////a////无语.png')

  assert.equal(parsePushLine(JSON.stringify({ type: 'meta', text: 'meme:' })), null, '没有路径不推')
  assert.equal(parsePushLine(JSON.stringify({ type: 'meta', text: 'seen:2026' })), null, '别的 meta 不推')
})

// ---------------------------------------------------------------- 增量读

test('第一次跑只记末尾，不补推历史', () =>
  withPusher(async ({ pusher, sent, file, statePath }) => {
    writeFileSync(file, '（她主动说）昨天的话。\n'.repeat(3).split('\n').filter(Boolean).map((t) => JSON.stringify({ type: 'utterance', source: 'tool', text: t })).join('\n') + '\n')
    const size = statSync(file).size
    const r = await pusher.tick()
    assert.equal(r.pushed, 0)
    assert.equal(sent.length, 0, '历史不该被推出去')
    assert.equal(pusher.offset, size)
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).offset, size, 'offset 要落盘')
  }))

test('新写的一条会被推，标记从正文里去掉', () =>
  withPusher(async ({ pusher, sent, file, event, write }) => {
    writeFileSync(file, event({ text: '（她主动说）以前的话。' }))
    await pusher.tick() // 基线
    write(event({ id: 'ev_2', text: '（她主动说）今天风大。' }))
    const r = await pusher.tick()
    assert.equal(r.pushed, 1)
    assert.deepEqual(sent.map((s) => s.text), ['今天风大。'])
    assert.equal(sent[0].kind, 'proactive')
    assert.equal(sent[0].id, 'ev_2')
  }))

test('没有标记的 utterance（她记下的判断）不推', () =>
  withPusher(async ({ pusher, sent, file, write }) => {
    writeFileSync(file, '')
    await pusher.tick()
    write(JSON.stringify({ id: 'ev_3', type: 'utterance', source: 'tool', text: '我原来那句说重了', ts: new Date(T0).toISOString() }) + '\n')
    write(JSON.stringify({ id: 'ev_4', type: 'meta', source: 'system', text: 'seen:xxx', ts: new Date(T0).toISOString() }) + '\n')
    const r = await pusher.tick()
    assert.equal(r.pushed, 0)
    assert.equal(sent.length, 0)
    assert.equal(pusher.offset, statSync(file).size, '不推的行也要把 offset 推过去')
  }))

test('半行不处理，补齐之后才推（写入中间被读到也不出错）', () =>
  withPusher(async ({ pusher, sent, file, event, write }) => {
    writeFileSync(file, '')
    await pusher.tick()
    const line = event({ text: '（她主动说）半行测试。' })
    const half = Math.floor(line.length / 2)
    write(line.slice(0, half))
    const r1 = await pusher.tick()
    assert.equal(r1.pushed, 0)
    assert.equal(sent.length, 0)
    write(line.slice(half))
    const r2 = await pusher.tick()
    assert.equal(r2.pushed, 1)
    assert.deepEqual(sent.map((s) => s.text), ['半行测试。'])
  }))

test('一次来了两条，按顺序推', () =>
  withPusher(async ({ pusher, sent, file, event, write }) => {
    writeFileSync(file, '')
    await pusher.tick()
    write(event({ id: 'ev_a', text: '（她主动说）第一句。' }) + event({ id: 'ev_b', text: '（她主动说）第二句。' }))
    await pusher.tick()
    assert.deepEqual(sent.map((s) => s.id), ['ev_a', 'ev_b'])
  }))

// ---------------------------------------------------------------- 失败与过期

test('推不出去就停在原处，下一轮重试', () =>
  withPusher(async ({ pusher, sent, file, event, write, fail }) => {
    writeFileSync(file, '')
    await pusher.tick()
    const before = pusher.offset
    write(event({ text: '（她主动说）重试我。' }))
    fail(2) // 这一轮两次都失败
    const r1 = await pusher.tick()
    assert.equal(r1.pushed, 0)
    assert.equal(r1.stopped, true)
    assert.equal(pusher.offset, before, 'offset 不能往前挪，否则这句就丢了')
    const r2 = await pusher.tick()
    assert.equal(r2.pushed, 1, '下一轮应该重试成功')
    assert.deepEqual(sent.map((s) => s.text), ['重试我。'])
  }))

test('放了太久的就不补发了（隔夜的话今早冒出来像鬼）', () =>
  withPusher(async ({ pusher, sent, file, write }) => {
    writeFileSync(file, '')
    await pusher.tick()
    const old = new Date(T0 - 10 * 60 * 1000).toISOString()
    write(JSON.stringify({ id: 'ev_old', type: 'utterance', source: 'tool', ts: old, text: '（她主动说）昨晚的话。' }) + '\n')
    const r = await pusher.tick()
    assert.equal(r.pushed, 0)
    assert.equal(sent.length, 0)
    assert.equal(pusher.offset, statSync(file).size, '过期丢弃也要把 offset 推过去，不然会卡死')
  }))

test('账本变小（被换过）就重新起算，不补推', () =>
  withPusher(async ({ pusher, sent, file, event }) => {
    writeFileSync(file, event({ text: '（她主动说）旧文件。' }) + event({ text: '（她主动说）旧文件二。' }))
    await pusher.tick()
    assert.equal(sent.length, 0)
    writeFileSync(file, event({ text: '（她主动说）新文件。' })) // 截断重写
    const r = await pusher.tick()
    assert.equal(r.pushed, 0)
    assert.equal(sent.length, 0)
    assert.equal(pusher.offset, statSync(file).size)
  }))

test('账本还不存在时不炸，等它出现', () =>
  withPusher(async ({ pusher, sent, file, event }) => {
    const r = await pusher.tick() // file 不存在
    assert.equal(r.pushed, 0)
    assert.equal(sent.length, 0)
    writeFileSync(file, event({ text: '（她主动说）来了。' }))
    const r2 = await pusher.tick() // 第一次见到文件 → 只记末尾
    assert.equal(r2.pushed, 0)
    appendFileSync(file, event({ id: 'ev_2', text: '（她主动说）再来一句。' }))
    const r3 = await pusher.tick()
    assert.equal(r3.pushed, 1)
    assert.deepEqual(sent.map((s) => s.text), ['再来一句。'])
  }))

test('中文与 emoji 不切坏（按字节走，不解码再回算）', () =>
  withPusher(async ({ pusher, sent, file, event, write }) => {
    writeFileSync(file, '')
    await pusher.tick()
    write(event({ text: '（她主动说）风好大🫘，你那边呢？' }))
    await pusher.tick()
    assert.deepEqual(sent.map((s) => s.text), ['风好大🫘，你那边呢？'])
  }))

// ---------------------------------------------------------------- 申请卡与信推 QQ（2026-11-08）

test('ask 事件成卡：文案带编号选项，解析出 askId/options', () => {
  const line = JSON.stringify({
    id: 'ev_ask1',
    type: 'ask',
    ts: new Date(T0).toISOString(),
    text: '能不能给我一样能把算式排成图片的东西？',
    ask: { kind: 'need-tool', subject: '算式排图', options: ['可以', '这次不行'] },
  })
  const r = parsePushLine(line, {})
  assert.equal(r.kind, 'ask')
  assert.equal(r.askId, 'ev_ask1')
  assert.deepEqual(r.options, ['可以', '这次不行'])
  assert.match(r.text, /（她想问你）能不能给我一样能把算式排成图片的东西？/)
  assert.match(r.text, /1\. 可以/)
  assert.match(r.text, /回数字就答了/)
})

test('ask 没有选项时不给答题指引（答不了就别教他答）', () => {
  const line = JSON.stringify({
    id: 'ev_ask2', type: 'ask', ts: new Date(T0).toISOString(),
    text: '问一句。', ask: { kind: 'other' },
  })
  const r = parsePushLine(line, {})
  assert.equal(r.kind, 'ask')
  assert.doesNotMatch(r.text, /回数字就答了/)
  assert.match(r.text, /观测台/)
})

test('letter：utterance + 紧跟的 letter: 标记配对，正文剥出来', () => {
  const state = {}
  const u = JSON.stringify({ id: 'ev_l', type: 'utterance', source: 'tool', ts: new Date(T0).toISOString(), text: '昨晚的雪托住了脚印。' })
  const mark = JSON.stringify({ id: 'ev_m', type: 'meta', ts: new Date(T0).toISOString(), text: 'letter:2026-11-08:ev_l' })
  assert.equal(parsePushLine(u, state), null, '信的正文本身不带标记，不单独推')
  const r = parsePushLine(mark, state)
  assert.equal(r.kind, 'letter')
  assert.equal(r.text, '（她留了封信）昨晚的雪托住了脚印。')
  assert.equal(r.ts, new Date(T0).toISOString(), '信的时间用正文那条的——推送超龄判定按它算')
})

test('letter：中间隔了别的 utterance 就配不上（宁漏不串）', () => {
  const state = {}
  parsePushLine(JSON.stringify({ id: 'ev_a', type: 'utterance', source: 'tool', ts: new Date(T0).toISOString(), text: '第一句' }), state)
  parsePushLine(JSON.stringify({ id: 'ev_b', type: 'utterance', source: 'tool', ts: new Date(T0).toISOString(), text: '第二句' }), state)
  const mark = JSON.stringify({ id: 'ev_m', type: 'meta', ts: new Date(T0).toISOString(), text: 'letter:2026-11-08:ev_a' })
  assert.equal(parsePushLine(mark, state), null, '标记指向 ev_a，手里是 ev_b——不硬配')
})

test('推出去的 ask 进待答表：数字映射选项，resolve 后不再拦', () =>
  withPusher(async ({ pusher, write, event }) => {
    write(event()) // 文件得先存在——首 tick 只记末尾，ready 才立起来
    await pusher.tick()
    write(JSON.stringify({ id: 'ev_ask', type: 'ask', ts: new Date(T0).toISOString(), text: '想要个算式排图的工具', ask: { kind: 'need-tool', options: ['可以', '这次不行'] } }) + '\n')
    await pusher.tick()
    assert.equal(pusher.pendingCount, 1)
    assert.deepEqual(pusher.pendingAskMatch('1'), { askId: 'ev_ask', selected: '可以' })
    assert.deepEqual(pusher.pendingAskMatch('2'), { askId: 'ev_ask', selected: '这次不行' })
    // 数字之外一律不拦——「可以」是日常词，宁可漏答不错答
    assert.equal(pusher.pendingAskMatch('可以'), null)
    assert.equal(pusher.pendingAskMatch('1 吧'), null)
    pusher.resolveAsk('ev_ask')
    assert.equal(pusher.pendingAskMatch('1'), null, '答完就不再拦')
  }))

test('ask 推失败不进待答表（重推成功才登记，防拦到没推出去的卡）', () =>
  withPusher(async ({ pusher, fail, write }) => {
    await pusher.tick() // 基线
    fail(1)
    write(JSON.stringify({ id: 'ev_ask', type: 'ask', ts: new Date(T0).toISOString(), text: '想要个工具', ask: { options: ['可以'] } }) + '\n')
    await pusher.tick()
    assert.equal(pusher.pendingCount, 0)
    write(JSON.stringify({ id: 'ev_ask', type: 'ask', ts: new Date(T0).toISOString(), text: '想要个工具', ask: { options: ['可以'] } }) + '\n')
    await pusher.tick()
    assert.equal(pusher.pendingCount, 1)
  }))

test('桥侧接线守卫：数字拦截 + /local/answer 调用都在', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../bridge.mjs', import.meta.url), 'utf8')
  // pendingAskMatch/resolveAsk 是 createPusher 实例的闭包方法——**不能**按模块导入
  // （链接期直接崩，node --check 查不出；11-08 踩过，桥重启即挂）
  assert.doesNotMatch(src, /import \{[^}]*pendingAskMatch/, '不许从 push.mjs 模块级导入实例方法')
  assert.match(src, /pusher\.pendingAskMatch\(text\)/, '拦截要走 pusher 实例')
  assert.match(src, /pusher\.resolveAsk\(hit\.askId\)/, '结算后要走实例方法清掉')
  assert.match(src, /\/dsh-fish\/local\/answer/, '要走插件 answerCard 的同一条路')
  assert.match(src, /text\.length <= 2/, '拦截必须限短消息')
  assert.match(src, /宁可漏答，不可错答/, '口径注释要在——下一个改这段的人得看到')
})
