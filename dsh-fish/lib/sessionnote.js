/**
 * sessionnote.js —— 往一条会话里补一句「人话」（0.6.16）
 *
 * 为什么需要它：请神结束、出门回家被驳回之后，那条会话的历史里还留着
 * 她以自己身份说过的话。系统提示撤干净了（0.6.11 修过），但 append-only
 * 的事件流撤不回来——下一轮模型读到自己上一句「我是大肥鱼」，会顺着演。
 * 唯一能做的，是在历史末尾补一条**可见的**边界标记：让下一轮先看到
 * 「这件事已经结束了」。
 *
 * 为什么写 `user/message` 而不是 meta：meta 是内部记帐，模型看不到；
 * 而这条标记必须进上下文才有意义。宿主的 `user/message` 校验（dsh-session
 * 的 assertMessageEventShape）要求：非空 id、role='user'、source.kind 非空、
 * content 数组，并且该类事件必须带 surfaceOp 标记——所以调用时传
 * `{ surfaceOp: 'append' }`。
 *
 * 永不抛：这些句子是「锦上添花」，写不进去也只是少一句话，不能连累
 * 请神结束 / 回家结算这两条主流程。
 */
import { readJson, writeAtomic } from './store.js'
import { join } from 'node:path'

/** 排队文件放在她屋子根下（与 home.json 同级，重启不丢）。 */
const NOTES_FILE = 'session-notes.json'
/** 排队上限：够用就好，别把文件撑大。 */
const NOTES_MAX = 50

export function noteId(now = Date.now()) {
  return `fish-note-${now}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 往一个活着的 agent 的会话里追加一条 user/message。
 * @param {object} agent  宿主的 agent（`agent.session.append`）
 * @param {string} text
 * @returns {{ok:boolean, why?:string}}
 */
export function appendNote(agent, text, { now = Date.now() } = {}) {
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, why: '空白的，没写。' }
  const session = agent?.session
  if (!session || typeof session.append !== 'function') {
    return { ok: false, why: '那条对话现在没开着' }
  }
  try {
    session.append(
      'user/message',
      {
        id: noteId(now),
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: body.slice(0, 800) }],
      },
      { surfaceOp: 'append' },
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 160) }
  }
}

function notesPath(root) {
  return join(root, NOTES_FILE)
}

/**
 * 那条会话不在线时先排队，等她/他下次打开这条会话再补。
 * @returns {{ok:boolean, queued:number, why?:string}}
 */
export async function queueNote(root, text) {
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, queued: 0, why: '空白的，没写。' }
  try {
    const saved = await readJson(notesPath(root), null)
    const list = Array.isArray(saved?.notes) ? saved.notes : []
    list.push({ at: new Date().toISOString(), text: body.slice(0, 800) })
    const notes = list.slice(-NOTES_MAX)
    await writeAtomic(notesPath(root), JSON.stringify({ version: 1, notes }, null, 2))
    return { ok: true, queued: notes.length }
  } catch (err) {
    return { ok: false, queued: 0, why: String(err?.message ?? err).slice(0, 160) }
  }
}

/** 取走全部排队句子（取走即清空，避免重复投递）。 */
export async function takeNotes(root) {
  let saved = null
  try { saved = await readJson(notesPath(root), null) } catch { saved = null }
  const list = Array.isArray(saved?.notes) ? saved.notes.filter((n) => n && String(n.text ?? '').trim()) : []
  if (list.length) await writeAtomic(notesPath(root), JSON.stringify({ version: 1, notes: [] }, null, 2)).catch(() => null)
  return list
}

/**
 * 会话打开时把排队的句子补进去。
 * @returns {Promise<{ok:boolean, delivered:number}>}
 */
export async function deliverQueued(agent, root) {
  const list = await takeNotes(root)
  if (!list.length) return { ok: true, delivered: 0 }
  let delivered = 0
  for (const n of list) {
    const r = appendNote(agent, n.text)
    if (r.ok) delivered += 1
  }
  return { ok: true, delivered }
}
