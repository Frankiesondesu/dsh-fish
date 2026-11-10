/**
 * bili.js —— B 站只读客户端（她"刷站"的唯一入口）
 *
 * 为什么不用第三方库：插件不能有 dependencies（避坑指南：多装一个包就可能把旧核心包拖进来）。
 * 所以这里只用 Node 内置的 fetch + crypto + zlib。
 *
 * 实测结论（2026-10-22 在本机逐条探过，见 04-小工具/bili-probe/probe*.mjs）：
 *   ✅ 无需登录：popular / ranking / view / reply(type=1&oid=aid) / tags / related
 *                / popular/precious / 弹幕 xml(oid=cid, deflate-raw)
 *   ⚠️ 需 wbi 签名：search/**、space/**、player/wbi/v2
 *        —— 不签名会拿到 -412「request was banned」；签名后**不带 cookie 也能用**
 *   ⚠️ 需 buvid：/x/frontend/finger/spi 拿 buvid3/buvid4，带上能显著降低被风控概率
 *   ❌ 需登录：字幕（AI 字幕）、AI 总结、空间页 arc/search、历史/收藏
 *        —— 所以 P2 **不依赖字幕**，她"看视频"靠的是 标题/简介/标签/热评/弹幕
 *
 * 设计约束：
 *   1. **永不抛出**。任何方法都返回 { ok, data, code, message }。一次失败不能污染唤醒流程。
 *   2. **限流**。串行 + 最小间隔（默认 800ms + 0–500ms 抖动，设置页可调），
 *      避免把本机 IP 刷成 -412。机房 IP 需要更慢——所以间隔不写死。
 *   3. **风控熔断**（issue #5 重做）。读/写两级分开，读 60 秒起、写 5 分钟起，
 *      连续复发才翻倍；**只关自己那一级**。签名接口的 -412 先当"密钥过期"重试一次，
 *      仍失败才算真风控。以前是一刀切 30 分钟全局冷却，一次偶发失败能把插件打死半天。
 *   4. **不下载视频**。只读元数据与文本——没有版权面，也不需要 1GB 转写模型。
 *
 * fork.29（2026-11-03）：原来 842 行的单文件按职责拆成三层，**函数体逐字节原样搬移**：
 *   bili-risk.js    限速 + 风控熔断（模块级状态）
 *   bili-sign.js    wbi 签名 + 文本小工具（纯函数）
 *   bili-danmaku.js 弹幕解析与采样（纯函数）
 * 本文件只剩 createClient 与它自己的两个私有函数，并把搬走的导出**原样 re-export**，
 * 所以所有 from ./bili.js 的调用方一处都不用改。
 */

import { inflateRawSync, inflateSync, gunzipSync } from 'node:zlib'
import { RISK, RISK_CODES, PACE, noteRisk, noteOk, fmtWait } from './bili-risk.js'
import { mixinKey, signQuery, stripEm, fmtDur, normalizeCookie } from './bili-sign.js'
import { parseDanmaku, sampleDanmaku } from './bili-danmaku.js'

// 搬走的导出全部原样转出去：调用方与测试的 import 路径保持不变
export {
  setPacing, getPacing, resetRisk, inCooldown, cooldownLeft, memoryCooldown,
} from './bili-risk.js'
export { mixinKey, signQuery, unescapeHtml, stripEm, fmtDur, normalizeCookie } from './bili-sign.js'
export { parseDanmaku, sampleDanmaku } from './bili-danmaku.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const API = 'https://api.bilibili.com'

// issue #67：排队状态提到模块级。翻视频、查回复、看画面各自 new 一个 client，
// 原来各排各的，等于没排队；现在共用一条链。
const PACE_STATE = { lastReq: 0, chain: Promise.resolve() }
/**
 * 建一个客户端。fetch 可注入（单测不打真网）。
 */
export function createClient(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const now = opts.now ?? (() => Date.now())
  // 间隔与抖动（issue #5：要可配）。显式传了就听传入的；没传就**运行时**读 PACE——
  // 这样设置页改完不需要重建客户端，已经在排队的请求也会用新节奏。
  const minInt = () => {
    const v = Number(opts.minIntervalMs)
    return Number.isFinite(v) && v > 0 ? v : PACE.minIntervalMs
  }
  const jitInt = () => {
    if (opts.jitterMs !== undefined && opts.jitterMs !== null) {
      const v = Number(opts.jitterMs)
      return Number.isFinite(v) && v >= 0 ? v : PACE.jitterMs
    }
    return PACE.jitterMs
  }
  const rnd = opts.random ?? Math.random
  const timeoutMs = opts.timeoutMs ?? 12_000
  const logger = opts.log ?? (() => {})

  let cookie = normalizeCookie(opts.cookie)
  let buvid = ''
  let buvidFailAt = 0
  let mk = ''
  let mkAt = 0

  /** 串行 + 最小间隔 + 随机抖动：所有请求排队，避免并发把 IP 刷红 */
  function throttle(fn) {
    const run = PACE_STATE.chain.then(async () => {
      const gap = minInt() + Math.floor(rnd() * Math.max(0, jitInt()))
      const wait = gap - (now() - PACE_STATE.lastReq)
      // PR #75：队列共用之后，上一条可能是另一个时钟的客户端发的（测试注入 now、
      // 系统时间回拨），算出的间隔会是负的。那时只等一个间隔，不照差值等满。
      const pause = wait > 0 ? Math.min(wait, gap) : 0
      if (pause > 0) await new Promise((r) => setTimeout(r, pause))
      PACE_STATE.lastReq = now()
      return fn()
    })
    PACE_STATE.chain = run.catch(() => {})
    return run
  }

  function cookieHeader() {
    const parts = []
    if (buvid) parts.push(buvid)
    if (cookie) parts.push(cookie)
    return parts.join('; ')
  }

  async function raw(url, { referer, cookieOverride, method = 'GET', body } = {}) {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const r = await fetchImpl(url, {
        method,
        signal: ctl.signal,
        body,
        headers: {
          'user-agent': UA,
          referer: referer ?? 'https://www.bilibili.com/',
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9',
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(cookieOverride !== null && cookieHeader() ? { cookie: cookieOverride ?? cookieHeader() } : {}),
        },
      })
      return r
    } finally {
      clearTimeout(t)
    }
  }

  /**
   * csrf 令牌 = cookie 里的 bili_jct。**没有它所有写操作都会被拒**（-111 / -101）。
   * 从 cookie 串里抠出来，不从别处拿 —— 它是登录凭据的一部分，不单独存。
   */
  function csrf() {
    const m = /(?:^|;\s*)bili_jct=([^;]+)/.exec(String(cookie ?? ''))
    return m ? m[1] : ''
  }

  /**
   * 写操作统一出口（发评论 / 回复评论 / 点赞）。**全部走 POST 表单**。
   *
   * 三条硬约束（写操作比读操作危险得多）：
   *   1. **必须登录**：没 cookie 一律返回 NOT_LOGIN，不试探。
   *   2. **必须有 csrf**：取不到就 NO_CSRF，不发请求（发了也只会拿到 -111）。
   *   3. **风控冷却期间宁可不写**：写操作被风控的代价远大于少发一条评论。
   */
  async function apiPost(path, form = {}, o = {}) {
    if (!cookie) return { ok: false, code: 'NOT_LOGIN', message: '没有登录凭据', data: null }
    const token = csrf()
    if (!token) return { ok: false, code: 'NO_CSRF', message: 'cookie 里没有 bili_jct，写不了', data: null }
    if (now() < RISK.write.until) {
      return { ok: false, code: 'COOLDOWN', message: `B站风控冷却中，还要约 ${fmtWait(RISK.write.until - now())}才能写`, data: null }
    }
    try {
      const body = new URLSearchParams({ ...form, csrf: token, csrf_token: token }).toString()
      const r = await throttle(() => raw(API + path, { referer: o.referer, method: 'POST', body }))
      const text = await r.text()
      let j
      try {
        j = JSON.parse(text)
      } catch {
        return { ok: false, code: 'BAD_JSON', message: `非 JSON（HTTP ${r.status}）`, data: null }
      }
      if (j?.code !== 0) {
        if (RISK_CODES.has(j?.code)) {
          const ms = noteRisk('write', now())
          logger(`写操作风控 ${j?.code}，${fmtWait(ms)}后再试`)
        }
        return { ok: false, code: j?.code, message: j?.message ?? String(j?.code), data: null }
      }
      noteOk('write')
      return { ok: true, code: 0, message: 'OK', data: j?.data ?? null }
    } catch (err) {
      return { ok: false, code: 'NETWORK', message: String(err?.message ?? err), data: null }
    }
  }

  /** 拿 buvid3/buvid4（不带它搜索容易被 -412） */
  async function ensureBuvid() {
    if (buvid) return true
    // 拿不到就 10 分钟内别再试：普通接口每次请求前都会走到这里，失败不能让请求数翻倍
    if (buvidFailAt && now() - buvidFailAt < 10 * 60_000) return false
    try {
      const r = await throttle(() => raw(`${API}/x/frontend/finger/spi`))
      const j = await r.json()
      const b3 = j?.data?.b_3
      const b4 = j?.data?.b_4
      if (!b3) { buvidFailAt = now(); return false }
      buvid = `buvid3=${b3}${b4 ? `; buvid4=${b4}` : ''}`
      return true
    } catch (err) {
      buvidFailAt = now()
      logger('buvid failed', err?.message ?? err)
      return false
    }
  }

  /** 拿 wbi 密钥（缓存 6 小时；密钥按天轮换） */
  async function ensureMk(force = false) {
    if (!force && mk && now() - mkAt < 6 * 3600_000) return true
    try {
      await ensureBuvid()
      const r = await throttle(() => raw(`${API}/x/web-interface/nav`))
      const j = await r.json()
      const w = j?.data?.wbi_img ?? {}
      const imgKey = String(w.img_url ?? '').split('/').pop().split('.')[0]
      const subKey = String(w.sub_url ?? '').split('/').pop().split('.')[0]
      if (!imgKey || !subKey) return false
      mk = mixinKey(imgKey, subKey)
      mkAt = now()
      return true
    } catch (err) {
      logger('wbi failed', err?.message ?? err)
      return false
    }
  }

  /**
   * 统一出口：GET 一个 JSON 接口，吞掉所有异常。
   * @param {string} path 以 / 开头
   * @param {object} params
   * @param {{signed?:boolean, referer?:string, label?:string}} o
   */
  async function api(path, params = {}, o = {}) {
    if (now() < RISK.read.until) {
      return {
        ok: false,
        code: 'COOLDOWN',
        message: `风控冷却中，${fmtWait(RISK.read.until - now())}后再试`,
        data: null,
      }
    }
    try {
      let url = API + path
      if (o.signed) {
        if (!(await ensureMk(o.forceMk))) return { ok: false, code: 'NO_WBI', message: '取不到签名密钥', data: null }
        url += `?${signQuery(params, mk, Math.floor(now() / 1000))}`
      } else {
        // 不签名的接口也要带 buvid3（2026-10-29 实测）：一个 cookie 都不带时，
        // /x/web-interface/view 多半直接回 -412，读熔断随即把这一轮的标签/热评/弹幕全关掉，
        // 定时刷站拼出来的素材只剩标题和播放量。带上匿名 buvid 就正常，不需要登录。
        if (!/(?:^|;\s*)buvid3=/.test(cookie)) await ensureBuvid()
        const q = Object.keys(params)
          .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
          .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
          .join('&')
        if (q) url += `?${q}`
      }
      const r = await throttle(() => raw(url, { referer: o.referer }))
      const text = await r.text()
      let j
      try {
        j = JSON.parse(text)
      } catch {
        return { ok: false, code: 'BAD_JSON', message: `非 JSON（HTTP ${r.status}）`, data: null }
      }
      const code = j?.code
      if (code !== 0) {
        if (RISK_CODES.has(code)) {
          /**
           * 签名接口的 -412 有两种原因：真的被风控；以及 wbi 密钥过期/换了。
           * 后者换一次密钥重试就能好（密钥按天轮换，进程开着一整天就会踩到）。
           * 以前一律当风控处理 → 整整半小时所有接口全死。issue #5 的第一现场。
           * 所以：签名接口先强制刷一次密钥重试；仍失败才认作真风控。
           */
          if (o.signed && !o.retried) {
            logger(`签名接口 ${code}，刷新 wbi 后重试一次`)
            return api(path, params, { ...o, forceMk: true, retried: true })
          }
          const ms = noteRisk('read', now())
          logger(`风控代码 ${code}，${fmtWait(ms)}内不再请求`)
        }
        return { ok: false, code, message: j?.message ?? String(code), data: null }
      }
      noteOk('read')
      return { ok: true, code: 0, message: 'OK', data: j?.data ?? null }
    } catch (err) {
      return { ok: false, code: 'NETWORK', message: String(err?.message ?? err), data: null }
    }
  }

  // ---------------- 具体接口 ----------------

  /** 热门：全站综合热门 */
  async function popular(ps = 20) {
    const r = await api('/x/web-interface/popular', { ps: Math.min(50, ps), pn: 1 })
    return r.ok ? { ...r, data: (r.data?.list ?? []).map(toVideo) } : { ...r, data: [] }
  }

  /** 排行榜：rid=0 全站，其它是分区 */
  async function ranking(rid = 0, type = 'all') {
    const r = await api('/x/web-interface/ranking/v2', { rid, type })
    return r.ok ? { ...r, data: (r.data?.list ?? []).map(toVideo) } : { ...r, data: [] }
  }

  /** 入站必刷（老片，自带"时间感"） */
  async function precious(pageSize = 20) {
    const r = await api('/x/web-interface/popular/precious', { page_size: Math.min(50, pageSize), page: 1 })
    return r.ok ? { ...r, data: (r.data?.list ?? []).map(toVideo) } : { ...r, data: [] }
  }

  /** 搜索（必须签名） */
  async function search(keyword, { page = 1, pageSize = 10 } = {}) {
    const kw = String(keyword ?? '').trim().slice(0, 40)
    if (!kw) return { ok: false, code: 'EMPTY', message: '关键词是空的', data: [] }
    const r = await api(
      '/x/web-interface/search/type',
      { search_type: 'video', keyword: kw, page, page_size: Math.min(20, pageSize) },
      { signed: true, referer: `https://search.bilibili.com/all?keyword=${encodeURIComponent(kw)}` },
    )
    if (!r.ok) return { ...r, data: [] }
    const list = (r.data?.result ?? []).map((v) => ({ ...toVideo(v), title: stripEm(v.title) }))
    return { ...r, data: list }
  }

  /** 相关推荐（"她看完一条，平台又推给她什么"） */
  async function related(bvid, limit = 10) {
    const r = await api('/x/web-interface/archive/related', { bvid })
    return r.ok ? { ...r, data: (r.data ?? []).slice(0, limit).map(toVideo) } : { ...r, data: [] }
  }

  /** 视频详情（简介全文在这里） */
  async function view(bvid) {
    const r = await api('/x/web-interface/view', { bvid })
    if (!r.ok) return r
    const d = r.data ?? {}
    return {
      ok: true,
      code: 0,
      message: 'OK',
      data: {
        ...toVideo(d),
        desc: String(d.desc ?? ''),
        pubdate: d.pubdate ? new Date(d.pubdate * 1000).toISOString() : null,
        cid: d.pages?.[0]?.cid ?? null,
        replyCount: d.stat?.reply ?? 0,
      },
    }
  }

  /** 标签（比标题更能说明"这是什么") */
  async function tags(bvid) {
    const r = await api('/x/tag/archive/tags', { bvid })
    return r.ok ? { ...r, data: (r.data ?? []).map((t) => t.tag_name).filter(Boolean) } : { ...r, data: [] }
  }

  /**
   * 评论。sort=1 按时间，sort=2 按热度。
   * 注意：oid 要传 **aid**（数字），传 bvid 会 -404「啥都木有」。
   */
  async function replies(aid, { sort = 2, ps = 10, pn = 1 } = {}) {
    const r = await api('/x/v2/reply', { type: 1, oid: aid, sort, ps: Math.min(20, ps), pn })
    if (!r.ok) return { ...r, data: [] }
    const list = (r.data?.replies ?? []).map((x) => ({
      rpid: Number(x.rpid) || 0,
      mid: Number(x.mid) || 0,
      like: Number(x.like) || 0,
      user: x.member?.uname ?? '',
      text: String(x.content?.message ?? ''),
      replies: Number(x.rcount) || 0,
      ctime: Number(x.ctime) || 0,
    }))
    return { ...r, data: list, total: r.data?.page?.count ?? 0 }
  }

  /**
   * 某条评论下面的楼中楼（只支持两层，B 站就两层）。
   * root 是**那条主评论的 rpid**（不是 aid）。
   *
   * 回包里的 `data.root` 是那条主评论本身，这里带出 `root: { rpid, mid }`（issue #63）：
   * 下面 `data` 换成了回复数组，不单独带出来，调用方就再也拿不到楼主。查她自己的
   * 评论楼时，楼主就是她发那条评论用的号，没记下登录号时靠它认她自己。回包里没有就是 null。
   */
  async function subReplies(aid, rootRpid, { ps = 20, pn = 1 } = {}) {
    const r = await api('/x/v2/reply/reply', { type: 1, oid: aid, root: rootRpid, ps: Math.min(20, ps), pn })
    if (!r.ok) return { ...r, data: [], root: null }
    const list = (r.data?.replies ?? []).map((x) => ({
      rpid: Number(x.rpid) || 0,
      mid: Number(x.mid) || 0,
      user: x.member?.uname ?? '',
      text: String(x.content?.message ?? ''),
      ctime: Number(x.ctime) || 0,
    }))
    const top = r.data?.root
    const root = top && typeof top === 'object' ? { rpid: Number(top.rpid) || 0, mid: Number(top.mid) || 0 } : null
    return { ...r, data: list, root, total: r.data?.page?.count ?? 0 }
  }

  /**
   * 弹幕。oid 要传 **cid**（不是 aid，不是 bvid）。
   * 返回 deflate-raw 压缩的 XML，需要手动解压。
   */
  async function danmaku(cid) {
    if (!cid) return { ok: false, code: 'NO_CID', message: '没有 cid', data: [] }
    if (now() < RISK.read.until) {
      return { ok: false, code: 'COOLDOWN', message: `风控冷却中，${fmtWait(RISK.read.until - now())}后再试`, data: [] }
    }
    try {
      const r = await throttle(() =>
        raw(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, {
          referer: 'https://www.bilibili.com/',
        }),
      )
      const buf = Buffer.from(await r.arrayBuffer())
      let xml = ''
      for (const fn of [inflateRawSync, inflateSync, gunzipSync]) {
        try {
          xml = fn(buf).toString('utf8')
          break
        } catch {
          /* 换下一种 */
        }
      }
      if (!xml) xml = buf.toString('utf8')
      return { ok: true, code: 0, message: 'OK', data: parseDanmaku(xml) }
    } catch (err) {
      return { ok: false, code: 'NETWORK', message: String(err?.message ?? err), data: [] }
    }
  }

  /**
   * 字幕（需要登录）。P2 不依赖它，但保留：一旦用户把有效 cookie 填进来，
   * 她就能读到官方/AI 字幕，比弹幕扎实得多。
   */
  async function subtitle(bvid, cid) {
    const r = await api('/x/player/wbi/v2', { bvid, cid }, { signed: true })
    if (!r.ok) return { ...r, data: [] }
    const subs = r.data?.subtitle?.subtitles ?? []
    if (!subs.length) return { ok: false, code: 'NO_SUB', message: '这条没有字幕轨（或需要登录）', data: [] }
    const out = []
    for (const s of subs.slice(0, 2)) {
      const url = String(s.subtitle_url ?? '')
      if (!url.startsWith('http')) continue
      try {
        const rr = await throttle(() => raw(url))
        const j = await rr.json()
        for (const line of j?.body ?? []) {
          out.push({ t: Number(line.from) || 0, text: String(line.content ?? '').trim() })
        }
      } catch {
        /* 单轨失败不影响其它 */
      }
      if (out.length) break
    }
    return out.length
      ? { ok: true, code: 0, message: 'OK', data: out }
      : { ok: false, code: 'NO_SUB', message: '字幕拉取失败', data: [] }
  }

  /** 是否登录（只用于观测台显示"能不能读字幕"，不参与 persona） */
  async function whoami() {
    const r = await api('/x/web-interface/nav')
    return {
      ok: Boolean(r.ok),
      isLogin: Boolean(r.data?.isLogin),
      uname: r.data?.uname ?? '',
      mid: r.data?.mid ?? 0,
    }
  }

  /**
   * 发一条评论（在视频下面）。**写操作，需要登录 cookie + bili_jct**。
   *
   * @param {number} aid 视频 aid（不是 bvid —— bvid 会 -404）
   * @param {string} message 正文
   * @returns {Promise<{ok:boolean, code:any, message:string, data:{rpid:number}|null}>}
   */
  async function replyAdd(aid, message) {
    const msg = String(message ?? '').trim()
    if (!msg) return { ok: false, code: 'EMPTY', message: '评论是空的', data: null }
    if (msg.length > 1000) return { ok: false, code: 'TOO_LONG', message: '太长了（B 站上限 1000 字）', data: null }
    const r = await apiPost('/x/v2/reply/add', { oid: aid, type: 1, message: msg, plat: 1 }, {
      referer: `https://www.bilibili.com/video/av${aid}`,
    })
    if (!r.ok) return r
    return { ok: true, code: 0, message: 'OK', data: { rpid: Number(r.data?.rpid) || 0 } }
  }

  /**
   * 回复**别人的一条评论**（楼中楼）。
   *
   * 参数必须是两个不同的 rpid：
   *   root   = 这条楼的**主评论** rpid（她那条评论本身）
   *   parent = 要回的那一条 rpid
   * 传错（比如两个都传主评论）B 站不会报错，但回复会平铺在主楼下而不是挂在被回复者下面
   * —— 看起来像"她对着空气说话"，很容易被当成"没回"。
   */
  async function replyReply(aid, rootRpid, parentRpid, message) {
    const msg = String(message ?? '').trim()
    if (!msg) return { ok: false, code: 'EMPTY', message: '回复是空的', data: null }
    if (msg.length > 1000) return { ok: false, code: 'TOO_LONG', message: '太长了（B 站上限 1000 字）', data: null }
    if (!rootRpid || !parentRpid) return { ok: false, code: 'NO_TARGET', message: '不知道在回哪一条', data: null }
    const r = await apiPost('/x/v2/reply/add', {
      oid: aid, type: 1, message: msg, root: rootRpid, parent: parentRpid, plat: 1,
    }, { referer: `https://www.bilibili.com/video/av${aid}` })
    if (!r.ok) return r
    return { ok: true, code: 0, message: 'OK', data: { rpid: Number(r.data?.rpid) || 0 } }
  }

  /** 是否已登录 + mid（写操作前的自检，观测台也用它显示"能不能发"） */
  async function me() {
    if (!cookie) return { ok: false, isLogin: false, mid: 0, uname: '', canWrite: false, why: '没有 cookie' }
    const w = await whoami()
    return { ...w, canWrite: Boolean(w.isLogin && csrf()), why: w.isLogin ? (csrf() ? '' : 'cookie 里没有 bili_jct') : 'cookie 已失效' }
  }

  /**
   * 取播放地址。**只用来抽几帧看画面**，不下载整段视频。
   * fnval=16 → DASH（视频轨与音频轨分开），我们只要视频轨，音频一点都不要。
   * 返回的 url 带有效期（约两小时），并且需要 Referer + UA + cookie 才拉得动——
   * 这三样由调用方（video.js）拼进 ffmpeg 的 -headers。
   */
  async function playurl(bvid, cid, o = {}) {
    if (!bvid || !cid) return { ok: false, code: 'BAD_ARG', message: '缺 bvid 或 cid', data: null }
    const r = await api('/x/player/playurl', { bvid, cid, qn: o.qn ?? 64, fnval: 16, fourk: 0 })
    if (!r.ok) return r
    const d = r.data ?? {}
    const v = d.dash?.video?.[0]
    const url = v?.baseUrl ?? v?.base_url ?? d.durl?.[0]?.url ?? ''
    // fork.14：音频流一起给——她"听"视频靠它（本地 ASR 外挂的输入）。
    const a = d.dash?.audio?.[0]
    const audioUrl = a?.baseUrl ?? a?.base_url ?? ''
    return {
      ok: Boolean(url),
      code: r.code,
      message: url ? 'OK' : '没有可用的视频地址',
      data: {
        url,
        audioUrl,
        duration: d.timelength ? d.timelength / 1000 : 0,
        width: v?.width ?? 0,
        height: v?.height ?? 0,
      },
    }
  }

  /**
   * 短链 / 页面链接 → BV 号（2026-10-28，用户 m01284：他递来一条链接，她得打得开）
   *
   * b23.tv 会 302 到 www.bilibili.com/video/BV…，raw() 默认跟随重定向，
   * 所以 r.url 就是落地地址；跟随被关掉时再从正文里抠一次。
   * 只认 BV：详情接口只吃 bvid，av 号在这里一律不接。
   */
  async function resolveUrl(url) {
    const u = String(url ?? '').trim().replace(/[)\],。；;，]+$/, '')
    if (!u) return { ok: false, code: 'BAD_ARG', message: '没有链接', data: null }
    const short = /^(?:https?:\/\/)?(?:b23\.tv|bili2233\.cn)\//i.test(u)
    const have = /BV[0-9A-Za-z]{10}/.exec(u)
    if (have && !short) return { ok: true, code: 0, message: 'OK', data: { bvid: have[0], url: u } }
    if (!/^https?:\/\//i.test(u)) return { ok: false, code: 'BAD_URL', message: '这不是链接', data: null }
    if (now() < RISK.read.until) {
      return { ok: false, code: 'COOLDOWN', message: `风控冷却中，${fmtWait(RISK.read.until - now())}后再试`, data: null }
    }
    try {
      const r = await throttle(() => raw(u))
      const final = String(r?.url ?? '')
      const hit = /BV[0-9A-Za-z]{10}/.exec(final)
      if (hit) return { ok: true, code: 0, message: 'OK', data: { bvid: hit[0], url: final } }
      const text = await r.text().catch(() => '')
      const hit2 = /BV[0-9A-Za-z]{10}/.exec(text)
      if (hit2) return { ok: true, code: 0, message: 'OK', data: { bvid: hit2[0], url: final } }
      return { ok: false, code: 'NOT_VIDEO', message: '这个链接点开不是一条视频', data: null }
    } catch (err) {
      return { ok: false, code: 'NETWORK', message: String(err?.message ?? err).slice(0, 120), data: null }
    }
  }

  return {
    popular,
    ranking,
    precious,
    search,
    related,
    resolveUrl,
    view,
    playurl,
    tags,
    replies,
    subReplies,
    replyAdd,
    replyReply,
    me,
    danmaku,
    subtitle,
    whoami,
    // 测试用
    _internal: { ensureMk, ensureBuvid, get mk() { return mk }, get cookie() { return cookie }, csrf },
    setCookie(c) {
      cookie = normalizeCookie(c)
      return cookie
    },
  }
}

/** 各种来源的视频对象字段不统一，统一成一个形状 */
function toVideo(v) {
  const stat = v.stat ?? {}
  const owner = v.owner ?? {}
  return {
    bvid: String(v.bvid ?? ''),
    aid: Number(v.aid) || 0,
    title: String(v.title ?? '').trim(),
    duration: Number(v.duration) || parseDur(v.duration),
    up: String(owner.name ?? v.author ?? '').trim(),
    mid: Number(owner.mid ?? v.mid) || 0,
    view: Number(stat.view ?? v.play) || 0,
    like: Number(stat.like ?? v.like) || 0,
    reply: Number(stat.reply ?? v.video_review) || 0,
    danmaku: Number(stat.danmaku ?? v.danmaku) || 0,
    tname: String(v.tname ?? '').trim(),
    pic: String(v.pic ?? '').trim(),
  }
}

/** "12:34" → 754 */
function parseDur(x) {
  const m = String(x ?? '').match(/^(\d+):(\d{1,2})$/)
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0
}
