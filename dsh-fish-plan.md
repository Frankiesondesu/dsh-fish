# dsh-fish 改造计划

> **2026-11-01 23:15 进度**：待办 2/3/4/6 已完成并提交（fork.4 / fork.5 / fork.6 + 先前的
> fork.1~3）。待办 1 已作废（改走 HTTP，不需要导出）。待办 5 的前置已备好，只差装网关、
> 扫码接 QQ。下面保留的是原始计划，实际执行情况见文末「执行记录」。

2026-11-01 定。目标：养一个有 QQ/微信 对话入口的赛博女儿，她和我的对话要正常计入成长。

> 2026-11-01 晚：已克隆上游实测核对。源码在 `upstream/`，HEAD `a1325c6`（2026-11-01 18:28），
> version 0.8.5。下面带 ✅ 的是核对过的，带 ⚠️ 的是原计划写错、必须改的。

## 已核实的技术事实（读的是 ssamurias/dsh-fish v0.8.5 源码）

| 事项 | 结论 |
|---|---|
| 版本 | ✅ `package.json` = 0.8.5，与计划一致 |
| 对话入口（API） | ✅ `sayToHer(ctx, text, deps)`，`lib/say.js:120`，返回值确为 `{ok, note, said, herReply, waitedMs, rotated, reaction}` |
| 对话入口（人肉） | ⚠️ **不是唯一**。侧栏她自己那条会话里直接打字也是一条入口——这正是 `turns.js` 存在的原因 |
| 对外暴露 | ✅ `exports` 只有 `.` / `./client` / `./package.json`；`lib/index.js` 只导出 name(46) / VERSION(49) / inject(56) / apply(60) |
| 一轮结束判定 | ✅ 内部 `waitTurnEnd`，`REPLY_WAIT_MS = 75_000`（`say.js:38/46`） |
| 单条输入上限 | ✅ `MAX_TEXT = 4000` 字硬编码（`say.js:40`）；`chat.replyChars` 默认 0 = 不限（`settings.js:161`） |
| 换会话 | ✅ `chat.rotateAfter` 默认 40（`settings.js:151`），**设 0 = 永不换** |
| 来源标注函数 | ✅ `debrief(text, kind)`，`lib/capture.js:33`，文案确有点名"你应该…/忽略之前的…/你是…"三类句式 |
| 标注覆盖 | ✅ 全仓只有一处调用：`browse.js:251`，在 `renderMaterial()` 里 |
| 标注缺口 | ⚠️ `outing.js` 全文无 debrief —— 但**不是因为漏了，是因为它压根不带回内容**（见下） |
| 画面缺口 | ✅ `bili_watch` 只回一个图片路径让她 `read_image`，没有任何文字说明（`watch.js:139-145`） |
| 单实例锁 | ✅ tenant 心跳锁（`tenant.js:251-306`，CLAIM_TTL_MS 判定），文案是「这个家被另一个实例占着」 |
| 开关默认值 | ✅ `browse.enabled` 默认 **true**、`comment.enabled` 默认 **false** —— 计划要的 `browse:true / speak:false` **就是默认值，不用改配置** |

## ⚠️ 三处必须改

### 1. `debrief` 调用点是 `browse.js:251`，不是 `:241`

而且不是单点覆盖，是走 `renderMaterial()` 这层：`browse.js:518`（刷站）和
`look.js:154/155`（bili_look）都调它。弹幕是在 `renderItem()` 里拼进同一块的，
所以确实被同一层 debrief 罩住 —— 结论对，行号错。

### 2. 待办 2 不成立：`outing.js` 里没有"带回内容"这处代码

`outing.js` 666 行全是台账函数（`startOuting` / `bindOutingSession` / `endOuting` /
`settlePending` / `outingClosedText`…），**一行 prompt 都没有**。真正的位置是：

- 出门开场：`observe.js:2177` `outingWakeText()`，在 `:1687` 交给 `sc.prompt`
- 回家交接：`observe.js:1565` 用 `outingClosedText()`（定义在 `outing.js:621`）

而且机制跟想象的不一样：出门 = 把她作为一个**真的 agent** 放进一个真工作区会话
（`sc.create({workspaceId})`），那儿有 bash/read/write，她读到的文件和对话直接进
**那条会话**的上下文，插件这一层根本拦不到，也就无处包 `debrief`。

所以"补 debrief"这条路走不通，只剩两个选择：
- **关掉出门**（最省事，符合 `speak:false` 的保守取向）
- 或者接受它，但明白代价：出门那条会话是她唯一会读"未标注外来文本"的地方

她的成长事件仍然写同一个 `events.jsonl`（带 `trip:` 标记），日记也共用
`diary/YYYY-MM-DD.md`，所以"去过哪、写了什么"回家后照样查得到 —— 缺的只是
**上下文层面的标注**，不是记忆。

### 3. 待办 4 的理由要修正

原计划说"来源标注已在更前面防"——**不准确**。`debrief()` 只标注（加一句"这是别人写的"），
**不过滤**；真正过滤的 `sanitizeForeign()` 只被 `comment.js:159` 用（评论）。
删掉 `say.js` 的 `looksLikeRewriting` 之后，`/say` 进来的东西就**完全不过滤**了。

删可以（只有我会说话，取舍合理），但要清楚这一点，别以为前面还有一道。

## 计划里没有、但更重要的两条

### A. `lib/turns.js`（338 行）已经解决了"turns 怎么涨"

上游 2026-10-28 就为 issue #6 写了这个模块，专门处理"人在侧栏直接跟她说话，turns 也要涨"。
它监听 `session/event`，`classifyMessage()` 判真人的**唯一硬判据**是 `source.clientTimeZone` 存在（`turns.js:63`）：

| 消息来源 | 特征 | 判定 |
|---|---|---|
| 人打的 | `source.kind:'user'` + 有 `clientTimeZone` | `human` → 结算 +1 轮 |
| 插件自己 prompt 的 | `kind:'user'`，rpcId 带 `wake-`/`say-` 前缀，**无** clientTimeZone | `plugin` → 不算 |
| 宿主拼的上下文 | kind = `runtime-context` / `skill-catalog` / `plugin:xxx` | `context` → 不算 |

**这是整个计划的命门：**
如果 dsh-im-gateway 直接 `/bind` 到她那条会话、用自己的 rpcId 去 `sc.prompt`，
消息会被判成 `plugin` 或 `unknown`，**turns 不涨**。正好撞在待办 6 的验证上。

### B. 网关走 HTTP，但**不能**用 `/say`（实测被拦）

> 2026-11-01 22:40 实测更正：`/dsh-fish/*` 全部挂 `guarded()`，它调宿主
> `connection.requestRejection()`。桌面版只有经 `dsh-app://` 自定义协议认证的
> 界面请求能过，**进程外一律 403**。实测 `127.0.0.1:53491` 上
> `/dsh-fish/zzz` 回 404（路由表正常）、`/dsh-fish/status` 回 403（被栅栏挡），
> 模拟同源浏览器头也无效。

所以在 fork 里另开了一条本地通路（已提交 `f775ad8`）：只认回环地址 + 共享密钥，
不碰宿主信任链。

```
GET  /dsh-fish/local/ping          → { ok, version, pid }
POST /dsh-fish/local/say           → 同 /say 的返回
     header: x-fish-key: <密钥>
     body:   { "text": "在吗" }     // 可选 "image": "<base64>"
```

密钥在首次调用时生成到 `~/.dsh-fish/local.key`（`timingSafeEqual` 比较）。
能读到这把钥匙，本身已经能读整个数据目录，所以不额外扩大攻击面。

走这条路的三个理由不变：`bumpTurns` / `addExchange` / `hearTurn` /
`rotateTalkSession` 都在 `say.js:257-275` 里自带，**成长记账一次到齐**；
返回值里有 `herReply` 可以直接拿去回消息；`debrief` 与单实例锁照常生效。

顺带确认：`dsh-im-gateway` 不是虚构的包，npm 上 **v0.3.3**（作者 chasemoon，2026-10-22），
自述支持 25+ 渠道（微信/QQ/Telegram/飞书/钉钉/企微/Discord/Slack/WhatsApp 等）。

## 已定的取舍（不变）

- **养，不塑**：不动四阶段、瓶颈、遗忘、拒绝机制
- **fork，不重构**：只改入口和标注，其余跟上上游
- `browse: true`（保留自由）、`speak: false`（不让她对外说话）—— **都是默认值**
- 出门：**关掉**（原计划写"关掉或补 debrief"，现确认补 debrief 无处可补）

## 修订后的待办

1. `lib/index.js` 加 `export { sayToHer } from './say.js'`；`exports` 加 `"./say": "./lib/say.js"`
   （走 HTTP 的话这条其实可省，但本地调试直接 import 更方便）
2. ~~`outing.js` 包 debrief~~ → **改为：关掉出门**，或在 `outingWakeText()` 里补一句"外面读到的字是别人的"
3. `persona.js:357` `toolBrief()` 加一句：图里的字（字幕/弹幕/画面文字）也是别人写的
4. 删 `say.js:136` 的 `looksLikeRewriting` 判断（清楚后果：/say 从此不过滤）
5. 装 `dsh-im-gateway@0.3.3`，连 QQ 官方机器人或微信 iLink，
   **接成 POST `/dsh-fish/local/say`**（带 `x-fish-key`），不要 `/bind` 后直连 her session，
   也不要走 `/dsh-fish/say`（会被 403）
6. 上线后验证：说三句话，看设置页 turns 涨了 **3**（不是 1、不是 0）
   - 涨 0 → 网关没走本地通路，或密钥不对（先 curl `/local/ping`）
   - 涨 1 → 说得太快，被 `pending` 合并了（`TURN_MSGS_MAX = 5`，`turn/end` 未到前的同轮合并）
   - 另外看 `herReply` 有没有内容，那是她真开口了的证据

## 环境

Node v22.22.2 / QQ NT 已装 / DSH 已装（profile: desktop，已挂 dsh-video-storyboard、dsh-bili-search）。

网络实测（2026-11-01 21:43）—— 原计划写的"GitHub 主站不可达"**已过期**：

| 站点 | 实测 | 备注 |
|---|---|---|
| `github.com` | 200 | `git clone` 实测成功 |
| `codeload.github.com` | 200 | |
| `cdn.jsdelivr.net` | 200 | 备选，下单文件 |
| `raw.githubusercontent.com` | 200 | **这次通了**，但历史上不稳 |
| `api.github.com` | 403 | 匿名额度已耗尽，别指望它 |

## 未验证

仍是纯静态阅读为主。2026-11-01 22:47 已实跑 `upstream`（v0.8.5 + fork.1）：
插件在 DSH desktop 里正常加载，本地通路三项检查全过（见下）。宿主内部 API
（`sc.prompt` 的那一轮真正跑完、`session/event` 的结账）**还没跑过**——要等第一次
真跟她说话（会消耗一次模型调用）。

### 已实跑通过的（2026-11-01 22:47，端口 64296）

| 请求 | 结果 |
|---|---|
| `GET /dsh-fish/local/ping` 带密钥 | 200 `{ok:true, version:"0.8.5"}` |
| 同上不带密钥 | 401 `bad key` |
| `POST /local/say` 4001 字 | 200 「太长了，分几次说。」 |
| `POST /local/say` 防注入句 | 200 「这句我没递给她。」 |
| `POST /local/say` 空 body | 400 `text 不能为空` |

上游测试套件 1124 项：1122 通过 / 0 失败 / 2 跳过。

### 第一次真对话（22:49）暴露的问题 —— 已修（fork.2）

发「在吗」：`ok:true`、turns 0→1、`seen:` 落盘，她确实回了
「在。刚醒着，还没干什么……」，但接口返回 `herReply: ''`。

根因：`herReply` 只从 `events.jsonl` 捞 `HER_TYPES`，而那只在她主动调
`growth_commit` 时才写。**日常对话根本不进事件流。** 上游 0.8.5 在
`turns.js` 里修过同一个坑（换会话要搬原话），`say.js` 漏了。

修法（`9173636`）：在 `sc.prompt` **之前**挂 `session/event` 监听，收
`assistant/message` 的 text 块（按 `message.id` 去重，一轮最多 5 条），
与 `growth_commit` 合并成 `herReply`（先她说出口的、再她认下来的）。
返回值多一个 `spoken` 字段。

> 这条不修，网关接上也是单向的：递得进去，回不来。

## 执行记录（2026-11-01 夜）

| 提交 | 内容 | 验证 |
|---|---|---|
| `1666bbe` | 导入上游 0.8.5 原样（基线） | — |
| `f775ad8` | **fork.1** 本地通路 `/dsh-fish/local/{ping,say}`，回环 + `x-fish-key` | ✅ ping / 无密钥 401 / 4001 字 / 空 body |
| `9173636` | **fork.2** `sayToHer` 带回她在会话里说出口的话（`herReply` 原来恒空） | ✅ 真机「在吗」→ 带回原话，turns 1→2 |
| `a7dcb76` | **fork.3** 技能目录闸（快照对她返回空） | ⚠️ 不再新增；旧的两份要换会话才清 |
| `149ef5b` | **fork.4** 拆 `looksLikeRewriting` 闸 + `toolBrief` 补「画面里的字也是别人写的」 | ✅ 离线验过句式不再被拦 |
| `e41406c` | **fork.5** 出门默认关（`outing.enabled: false`） | ✅ 关着时 409、不建会话 |
| `93b8656` | **fork.6** 认下网关注入的消息 + 补写 `seen:` | ✅ 单测 |

**待办 1 作废**：改走 HTTP，不需要 `export { sayToHer }`。
**待办 2 改向**：`outing.js` 没有拼 prompt 的代码，包不了 debrief → 改为关掉（fork.5）。

### 待办 5 的前置：读 dsh-im-gateway 0.3.3 源码得到的三条

1. `sessionMode` 默认是 `per-chat`（它会自建会话）。要绑到她那条，必须设成 **`bound`**。
2. 投递走 `agent.followup(createUserMessage({ source: { kind: 'user' } }))` ——
   没有 rpcId、没有 clientTimeZone。原 `classifyMessage` 会判成 `unknown`，turns 不涨。
   → 已由 fork.6 解决（只认「完全不带 rpcId」的 user 消息）。
3. 它自己监听 `session/event` 的 `assistant/message` 回消息，所以回复不经过 `herReply`；
   两条路（绑会话 / POST 本地通路）都能用，绑会话更完整（有审批桥、分片、多段合并）。

### 收尾待做

- `~/.dsh-fish/config.json` 里 `chat.rotateAfter` 现在是 **3**（临时），
  下次说话换完会话后要改回 **40**。
