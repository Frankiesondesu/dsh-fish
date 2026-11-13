/**
 * attachment.mjs —— 他发来的「文件」怎么认（2026-11-06）
 *
 * 用户 11-06 定的口径：**他发的所有文件，不论格式类型**（图片、视频、文档、
 * 以及以后 OneBot 冒出来的新格式），一律按「文件模式」处理 ——
 * 存到本地 `home/inbox/`，只把事实（名字 / 大小 / 路径）告诉她，
 * 看不看、怎么处理由她自己判断。系统不再按段类型分流。
 *
 * 为什么按「数据形态」而不是白名单：以前 readMessage 里 image 直传、file 落盘、
 * video 根本没人接 —— 视频整条被丢（11-06 真机）。列白名单就得永远补新类型。
 * 改成「段里带着能取回来的东西（url / file / file_id / path…）就是附件」，
 * video 自然被接住，将来冒出新格式也不用改代码。
 *
 * 两条保留：`record`（他说的话，走 ASR 转字）和 `forward` / `node`（聊天记录，
 * 走展开）不是「文件」，仍走各自原来的通路。
 *
 * 口径边界（跟项目铁律一致）：这里只做**分类和取名字**，不判断内容好不好、
 * 不替她挑哪个值得看、不承诺某个工具能打开。对她说的话必须为真（fork.13）。
 */

import { FACE_NAMES } from './face-names.mjs'

/** 明确不是附件的段。它们 data 里也可能有 url（卡片 / 分享），别拿去当文件下载。 */
const NON_ATTACHMENT = new Set([
  'text', 'at', 'face', 'reply', 'poke', 'dice', 'rps', 'shake', 'anonymous',
  'contact', 'location', 'music', 'share', 'json', 'xml', 'forward', 'node', 'record',
])

/** 已知附件类型：即便这次没带下载字段也收 —— 取不到会如实说「没到你手上」，不静默丢。 */
const KNOWN_ATTACHMENT = new Set(['image', 'mface', 'video', 'file', 'flash'])

/**
 * QQ 自带表情（face 段）的 id → 中文名。
 * 表见 face-names.mjs（从 LLOneBot 的 face_config.json 生成，289 条）。
 * 表里没有的一律退回 `[表情]`，**绝不按 id 猜**——猜错就是对她说假话（fork.13）。
 */
const FACE_NAME = new Map(Object.entries(FACE_NAMES))

const clip = (s, n = 40) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/**
 * 卡片（json 段）里能当标题的那句。
 * QQ 的卡片长得像 `{prompt:"[QQ小程序]xx", meta:{detail_1:{title:"真正的标题"}}}` ——
 * prompt 带平台前缀且常常只是应用名，**优先取 meta 里的 title/desc**，取不到才退回 prompt。
 */
function jsonTitle(raw) {
  let o
  try {
    o = JSON.parse(raw)
  } catch {
    return ''
  }
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '')
  const m = o?.meta ?? {}
  for (const k of ['detail_1', 'detail_2', 'title', 'desc']) {
    const v = m[k]
    const s = pick(v)
    if (s) return clip(s)
    if (v && typeof v === 'object') {
      for (const kk of ['title', 'desc', 'content']) {
        const t = pick(v[kk])
        if (t) return clip(t)
      }
    }
  }
  const p = pick(o?.prompt)
  if (p) return clip(p)
  if (typeof o?.title === 'string' && o.title.trim()) return clip(o.title)
  return ''
}

/** 卡片（xml 段）里取 <title>，退而求其次取 <summary>。 */
function xmlTitle(raw) {
  for (const tag of ['title', 'summary']) {
    const m = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i').exec(raw)
    if (m && m[1].trim()) return clip(m[1])
  }
  return ''
}

/**
 * 把「不是文件、但带信息」的段翻成一句可读标记（2026-11-12，用户拍板 B）。
 *
 * 以前 face / poke / share / json / xml / dice / rps / location / music / contact
 * 全被 `classifySegments` 直接跳过（注释写「其余…跳过」）。他发一个表情，她那边
 * 一个字都没有——在她看来是他没说话，实际是消息被我们吃了。
 *
 * 铁律：只说拿得到的事实。拿不到名字就 `[表情]`，解析不出标题就 `[卡片]`。
 * 返回 '' 表示「这段确实没有可说的」（reply 的正文在别处、anonymous 只是群标识）。
 */
export function markOf(seg) {
  const t = String(seg?.type ?? '')
  const d = seg?.data ?? {}
  const str = (k) => String(d[k] ?? '').trim()

  switch (t) {
    case 'face': {
      const name = FACE_NAME.get(str('id'))
      return name ? `[表情:${name}]` : '[表情]'
    }
    case 'poke':
      return '[戳一戳]'
    case 'dice':
      return str('result') ? `[骰子:${str('result')}]` : '[骰子]'
    case 'rps': {
      const r = str('result')
      const name = { 1: '石头', 2: '剪刀', 3: '布' }[r]
      return r ? `[猜拳:${name ?? r}]` : '[猜拳]'
    }
    case 'shake':
      return '[窗口抖动]'
    case 'location': {
      const title = str('title') || str('content')
      return title ? `[位置:${clip(title)}]` : '[位置]'
    }
    case 'music': {
      const title = str('title')
      const singer = str('singer')
      if (!title) return '[音乐]'
      return `[音乐:${clip(title)}${singer ? `-${clip(singer, 20)}` : ''}]`
    }
    case 'share': {
      const title = str('title')
      const url = str('url')
      if (title) return `[分享:${clip(title)}]${url ? ` ${url}` : ''}`
      return url ? `[分享] ${url}` : '[分享]'
    }
    case 'contact':
      return str('id') ? `[名片:${clip(str('id'), 20)}]` : '[名片]'
    case 'json': {
      const title = jsonTitle(str('data'))
      return title ? `[卡片:${title}]` : '[卡片]'
    }
    case 'xml': {
      const title = xmlTitle(str('data'))
      return title ? `[卡片:${title}]` : '[卡片]'
    }
    case 'markdown':
      return '[卡片]'
    // reply 只有被引用那条的 id，正文不在这一段里；anonymous 只是群匿名标识。
    // 都不产生内容，返回空——不重复、也不编。
    case 'reply':
    case 'anonymous':
      return ''
    default:
      return ''
  }
}

/** data 里出现这些字段（且非空字符串），说明它带着一个可以取回来的东西。 */
const FILE_FIELD = /^(?:url|file|file_id|file_url|path|file_path|base64)$/i

/** 这个段算不算「他发来的文件」 */
export function isAttachment(seg) {
  const t = String(seg?.type ?? '')
  if (NON_ATTACHMENT.has(t)) return false
  if (KNOWN_ATTACHMENT.has(t)) return true
  const d = seg?.data ?? {}
  return Object.keys(d).some(
    (k) => FILE_FIELD.test(k) && typeof d[k] === 'string' && d[k].trim(),
  )
}

/**
 * OneBot 消息段 → 纯文本 + 统一附件。
 * `images` 保留但恒空：下游（合批、放行条件、flush）还引用它，
 * 11-06 起不再单列图片 —— 图也是文件。
 */
export function classifySegments(segs, selfId = '') {
  const list = Array.isArray(segs) ? segs : []
  let text = ''
  let atMe = false
  const files = []
  const forwards = []
  const audios = []
  for (const s of list) {
    const t = s?.type
    if (t === 'text') text += String(s.data?.text ?? '')
    else if (t === 'at') {
      if (String(s.data?.qq) === String(selfId)) atMe = true
    } else if (t === 'record') audios.push(s)
    else if (t === 'forward' || t === 'node') forwards.push(s)
    else if (isAttachment(s)) files.push({ ...s, _kind: t })
    // 2026-11-12（用户 m0xxxx）：不是文件、但带信息的段要翻成一句标记，不能静默丢——
    // 他发个表情，她那边一个字都没有，在她看来就是「他没说话」。
    else text += markOf(s)
  }
  // mface 有时没有 url，只有一句 summary（「[动画表情]」），拿它当文字兜底
  if (!text && files.length) {
    const sum = files.map((s) => String(s?.data?.summary ?? '')).filter(Boolean).join(' ')
    if (sum) text = sum
  }
  return { text: text.trim(), atMe, images: [], files, forwards, audios }
}

/** 从段里挑一个像样的展示名。QQ 常把文件名塞在 name / file / url 里。 */
export function displayName(seg) {
  const d = seg?.data ?? {}
  for (const c of [d.name, d.filename, d.file_name, d.file, d.path, d.url]) {
    const s = String(c ?? '').trim()
    if (!s) continue
    const clean = s.split(/[?#]/)[0].replace(/^.*[\\/]/, '')
    if (clean) return clean
  }
  // _kind 是 classifySegments 打上的；直接拿原始段调用时退回 type，别一律叫「文件」
  return `${String(seg?._kind ?? seg?.type ?? '文件')}-${Date.now()}`
}

/**
 * 没后缀时按内容补一个 —— 视频 / 图片段常常只给一串 hash，
 * 落盘没后缀她就没法判断那是什么，等于把「自己判断」架空了。
 * 返回要补的后缀（已有后缀时返回 ''）。
 */
export function guessExt(name, buf, kind = '') {
  if (/\.[a-z0-9]{1,8}$/i.test(String(name ?? ''))) return ''
  const b = buf
  if (b && b.length >= 12) {
    const s = (a, z) => b.subarray(a, z).toString('latin1')
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg'
    if (s(0, 4) === '\x89PNG') return '.png'
    if (s(0, 3) === 'GIF') return '.gif'
    if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return '.webp'
    if (s(4, 8) === 'ftyp') return '.mp4' // mp4 / mov / m4v 都是 ftyp
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return '.mkv'
    if (s(0, 4) === '%PDF') return '.pdf'
    // docx / xlsx / apk 也是 PK 头；它们一般自带名字，轮不到这里猜
    if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return '.zip'
    if (s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return '.mp3'
    if (s(0, 4) === 'OggS') return '.ogg'
    if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return '.wav'
  }
  if (kind === 'image' || kind === 'mface') return '.jpg'
  if (kind === 'video') return '.mp4'
  return '.bin'
}

export function ensureExt(name, buf, kind = '') {
  const ext = guessExt(name, buf, kind)
  return ext ? `${name}${ext}` : name
}
