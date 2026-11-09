# fish —— dsh-fish 的 fork：在 QQ 上养一个 AI 人格

这是 [ssamurias/dsh-fish](https://github.com/ssamurias/dsh-fish) 的 fork。上游是一个
DSH（DeepSeek Harness）插件：**不写人设、不做记忆摘要**——人格从一本只增不改的账本
（`events.jsonl`）每轮现算出来，把「塑成一个什么样的人」换成「从经历里长成一个人」。

这个 fork 在上游之上补齐了「她的生活基建」：

- **QQ 桥**（bridge/）：她的主要通路。消息收发、合批、语音转写、附件文件模式、
  主动搭话推送、申请卡推送与代答
- **查看器**（viewer/，127.0.0.1:7788）：人格数据、她说的话（含发到 QQ 的）、事件流、
  观测台（待答申请/信箱/规则裁决/你不在的时候）、上网记录、记忆体检、用量、
  本机状态、**全量设置页（71 项）**
- **GUI 管理器**（manager/，7789）：各服务启停/重启、待重启检测、启动日志
- **白板画笔 her_draw**：线/矩形/圆/箭头/文字，构图由她定，渲染成 PNG
- **公式排版 her_formula**：一段「文字 + `$公式$`」排成一页图（Edge 无头 + MathJax），讲推导用
- **her_world**：日期与天气（她自己申请的）
- **生命周期**：一键启动/重启/关闭、本地语音服务接入、本地通路 API（local.key 鉴权）

设计立场（与上游一致，fork 另有两条定案）：**工具对她说的话必须为真**；**发不发、
画不画、说不说由她决定**——基建只提供能力，不替她做主。

> ⚠️ 仓库里**没有**她——她的账本、日记、画都在运行目录（默认 `~/.dsh-fish`），
> 每一份都是那个使用者在自己的生活里养出来的。你拿到的是一套养她的框架。

---

## 环境要求

| 组件 | 说明 |
|---|---|
| Windows 10/11 | 强绑定：生命周期脚本、GDI 渲染、路径解析都按 Windows 设计 |
| [DSH（DeepSeek Harness）桌面版](https://github.com/ssamurias/dsh-fish) | 她的宿主。先按上游说明装好、能正常对话 |
| Node.js 22+ | 桥 / 查看器 / 管理器 / 启动器 |
| QQ + [LLOneBot](https://github.com/LLOneBot/LLOneBot) | QQ 协议侧：LLOneBot 以 OneBot 连到桥的 WebSocket（默认 6199） |
| ffmpeg（可选） | 动图表情拆帧。装了 WinGet 版会自动找，或设 `DSH_FISH_FFMPEG` |
| funasr ASR 服务（可选） | 语音转写，端口 18765（归你自己的语音管线管，桥只调用） |

## 快速开始

```bat
:: 放在哪都行，下面的例子用 %USERPROFILE%\fish（路径别带空格）
git clone <本仓库> %USERPROFILE%\fish
cd %USERPROFILE%\fish
:: dsh-fish/ 是插件本体——按 DSH 的插件方式挂载（推荐目录联接）
mklink /D "DSH 插件目录\dsh-fish" "%USERPROFILE%\fish\dsh-fish"

:: 1) 配置桥（见下文「桥的配置」）
copy bridge\config.example.json bridge\config.json

:: 2) 一键启动（DSH / LuckyLillia / 桥 / 查看器 / 本地语音服务）
一键启动.cmd

:: 3) 打开控制台
管理器.cmd      :: 127.0.0.1:7789 —— 服务启停 / 待重启提示 / 启动日志
:: 查看器       :: 127.0.0.1:7788 —— 她的一切数据与全量设置
```

启动器（`launch.mjs`）是所有启动路径的唯一入口：按依赖顺序拉 DSH、LuckyLillia、
话轮、全双工、桥、查看器，已启动的自动跳过。`restart.mjs` / `shutdown.mjs` 同理，
`管理器.cmd` 的网页控制台全部转发到这三个脚本——**本仓库不实现第二套启停逻辑**。

## 桥的配置：`bridge/config.json`

QQ 桥是独立 Node 进程，连 LLOneBot（OneBot）收发 QQ 消息。从
`config.example.json` 复制后必看这几项：

```jsonc
{
  "ownerIds": [123456789],        // 必填：你的 QQ 号白名单。不在名单里的一律不转
  "fishRoot": "",                 // 她的数据目录。留空 = 默认 ~/.dsh-fish（推荐）
  "wsPort": 6199,                 // 桥的 WebSocket 端口（LLOneBot 连这里）
  "push": true,                   // 她主动说的话 / 申请卡 / 信，推到你 QQ
  "pushPollMs": 1500,             // 推送扫描间隔
  "mergeMs": 1500,                // 你连发几条时等多久合成一轮（防抢答）
  "imageHoldMs": 10000,           // 带图消息多等一会，等你把话说完
  "splitReplies": true,           // 她的回复按空行切条发送
  "chunkChars": 1500,             // 单条上限，超长自动分段
  "allowGroup": false             // 群聊开关（开了也只响应白名单里的人 @她）
}
```

桥与插件之间走**本地通路**（只收回环 + `<数据目录>/local.key` 密钥）：
`/dsh-fish/local/ping · /say · /wake · /answer`。密钥第一次启动自动生成，
不出本机。

## 她的配置：`~/.dsh-fish/config.json`

26 组配置控制成长节奏与生活半径：醒来的时段与次数（`wakesPerDay`/`window`）、
主动搭话（`proactive`/`drive`）、上网与看视频（`browse`/`bili`/`video`/`comment`）、
日记与回忆门槛（`diary`/`recall`）、上下文预算（`memory`）、会话轮换（`chat`）、
天气坐标（`world.city`）、工具面白名单（`tools.restrict`/`allow`）……

**不建议手编**——打开 7788 查看器的「设置」页改，保存即生效（改 `lib/**` 才需要重启）。
配置有夹紧与归一化保护，页面不认识的键会如实报错。

## 目录结构

```
fish/
├── dsh-fish/          # 插件本体（上游同步在此进行）
│   ├── lib/           #   账本人格 / 调度器 / 20 件工具 / 观测接口
│   └── test/          #   1800+ 项测试
├── bridge/            # QQ 桥（独立 Node 进程，配置见上）
├── viewer/            # 查看器（7788）
├── manager/           # GUI 管理器（7789）
├── shared/            # 数据目录解析（换盘/换机机制）
├── launch|shutdown|restart.mjs
├── llbot-patch.mjs    # LLOneBot 帧头补丁（启动前自动兜）
└── 一键启动/重启/关闭.cmd · 管理器.cmd · 体检.cmd
```

她的数据（账本、日记、收件箱、表情库、画的画）全在**数据目录**，与代码分离；
换盘/换机见「数据目录解析」——支持 `DSH_FISH_HOME` 环境变量与指针文件，
**永远不要合并两份数据目录**。

## 她的工具面（21 件）

收窄后的白名单（`tools.restrict`，默认开）让她只看见这一套：
`her_say`（发消息到 QQ，主动/回复同款）、`her_draw`（白板）、`her_formula`（公式排版）、`her_voice`（语音条）、
`her_meme`（表情包）、`her_world`（日期/天气）、`her_note`（桌面便条）、
`her_alarm`（自定闹钟）、`her_recall`/`her_diary`/`growth_commit`/`her_dream`（记忆与自我）、
`her_leave`/`ask_owner`/`her_help`（留言/申请/说明书）、
`bili_look`/`bili_watch`/`bili_zoom`/`bili_speak`（B 站）、
`her_open`/`her_watch_local`/`read_image`（文件与画面）。

每件的说明书她用 `her_help` 现查——**给她的工具说明必须为真**是本项目的铁律。

## 隐私与外联

- 她的一切数据（账本、日记、画、收件箱）只在本机
- 外联仅三处：QQ（经你自己的 LLOneBot）、Open-Meteo（天气查询）、B 站（她上网时）
- 无任何遥测、无云依赖、无 API 密钥
- 本仓不含私人交接文档（它们在仓外同级目录）；提交时有隐私守卫拦真名 / 真邮箱 / QQ 号，
  见 `AGENTS.md`「隐私守卫」

## 上游同步（进阶）

`dsh-fish/` 的历史曾以 merge 方式接入上游；后来做过一次发布前的历史清洗
（真值脱敏 + 目录归位到 `dsh-fish/`），提交哈希整体改写，与上游仓库不再共享哈希。
所以同步上游要先补一次祖先关系，之后都是常规三方合并：

```bash
git remote add upstream <上游仓库路径或 URL>
git fetch upstream
git merge -s ours --allow-unrelated-histories upstream/main -m "血缘接线：补祖先关系，不取内容"
git merge upstream/main -X subtree=dsh-fish   # 之后每次同步：-X subtree 把上游路径对齐到 dsh-fish/
```

合完后跑 `dsh-fish/` 里 `node --test test/*.test.mjs`（全绿再提交），并核对账本指纹
（`node tools-ledger.mjs`，--sync 补记）。本 fork 有一条合并定案：
**her_say 相关提示词与口径以 fork 为准**（QQ 通路架构与上游不同），别被上游冲掉。

## 致谢与协议

- 上游 [ssamurias/dsh-fish](https://github.com/ssamurias/dsh-fish)（MIT）——账本人格的全部根基
- 社区贡献：BBleae、jay23606 及上游各 issue 反馈者
- 本 fork 在上游协议（MIT）之内发布；`dsh-fish/LICENSE` 随目录保留

## 现状声明

个人实验项目，强绑定 Windows 与本机部署；接口与行为以仓库内代码与测试为准。
它不是一个产品，是一个人住的地方。
