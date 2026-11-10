/**
 * hand.js —— 「他递过来一条视频」的记账（fork.20，2026-11-02）
 *
 * 为什么单独一个文件：
 *   1. `hand:` 有**两个**写入口——侧栏的 turns.js、QQ 的 say.js。格式只能有一处
 *      （intent.js 的 handText），怎么记也只能有一处。
 *   2. 手机上分享出来的多半是 `b23.tv` 短链，不是 BV 号。短链要先解析才知道是哪条，
 *      而解析要发网络请求——turns.js 当初就是因为这个没解析（"不该卡在她说话的路径上"）。
 *      这里的解法是：**当场能记的当场记，只有短链才异步补一刀**，谁都不等它。
 *
 * 记不上会怎样：那条视频会被当成"她自己翻到的"，占她的额度。
 * 所以失败是**安静**的——宁可她多花一次额度，也不能因为网络抖一下让这句话递不进去。
 */

import { appendEvent, readOwner } from './store.js'
import { createClient } from './bili.js'
import { dateKey } from './settings.js'
import { handText } from './intent.js'

// b23.tv / bili2233.cn 是 B 站自己的短链域名；带不带 https:// 都认。
const LINK_RE = /(?:https?:\/\/)?(?:b23\.tv|bili2233\.cn)\/[0-9A-Za-z]+/gi

/** 他这条消息里的第一条短链（没有就是空串）。 */
export function shortLinkOf(text) {
  return shortLinksOf(text)[0] ?? ''
}

/** 他这条消息里**所有**短链（去重，补上协议）。一条消息丢好几条链接是常事。 */
export function shortLinksOf(text) {
  const all = String(text ?? '').match(LINK_RE) ?? []
  const out = all.map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`))
  return [...new Set(out)]
}

/**
 * 短链 → BV → 记一行 `hand:`。**不 await、不抛、不记日志噪音**。
 *
 * 只有解析出 BV 号才写：解析不出来就当这条没递过（她看的时候照常占额度）。
 * 一条消息里几条短链就解析几条——只解析第一条的话，第二条会被当成她自己翻到的。
 */
export function recordHandFromLink(root, text) {
  const urls = shortLinksOf(text)
  if (!urls.length) return
  ;(async () => {
    try {
      const cookie = (await readOwner(root))?.cookie ?? ''
      const client = createClient({ cookie })
      for (const url of urls) {
        try {
          const r = await client.resolveUrl(url)
          const bvid = r?.data?.bvid
          if (!bvid) continue
          await appendEvent(
            { type: 'meta', text: handText(dateKey(), bvid) },
            { day: 0, stage: 1, source: 'system' },
            root,
          )
        } catch {
          /* 这一条解析不了就跳过，别拖累其它几条 */
        }
      }
    } catch {
      /* 连 client 都建不起来：当没递过 */
    }
  })()
}
