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
import { loadConfig, dateKey } from './settings.js'
import { createClient } from './bili.js'
import { grabFrames } from './video.js'
import { watchViaStoryboard } from './vs.js'
import { logLine } from './log.js'
import { isHanded } from './intent.js'

import { defineTool } from './tool.js'
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
  } catch {
    /* 补不到就留裸 BV 号，记账照走 */
  }
}

/** 没有 tenancy（单测、老调用）时自己拼一个，理由同 look.js 的 tenancyOf。 */function tenancyOf(root, tenancy) {
  if (tenancy && typeof tenancy === 'object') {
    return { root, herDir: String(tenancy.herDir ?? ''), tenant: tenancy.tenant ?? { ok: true } }
  }
  return { root, herDir: '', tenant: { ok: true } }
}

export function registerWatch(ctx, deps = {}) {
  const root = deps.root ?? rootDir()

  return ctx.tools.register(
    defineTool({
      name: 'bili_watch',
      description:
        '看一条视频的画面。会把整条视频里取几张截图拼成一张图存下来，告诉你文件在哪，' +
        '你用 read_image 打开它就能看见画面了。取画面要花十几秒，所以别每条都看，' +
        '挑你真的想知道"画面里是什么"的那条。默认在整条视频里分段随机取几张' +
        '（每次取到的时刻不一样）；想盯住某一刻就传 at（秒），只取你点的那几秒。不用它也可以。',
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
        if (!config?.browse?.enabled) return { ok: false, path: '', text: '', note: '现在打不开。' }
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

        // fork.17（2026-11-02）：看画面走两条引擎。
        //   vs（默认）= 用户的 dsh-video-storyboard 全管线：镜头切分取帧、
        //               每格选最锐利帧、最多 4 张宫格、硬字幕 OCR、台词对齐。
        //   lite      = 内置九帧（HTTP seek，不下载全片）。
        // vs 走不通就退回 lite 兜底——两条路都要写 watched: 记账，额度才数得对。
        const engine = String(config?.video?.engine ?? 'vs')
        let r = null
        if (engine === 'vs') {
          r = await watchViaStoryboard({
            bvid,
            root,
            hotword: config?.video?.hotword,
            at: args?.at,
            vsPath: config?.video?.vsPath,
          }).catch((err) => ({ ok: false, why: String(err?.message ?? err) }))
          if (!r?.ok) logLine('warn', ['看画面：vs 外挂没走通，退回轻量九帧', r?.why ?? ''], root)
        }
        if (!r?.ok) {
          const lite = await grabFrames({
            bvid,
            root,
            frames: config?.video?.frames,
            at: args?.at,
            subs: config?.video?.subs,
            asr: config?.video?.asr,
            vsPath: config?.video?.vsPath,
            chunkSec: config?.video?.chunkSec,
            asrBudgetMs: config?.video?.asrBudgetMs,
            asrWaitMs: config?.video?.asrWaitMs,
            hotword: config?.video?.hotword,
          })
          if (!lite.ok) {
            logLine('warn', ['看画面：抽帧失败', bvid, lite.why ?? ''], root)
            return { ok: false, path: '', text: '', note: lite.why }
          }
          r = lite
        }
        // fork.20：vs 那边没有标题，补一次接口，报告才认得出来是哪条。
        await enrichInfo(root, r, bvid)
        // ---- 记账：两条引擎都必须写 ----
        //
        // fork.20（2026-11-02）：原来 vs 分支在下面提前 return，这一步被整个跳过。
        // 而 fork.17 起 vs 是默认引擎——于是每一次成功的看画面都不进账本：
        // 报告里没有、额度不涨、评论闸门（认的正是 watched:）还会把她挡在外面。
        // 记账挪到 return 之前，两条路共用一次。
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

        // vs 路径自带说明文字（多张图 + 台词），直接用
        if (engine === 'vs' && r.text) {
          logLine(
            'info',
            ['看画面（vs）：取到了', bvid, `${(r.paths ?? []).length} 张`, quotaText, r.path ?? ''],
            root,
          )
          return { ok: true, path: r.path ?? '', text: r.text, note: '' }
        }

        // 路径一律给正斜杠：宿主渲染 markdown 图片时会拿路径拼 /api/file，
        // C:\... 这种反斜杠写法在客户端解析后取不到文件，图片就显示成「无法预览」
        // （2026-10-26 实测：同一张图 C:\ 版失败、C:/ 版正常）。
        const posix = slashed(r.path)
        // 成功的这一条也要记：跟日志里「今日额度已满」对得上，才知道额度是怎么用掉的。
        logLine('info', ['看画面：取到了', bvid, quotaText, posix], root)
        return {
          ok: true,
          path: posix,
          text: [
            `《${r.title || bvid}》的画面，我取了几张拼成一张图放在这儿：`,
            ...(Array.isArray(r.times) && r.times.length
              ? [`（取的是：${r.times.map((t) => `${t} 秒`).join('、')}）`]
              : []),
            posix,
            '用 read_image 读它就能看见。要在回复里贴这张图，路径就照抄上面这一行——用正斜杠。',
            // fork.14：字幕台词（如果这条视频有字幕轨）。按画面取帧时刻对齐的几句。
            ...(r.subsText ? ['', '画面那几个时刻的台词：', r.subsText] : []),
          ].join('\n'),
          note: '',
        }
      },
    }),
  )
}
