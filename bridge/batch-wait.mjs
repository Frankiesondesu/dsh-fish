/**
 * batch-wait.mjs —— 合批窗口该等多久（2026-11-05）
 *
 * 单独拎出来是为了能测：这段是纯计算，而合批的时序错一次就是
 * 「图发出去了、文字单独成了一轮」或者「每条消息都卡十秒」。
 *
 * 用户的习惯（2026-11-05 原话）：**先发图片，再发对话**。
 * 所以规则是：
 *   · 有图、还没等到文字 → 从**第一张图**开始算 imageHoldMs（默认 10 秒）
 *   · 连发几张图 → 不重置，还是从第一张算（不然发五张要等五十秒）
 *   · 文字一到 → 立刻发（0 秒），不等满窗口
 *   · 纯文字 → 压 mergeMs，够粘住连发的几行
 */

export const DEFAULT_IMAGE_HOLD_MS = 10_000
export const DEFAULT_MERGE_MS = 1_500

/**
 * @param {object} o
 * @param {boolean} o.hasImage   这一批里有没有图
 * @param {boolean} o.hasText    这一条消息带不带文字
 * @param {number}  o.imageAt    第一张图到达的时刻（毫秒）；没有图时是 0
 * @param {number}  o.now        现在
 * @param {number}  o.mergeMs    纯文字的窗口
 * @param {number}  o.imageHoldMs 带图的窗口
 * @returns {number} 还要等多久（毫秒）；<= 0 表示立刻发
 */
export function batchWait({ hasImage = false, hasText = false, imageAt = 0, now = 0, mergeMs = 0, imageHoldMs = 0 } = {}) {
  if (!hasImage) return mergeMs
  // 文字来了就发：他在补那句话，补完就是他想说的全部
  if (hasText) return 0
  // 没有文字：从第一张图算，已经过去的要扣掉
  const elapsed = imageAt > 0 && now > 0 ? Math.max(0, now - imageAt) : 0
  return Math.max(0, imageHoldMs - elapsed)
}
