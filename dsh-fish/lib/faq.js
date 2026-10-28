/**
 * faq.js —— 常见问题解答（设置 → 反馈页那个按钮点开看到的一页）
 *
 * 正文来自作者 2026-10-28 给的《常见问题解答.doc》。逐条保留作者原话，不在这里改语气、
 * 不自己补例子——这份文档是写给用户的说明，不是她的口吻，也不进她的上下文。
 *
 * 为什么做成「插件自带一页」而不是把 doc 一起打包：
 * - 插件零依赖、不读用户磁盘；.doc 是 OLE 二进制，浏览器也打不开，换台机器就废了。
 * - 两处出口永远和插件同版本：`/dsh-fish/faq`（整页 HTML，断网可看）与
 *   `/dsh-fish/faq.data`（同一份正文的 JSON，设置 → 反馈页的面板就地展开用）。
 *   2026-10-28 晚起前面那个按钮改成就地展开：新标签页敲这个路径会被宿主的信任栅栏拦成
 *   403（只认 App 登录 cookie），用户看到的就是「点了没反应」。
 */

export const FAQ_TITLE = '插件常见问题解答（有问题优先看这个）'

/** 每项：{ q: 问题, a: [段落, ...] }。顺序 = 原文档顺序。 */
export const FAQ = [
  {
    q: '插件创建的大肥鱼插件怎么没有各种权限？',
    a: [
      '因为她能用的工具越多，越影响养成。每个工具都会把自己的使用说明注入到她的上下文，会削弱她的人格属性，增加她的工具属性。且会占用更多上下文，消耗更多token。如果一定要让她使用某些工具，请开插件白名单。',
    ],
  },
  {
    q: '如何让插件接qq/微信/抖音等各种渠道？',
    a: [
      '请去社区找各种成熟项目，把对应的插件和本插件一起安装，即可实现桥接功能。只需要在本插件设置白名单放行（设置的插件页面操作），且在对应插件的设置面板调整即可。有不懂的可以问你的大肥鱼（非本项目创建的那条）',
    ],
  },
  {
    q: '上下文撑爆了怎么办？',
    a: [
      '轮数越多，上下文越多，早晚撑爆，所以设置了个换窗口功能，默认40轮换一次窗口。会把这40轮大肥鱼已经形成的认知、矛盾等关键信息一起搬到新对话，只搬了人格相关的，具体的记忆细节没有搬。',
      '我认为就像是人不会记住今天吃了啥，今天路上有什么风景，一些记忆其实对于人格的养成不重要，所以只搬核心的认知层面的东西，剩余的都留在本地存储',
    ],
  },
  {
    q: '遗忘机制是怎么回事',
    a: [
      '遗忘一方面删上下文省token，另一方面这是在有取舍的找到真正重要的核心认知和人格进行保留。',
      '大肥鱼上下文有限，所以只记重要的事情，什么重要，就是她自己经过实践验证的2次以上的事，或者是你提供三次以上的事，此外还有她自己的观点冲突（我说过a对，又说过b对，我想不明白），以及你说她和她吵架可能也会被记住',
      '还有更后期的立场的诞生，我是谁，我喜欢什么，我不喜欢什么这些会被永远的保留在上下文里，其余的都放到本地存储了。',
      '并且这些已经很核心的记忆也有可能被更核心的记忆取代，目前并没有办法做到这种核心认知也可以无限制的增加，因为那还是会超过上下文，可能后期会想一个优化方案。',
    ],
  },
  {
    q: '对话认知条数什么意思',
    a: ['对话认知条数越多，就等于她能记得的认知就会越多，在条数没有满之前，不会被新认知替代'],
  },
  {
    q: '上下文字数限制是什么',
    a: ['上下文字数限制，就是提升上限，上限越高，越不容易触发认知被删除替换的情况'],
  },
  {
    q: '如果一直不换新对话会怎么样（聊满多少轮换对话设置为0）',
    a: [
      '消耗token会变多，虽然我限制了全量工具的使用，并且规定只有认知进提示词，已经少用很多token了',
      '但是还是会不断读取全部的上下文，肯定会随着对话条数增加，消耗token越来越多，并且这个对话的打开时间也会变得更长，大肥鱼给你的回复速度也会越来越慢',
    ],
  },
  {
    q: '换对话后她还是不是她',
    a: [
      '理论上不影响，因为记忆和遗忘机制的存在，最核心的人格已经锁死在上下文了，会随着上下文直接移动到新对话，她继承的是前一轮对话形成的完整认知和人格。',
    ],
  },
  {
    q: '为什么会出现显示没有可用的成长事件？',
    a: ['因为你和大肥鱼聊天太少，没有满足触发成长事件的条件'],
  },
  {
    q: '为什么大肥鱼看不了视频',
    a: [
      '可能是没装ffmpeg，可能是没到她刷视频的时间（随机时间刷视频），可能是你没有给详细的视频链接或者bv号，你可以主动让大肥鱼刷视频去触发，也可以发具体链接让大肥鱼去看。',
    ],
  },
  {
    q: '我能不能额外加各种功能',
    a: ['可以，请直接下载对应插件，并和本插件一起启用，且在插件白名单放行。'],
  },
  {
    q: '还有XXX问题',
    a: ['请去请教万能的大肥鱼还有万能的群友。'],
  },
]

/** 只做 HTML 文本转义：这一页的内容全部是纯文本，没有一处该被当成标签。 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 整页 HTML。默认用内置的 FAQ；参数只在测试里用得上。
 * 不引外部字体/脚本/图片：断网也能看，也不会因为第三方挂了整页白屏。
 */
export function renderFaqPage(items = FAQ, title = FAQ_TITLE) {
  const body = items
    .map((it, i) => {
      const paras = (it.a ?? []).map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')
      return `<section class="qa" id="q${i + 1}">\n<h2><span class="no">${i + 1}.</span>${escapeHtml(it.q)}</h2>\n${paras}\n</section>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;padding:32px 20px 56px;font:15px/1.85 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
       background:#fff;color:#1b1b1f;-webkit-text-size-adjust:100%}
  main{max-width:760px;margin:0 auto}
  h1{margin:0 0 6px;font-size:22px;line-height:1.4;letter-spacing:.2px}
  .sub{margin:0 0 28px;font-size:13px;color:#6b6b73}
  .qa{padding:18px 0;border-top:1px solid rgba(128,128,128,.22)}
  .qa:first-of-type{border-top:0}
  h2{margin:0 0 10px;font-size:16px;line-height:1.6;font-weight:600}
  h2 .no{display:inline-block;min-width:1.9em;color:#8a8a93;font-weight:600}
  .qa p{margin:0 0 10px;color:#33333a}
  .qa p:last-child{margin-bottom:0}
  footer{margin-top:32px;padding-top:16px;border-top:1px solid rgba(128,128,128,.22);font-size:13px;color:#6b6b73}
  @media (prefers-color-scheme:dark){
    body{background:#16171a;color:#e9e9ee}
    .sub,.qa p,footer{color:#b9b9c2}
    .qa,h2 .no{color:#8f8f99}
    .qa{border-color:rgba(255,255,255,.14)}
    .qa p{color:#c9c9d2}
    footer{border-color:rgba(255,255,255,.14)}
  }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p class="sub">这一页是插件自带的说明书，不用联网也能看。关了窗口就回去了。</p>
${body}
<footer>还有没写到的，去设置里的「反馈」页找开发者或进交流群。</footer>
</main>
</body>
</html>
`
}
