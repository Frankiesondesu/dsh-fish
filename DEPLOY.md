# 部署指南（Windows）

> 这份文档讲**从零把整套东西跑起来**：DSH 插件（她）+ QQ 桥 + 查看器 + 管理器
> + 可选的本地语音服务。上游插件本身的 npm 安装说明在 `dsh-fish/README.md`；
> 本仓是 fork，插件走本地源码目录，不发布 npm 包。

## 0. 先理解三件事

1. **仓库里没有她**。账本、日记、收件箱、画、表情都在运行目录
   （默认 `~/.dsh-fish`），由你自己养出来。代码只是框架。
2. **她的记忆只增不改**。`events.jsonl` 是唯一真相；备份、迁移都别手改它。
3. **本仓是公开仓**。不要把自己的 QQ 号、密钥、数据目录、聊天原文提交进来；
   `bridge/config.json`、`local.key`、`viewer-pass.txt` 都在忽略/运行目录里。

## 1. 环境要求

| 组件 | 必需 | 说明 |
|---|---|---|
| Windows 10/11 | 是 | 生命周期脚本、路径解析、GDI 渲染都按 Windows 设计 |
| [DSH 桌面版](https://github.com/ssamurias/dsh-fish) | 是 | 她的宿主；先确保能正常对话 |
| Node.js 22+ | 是 | 桥 / 查看器 / 管理器 / 启动器 |
| Git | 是 | 拉取与更新 |
| QQ + OneBot 实现 | 接 QQ 时必需 | LLOneBot（推荐）或 LuckyLillia；见第 5 节 |
| ffmpeg | 可选 | 动图表情拆帧；可用 `DSH_FISH_FFMPEG` 指定 |
| funasr 听写服务 | 可选 | 语音转字，默认端口 18765；桥按需调用 |
| smart-turn / 全双工 | 可选 | 本地语音链路，端口 18766 / 18768；缺了启动器会跳过 |

安装路径尽量**不含空格**。如果路径必须带中文，用 ASCII 目录联接（junction）指过去，
再对 ASCII 路径安装插件；直接把中文路径交给 DSH 容易出 `MODULE_NOT_FOUND`。

## 2. 拿代码

```bat
:: 例：放到 %USERPROFILE%\fish（路径别带空格）
git clone https://github.com/Frankiesondesu/dsh-fish.git %USERPROFILE%\fish
cd %USERPROFILE%\fish
```

目录结构：

```
fish/
├── dsh-fish/          # 插件本体（她的账本人格、调度器、工具、观测接口）
├── bridge/            # QQ 桥（独立 Node 进程）
├── viewer/            # 查看器（7788）
├── manager/           # 管理器（7789）
├── shared/            # 数据目录解析
├── launch|shutdown|restart.mjs
└── 一键启动/重启/关闭.cmd · 管理器.cmd · 体检.cmd
```

## 3. 把插件装进 DSH

**先把 DSH 完全退出**（包括托盘图标），再装。运行中替换已被加载的包会 `EPERM`。

```bat
:: <DSH 安装目录> 换成你的实际路径
"<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "link:<本仓绝对路径>\dsh-fish"
```

说明：

- `--profile desktop` 是桌面版默认 profile；不是这个名就换成你的。
- 装完检查 profile 的 `package.json`：`dependencies` 和 `dsh.profile.bundles`
  里都要有 `@ssamurias/dsh-fish`。只写一边，下次 pnpm 清理会把包删掉。
- 中文路径：先做 ASCII junction，再 `link:<ASCII 别名>`。例：
  `mklink /J C:\fish-src "D:\某个中文目录\fish"`，然后装 `C:\fish-src\dsh-fish`。
- 这个 fork 不走 npm 发布；不要用 `npm add @ssamurias/dsh-fish` 装上游包来替代。

装完启动 DSH，设置页应出现「大肥鱼」。第一次启动会在数据目录生成账本、
`local.key`、默认配置。

## 4. 第一次启动

**由你在资源管理器里双击**：

```bat
一键启动.cmd
```

它会按顺序拉起：DSH → LuckyLillia（存在才拉）→ 话轮 / 全双工（存在才拉）→
QQ 桥 → 查看器。已经在跑的服务会自动跳过。缺组件只记一行「缺文件，已跳过」，
不会拦住其他服务。

启动后打开：

- **管理器** `http://127.0.0.1:7789`：服务启停、待重启提示、启动日志
- **查看器** `http://127.0.0.1:7788`：她的一切数据、观测台、全量设置

> 本 fork 的插件**不会**在 DSH 启动时自动拉起查看器。只想看查看器时，
> 用管理器里的「启动」或双击 `viewer/start.cmd`。

第一次可以先不接 QQ：在 DSH 侧栏和她说话，确认插件已加载、查看器有数据，
再接第 5 节。

## 5. 接 QQ（QQ 桥）

QQ 客户端 / OneBot 实现**不在本仓内**，需要你自己准备。桥只负责连它。

### 5.1 配桥

```bat
copy bridge\config.example.json bridge\config.json
```

至少改这一项：

```jsonc
{
  "ownerIds": [123456789],   // 你的 QQ 号；不在名单里的人一律不转
  "wsPort": 6199,            // 桥监听端口
  "wsPath": "/ws",           // OneBot 反向 WS 路径
  "fishRoot": "",            // 她的数据目录；留空 = ~/.dsh-fish
  "push": true               // 她主动说的话 / 申请卡推到你 QQ
}
```

`bridge/config.json` 含 QQ 号与本机信息，已在 `.gitignore`，**永不提交**。

### 5.2 让 OneBot 连上桥

以 LLOneBot 为例：登录 QQ 后，把 OneBot 的 **WebSocket 客户端 / 反向 WS**
指向：

```
ws://127.0.0.1:6199/ws
```

`accessToken` 留空就两边都留空；设了就要在 LLOneBot 侧填同一个值。

如果用的是 LuckyLillia：把它的目录放到 `runtime/LL/`，启动器会自动拉起。
它自带的 LLBot 需要剥 PM2/Pmhq 的 4 字节帧头，`launch.mjs` 每次启动会自动兜一次；
收不到 QQ 消息时先跑：

```bat
node llbot-patch.mjs --check
```

### 5.3 验证

用白名单里的 QQ 给机器人发一句私聊，然后看：

- `bridge\bridge.log` 有没有收到与转交记录
- 查看器「她说的话」/ 事件流里有没有新记录
- 她回的话有没有分条发回 QQ

没反应按顺序查：OneBot 是否连上 6199、WS 路径是否 `/ws`、`ownerIds` 是否匹配、
LLBot 帧头补丁是否在位。桥的日志会写清楚卡在哪一步。

## 6. 查看器与安全边界

- 查看器监听 `0.0.0.0:7788`（可用环境变量 `VIEWER_HOST` 改）。
- **本机回环访问免密可写**；局域网/隧道等外部访问要密码，且**只读**。
- 外部密码首次需要时自动生成在 `~/.dsh-fish/viewer-pass.txt`；删掉后重启查看器会换新。
- 管理器只监听 `127.0.0.1:7789`，不对外。
- `~/.dsh-fish/local.key` 是桥与插件本地通路的密钥，不出本机、不进 git。
- 不要把 6199 / 7788 / 7789 直接暴露到公网。需要远程访问就用隧道 + 密码，
  并确认查看器的「本机免密」判据（回环 + 无代理头）没有被你的代理破坏。
- 本仓无遥测；外联只有 QQ（经你的 OneBot）、Open-Meteo（天气）、B 站（她上网时），
  以及 DSH 自己的模型调用。

## 7. 数据目录、备份与迁移

默认 `~/.dsh-fish`（可用 `DSH_FISH_HOME` 或指针文件换盘）：

```
~/.dsh-fish/
├── config.json         # 全部设置（建议用查看器改，不建议手编）
├── events.jsonl        # 她的账本：只增不改，唯一真相
├── home/               # 她的房间、资料柜、收件箱
├── diary/              # 日记
├── media/              # 画、截图、语音等
├── local.key           # 本地通路密钥
└── viewer-pass.txt     # 查看器外部访问密码
```

- 备份：查看器「数据」页可导出；或直接复制整个数据目录（先停服务）。
- 恢复：同样在查看器「数据」页做；恢复后重启 DSH。
- 迁移：复制整个目录后用 `DSH_FISH_HOME` 指过去；**不要合并两份数据目录**。
- 永远不要手改 `events.jsonl`；「让她忘」靠召回衰减，不靠删行。

## 8. 停止、重启与端口

- 关闭：双击 `一键关闭.cmd`（按反向顺序收，包括语音子进程树）。
  尽量别用任务管理器强杀 DSH——写在磁盘上的 cookie 库可能损坏，导致下次起不来。
- 重启：双击 `一键重启.cmd`，菜单可选只重启 DSH / 桥 / 查看器等；
  单目标重启不会顺带拉起其他没在跑的服务。
- **改了 `dsh-fish/lib/**` → 重启 DSH 才生效**（会断她当前会话，挑她不在聊天时）。
- **改了 `viewer/**` → 重启查看器即可**，不用动 DSH。
- 改了 `bridge/**` → 重启桥。

| 端口 | 服务 |
|---|---|
| 6199 | QQ 桥（OneBot 连这里） |
| 7788 | 查看器 |
| 7789 | 管理器 |
| 18765 | 本地听写（可选，按需） |
| 18766 | 话轮（可选） |
| 18768 | 全双工接口（可选） |

## 9. 更新

```bat
:: 先备份数据目录
git pull
```

- 插件是用 `link:` 装的：拉完代码后**完全退出 DSH 再启动**即可。
- 插件是复制/打包装的：退出 DSH，重新用第 3 节的 `plugin add link:` 指到新目录。
- 更新前先备份；账本只追加，向后兼容，不要删旧数据。
- 想同步上游：见 `README.md` 的「上游同步（进阶）」；her_say 相关提示词以本 fork 为准。

## 10. 常见问题

| 现象 | 先查 |
|---|---|
| QQ 消息进不来，日志也没有 | LLBot 帧头补丁（`node llbot-patch.mjs --check`）、OneBot 是否连上 6199、WS 路径是否 `/ws` |
| 她能回侧栏，但 QQ 收不到 | `ownerIds`、`push`、桥日志；她的话必须走 `her_say` 才会发到 QQ |
| DSH 双击没反应/一闪就退 | 别从终端用带 `ELECTRON_RUN_AS_NODE` 的环境启动；用 `.cmd`/快捷方式 |
| 改了插件代码但行为没变 | `dsh-fish/lib/**` 改动要重启 DSH；查看器改动要重启查看器 |
| 查看器打不开或数据是旧的 | 重启查看器；确认 7788 没被别的进程占用 |
| 路径带中文后 DSH 报 `MODULE_NOT_FOUND` | 用 ASCII junction 再 `link:`，别直接接中文路径 |
| 第一次语音转写等很久 | funasr 冷启动要一两分钟；服务没开时桥会如实说听不了 |
| 端口冲突 | 6199 / 7788 / 7789 / 18765 / 18766 / 18768；先看管理器「本机状态」 |

## 11. 许可与致谢

- 上游 [ssamurias/dsh-fish](https://github.com/ssamurias/dsh-fish)（MIT）——账本人格的全部根基
- 本 fork 在上游协议（MIT）之内发布；`dsh-fish/LICENSE` 随目录保留
- 社区贡献：BBleae、jay23606 及上游各 issue 反馈者

个人实验项目，强绑定 Windows 与本机部署；接口与行为以仓库内代码与测试为准。
