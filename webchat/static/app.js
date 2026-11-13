/* 网页对话前端（2026-11-12；QQ 风格 + 完整聊天：图片/视频文件/定位/她的申请卡/语音/信）。
 * 独立文件、不在模板字符串里——node --test 里有 node --check 兜着（踩过内嵌 JS 的坑）。
 * 协议：
 *   auth → auth-ok(token,history) / auth-fail
 *   chat {text, image?, uploadId?} → sent；answer {askId, selected} → answer-result
 *   服务端推：say（say/proactive/watch/letter/me 本地回显）/ media（voice/meme）/ ask
 */
'use strict'

const KIND_LABEL = {
  say: '她说', proactive: '她主动说', watch: '陪你看',
  letter: '她留了封信', voice: '她的语音', meme: '她的表情',
}

const $status = document.getElementById('status')
const $log = document.getElementById('log')
const $form = document.getElementById('form')
const $input = document.getElementById('input')
const $send = document.getElementById('send')
const $imgInput = document.getElementById('img-input')
const $fileInput = document.getElementById('file-input')

let ws = null
let password = sessionStorage.getItem('webchat-password') || ''
let token = ''
let lastTs = 0
const askButtons = new Map() // askId → 按钮数组（答完禁用）

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function mediaUrl(p) {
  return '/media?token=' + encodeURIComponent(token) + '&path=' + encodeURIComponent(p)
}

/* QQ 的习惯：两条消息隔了 3 分钟以上，中间插一行居中的时间 */
function addDivider(ts) {
  const t = Date.parse(ts || '')
  if (Number.isFinite(t) && lastTs && t - lastTs < 3 * 60 * 1000) return
  if (!Number.isFinite(t) || !ts) return
  const div = document.createElement('div')
  div.className = 'divider'
  div.textContent = fmtTime(ts)
  $log.appendChild(div)
}

function makeRow(her) {
  const row = document.createElement('div')
  row.className = 'row ' + (her ? 'her' : 'me')
  const avatar = document.createElement('span')
  avatar.className = 'avatar ' + (her ? 'her' : 'me')
  avatar.textContent = her ? '她' : '我'
  const col = document.createElement('div')
  col.className = 'col'
  row.appendChild(avatar)
  row.appendChild(col)
  return { row, col }
}

function finishRow(row) {
  $log.appendChild(row)
  row.scrollIntoView({ block: 'end' })
}

/* 她的正文里可能嵌 ![图](路径)（她自己会贴）；路径经 /media 鉴权后展示 */
function fillBubble(bubble, text) {
  const parts = String(text).split(/!\[[^\]]*\]\(([^)]+)\)/g)
  for (let i = 0; i < parts.length; i++) {
    const piece = parts[i]
    if (i % 2 === 1) {
      if (!piece) continue
      const a = document.createElement('a')
      a.href = mediaUrl(piece)
      a.target = '_blank'
      a.rel = 'noopener'
      const img = document.createElement('img')
      img.className = 'chat-img'
      img.alt = '她发的图'
      img.src = mediaUrl(piece)
      a.appendChild(img)
      bubble.appendChild(a)
    } else if (piece) {
      const span = document.createElement('span')
      span.textContent = piece
      bubble.appendChild(span)
    }
  }
}

function herTextBubble(kind, text, ts) {
  addDivider(ts)
  const { row, col } = makeRow(true)
  const meta = document.createElement('div')
  meta.className = 'meta'
  meta.textContent = KIND_LABEL[kind] || '她说'
  col.appendChild(meta)
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  fillBubble(bubble, text)
  col.appendChild(bubble)
  finishRow(row)
}

function herMedia(kind, path, ts) {
  addDivider(ts)
  const { row, col } = makeRow(true)
  const meta = document.createElement('div')
  meta.className = 'meta'
  meta.textContent = KIND_LABEL[kind] || '她发的东西'
  col.appendChild(meta)
  if (kind === 'voice') {
    const audio = document.createElement('audio')
    audio.controls = true
    audio.src = mediaUrl(path)
    col.appendChild(audio)
  } else {
    const a = document.createElement('a')
    a.href = mediaUrl(path)
    a.target = '_blank'
    a.rel = 'noopener'
    const img = document.createElement('img')
    img.className = 'chat-img'
    img.alt = KIND_LABEL[kind] || '她发的东西'
    img.src = mediaUrl(path)
    a.appendChild(img)
    col.appendChild(a)
  }
  finishRow(row)
}

function herAsk(m) {
  addDivider(m.ts)
  const { row, col } = makeRow(true)
  const meta = document.createElement('div')
  meta.className = 'meta'
  meta.textContent = '她想问你'
  col.appendChild(meta)
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  bubble.textContent = m.question
  col.appendChild(bubble)
  if ((m.options ?? []).length) {
    const box = document.createElement('div')
    box.className = 'ask-options'
    const buttons = []
    m.options.forEach((opt, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ask-btn'
      b.textContent = (i + 1) + '. ' + opt
      b.addEventListener('click', () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return
        ws.send(JSON.stringify({ type: 'answer', askId: m.askId, selected: opt }))
        setStatus('答她：' + opt, true)
      })
      buttons.push(b)
      box.appendChild(b)
    })
    if (m.askId) askButtons.set(m.askId, buttons)
    col.appendChild(box)
    const hint = document.createElement('div')
    hint.className = 'meta'
    hint.textContent = '点选项就答了；想说别的直接说，她能收到。'
    col.appendChild(hint)
  } else {
    const hint = document.createElement('div')
    hint.className = 'meta'
    hint.textContent = '这题没有预设选项——直接打字回她。'
    col.appendChild(hint)
  }
  finishRow(row)
}

function meBubble(text, ts) {
  addDivider(ts)
  const { row, col } = makeRow(false)
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  bubble.textContent = text
  col.appendChild(bubble)
  finishRow(row)
}

/* 自己发的图/视频在本地回显一张预览——纯界面，不经过 WS、不递给她、不替她判断 */
function meMediaBubble(file, caption, ts) {
  addDivider(ts)
  const { row, col } = makeRow(false)
  if (caption) {
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.textContent = caption
    col.appendChild(bubble)
  }
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.textContent = '（发了文件：' + (file.name || '文件') + '）'
    col.appendChild(bubble)
    finishRow(row)
    return
  }
  const url = URL.createObjectURL(file)
  const el = document.createElement(file.type.startsWith('image/') ? 'img' : 'video')
  el.className = file.type.startsWith('image/') ? 'chat-img' : 'chat-video'
  if (el.tagName === 'IMG') el.alt = file.name || '我发的图'
  else el.controls = true
  el.src = url
  col.appendChild(el)
  finishRow(row)
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

function renderItem(m) {
  if (m.type === 'say') {
    if (m.kind === 'me') meBubble(m.text, m.ts)
    else herTextBubble(m.kind, m.text, m.ts)
  } else if (m.type === 'media') {
    herMedia(m.kind, m.path, m.ts)
  } else if (m.type === 'ask') {
    herAsk(m)
  }
}

function disableAsk(askId) {
  const buttons = askButtons.get(askId)
  if (!buttons) return
  for (const b of buttons) b.disabled = true
  askButtons.delete(askId)
}

function setStatus(s, ok) {
  $status.textContent = s
  $status.className = ok ? 'ok' : 'err'
}

function enableInput(on) {
  $input.disabled = !on
  $send.disabled = !on
}

function askPassword() {
  password = window.prompt('本机免密；这台机器不是本机的话，输入 config.json 里的密码：', '') || ''
  sessionStorage.setItem('webchat-password', password)
  connect()
}

function connect() {
  setStatus('连接中…', false)
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(proto + '://' + location.host + '/ws')
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', password }))
  }
  ws.onmessage = (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.type === 'auth-ok') {
      token = msg.token || ''
      setStatus('已连接（她的新话会实时出现）', true)
      enableInput(true)
      $log.textContent = ''
      lastTs = 0
      askButtons.clear()
      if (Array.isArray(msg.history)) {
        for (const it of msg.history) renderItem(it)
      }
      if (!password) sessionStorage.setItem('webchat-password', '')
    } else if (msg.type === 'auth-fail') {
      setStatus('没连上：' + (msg.note || '要密码'), false)
      enableInput(false)
      if (!password) askPassword()
      else {
        password = ''
        sessionStorage.removeItem('webchat-password')
        askPassword()
      }
      try { ws.close() } catch { /* 已断就算了 */ }
    } else if (msg.type === 'say' || msg.type === 'media' || msg.type === 'ask') {
      renderItem(msg)
    } else if (msg.type === 'sent') {
      setStatus(msg.ok ? '已递到她那里（她想说才说）' : '没送到：' + (msg.note || ''), msg.ok)
    } else if (msg.type === 'answer-result') {
      if (msg.ok) {
        disableAsk(msg.askId)
        setStatus('答过去了：' + (msg.selected || ''), true)
      } else {
        setStatus('没答成：' + (msg.note || ''), false)
      }
    } else if (msg.type === 'pong') {
      /* 心跳回执，不用渲染 */
    }
  }
  ws.onclose = () => {
    setStatus('断线了，3 秒后重连…', false)
    enableInput(false)
    setTimeout(connect, 3000)
  }
  ws.onerror = () => setStatus('连接出错', false)
}

/* 图片走 /local/say 的 image 通路（她被教过用 read_image 看）；
 * 7MB 以上或视频/其他文件走上传 → 收件箱 → 只报事实（与桥的文件模式同一口径） */
async function sendImage(file) {
  const caption = $input.value.trim()
  if (file.size <= 7 * 1024 * 1024) {
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result)
      r.onerror = () => reject(new Error('读不出这张图'))
      r.readAsDataURL(file)
    })
    meMediaBubble(file, caption, new Date().toISOString())
    ws.send(JSON.stringify({ type: 'chat', text: caption, image: dataUrl }))
  } else {
    await sendFile(file, caption)
    return
  }
  $input.value = ''
  setStatus('递话中…她这一轮可能要好一会儿', true)
}

async function sendFile(file, caption) {
  setStatus('传文件中：' + file.name, true)
  const r = await fetch('/upload?token=' + encodeURIComponent(token) +
    '&name=' + encodeURIComponent(file.name), { method: 'POST', body: file })
  const j = await r.json().catch(() => ({}))
  if (!j.ok) {
    setStatus('没传上：' + (j.error || ('HTTP ' + r.status)), false)
    return
  }
  meMediaBubble(file, caption, new Date().toISOString())
  ws.send(JSON.stringify({ type: 'chat', text: caption, uploadId: j.uploadId }))
  $input.value = ''
  setStatus('递话中…她这一轮可能要好一会儿', true)
}

function sendLocation() {
  if (!navigator.geolocation) {
    setStatus('这个浏览器拿不到定位', false)
    return
  }
  setStatus('拿定位中…', true)
  navigator.geolocation.getCurrentPosition((pos) => {
    const lat = pos.coords.latitude.toFixed(6)
    const lon = pos.coords.longitude.toFixed(6)
    const acc = Math.round(pos.coords.accuracy || 0)
    const text = '（我的位置）经纬度 ' + lat + ', ' + lon + '（大概 ±' + acc + ' 米）。' +
      '高德地图：https://uri.amap.com/marker?position=' + lon + ',' + lat + '&name=我的位置'
    meBubble(text, new Date().toISOString())
    ws.send(JSON.stringify({ type: 'chat', text }))
    setStatus('递话中…她这一轮可能要好一会儿', true)
  }, (err) => {
    setStatus('定位没拿到：' + (err.message || err.code), false)
  }, { enableHighAccuracy: true, timeout: 10000 })
}

$form.addEventListener('submit', (ev) => {
  ev.preventDefault()
  const text = $input.value.trim()
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return
  meBubble(text, new Date().toISOString())
  ws.send(JSON.stringify({ type: 'chat', text }))
  $input.value = ''
  setStatus('递话中…她这一轮可能要好一会儿', true)
})

document.getElementById('btn-image').addEventListener('click', () => $imgInput.click())
document.getElementById('btn-file').addEventListener('click', () => $fileInput.click())
document.getElementById('btn-loc').addEventListener('click', sendLocation)

$imgInput.addEventListener('change', () => {
  const f = $imgInput.files && $imgInput.files[0]
  $imgInput.value = ''
  if (f && ws && ws.readyState === WebSocket.OPEN) void sendImage(f)
})

$fileInput.addEventListener('change', () => {
  const f = $fileInput.files && $fileInput.files[0]
  $fileInput.value = ''
  if (f && ws && ws.readyState === WebSocket.OPEN) void sendFile(f, $input.value.trim())
})

connect()
