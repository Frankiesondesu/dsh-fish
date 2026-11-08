/**
 * 插话判定（2026-11-08，用户选 A）——纯函数，好测。
 *
 * 她这一轮在飞（/local/say 还没返回）时，他后发的**纯文字**不再排队等第二轮，
 * 而是插进同一个回合，让两条一起在她面前。
 *
 * 带附件 / 语音 / 转发 / 图的批次仍走原队列：那些要落盘、要把「收到文件」的
 * 事实拼给她，只带文字的 steer 会把它们静默吞掉。宁可排队，不能丢（fork.13）。
 */
export function shouldSteer(inFlight, p) {
  if (!(inFlight > 0)) return false
  if (!p || !Array.isArray(p.texts) || !p.texts.length) return false
  if (p.files?.length || p.forwards?.length || p.audios?.length || p.images?.length) return false
  return Boolean(p.texts.join('\n').trim())
}

/** 与 /local/say 同一套 QQ 来源标注，不养第二份真相。 */
export const QQ_NOTE = '（这条消息从 QQ 发来）\n\n'
