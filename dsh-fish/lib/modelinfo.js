/**
 * modelinfo.js —— 「她那条会话现在用的是哪个模型、吃不吃图」（2026-10-28 加）
 *
 * 为什么需要它：另一台机器反馈「看不到视频画面」，查了半天——ffmpeg 装了、
 * 额度没用完。真正能一句话回答这件事的只有两个数：她的模型是谁、这个模型
 * 支不支持图像输入。宿主在图像准入那里查的也正是这两样：
 *
 *   (await llm.resolveModelInfo(provider, model)).inputModalities?.includes('image')
 *
 * 日志里一个字都没有，于是只能靠人肉猜。所以导出包里补上这一行。
 *
 * 三条纪律：
 * 1. **永不抛**。拿不到就是拿不到，写「读不到」+ 原因，绝不因为探测失败连累导出。
 * 2. **不冒充结论**。三个状态分开：`imageInput: true` / `false` / `null`（说不准）。
 *    没读到模型信息时是 null，不是 false——不能说人家不支持。
 * 3. **只读**。不切模型、不写配置、不发请求。
 */

/** 从宿主会话投影里取她这条会话最后用过的模型。 */
async function lastUsedSelection(ctx, sessionId) {
  if (!sessionId) return null
  const projections = ctx?.get?.('sessionProjections') ?? ctx?.sessionProjections
  if (!projections) return null

  // 投影名字是宿主的内部约定：`modelSelection`，结构 { lastUsed: {provider, model} | null }
  // snapshot(session) 一次给全部投影；stateOf(session, key) 只给一个。两个都试。
  try {
    const all = projections.snapshot
      ? await projections.snapshot(sessionId)
      : projections.stateOf
        ? await projections.stateOf(sessionId, 'modelSelection')
        : null
    const pick = all?.modelSelection ?? (all && all.provider ? all : null)
    const last = pick?.lastUsed ?? pick?.next ?? null
    if (last?.provider && last?.model) return { provider: String(last.provider), model: String(last.model) }
  } catch { /* 换下一条路 */ }

  try {
    if (projections.stateOf) {
      const one = await projections.stateOf(sessionId, 'modelSelection')
      const last = one?.lastUsed ?? one?.next ?? null
      if (last?.provider && last?.model) return { provider: String(last.provider), model: String(last.model) }
    }
  } catch { /* 拿不到就算了 */ }

  return null
}

/** 问 llm 服务这个模型吃不吃图。 */
async function imageSupport(ctx, provider, model) {
  const llm = ctx?.get?.('llm') ?? ctx?.llm
  if (!llm || typeof llm.resolveModelInfo !== 'function') {
    return { imageInput: null, why: '宿主没给 llm 服务，问不到' }
  }
  try {
    const info = await llm.resolveModelInfo(provider, model)
    const mods = Array.isArray(info?.inputModalities) ? info.inputModalities : null
    if (!mods) return { imageInput: null, why: '这个模型没报 inputModalities' }
    return { imageInput: mods.includes('image'), why: '' }
  } catch (err) {
    return { imageInput: null, why: `问不到：${String(err?.message ?? err)}` }
  }
}

/**
 * 一次拿全：`{ provider, model, imageInput, why }`。
 * `imageInput` 三态：true / false / null（说不准）。
 */
export async function resolveHerModel(ctx, sessionId) {
  try {
    const sel = await lastUsedSelection(ctx, sessionId)
    if (!sel) return { provider: '', model: '', imageInput: null, why: '还没跟她说过话，读不到她用的模型' }
    const sup = await imageSupport(ctx, sel.provider, sel.model)
    return { provider: sel.provider, model: sel.model, imageInput: sup.imageInput, why: sup.why }
  } catch (err) {
    return { provider: '', model: '', imageInput: null, why: `读不到：${String(err?.message ?? err)}` }
  }
}
