# webchat —— 自建网页对话通道（2026-11-12）

与 QQ 桥（`../bridge/`）**平级的第二个网关**：用自建网页跟她对话。
调研与拍板记录见 `../research/web-channel/README.md`
（广播式路由 / 放 bridge 旁 / MVP 纯文字，2026-11-12 用户拍板）。
同日按「把聊天的完整功能做了，包括询问，图片，视频，定位等功能」补全。

## 链路

```
浏览器 ←HTTP+WS→ webchat.mjs（默认 :6210，只绑 127.0.0.1）
   ├─ 入站：网页发言 → POST /dsh-fish/local/say（带「（这条消息从网页发来）」标注，fork.13）
   │        她还在跑时后到的纯文字 → /local/steer 插话，插不进去退回排队重发
   │        申请卡点选项 → /local/answer（与 DSH 卡片同一条 answerCard）
   │        图片 → /local/say 的 image（data URL → 落盘 → 她用 read_image 看）
   │        视频/大图/其他文件 → /upload → <fishRoot>/home/inbox/（只报事实）
   │        定位 → 浏览器 geolocation，只把经纬度/精度/地图链接当文字递过去
   └─ 出站：push.mjs（复用桥的监账本骨架，独立 state 文件）→ WS 广播 → 浏览器
            say / proactive / watch / letter / ask / voice / meme 全种类呈现
            /media 取她的图/音视频（要 auth-ok 发的 token，且只能取数据目录内的文件）
```

- **广播式**（拍板）：她的话（her_say → 账本）QQ 和网页都会出现，不做会话隔离。
- **不转接正文**（2026-11-07 口径，与桥一致）：`/local/say` 响应里的窗口正文忽略；
  她想说的话只会经 her_say → 账本 → 推送到达。
- 零腾讯依赖：QQ 通道死了这里照跑。**桥 / 插件 / DSH 一行没改，无需重启**。

## 用法

```cmd
:: Windows：双击 start.cmd，或
cd webchat && node webchat.mjs
```

浏览器开 `http://127.0.0.1:6210`。本机免密；局域网访问要在 `config.json` 里设
`password` 并把 `host` 改成 `0.0.0.0`（先想清楚暴露面，详见调研报告 §5）。

首次运行会按 `config.example.json` 的默认值生成 `config.json`（已 gitignore）。

工具栏三个键：**图片**（小图直传 base64，>7MB 转上传）、**文件**（视频/任意文件）、
**定位**（浏览器要授权，拿不到就如实说没拿到）。她的申请卡直接点选项就答。

## 配置（config.json）

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | 6210 | 监听端口 |
| `host` | 127.0.0.1 | 只绑本机；改 0.0.0.0 才能局域网访问（必须配 password） |
| `password` | "" | 非本机连接的密码；空 = 只允许本机 |
| `fishPort` | 0 | 0=自动发现 DSH 端口；DSH 端口发现不了时写死 |
| `fishRoot` | 自动 | 数据目录（`~/.dsh-fish`），密钥与账本都在里面 |
| `pollMs` | 1500 | 盯账本的间隔 |
| `historyLines` | 200 | 打开页面时回放账本末尾多少行 |
| `fileMaxBytes` | 512MB | 上传上限（视频动辄几百 MB）；超了如实报错并清掉半成品 |
| `sayTimeoutMs` | 300000 | 等她这一轮的超时（她想说才说，可能很久） |

## 测试

```bash
cd webchat && npm install && npm test
```

21 条：纯函数单测 + 集成（mock DSH 起真服务，把 auth / 递话 / 图片 / 上传 /
申请卡结算 / 媒体鉴权 / 账本推送 / 前端 JS 语法全走一遍）。

## 口径与边界（改代码前先读）

- **来源必须为真（fork.13）**：网页来的话必须带 `WEB_NOTE` 标注，她要先知道这话从哪来；
  文件话术与桥同一字据——只报名字 / 大小 / 路径，**不承诺工具能打开**，看不看由她定。
  0 字节就是 0KB，别四舍五入成 1KB。
- **内心活动不算开口（fork.7 教训）**：账本里只有 `source=tool` 且带三种标记
  （她说 / 她主动说 / 陪你看，同 push.mjs 的认法）的 utterance 才推给网页。
  **不养第二份账本解析器**：直接用 `bridge/push.mjs` 的 `parsePushLine`。
- **视频/文件按文件模式**（2026-11-06 口径）：一律落 `home/inbox/`，不按格式分流，
  也不替她挑哪个值得看。定位是纯文字事实，不替她说「在哪」。
- **历史只有她这半边**：他那侧的入话事件形状没接（二期），页面上历史只有她说的话；
  网页自己刚发的消息只是本地回显，不是账本回放。
- **/media 不裸奔**：要 WS auth-ok 发的 token，连接一断 token 就作废；
  路径必须在 `fishRoot` 之内（`realpathSync` 判，符号链接也拦）。
- **前端 JS 必须是独立文件**（`static/app.js`），测试里有 `node --check` 兜底——
  模板字符串内嵌 JS 的坑踩过两次，别再踩。改了 UI 文案别把测试断言绑在文案上。
