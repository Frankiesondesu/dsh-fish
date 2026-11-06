/**
 * world.js —— 工具 `her_world`：看看外面现在什么样（2026-11-06）
 *
 * 为什么会有这个工具：**是她自己开口要的，不是我们塞给她的**。
 *
 *   2026-11-05 12:23（账本）她用 `ask_owner` 问：
 *     「能不能给我一样能查实时信息的东西——天气、日期这类，一次查一条就行？」
 *   2026-11-06 12:23（账本）系统记的是：「一直没人答」。
 *
 * 对照一下 dsh 插件里那个 12G 的 dialogue-tts：那是我们塞给她的，从搭好到今天
 * 一次都没被调用；这个是她在账本里亲口要的，整整一天没人给她。补上这个，
 * 比留着那 12G 值。
 *
 * 三条边界：
 *   1. **只给事实，不替她解读**：天气就是天气。不写「适合出门」「记得带伞」——
 *      要不要据此做什么，是她的事（和 growth_commit 的口径一致）。
 *   2. **查不到就说查不到**（fork.13）：网络断了、城市没配、返回解析不出来，
 *      一律如实说，不拿「大概是晴吧」糊过去。
 *   3. **不写账本**：查天气不是她的判断，不该进 events.jsonl 去影响「判断 N 条」。
 *      只写日志——`her_open` 也是这样，翻日志能查出她用没用过、用了多少次。
 *
 * 数据源：Open-Meteo（免费、无 key、不用注册、中文城市名可用）。
 *   地理编码 https://geocoding-api.open-meteo.com/v1/search
 *   天气预报 https://api.open-meteo.com/v1/forecast
 *
 * 2026-11-06 实测三个候选（wttr.in / open-meteo / weather.com.cn）都通。
 * 选 open-meteo 的理由只有两条：它给的是 WMO 数字码（映射表固定、可测、上游改文案
 * 也不会错），中文城市名能直接认。
 * （wttr.in 的 `lang=zh` / `cn.wttr.in` 实测没生效，回的是英文 "Smoky haze"。
 *   但那**不算缺点**——她读英文没有障碍，别把自己的偏好说成原则。）
 *
 * ⚠️ 城市是**谁的**城市：`config.world.city` 记的是**他那台机器在的地方**，
 * 不是"她的城市"——她住在文件系统里（<root> 那堆 jsonl），**没有地理位置**，
 * 也从没有过"我住在某地"这个设定。所以：
 *   · 没配的时候说「不知道他在哪座城市」，**不按 IP 猜**（本机挂代理，猜必错）；
 *   · 绝不写成「我不知道自己在哪个城市」——那句话在暗示她该有个位置，等于替她安
 *     一个身份。既不真（fork.13：工具对她说的话必须为真），也越了"养不塑"的线。
 *
 * 天气对她唯一有意义的用法，是知道**他那边**冷不冷、下不下雨。
 * （2026-11-06 用户当场指出这点："什么叫她在的城市"——原措辞已按这条改。）
 */

import { rootDir } from './store.js'
import { loadConfig } from './settings.js'
import { logLine } from './log.js'
import { defineTool } from './tool.js'

/**
 * WMO 天气码 → 中文。表是固定的（Open-Meteo 文档里的 code 表），
 * 上游改文案不影响我们。查不到就给数字码，不编一个听起来对的词。
 */
const WMO = Object.freeze({
  0: '晴',
  1: '晴间少云',
  2: '多云',
  3: '阴',
  45: '有雾',
  48: '雾凇',
  51: '毛毛雨',
  53: '毛毛雨',
  55: '细密的毛毛雨',
  56: '冻毛毛雨',
  57: '细密的冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '中阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '大阵雪',
  95: '雷雨',
  96: '雷雨夹冰雹',
  99: '强雷雨夹冰雹',
})

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

/** 几点 → 中文时段。写成「晚上 21:52」比「21:52」好读，也不多花字。 */
function periodOf(h) {
  if (h < 5) return '凌晨'
  if (h < 8) return '早上'
  if (h < 11) return '上午'
  if (h < 13) return '中午'
  if (h < 17) return '下午'
  if (h < 19) return '傍晚'
  return '晚上'
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 日期这一条完全在本地算，不走网络——断网也该知道今天几号。 */
export function dateText(now = new Date()) {
  return (
    `今天是 ${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日，` +
    `星期${WEEK[now.getDay()]}。现在是${periodOf(now.getHours())} ` +
    `${pad2(now.getHours())}:${pad2(now.getMinutes())}。`
  )
}

/** `2026-11-06T06:48` → `06:48`；拿不到就返回空串，调用方自己决定要不要提。 */
function hhmm(iso) {
  const m = /T(\d{2}:\d{2})/.exec(String(iso ?? ''))
  return m ? m[1] : ''
}

/**
 * Open-Meteo 的返回 → 一句话事实。
 * 导出是为了测试能直接喂假数据，不必联网。
 */
export function weatherText(city, w) {
  const c = w?.current ?? {}
  const d = w?.daily ?? {}
  const code = Number(c.weather_code)
  const desc = WMO[code] ?? `天气代码 ${code}`

  const bits = [`${city}：${desc}，${Math.round(Number(c.temperature_2m))}°C`]
  // 体感和实际差不到 2 度就不提，省得一句话里两个温度打架
  if (Number.isFinite(Number(c.apparent_temperature))) {
    const diff = Math.abs(Number(c.apparent_temperature) - Number(c.temperature_2m))
    if (diff >= 2) bits.push(`体感 ${Math.round(Number(c.apparent_temperature))}°C`)
  }
  if (Number.isFinite(Number(c.relative_humidity_2m))) {
    bits.push(`湿度 ${Math.round(Number(c.relative_humidity_2m))}%`)
  }
  // 风小于 5 公里每小时说出来没意义，反而像凑字数
  if (Number.isFinite(Number(c.wind_speed_10m)) && Number(c.wind_speed_10m) >= 5) {
    bits.push(`风 ${Math.round(Number(c.wind_speed_10m))} 公里每小时`)
  }

  let line = bits.join('，') + '。'
  const lo = d.temperature_2m_min?.[0]
  const hi = d.temperature_2m_max?.[0]
  if (Number.isFinite(Number(lo)) && Number.isFinite(Number(hi))) {
    line += `今天 ${Math.round(Number(lo))}~${Math.round(Number(hi))}°C`
  }
  const sunrise = hhmm(d.sunrise?.[0])
  const sunset = hhmm(d.sunset?.[0])
  if (sunrise && sunset) {
    line += `${line.endsWith('。') ? '' : '，'}天亮 ${sunrise}，天黑 ${sunset}。`
  }
  return line
}

/** 带超时的 JSON 请求。Node 22 自带 fetch；不读系统代理，直连（本机实测可通）。 */
async function getJson(url, ms = 8000) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(ms),
    headers: { accept: 'application/json' },
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return await r.json()
}

export function registerWorld(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  // 测试可以注入假的取数函数，不联网
  const fetchWeather = deps.fetchWeather ?? defaultFetchWeather

  return ctx.tools.register(
    defineTool({
      name: 'her_world',
      description:
        '看看外面现在什么样：今天几号、星期几、现在几点（date），或者外面什么天气（weather）。' +
        '一次查一条。给的是事实，不带建议。',
      parameters: {
        type: 'object',
        properties: {
          what: {
            type: 'string',
            enum: ['date', 'weather'],
            description: 'date = 日期、星期、此刻几点；weather = 外面现在的天气。',
          },
        },
        required: ['what'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            what: { type: 'string' },
            text: { type: 'string', description: '查到的事实，一句话。查不到时是空串。' },
            note: { type: 'string', description: '查不到的原因（对她说的那句实话）。' },
          },
          required: ['ok', 'what', 'text', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : out.note }],
      },
      async execute(args) {
        const what = String(args?.what ?? '').trim().toLowerCase()

        if (what === 'date') {
          const text = dateText()
          logLine('info', ['她查了世界：date', text], root)
          return { ok: true, what, text, note: '' }
        }

        if (what !== 'weather') {
          // 参数校验本来就该挡住这里；真到了说明宿主放行了非法值，如实说
          return { ok: false, what, text: '', note: '这件事我还查不了。' }
        }

        const { config } = await loadConfig(root)
        const city = String(config?.world?.city ?? '').trim()
        if (!city) {
          // 不猜、不按 IP 定位（本机挂着代理，定位会指到代理那头去）。
          // 也别写成「不知道自己在哪」——她不在任何城市，那句话是假的。
          logLine('warn', ['她查了世界：weather，但没配城市'], root)
          return {
            ok: false,
            what,
            text: '',
            note: '不知道他在哪座城市。问一句就行。',
          }
        }

        try {
          const text = await fetchWeather(city)
          logLine('info', ['她查了世界：weather', text], root)
          return { ok: true, what, text, note: '' }
        } catch (err) {
          // 技术原因只进日志，对她只说「没查到」（fork.13：不编，也不甩堆栈）
          logLine('warn', ['她查了世界：weather 没查到', city, String(err?.message ?? err)], root)
          return { ok: false, what, text: '', note: '这次没查到。' }
        }
      },
    }),
  )
}

/**
 * 真去查：城市名 → 经纬度 → 当前天气。
 * 城市名用 Open-Meteo 的地理编码，中文直接认（实测「北京」→ 39.9075, 116.39723）。
 */
async function defaultFetchWeather(city) {
  const geo = await getJson(
    'https://geocoding-api.open-meteo.com/v1/search?count=1&language=zh&format=json&name=' +
      encodeURIComponent(city),
  )
  const loc = geo?.results?.[0]
  if (!loc) throw new Error(`认不出这个城市：${city}`)

  const w = await getJson(
    'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${loc.latitude}&longitude=${loc.longitude}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
      '&daily=temperature_2m_min,temperature_2m_max,sunrise,sunset' +
      '&timezone=auto&forecast_days=1',
  )
  if (!w?.current) throw new Error('返回里没有 current')

  // 用地理编码认出来的名字（「北京」）而不是调用方传的字符串，
  // 免得她传「bj」我们回「bj：晴」——回她那句要说得出口
  return weatherText(String(loc.name || city), w)
}
