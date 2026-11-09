import { join } from 'node:path'

/**
 * settings-schema.mjs —— 查看器设置页的字段清单（2026-11-07 全量化）
 *
 * 只描述「怎么显示、怎么校验」，不复制默认值——默认值从插件的 DEFAULTS 现读，
 * 免得两边各写一份、哪天对不上。保存走插件自己的 updateConfig（夹紧 + 归一化）。
 *
 * 全量口径：与 DSH 侧 client.js 的设置区对齐（内部字段除外：
 * notify.lastShown / comment.lastScanAt / ui.ownerHintDismissed / observe.port 这类
 * 运行时状态不做成旋钮）。顶层键必须全部落在 observe.js /config 的 allowed 白名单里，
 * viewer/test/settings-schema.test.mjs 钉着这条（镜像 p5 的防漂移测试）。
 *
 * kind：
 *   num    数字（min/max/step）
 *   bool   开关
 *   window 两个 HH:MM
 *   list   逗号分隔的字符串数组
 *   text   单行文本
 * danger=true 的项，改了会明显改变她的世界，前端会多问一句。
 */

export const SETTINGS = [
  { group: '成长节奏', key: 'growthDays', label: '成长天数', kind: 'num', min: 7, max: 180, step: 1, hint: '走完四个阶段用多少天' },
  { group: '成长节奏', key: 'wakesPerDay', label: '每天醒来几次', kind: 'num', min: 0, max: 4, step: 1, hint: '0 = 只在你找她的时候才在' },
  { group: '成长节奏', key: 'window', label: '她醒着的时间', kind: 'window', hint: '之外不叫她、不主动说话' },

  { group: '每日配额', key: 'daily.events', label: '每天推几条成长事件', kind: 'num', min: 0, max: 10, step: 1 },
  { group: '每日配额', key: 'daily.questions', label: '其中她向你提问几条', kind: 'num', min: 0, max: 5, step: 1, hint: '防退化成问答机器' },

  { group: '外面', key: 'world.city', label: '你在的城市', kind: 'text', hint: 'her_world 查天气用的坐标——是**你这台机器**在的城市，她住在文件里，没有地理位置。中文城市名（比如「杭州」）；空 = 查不了天气，date 不受影响' },

  { group: '她主动说话', key: 'proactive.enabled', label: '开着', kind: 'bool', hint: '关掉她就只在被叫醒时才能开口' },
  { group: '她主动说话', key: 'proactive.maxPerDay', label: '一天最多开几次空手回合', kind: 'num', min: 0, max: 20, step: 1, hint: '只管「自己攒劲儿开一轮」的次数；her_say 发消息不受这个数管（2026-11-07 起没有闸）' },
  { group: '她主动说话', key: 'proactive.minIdleHours', label: '多久没人说话才够格', kind: 'num', min: 0, max: 48, step: 0.5, hint: '小时' },
  { group: '她主动说话', key: 'proactive.baseChance', label: '每次掷骰的基础概率', kind: 'num', min: 0, max: 1, step: 0.01 },
  { group: '她主动说话', key: 'proactive.gainPerHour', label: '每多等一小时加多少', kind: 'num', min: 0, max: 0.5, step: 0.01 },
  { group: '她主动说话', key: 'proactive.maxChance', label: '概率上限', kind: 'num', min: 0, max: 1, step: 0.01 },
  { group: '她主动说话', key: 'proactive.cooldownHours', label: '两次之间至少隔多久', kind: 'num', min: 0, max: 48, step: 0.5, hint: '小时' },
  { group: '她主动说话', key: 'proactive.rollsPerHour', label: '每小时最多掷几次', kind: 'num', min: 1, max: 12, step: 1, hint: '只决定多叫她几次，说不说仍由她' },
  { group: '她主动说话', key: 'proactive.sendTools', label: '靠哪些工具算开口', kind: 'list', hint: '0.9.1（PR #44）。2026-11-07 统一后正文永远不会发到 QQ，只有 her_say 会发；这个名单决定调成功哪些工具才算「她开了口」。逗号分隔，留空 = 只认 her_say' },
  { group: '她主动说话', key: 'proactive.foldSilent', label: '没开口就把这轮折掉', kind: 'bool', hint: '0.9.1：静默回合在模型看到的历史里折成一行，人类对话记录不动' },
  { group: '她主动说话', key: 'proactive.idleCountsSeen', label: '「他来过」打断安静', kind: 'bool', hint: '0.9.1：seen: 也计入空闲判定' },

  { group: '她自己的三件事', key: 'drive.enabled', label: '主动性（攒劲儿）', kind: 'bool', hint: '0.9.0 起：关掉她不会自己攒劲儿开一轮，日程唤醒与手动叫醒照样能用' },
  { group: '她自己的三件事', key: 'interest.enabled', label: '兴趣（摆到桌上的那几行）', kind: 'bool' },
  { group: '她自己的三件事', key: 'dream.enabled', label: '梦', kind: 'bool', hint: '关掉只是「以后不再记」，已经记的一条不删' },

  { group: '日记', key: 'diary.enabled', label: '她每天写日记', kind: 'bool' },
  { group: '日记', key: 'diary.visible', label: '日记给你看', kind: 'bool', hint: '默认关——这是她的本子' },
  { group: '日记', key: 'diary.keepDays', label: '保留多少天', kind: 'num', min: 0, max: 365, step: 1, hint: '0 = 永久' },

  { group: '回忆与遗忘', key: 'recall.oldDays', label: '多久以前的事开始忘', kind: 'num', min: 0, max: 365, step: 1, hint: '天；0 = 不设门槛' },
  { group: '回忆与遗忘', key: 'recall.minCue', label: '要多具体的线索才想得起来', kind: 'num', min: 0, max: 1, step: 0.05, hint: '0 = 什么都翻得到，调大忘得更狠' },
  { group: '回忆与遗忘', key: 'recall.jitter', label: '门槛的「今天状态」浮动', kind: 'num', min: 0, max: 1, step: 0.05, hint: '0 = 完全确定；0.2 = 上下浮 20%' },

  { group: '冷落', key: 'absenceAfterDays', label: '你多久不出现算冷落', kind: 'num', min: 1, max: 30, step: 1, hint: '天' },

  { group: '刷站', key: 'browse.enabled', label: '她能上网', kind: 'bool' },
  { group: '刷站', key: 'browse.perDay', label: '每天刷几次', kind: 'num', min: 0, max: 10, step: 1 },
  { group: '刷站', key: 'browse.topN', label: '一次看几条', kind: 'num', min: 1, max: 10, step: 1 },
  { group: '刷站', key: 'browse.rankingTids', label: '一次轮换几个分区', kind: 'num', min: 1, max: 10, step: 1, hint: '首批别只吃固定片单' },
  { group: '刷站', key: 'browse.deepRead', label: '每条深读几条热评', kind: 'num', min: 0, max: 20, step: 1 },
  { group: '刷站', key: 'browse.danmaku', label: '每条抽几条弹幕', kind: 'num', min: 0, max: 20, step: 1, hint: '0 = 不抽' },
  { group: '刷站', key: 'browse.keywords', label: '额外的搜索词', kind: 'list', hint: '逗号分隔；空 = 只看首页/排行' },
  { group: '刷站', key: 'browse.window', label: '什么时候能上网', kind: 'window', hint: '醒着不一定要上网，上网只在醒着时发生' },
  { group: '刷站', key: 'browse.voices', label: '让她读评论区', kind: 'bool', hint: '关掉也能上网，只是她再也读不到别人的说法' },

  { group: '避雷', key: 'avoid.keywords', label: '不想看的关键词', kind: 'list', hint: '逗号分隔' },
  { group: '避雷', key: 'avoid.upMids', label: '屏蔽的 UP 主', kind: 'list', hint: 'mid，逗号分隔' },
  { group: '避雷', key: 'avoid.minDuration', label: '太短的不看（秒）', kind: 'num', min: 0, max: 3600, step: 10 },

  { group: '请求节奏', key: 'bili.minIntervalMs', label: '两次 B 站请求至少间隔', kind: 'num', min: 0, max: 10000, step: 100, hint: '毫秒；机房 IP 要放慢' },
  { group: '请求节奏', key: 'bili.jitterMs', label: '在间隔上再随机多等', kind: 'num', min: 0, max: 5000, step: 100, hint: '毫秒' },

  { group: '看画面', key: 'video.enabled', label: '她能看视频画面', kind: 'bool' },
  { group: '看画面', key: 'video.perDay', label: '高峰时段每天几条', kind: 'num', min: 0, max: 20, step: 1, hint: '工作日 9-12 / 14-18 点（原价）' },
  { group: '看画面', key: 'video.offPeakPerDay', label: '空闲时段每天几条', kind: 'num', min: 0, max: 20, step: 1, hint: '其余时间（半价），额度给得多些' },
  { group: '看画面', key: 'video.vsPath', label: 'vs 外挂目录', kind: 'text', hint: '空 = 自动找，通常不用填' },
  { group: '看画面', key: 'video.hotword', label: '听写热词', kind: 'text', hint: '空格分开，提高专有名词识别率；空 = 不用' },

  { group: '评论区', key: 'comment.enabled', label: '她能在 B 站说话', kind: 'bool', danger: true, hint: '唯一会改动她账号上东西的功能：发评论留痕、别人能看见。默认关' },
  { group: '评论区', key: 'comment.perDay', label: '每天最多发几条', kind: 'num', min: 0, max: 10, step: 1 },
  { group: '评论区', key: 'comment.replyPerDay', label: '每天最多回几条楼中楼', kind: 'num', min: 0, max: 10, step: 1 },
  { group: '评论区', key: 'comment.replyToReplies', label: '有人回她时允许回一句', kind: 'bool' },
  { group: '评论区', key: 'comment.scanEveryMin', label: '多久看一眼有没有人回她', kind: 'num', min: 5, max: 240, step: 5, hint: '分钟' },
  { group: '评论区', key: 'comment.window', label: '只在什么时段说话', kind: 'window', hint: '与她的作息分开，可单独调' },
  { group: '评论区', key: 'comment.atOwner', label: '评论开头 @ 你', kind: 'bool', hint: '需要先在 DSH 侧存过你的昵称' },

  { group: '对话', key: 'chat.rotateAfter', label: '聊满几轮换新会话', kind: 'num', min: 0, max: 400, step: 10, hint: '0 = 永不换。撑爆上下文的那次事故根因就是轮数；换会话=侧栏上下文换一条，账本记忆不断。改之前先想清楚' },
  { group: '对话', key: 'chat.rotateWhenKB', label: '会话内容多大换新', kind: 'num', min: 0, max: 5000, step: 100, hint: 'KB，0 = 不看大小。轮数和上下文大小不挂钩（一轮调很多次工具也会顶爆），量的是会话日志里会进上下文的内容（估），与轮数谁先到谁生效。默认 800 是 11-09「一天 8700 万 tokens」事故反推的保守值' },
  { group: '对话', key: 'chat.replyChars', label: '单轮最多写多少字', kind: 'num', min: 0, max: 4000, step: 100, hint: '0 = 不限（默认），提示词里不出现任何长度要求' },

  { group: '房间', key: 'rooms.groupRotateDays', label: '群房用几天换新', kind: 'num', min: 0, max: 60, step: 1, hint: '0 = 不换；书房按 chat.rotateAfter 的轮数换' },

  { group: '记忆与上下文', key: 'memory.docBudget', label: '身份文档字数预算', kind: 'num', min: 600, max: 4000, step: 100, hint: '超了按优先级丢可选段，「你是谁」永不丢；2400 实测一段不丢' },
  { group: '记忆与上下文', key: 'memory.sleepEveryDays', label: '每几天让她想一想', kind: 'num', min: 0, max: 60, step: 1, hint: '0 = 不主动想' },
  { group: '记忆与上下文', key: 'memory.selfWake', label: '空醒时自己找事做', kind: 'bool', hint: '0.9.0：醒来没派活、桌上也没东西时' },
  { group: '记忆与上下文', key: 'memory.sleepKeep', label: '总共留多少条自述', kind: 'num', min: 1, max: 50, step: 1, hint: '超出后最早的折进「更早以前」' },
  { group: '记忆与上下文', key: 'memory.beliefsShown', label: '一轮摆几条判断', kind: 'num', min: 1, max: 8, step: 1, hint: '其余折成一行' },
  { group: '记忆与上下文', key: 'memory.hearEvery', label: '每几轮旁听你一句话', kind: 'num', min: 0, max: 50, step: 1, hint: '0 = 不记；记的是你曾经说过什么' },

  { group: '规则与申请', key: 'rules.offers', label: '允许她提「想改一条规矩」', kind: 'bool', hint: '关掉只是最近别来要东西，已有授权不撤销' },
  { group: '规则与申请', key: 'rules.holdDays', label: '几天不处理算搁置', kind: 'num', min: 1, max: 30, step: 1, hint: '搁置不算驳回、不加重冷却' },
  { group: '规则与申请', key: 'rules.cooldownDays', label: '被驳回后隔几天才能再提', kind: 'num', min: 1, max: 30, step: 1, hint: '天' },

  { group: '出门', key: 'outing.ack', label: '出门说明卡已看过一遍', kind: 'bool', hint: '一次性确认；看过的不用再看' },
  { group: '出门', key: 'outing.enabled', label: '她能出门进真工作区', kind: 'bool', danger: true, hint: '那儿有 bash/read/write，读到的东西直接进她那条会话的上下文。默认关' },

  { group: '桌面提醒', key: 'notify.enabled', label: '她开口时弹桌面通知', kind: 'bool', hint: '默认关；打开后一天最多一次，且只在她真的开口之后弹' },

  { group: '工具面', key: 'tools.preset', label: '会话 preset', kind: 'text', hint: '宿主按 preset 收窄工具；宿主那侧没打通前留空（写了也不生效，别写一个假装生效的名字）' },
  { group: '工具面', key: 'tools.allow', label: '额外放行的工具', kind: 'list', hint: '宿主工具名白名单（如 schedule_create、bring_back），逗号分隔；空 = 只给她自己的那些' },
  { group: '工具面', key: 'tools.restrict', label: '工具面收窄', kind: 'bool', danger: true, hint: '关掉她会看到宿主的全部工具，会开始做很多她本来不做的事' },
]

/** 按 "a.b" 取/设嵌套值 */
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}
export function setPath(obj, path, val) {
  const keys = path.split('.')
  const last = keys.pop()
  const t = keys.reduce((o, k) => (o[k] ?? (o[k] = {})), obj)
  t[last] = val
}

/** 数字字段右边的单位（有就显示，没有就不显示） */
export const UNIT = {
  'growthDays': '天', 'wakesPerDay': '次', 'daily.events': '条', 'daily.questions': '条',
  'diary.keepDays': '天', 'recall.oldDays': '天', 'absenceAfterDays': '天',
  'proactive.maxPerDay': '次', 'proactive.minIdleHours': '小时', 'proactive.cooldownHours': '小时',
  'proactive.rollsPerHour': '次', 'browse.perDay': '次', 'browse.topN': '条',
  'browse.rankingTids': '个', 'browse.deepRead': '条', 'browse.danmaku': '条',
  'avoid.minDuration': '秒', 'bili.minIntervalMs': 'ms', 'bili.jitterMs': 'ms',
  'video.perDay': '条', 'video.offPeakPerDay': '条',
  'comment.perDay': '条', 'comment.replyPerDay': '条', 'comment.scanEveryMin': '分',
  'chat.rotateAfter': '轮', 'chat.rotateWhenKB': 'KB', 'chat.replyChars': '字',
  'rooms.groupRotateDays': '天',
  'memory.docBudget': '字', 'memory.sleepEveryDays': '天', 'memory.sleepKeep': '条',
  'memory.beliefsShown': '条', 'memory.hearEvery': '轮',
  'rules.holdDays': '天', 'rules.cooldownDays': '天',
}

/** 从插件读默认值；读不到就用空对象（页面会显示「读不到默认值」）。 */
export async function readDefaults(fishDir) {
  try {
    const m = await import('file:///' + join(fishDir, 'lib', 'settings.js').replace(/\\/g, '/'))
    return m?.DEFAULTS ?? {}
  } catch {
    return {}
  }
}
