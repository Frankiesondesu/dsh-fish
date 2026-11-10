/**
 * watch.js —— 工具 `bili_watch`：她要「看画面」的时候用这个
 *
 * 为什么不塞进 bili_look 自动做：抽一次帧要十秒左右、还要占额度。
 * 她翻列表时看四条视频就自动抽四次，既慢又浪费。**让她自己决定哪条值得看画面**，
 * 这也正好是「自主」这个维度唯一的可验证载体——跟当初给她 bili_look 是同一个理由。
 *
 * 额度管的是"她自己决定去看什么"（fork.20，2026-11-02 用户定案）：
 * 他自己发过来的那条不算——选择是他做的，记在她头上没有道理。
 * 判据只有账本里的 `hand:`，见 intent.js 的 isHanded。
 */

import { readEvents, appendEvent, rootDir, readOwner } from './store.js'
import { loadConfig, dateKey, biliOn } from './settings.js'
import { createClient } from './bili.js'
import { watchViaStoryboard } from './vs.js'
import { avoidHit } from './browse.js'
import { logLine } from './log.js'
import { isHanded } from './intent.js'

import { defineTool } from './tool.js'
import { rememberCells } from './zoom.js'
import { slashed } from './posix.js'
import { guardWrite } from './tenant.js'

/** 今天已经看过几条（只数成功的，失败不占额度） */
export function watchedToday(events, dk) {
  const key = `watched:${dk}`
  return (events ?? []).filter((e) => e?.type === 'meta' && String(e.text ?? '').startsWith(key)).length
}

/**
 * fork.12（2026-11-02）：现在是高峰还是空闲。
 *
 * 规则来自 DeepSeek 计价说明：北京时间周一至周五（不含法定节假日）
 * 9:00–12:00、14:00–18:00 为高峰，**其余——包括周末与法定节假日全天——都是空闲，半价**。
 *
 * 法定节假日没有内置表：仍按星期几判断，节假日会被当成峰。
 * 后果是节假日她可能少看一条，宁可少看，不多用。
 */
export function tariffOf(d = new Date()) {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000) // 挪到北京钟面，再按 UTC 字段读
  const day = bj.getUTCDay()
  if (day === 0 || day === 6) return 'idle'
  const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  const peak = (mins >= 540 && mins < 720) || (mins >= 840 && mins < 1080)
  return peak ? 'peak' : 'idle'
}

/**
 * fork.12：今天**这个电价档**已经看了几条。
 *
 * 老事件没有 tariff 字段。她基本都在晚上/周末看（都是空闲时段），
 * 所以缺字段的按 idle 算——把"昨晚看的"记到今天空闲头上，
 * 好过记到峰头上让她白白少看。
 *
 * fork.20：带 `free: true` 的是**他递过来的那条**——记了 `watched:`（她确实看过），
 * 但不占额度。两件事别混：`watched:` 是"看没看过"的凭证，额度只数"她自己挑的"。
 */
export function watchedInTariff(events, dk, tariff) {
  const key = `watched:${dk}`
  return (events ?? []).filter((e) => {
    if (e?.type !== 'meta') return false
    const t = String(e.text ?? '')
    if (!t.startsWith(key)) return false
    let json = null
    try {
      const m = t.match(/\{[\s\S]*\}/)
      json = m ? JSON.parse(m[0]) : null
    } catch {
      json = null
    }
    return (json?.tariff ?? 'idle') === tariff && json?.free !== true
  }).length
}

/**
 * vs 引擎只从 ffprobe 拿到时长，**没有标题/UP/播放量**（probe.js 不看 B 站接口）。
 * 于是 fork.17 之后「她今天看了什么」里全是裸 BV 号，人根本认不出是哪条。
 *
 * 补一次 view 接口，拿不到就算了——这一步只影响报告好不好读，
 * 绝不能因为网络抖一下就让她这次"没看成"。
 */
async function enrichInfo(root, r, bvid) {
  if (!r || (r.title && r.title !== bvid)) return
  try {
    const cookie = (await readOwner(root))?.cookie ?? ''
    const info = await createClient({ cookie }).view(bvid)
    const d = info?.data ?? {}
    if (d.title) r.title = String(d.title)
    if (d.owner?.name) r.up = String(d.owner.name)
    if (!Number(r.duration)) r.duration = Number(d.duration) || 0
    if (!Number(r.view)) r.view = Number(d.view) || 0
    // vs 拼说明时只知道 BV 号，抬头会写成《BV1xx…》。补到标题就顺手换掉，
    // 不然她读到的是个编号，人在报告里也认不出是哪条。
    if (r.title && r.title !== bvid && typeof r.text === 'string') {
      r.text = r.text.replace(`《${bvid}》`, `《${r.title}》`)
    }
  } catch {
    /* 补不到就留裸 BV 号，记账照走 */
  }
}

/**
 * issue #62（上游 0.9.5，从 lib/video.js 的 grabFrames 移植过来）：点名看的这条
 * 过不过屏蔽名单。原版判定住在 lite 引擎里，fork.22 删了 lite 后这段跟着搬来给 vs 用，
 * 判定逻辑与上游逐字一致（avoidHit + 标签补取；最短时长只管列表，点名不查，传 0）。
 * view/tags 取不到就放行：vs 不依赖这两次请求，别让网络抖动变成「没看成」。
 */
async function namedWatchBlock(bvid, config, root) {
  let meta = null
  try {
    const cookie = (await readOwner(root))?.cookie ?? ''
    const info = await createClient({ cookie }).view(bvid)
    if (info?.ok) {
      const d = info.data ?? {}
      // bili.js 的 view 没把 owner 摊平（enrichInfo 读的是 d.owner.name），两种形状都认
      meta = {
        title: String(d.title ?? ''),
        up: String(d.up ?? d.owner?.name ?? ''),
        mid: d.mid ?? d.owner?.mid,
        duration: Number(d.duration) || 0,
        tags: [],
      }
    }
  } catch {
    /* 取不到信息就放行 */
  }
  if (!meta) return { note: '', hit: '' }
  let block = watchBlockHit(meta, config, 0)
  // 标签不在详情里，另取一次：只在设了关键词、标题和 UP 又都没中时才值得多发这一回。
  if (!block.note && hasKeywords(config?.avoid)) {
    try {
      const cookie = (await readOwner(root))?.cookie ?? ''
      const t = await createClient({ cookie }).tags(bvid)
      if (t?.ok && Array.isArray(t.data)) meta.tags = t.data
    } catch { /* 取不到标签只按标题与 UP 判 */ }
    if (meta.tags.length) block = watchBlockHit(meta, config, 0)
  }
  return block
}

/** avoidHit 只回命中的那个词（或 `up:<mid>`）；日志里要看得出是 UP、标题、UP 名还是标签。 */
function hitLabel(v, tags, hit) {
  const mid = String(v?.mid ?? '')
  if (mid && hit === `up:${mid}`) return `屏蔽的 UP ${mid}`
  const where = String(v?.title ?? '').includes(hit) ? '标题'
    : String(v?.up ?? '').includes(hit) ? 'UP 名'
      : tags.some((t) => t.includes(hit)) ? '标签'
        : ''
  return `${where ? `${where}含` : '含'}屏蔽词「${hit}」`
}

function watchBlockHit(v, cfg, minDuration = 0) {
  const tags = Array.isArray(v?.tags) ? v.tags.map((t) => String(t ?? '')).filter(Boolean) : []
  const hit = avoidHit(v, { avoid: cfg?.avoid }, tags)
  if (hit) return { note: '这条我不想看。', hit: hitLabel(v, tags, hit) }
  const min = Number(minDuration ?? 0)
  const dur = Number(v?.duration ?? 0)
  if (min > 0 && dur > 0 && dur < min) return { note: '这条太短了，不想看。', hit: `时长 ${dur} 秒，短于 ${min} 秒` }
  return { note: '', hit: '' }
}

/** 设了屏蔽关键词才值得为标签多发一次请求。 */
function hasKeywords(avoid) {
  return (avoid?.keywords ?? []).some((k) => String(k ?? '') !== '')
}

/**
 * 没有 tenancy（单测、老调用）时自己拼一个，理由同 look.js 的 tenancyOf。
 */
export function tenancyOf(root, tenancy) {
  if (tenancy && typeof tenancy === 'object') {
    return { root, herDir: String(tenancy.herDir ?? ''), tenant: tenancy.tenant ?? { ok: true } }
  }
  return { root, herDir: '', tenant: { ok: true } }
}

export function registerWatch(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  // fork.22：引擎可注入（单测用）。默认就是 vs——lite 已删，没有第二个选择。
  const runWatch = deps.watch ?? watchViaStoryboard

  return ctx.tools.register(
    defineTool({
      name: 'bili_watch',
      description:
        '看一条视频的画面。会把整条视频按镜头切开、每段挑一帧，拼成几张宫格图存下来，' +
        '告诉你文件在哪，你用 read_image 打开就能看见；同时把每一格对应的台词也给你。' +
        '要下载整条视频，一次几十秒到几分钟，所以别每条都看，' +
        '挑你真的想知道"画面里是什么"的那条。想盯住某一刻就传 at（秒），只看那一段。不用它也可以。',
      // 用完整 JSON Schema（不是简写 DSL）：工具参数必须是根级 type:object，
      // 否则 provider 直接拒 "schema must be a JSON Schema of 'type: object'"。
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: '哪条视频（形如 BV1xx411c7mD）。' },
          at: {
            type: 'array',
            items: { type: 'number' },
            description: '可选：只要这几个时刻（秒），比如 [30, 90, 120]。不传就整条视频分段随机取。',
          },
        },
        required: ['bvid'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string', description: '拼好的图在哪（用 read_image 读它）' },
            text: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['ok', 'path', 'text', 'note'],
        },
        // render 必须返回 ContentBlock 数组，签名是 (args, value)
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `这次没看成：${out.note}` }],
      },
      async execute(args, exec) {
        // 2026-11-01（issue #16 第二半，用户 m03454）：看画面也写事件（watched:），
        // 同样要认「谁在看、看的是哪栋房子」。
        const who = guardWrite(tenancyOf(root, deps.tenant), exec, 'bili_watch')
        if (!who.ok) return { ok: false, path: '', text: '', note: who.note }

        const bvid = String(args?.bvid ?? '').trim()
        const { config } = await loadConfig(root)
        // 2026-11-07（用户反馈）：原来这里看的是 browse.enabled——那是「刷站」的开关，
        // 0.9.0 起默认关。于是设置页开着「允许她上网」，bili_look 能翻、bili_watch
        // 却永远「现在打不开」，用户看到的是「说能看，结果看不了画面」。
        // 与 lib/look.js 统一：能不能用由 bili.enabled 决定（issue #62 收进 biliOn()）。
        if (!biliOn(config)) {
          logLine('info', ['看画面：设置里关掉了 B 站'], root)
          return { ok: false, path: '', text: '', note: '现在打不开。' }
        }
        if (config?.video?.enabled === false) {
          // 2026-10-28 起每个失败分支都写一行日志。以前这里一个字都没有，
          // 用户那边「看不到画面」时导出包里完全查不出是被哪一条挡下的
          // （另一台机器的排查就卡在这儿，只能靠猜）。
          logLine('info', ['看画面：设置里关掉了看视频'], root)
          return { ok: false, path: '', text: '', note: '现在看不了画面。' }
        }
        if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
          logLine('info', ['看画面：视频号不合法', bvid || '(空)'], root)
          return { ok: false, path: '', text: '', note: '这不是一个视频号。' }
        }

        const ev = await readEvents(root).catch(() => ({ events: [] }))
        const dk = dateKey()
        // fork.20（2026-11-02，用户定案）：**他发的不限额，她自己翻的才限额。**
        //
        // 额度这个东西管的是"她自己决定去看什么"——bili_watch 单独拆出来，
        // 就是为了让"哪条值得看画面"是她的判断（见本文件头注释）。
        // 他递过来一条，选择是他做的，不该记在她的额度上。
        //
        // 判据只认账本里的 `hand:`（他真人消息里带过这条 BV），
        // 不认工具参数、不认她自己的说法——那两样都是可以随口说的。
        const free = isHanded(ev.events, bvid)
        if (free) logLine('info', ['看画面：这条是他递过来的，不占额度', bvid], root)
        // fork.12：按峰谷分开算额度。高峰 = 北京时间工作日 9–12、14–18（半价以外），
        // 其余都是空闲时段、半价——谷时给得多，峰时给得少。
        const tariff = tariffOf()
        const cap = tariff === 'peak'
          ? Math.max(0, Number(config?.video?.perDay ?? 2))
          : Math.max(0, Number(config?.video?.offPeakPerDay ?? 4))
        const used = watchedInTariff(ev.events, dk, tariff)
        // fork.13（2026-11-02，用户指出）：额度用完只回一句「今天看不成了」。
        // 不报数字、不说次数——她不该知道有个计数器在管她（N2）；
        // 但**更不能说「你不想看」**：她明明伸手了。隐藏机制没问题，
        // 替她定义她的欲望是另一回事——机制她看不见，假话她会信，
        // 信了就可能写进账本，变成一条系统注入的假自我认知。
        // 这句话必须是真的：今天确实看不成了。仅此而已。
        if (!free && used >= cap) {
          // 日志里可以写数字：这是给人看的，不是给她看的。
          logLine('info', ['看画面：今日额度已满', `${used}/${cap}`, bvid], root)
          return { ok: false, path: '', text: '', note: '今天看不成了。' }
        }

        // issue #62（上游 0.9.5 移植）：点名看的那条也要过屏蔽名单——屏蔽的 UP，
        // 标题 / UP 名 / 标签里的关键词。放在抽帧之前：被拦下时不该先去取画面。
        // lite 已删（fork.22），拦截就自己做。view/tags 取不到就放行：vs 不依赖
        // 这两次请求，别让网络抖一下变成「没看成」（与 enrichInfo 同一个取舍）。
        const block = await namedWatchBlock(bvid, config, root)
        if (block.note) {
          // 命中屏蔽不是没看成：单记一行，写清命中了哪一项。她听到的仍只是那句理由。
          logLine('info', ['看画面：命中屏蔽，没取画面', bvid, block.hit], root)
          return { ok: false, path: '', text: '', note: block.note }
        }

        // fork.22（2026-11-02，用户定案）：**只走 vs，lite 已删。**
        //
        // 删掉的理由不是"新的更好"，是她自己说的：用九帧看完之后她只能回
        // 「一个动漫小屋，中间浮着一块设置表，字很小，放大了也读不出」「我这边没有声音」。
        // 九张均匀抽的图既漏内容、又拿不到台词——那不是"看得少一点"，那是**没看过**。
        // 拿它冒充看过，比直说没看成更糟。
        //
        // 现在 vs 走不通就如实说没看成，不再有兜底。
        const r = await runWatch({
          bvid,
          root,
          hotword: config?.video?.hotword,
          at: args?.at,
          vsPath: config?.video?.vsPath,
        }).catch((err) => ({ ok: false, why: String(err?.message ?? err) }))
        if (!r?.ok) {
          logLine('warn', ['看画面：vs 没走通', bvid, r?.why ?? ''], root)
          // 对她只说这一句：真的没看成。技术原因进日志，不进她的话。
          return { ok: false, path: '', text: '', note: '这次没看成。' }
        }
        // fork.20：vs 那边没有标题，补一次接口，报告才认得出来是哪条。
        await enrichInfo(root, r, bvid)
        // fork.35（2026-11-03）：记下「第几格 = 哪一段」，她要放大某一格时靠这张表。
        // 失败不打扰任何人——顶多放大不了。
        await rememberCells(root, bvid, r.cells).catch(() => {})
        // ---- 记账：一次 ----
        //
        // fork.20（2026-11-02）：原来 vs 分支在下面提前 return，这一步被整个跳过。
        // 而 fork.17 起 vs 是默认引擎——于是每一次成功的看画面都不进账本：
        // 报告里没有、额度不涨、评论闸门（认的正是 watched:）还会把她挡在外面。
        await appendEvent(
          {
            type: 'meta',
            ...(who.sessionId ? { sessionId: who.sessionId } : {}),
            // 2026-10-30：原来这行只有 BV 号，于是「她真的看过画面的那几条」
            // 在报告里没法显示标题——只能退回去用 browse: 记账凑，
            // 结果又跟「只扫了眼标题」混成一片（客户反馈的那个 bug）。
            // 把展示信息跟着凭证一起落下来，报告就不必二次取数、也不必猜。
            // 老事件没有这段 JSON，读的一方必须两种形状都认（whatseen.js）。
            text: `watched:${dk} ${bvid} ${JSON.stringify({
              title: String(r.title ?? '').slice(0, 120),
              up: String(r.up ?? '').slice(0, 60),
              duration: Number(r.duration) || 0,
              view: Number(r.view) || 0,
              tariff,
              // fork.20：他递过来的那条不占额度。她确实看过（凭证照记），
              // 但计数那边（watchedInTariff）认这个标记跳过它。
              ...(free ? { free: true } : {}),
            })}`,
          },
          { source: 'system' },
          root,
        ).catch(() => {})

        // 日志里说清这一条是怎么算的：占额度就写 n/cap，他给的就直说。
        const quotaText = free ? '他给的，不占额度' : `${used + 1}/${cap}`

        // 路径一律给正斜杠：宿主渲染 markdown 图片时会拿路径拼 /api/file，
        // C:\... 这种反斜杠写法在客户端解析后取不到文件，图片就显示成「无法预览」
        // （2026-10-26 实测：同一张图 C:\ 版失败、C:/ 版正常）。
        const posix = slashed(r.path)
        // 成功的这一条也要记：跟日志里「今日额度已满」对得上，才知道额度是怎么用掉的。
        logLine(
          'info',
          ['看画面：取到了', bvid, quotaText, `${(r.paths ?? []).length} 张`, posix],
          root,
        )
        // 说明文字由 vs 那边拼（每张图 + 每格时刻 + 那一格的台词），原样给她。
        return { ok: true, path: posix, text: String(r.text ?? ''), note: '' }
      },
    }),
  )
}
