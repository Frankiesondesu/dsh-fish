/**
 * her_world（2026-11-06）：看看外面——今天几号、外面什么天气。
 *
 * 这个工具跟别的工具不一样：**是她自己在账本里开口要的**。
 *   11-05 12:23 她用 ask_owner 问「能不能给我一样能查实时信息的东西——天气、日期这类」
 *   11-06 12:23 账本记的是「一直没人答」
 * 所以测试重点不在功能多花哨，而在几条**不能退让的线**：
 *   1. 查不到就说查不到（fork.13），不编一个听起来对的天气；
 *   2. 没配城市就明说不知道**他**在哪，不按 IP 猜（本机挂代理，猜也会猜错）；
 *      ⚠️ 不能写成「不知道自己在哪」——她不在任何城市，那句话是假的。
 *   3. 只给事实，不给「适不适合出门」这类建议（不替她判断）；
 *   4. 不写账本——查天气不是她的判断，别去污染「判断 N 条」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerWorld, dateText, weatherText } from '../lib/world.js'
import { readEvents } from '../lib/store.js'
import { updateConfig } from '../lib/settings.js'
import { FISH_TOOLS } from '../lib/restrict.js'
import { TOOL_GUIDE } from '../lib/toolguide.js'

function fakeCtx() {
  const regs = new Map()
  return {
    regs,
    tools: {
      register: (t) => {
        regs.set(t.name, t)
        return () => regs.delete(t.name)
      },
    },
  }
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-world-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
}

/** Open-Meteo 真实返回的形状（2026-11-06 实测抓的那一份） */
const SAMPLE = {
  current: {
    time: '2026-11-06T21:45',
    temperature_2m: 7.4,
    apparent_temperature: 4.7,
    relative_humidity_2m: 49,
    weather_code: 2,
    wind_speed_10m: 0.9,
    is_day: 0,
  },
  daily: {
    temperature_2m_min: [4.8],
    temperature_2m_max: [13.2],
    sunrise: ['2026-11-06T06:48'],
    sunset: ['2026-11-06T17:07'],
  },
}

// ---------------------------------------------------------------- 格式化

test('dateText：日期、星期、时段都说得出口', () => {
  // 2026-11-06 是星期五（用户那边的时间）
  const s = dateText(new Date(2026, 10, 6, 21, 52))
  assert.equal(s, '今天是 2026 年 11 月 6 日，星期五。现在是晚上 21:52。')
})

test('dateText：时段分界（凌晨/早上/中午/傍晚）', () => {
  const at = (h, m = 0) => dateText(new Date(2026, 10, 6, h, m))
  assert.match(at(3), /凌晨 03:00/)
  assert.match(at(7), /早上 07:00/)
  assert.match(at(12), /中午 12:00/)
  assert.match(at(18), /傍晚 18:00/)
  assert.match(at(23, 5), /晚上 23:05/)
})

test('weatherText：气温、体感、湿度、今天高低、天明天黑', () => {
  const s = weatherText('北京', SAMPLE)
  assert.match(s, /^北京：多云，7°C/)
  assert.match(s, /体感 5°C/)
  assert.match(s, /湿度 49%/)
  assert.match(s, /今天 5~13°C/)
  assert.match(s, /天亮 06:48/)
  assert.match(s, /天黑 17:07/)
  // 只给事实：不要出现「适合」「记得」「建议」这类替她判断的话
  assert.doesNotMatch(s, /适合|建议|记得|小心|注意/)
})

test('weatherText：体感差不到 2 度就不提，风太小也不提（少凑字数）', () => {
  const flat = {
    current: { ...SAMPLE.current, apparent_temperature: 7.6, wind_speed_10m: 1 },
    daily: SAMPLE.daily,
  }
  const s = weatherText('北京', flat)
  assert.doesNotMatch(s, /体感/)
  assert.doesNotMatch(s, /风 /)
})

test('weatherText：认得的风大才说', () => {
  const windy = { current: { ...SAMPLE.current, wind_speed_10m: 22.4 }, daily: SAMPLE.daily }
  assert.match(weatherText('北京', windy), /风 22 公里每小时/)
})

test('weatherText：没见过的天气码就报数字，不编一个词', () => {
  const weird = { current: { ...SAMPLE.current, weather_code: 777 }, daily: SAMPLE.daily }
  assert.match(weatherText('北京', weird), /天气代码 777/)
})

// ---------------------------------------------------------------- 工具行为

test('date 不走网络：注入的取数函数一次都不该被调用', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    let called = 0
    registerWorld(ctx, { root, fetchWeather: async () => { called++; return 'x' } })
    const tool = ctx.regs.get('her_world')

    const r = await tool.execute({ what: 'date' })
    assert.equal(r.ok, true)
    assert.equal(r.what, 'date')
    assert.match(r.text, /^今天是 \d{4} 年 \d{1,2} 月 \d{1,2} 日，星期[日一二三四五六]。/)
    assert.equal(called, 0, 'date 是本地算的，不该发请求')
  })
})

test('没配城市：如实说不知道他在哪，不按 IP 猜，也不发请求', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    let called = 0
    registerWorld(ctx, { root, fetchWeather: async () => { called++; return 'x' } })
    const tool = ctx.regs.get('her_world')

    const r = await tool.execute({ what: 'weather' })
    assert.equal(r.ok, false)
    assert.equal(r.text, '')
    assert.match(r.note, /不知道他在哪座城市/)
    // 关键：不能暗示她「自己」有个位置——那是替她安一个她从来没有的身份
    assert.doesNotMatch(r.note, /自己在哪|我在哪个城市|我的城市/)
    assert.equal(called, 0, '不知道该查哪，就别乱查')
  })
})

test('配了城市：查到就把那句话原样给她', async () => {
  await withRoot(async (root) => {
    await updateConfig({ world: { city: '北京' } }, root)
    const ctx = fakeCtx()
    const cities = []
    registerWorld(ctx, {
      root,
      fetchWeather: async (city) => { cities.push(city); return '北京：多云，7°C。' },
    })
    const tool = ctx.regs.get('her_world')

    const r = await tool.execute({ what: 'weather' })
    assert.equal(r.ok, true)
    assert.equal(r.text, '北京：多云，7°C。')
    assert.deepEqual(cities, ['北京'])
  })
})

test('查不到（网络/接口挂了）：只说「这次没查到」，不倒错误给她', async () => {
  await withRoot(async (root) => {
    await updateConfig({ world: { city: '北京' } }, root)
    const ctx = fakeCtx()
    registerWorld(ctx, {
      root,
      fetchWeather: async () => { throw new Error('getaddrinfo ENOTFOUND geocoding-api.open-meteo.com') },
    })
    const tool = ctx.regs.get('her_world')

    const r = await tool.execute({ what: 'weather' })
    assert.equal(r.ok, false)
    assert.equal(r.text, '')
    assert.equal(r.note, '这次没查到。')
    // 技术细节不许漏到她眼前
    assert.doesNotMatch(r.note, /ENOTFOUND|open-meteo|Error/)
  })
})

test('不认识的 what：如实说查不了，不瞎编一条', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerWorld(ctx, { root, fetchWeather: async () => 'x' })
    const tool = ctx.regs.get('her_world')
    const r = await tool.execute({ what: 'news' })
    assert.equal(r.ok, false)
    assert.equal(r.text, '')
    assert.match(r.note, /查不了/)
  })
})

test('不写账本：查天气不是她的判断，别去污染「判断 N 条」', async () => {
  await withRoot(async (root) => {
    await updateConfig({ world: { city: '北京' } }, root)
    const ctx = fakeCtx()
    registerWorld(ctx, { root, fetchWeather: async () => '北京：多云，7°C。' })
    const tool = ctx.regs.get('her_world')

    await tool.execute({ what: 'date' })
    await tool.execute({ what: 'weather' })

    const { events } = await readEvents(root)
    assert.equal(events.length, 0, 'her_world 不该产生任何事件')
  })
})

// ---------------------------------------------------------------- 接线

test('her_world 在工具面白名单里——不进这个名单她根本看不见它', () => {
  assert.ok(FISH_TOOLS.includes('her_world'), 'FISH_TOOLS 少了 her_world，工具面就会把它筛掉')
})

test('her_world 有说明书（her_help 要能查到）', () => {
  const g = TOOL_GUIDE.her_world
  assert.ok(g, 'TOOL_GUIDE 缺 her_world')
  assert.match(g.brief, /天气|几号/)
  // 说明书写的是事实边界，不能写成「遇到 X 就用它」那种替她做判断的话
  assert.ok(Array.isArray(g.cant) && g.cant.length > 0)
  assert.ok(g.cant.some((s) => /建议|替你判断/.test(s)), '得写明它不给建议')
})
