/**
 * said.mjs —— 「她说的话」时间线的合并逻辑（2026-11-07）
 *
 * 为什么要有：her_say 是工具调用，不产生 assistant/message，所以它**不在 DSH 会话
 * 日志里**——正文落在账本（utterance + source=tool + 「（她说）」前缀，桥靠这个前缀
 * 推 QQ）。用户平时主要用 QQ，她在他手机上说的话恰恰是「她说的话」的大头，
 * 查看器那个 tab 却只显示窗口正文。这里把两路并成一条时间线。
 *
 * 只并 her_say 的话：growth_commit 记下的内心判断不是"说给他听的"（fork.2 口径），
 * 不混进来；窗口正文照旧来自会话日志。
 */

/** 账本里她经 her_say 发到 QQ 的话（剥掉推送标记前缀） */
export function qqSaidOf(events = []) {
  const out = []
  for (const e of events ?? []) {
    if (e?.type !== 'utterance' || e?.source !== 'tool') continue
    const raw = String(e.text ?? '')
    // （她说）= 2026-11-07 统一后的唯一前缀；（她主动说）= 之前主动开口的旧前缀。
    // 都是「她发到他 QQ 上的话」，一并收。
    const body = raw.startsWith('（她说）')
      ? raw.slice(4)
      : raw.startsWith('（她主动说）')
        ? raw.slice(6)
        : ''
    if (!body.trim()) continue
    out.push({ at: Date.parse(e.ts) || 0, text: body, id: String(e.id ?? '') })
  }
  return out
}

/**
 * 窗口正文（会话日志）与 QQ 上的话（账本）并成一条时间线，新的在前。
 * where: 'desk' = 窗口里说的（有 turn 号）；'qq' = her_say 发到手机上的。
 */
export function mergeSaid(spoken = [], qq = []) {
  return [
    ...(Array.isArray(spoken) ? spoken : []).map((s) => ({ ...s, where: 'desk' })),
    ...(Array.isArray(qq) ? qq : []).map((s) => ({ ...s, where: 'qq' })),
  ].sort((a, b) => (b.at || 0) - (a.at || 0))
}
