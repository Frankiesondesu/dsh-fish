# Linux 部署指南（Ubuntu / Debian）

> 这套东西原本按 Windows 写：GDI 画板、`.cmd` 生命周期、LuckyLillia、任务管理器。
> 2026-11-11 起，**核心插件 / QQ 桥 / 查看器 / her_draw / her_formula / her_voice 都能在
> Linux 上跑**；管理器 GUI 和 QQ 通话没有移植，用 systemd 与查看器替代。
>
> 目标环境：Ubuntu 22.04/24.04 或 Debian 12，能用 systemd 用户服务。
> 需要 **Linux 版 DSH**（`headless` / `web` / `desktop` profile 之一）。

## 0. 能跑什么、不能跑什么

| 组件 | Linux | 说明 |
|---|---|---|
| 插件本体（她 / 账本 / 调度器 / 工具） | ✅ | 跟着 DSH 跑，Node 代码 |
| QQ 桥 | ✅ | NapCat / Lagrange 等 OneBot 实现，走反向 WS |
| 查看器 7788 | ✅ | 纯 Node HTTP |
| 管理器 7789 | ❌ | Windows 进程探测；Linux 用 systemd + `fishctl.sh` |
| her_draw | ✅ | Windows 用 GDI；Linux 用无头 Chromium 画 canvas 导出 PNG |
| her_formula | ✅ | 无头 Chromium + MathJax，Linux/Windows 同一套 |
| her_voice / 对讲机 | ✅ | `edge-tts` + ffmpeg；Python 用 venv |
| 看 B 站 / 本地视频 / 听写 | ✅ | 需要 ffmpeg / yt-dlp / 你的 ASR 服务 |
| LuckyLillia + `llbot-patch` | ❌ | Windows 专用；Linux 换 NapCat / Lagrange，不需要帧头补丁 |
| 一键通话（ohwhale / WASAPI） | ❌ | Windows 音频设备层；不迁 |
| `一键*.cmd` | ❌ | Linux 用 `deploy/linux/*.sh` + systemd |

## 1. 前置条件

- **DSH**：Linux 可用的版本，先能正常新建会话、和模型对话。
- **Node.js 22+**（最低 20；建议 22 LTS）。
- **Git**、**ffmpeg**、**Chromium/Chrome**、**Noto Sans CJK 字体**。
- **QQ + OneBot 实现**：推荐 [NapCat](https://github.com/NapNeko/NapCatQQ) 或
  [Lagrange](https://github.com/LagrangeDev/Lagrange.Core)。
- 可选：你的本地 ASR 服务（默认 `~/.dsh/asr.json` → 127.0.0.1:18765）。

先拿代码（路径尽量不带空格）：

```bash
git clone https://github.com/Frankiesondesu/dsh-fish.git ~/fish
cd ~/fish
```

## 2. 装系统依赖

Ubuntu/Debian：

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg fonts-noto-cjk python3-venv python3-pip
# Chromium：Debian 是 chromium；Ubuntu 常是 chromium-browser（snap）
sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser
```

装完确认：

```bash
node -v          # 22+
ffmpeg -version
chromium --version || chromium-browser --version || google-chrome --version
```

如果 Chromium 不在常见路径，后面在 `~/.config/fish-fork.env` 里设
`FISH_DRAW_BROWSER=/实际路径`。`her_draw` / `her_formula` 都靠它。

## 3. 把插件挂进 DSH

**先完全停掉 DSH**（源码目录安装时替换已加载的包会 `EPERM`）：

```bash
# profile 按你的 DSH 用法改：headless / web / desktop
"$DSH_CLI" plugin --profile headless add "link:$HOME/fish/dsh-fish"
```

`DSH_CLI` 就是你 Linux 上 DSH 的 CLI（例如 DSH 安装目录下的 `bin/dsh`，或 PATH 里的
`dsh`）。装完检查 profile 的 `package.json`：

- `dependencies` 里有 `@ssamurias/dsh-fish`；
- `dsh.profile.bundles` 里也有它。

只写一边，下次 pnpm 清理会把包删掉。全新 profile 还需要 `@deepseek-ai/dsh-web-app`
（`dsh-base` 不够，否则插件会停在 `waiting for services: sessionController, webServer`）。
装完启动 DSH，设置页应出现「大肥鱼」。

## 4. 配 QQ 桥

```bash
cd ~/fish
cp bridge/config.example.json bridge/config.json
```

编辑 `bridge/config.json`，至少改：

```jsonc
{
  "ownerIds": [123456789],   // 你的 QQ 号白名单
  "wsPort": 6199,
  "wsPath": "/ws",
  "fishRoot": "",            // 留空 = ~/.dsh-fish
  "push": true
}
```

`bridge/config.json` 含 QQ 号，已在 `.gitignore`，**不要提交**。

### NapCat / Lagrange

登录你的 QQ，把 OneBot 的 **WebSocket 客户端 / 反向 WS** 指向：

```
ws://127.0.0.1:6199/ws
```

`accessToken` 留空就两边都留空；设了就在 OneBot 侧填同一个值。Linux 不需要
Windows 那个 `llbot-patch.mjs`。

## 5. 安装并启动 bridge / viewer

```bash
cd ~/fish
bash deploy/linux/install.sh
```

它会：

- 检查 Node、装 ffmpeg/字体/Python/Chromium（Debian/Ubuntu）；
- 准备 `~/.dsh-fish`，没有 `bridge/config.json` 就复制一份模板；
- 在 `~/.dsh-fish/venv` 里装 `edge-tts`（`WITH_EDGE_TTS=0` 可跳过）；
- 写 `~/.config/fish-fork.env`；
- 生成并启用两个 **systemd 用户服务**：`fish-bridge`、`fish-viewer`。

想让 SSH 退出后服务继续跑：

```bash
sudo loginctl enable-linger "$USER"
```

启停/状态/日志：

```bash
bash deploy/linux/fishctl.sh status
bash deploy/linux/fishctl.sh restart
bash deploy/linux/fishctl.sh logs
```

**启动顺序**：先启动 DSH（插件在里面）→ 再确认 `fish-bridge` / `fish-viewer`。
桥会自动发现她那边的本地端口；查看器读同一个 `~/.dsh-fish`。

## 6. 验证

1. 打开 `http://127.0.0.1:7788`（查看器）：
   - 「本机状态」能看到桥 6199、查看器 7788、ASR 等探活；
   - 人格数据页有账本行数。
2. 用白名单 QQ 给机器人发一句私聊：
   - `journalctl --user -u fish-bridge -n 100` 看到收到与转交；
   - 她回的话能分条发回 QQ。
3. 在 DSH 里让她调一次 `her_draw`、`her_formula`、`her_voice`：
   - draw/formula 产出 PNG（Linux 走 Chromium）；
   - voice 产出 mp3 并推到 QQ。

## 7. her_draw / her_formula / her_voice 的 Linux 细节

- **her_draw**：Windows 仍用 GDI；Linux 用无头 Chromium 把画布导出 PNG，
  实测包围盒回执照旧给（不是估算）。字体用系统 Noto Sans CJK；
  没装字体会出现方框。
- **her_formula**：Chromium 无头 + 本地 MathJax。Linux 容器里会自动加
  `--no-sandbox` / `--disable-dev-shm-usage`；渲染的是本机生成的可信页面。
- **her_voice**：`python3 -m edge_tts`；用 install.sh 的 venv 时，在
  `~/.config/fish-fork.env` 写 `FISH_PYTHON=~/.dsh-fish/venv/bin/python`。
  edge-tts 需要联网（走微软的语音服务）。

## 8. 查看器与安全

- 查看器默认监听 `0.0.0.0:7788`；本机回环免密可写，外部访问要密码且只读。
- 外部密码自动生成在 `~/.dsh-fish/viewer-pass.txt`。
- 服务器上建议在 `~/.config/fish-fork.env` 设 `VIEWER_HOST=127.0.0.1`，
  用 Nginx/Caddy/隧道对外，并自己加认证。
- 管理器 7789 没有 Linux 版；它是本地 Windows 进程面板，Linux 用 systemd。
- 不要暴露 6199 / 7788 / 7789 到公网；`local.key`、`viewer-pass.txt`、
  `bridge/config.json` 都不进 git。

## 9. 数据目录与从 Windows 迁移

默认 `~/.dsh-fish`（`DSH_FISH_HOME` 或 `~/.dsh-fish-location.json` 可改）：

```
~/.dsh-fish/
├── config.json        # 设置（建议查看器改）
├── events.jsonl       # 账本：只增不改
├── home/              # 房间、资料柜、收件箱
├── diary/ media/      # 日记、图/语音
├── local.key          # 桥 ↔ 插件的本地密钥
└── viewer-pass.txt    # 查看器外部密码
```

从 Windows 搬过来：

1. 停掉 Windows 侧所有服务，复制整个数据目录到 Linux `~/.dsh-fish`；
2. 不要合并两份数据目录；
3. `config.json` 里如果有 Windows 专属路径（比如 `video.vsPath`），改成 Linux 路径或留空；
4. 账本、日记、收件箱原样可用；`local.key` / `viewer-pass.txt` 可以一起带，也可以删掉重建；
5. 启动 DSH + bridge + viewer 后核对账本行数与查看器「本机状态」。

## 10. 更新

```bash
cd ~/fish
git pull
# 插件是 link: 装的：改的是源码目录，重启 DSH 即可加载新代码
# 外壳（bridge/viewer）：
bash deploy/linux/fishctl.sh restart
```

- 改 `dsh-fish/lib/**` → **重启 DSH**（会断她当前会话）。
- 改 `viewer/**` → 重启 `fish-viewer`。
- 改 `bridge/**` → 重启 `fish-bridge`。
- 升级前先备份数据目录；账本只追加、向后兼容。

## 11. 常见问题

| 现象 | 先查 |
|---|---|
| DSH 设置页没有「大肥鱼」 | profile 的 `dependencies` / `bundles` 是否有 `@ssamurias/dsh-fish`；DSH 是否完全重启；插件日志是否报 `pending` |
| 桥找不到她 | DSH 是否在跑、插件是否加载；`journalctl --user -u fish-bridge`；`~/.dsh-fish/local.key` 是否存在 |
| QQ 收不到/发不出 | OneBot 反向 WS 是否连到 `ws://127.0.0.1:6199/ws`、`ownerIds`、`accessToken`、桥日志 |
| draw/formula 报没有浏览器 | 装 Chromium/Chrome，或设 `FISH_DRAW_BROWSER`；服务器上确认 `--no-sandbox` 已自动加 |
| 图里中文是方框 | 装 `fonts-noto-cjk`，重启浏览器进程（服务） |
| `her_voice` 没声音 | `~/.dsh-fish/venv/bin/python -m edge_tts --help` 是否可用；`FISH_PYTHON` 是否指向它；ffmpeg 是否在 PATH |
| 退出 SSH 后服务停了 | `sudo loginctl enable-linger "$USER"`；确认用的是 systemd 用户服务 |
| 端口冲突 | 6199 / 7788 / 18765；`ss -ltnp` 查占用 |

## 12. 已知边界

- **管理器 GUI 未移植**：用 systemd + `fishctl.sh` + 查看器「本机状态」。
- **QQ 通话（WASAPI）未移植**：Linux 上不走这条路。
- **Windows 的 GDI 画笔**保留给 Windows；Linux 用 Chromium，字体度量会有细微差别，
  但回执是实测值，不是估算。
- **DSH 本体**是前置：本仓只提供插件和外挂设施，不附带 DSH。

## 13. 许可与致谢

- 上游 [ssamurias/dsh-fish](https://github.com/ssamurias/dsh-fish)（MIT）
- 本 fork 在上游协议（MIT）之内发布；`dsh-fish/LICENSE` 随目录保留
