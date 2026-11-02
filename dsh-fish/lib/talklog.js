/**
 * talklog.js —— 把「这一轮说了什么」落进账本（fork.11，2026-11-02）
 *
 * 为什么要它：账本里原来只有"她怎么想"（utterance），没有"我们说过什么"。
 * 于是她翻旧账只能翻到自己的判断，翻不到对话本身——
 * 「你上次跟我说的那个视频」，她手上根本没有那句话可查。
 * 会话日志（DSH 那份）里是有全文的，但那是机器格式，她读不到，换会话还会沉底。
 *
 * 记法：一轮一行，只留原话，不做摘要。
 * 截断 180 字——够她认出"是哪件事"，又不至于把账本撑成聊天记录的副本。
 *
 * 这行是 `meta`，系统侧写（source: system）。她写不了自己说过的"话"，
 * 和 heard 同理：能被她伪造的"事实"就不是事实。
 */

import { appendEvent } from './store.js'

/** 一边最多留多少字 */
export const TALK_SNIPPET = 180

function cut(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > TALK_SNIPPET ? t.slice(0, TALK_SNIPPET - 1) + '…' : t
}

/**
 * fork.18（2026-11-02）：sessionId 只收字符串/数字。
 *
 * 之前直接 `String(o.sessionId)`，于是调用方传了个没 await 的 Promise 时，
 * 账本里留下的是 `"sessionId":"[object Promise]"`——账本只增不改，擦不掉。
 * 与其指望每个调用点都记得 await，不如在这一层把非标量挡掉：
 * 认不出来的就当没给（这字段只是溯源线索，缺了不影响她读）。
 */
function idOf(v) {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

/**
 * @param {string} root
 * @param {{me?:string, her?:string, day?:number, stage?:number, sessionId?:string}} o
 * @returns {Promise<boolean>} 写没写进去（写失败不抛，别连累对话）
 */
export async function logExchange(root, o = {}) {
  const me = cut(o.me)
  const her = cut(o.her)
  if (!me && !her) return false
  const dk = new Date().toISOString().slice(0, 10)
  const body = [me ? `他说「${me}」` : '', her ? `我答「${her}」` : ''].filter(Boolean).join('／')
  const sid = idOf(o.sessionId)
  try {
    await appendEvent(
      {
        type: 'meta',
        text: `talk:${dk} ${body}`,
        ...(sid ? { sessionId: sid } : {}),
      },
      { day: Number(o.day ?? 0), stage: Number(o.stage ?? 1), source: 'system' },
      root,
    )
    return true
  } catch {
    return false
  }
}
