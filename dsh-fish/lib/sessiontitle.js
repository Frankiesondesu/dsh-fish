/**
 * 一条对话的名字（2026-10-29，用户 m00761）。
 *
 * 宿主把「这条对话叫什么」写成 `session/title` 事件，由 `sessionTitle` 服务折出来；
 * **会话 header 里没有 title**——请神下拉原来只读 header，读不到就退回会话 id 尾巴，
 * 所以用户看到的是一串数字字母。这里按可靠性排三层：
 *   1. 问宿主服务 `ctx.get('sessionTitle').get(session)`（活会话最快、最准）；
 *   2. 服务不在（宿主版本不同 / 测试里没这个服务）就自己折事件流，从后往前找最后一个
 *      `session/title` 的 `data.title`；
 *   3. 都没有才退回 header 的 `title ?? name`，再没有就是空字符串（由调用方给一句人话）。
 *
 * 永不抛：这是显示用的信息，拿不到名字不该让整页报错。
 */

/**
 * 从一条会话里读出它的名字。
 * @param {{ get?: Function }} ctx 插件 ctx（有没有 sessionTitle 服务都不影响）
 * @param {object} session 宿主会话对象（提供 snapshotEvents()）
 * @returns {string} 名字；没有就空字符串
 */
export function titleOfSession(ctx, session) {
  if (!session) return ''
  try {
    const snapshot = ctx?.get?.('sessionTitle')?.get?.(session)
    const title = String(snapshot?.title ?? '').trim()
    if (title) return title
  } catch { /* 没有这个服务、或它这一版签名不同：退回自己折事件流 */ }
  try {
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event?.type !== 'session/title') continue
      const title = String(event?.data?.title ?? '').trim()
      if (title) return title
    }
  } catch { /* 事件流读不出来就当这条还没名字 */ }
  return ''
}

/**
 * 从宿主 agent 对象里读出它那条对话的名字。
 * @param {{ get?: Function }} ctx 插件 ctx
 * @param {object} agent 宿主 agent（`agent.session`）
 * @returns {string} 名字；没有就空字符串
 */
export function titleOfAgent(ctx, agent) {
  const own = titleOfSession(ctx, agent?.session)
  if (own) return own
  const header = agent?.session?.header ?? agent?.session ?? {}
  return String(header.title ?? header.name ?? '').trim()
}

/**
 * 名字太长就截断（下拉/卡片一行放得下）。
 * @param {string} title 原名
 * @param {number} [max] 上限，默认 80
 * @returns {string}
 */
export function clipTitle(title, max = 80) {
  const s = String(title ?? '').trim()
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s
}
