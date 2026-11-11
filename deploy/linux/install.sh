#!/usr/bin/env bash
# fish (dsh-fish fork) —— Ubuntu/Debian 安装与 systemd 用户服务生成
#
# 只做「外壳」：装系统依赖、准备数据目录、生成 bridge/viewer 的 systemd 用户单元。
# 不替你装 DSH、不替你登录 QQ、不写你的 QQ 号。
#
# 用法：
#   bash deploy/linux/install.sh
#   DSH_CLI=/path/to/dsh DSH_PROFILE=headless bash deploy/linux/install.sh
#
# 可选环境变量：
#   DSH_FISH_HOME   数据目录（默认 ~/.dsh-fish）
#   DSH_CLI         dsh 命令；设了才会打印插件挂载命令（不会自动执行）
#   DSH_PROFILE     DSH profile（默认 headless；桌面版用 desktop）
#   WITH_EDGE_TTS   1=在数据目录建 venv 并装 edge-tts（默认 1）
#   NODE_BIN        node 可执行文件（默认 PATH 里的 node）
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FISH_HOME="${DSH_FISH_HOME:-$HOME/.dsh-fish}"
DSH_PROFILE="${DSH_PROFILE:-headless}"
DSH_CLI="${DSH_CLI:-}"
WITH_EDGE_TTS="${WITH_EDGE_TTS:-1}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
ENV_FILE="$HOME/.config/fish-fork.env"

say() { printf '\n== %s ==\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*"; }

say "检查 Node"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "找不到 node。先装 Node.js 22+（推荐 nvm 或 NodeSource），再跑本脚本。"
  exit 1
fi
"$NODE_BIN" -e 'const v=process.versions.node.split(".").map(Number); if(v[0]<20) { console.error("Node 版本太低："+process.versions.node); process.exit(1) }'
echo "node: $("$NODE_BIN" -v)（$NODE_BIN）"

say "安装系统依赖（Debian/Ubuntu）"
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y ffmpeg fonts-noto-cjk python3-venv python3-pip
  # Chromium 的包名随发行版变化：Debian 是 chromium，Ubuntu 常是 chromium-browser(snap)。
  if ! sudo apt-get install -y chromium 2>/dev/null; then
    sudo apt-get install -y chromium-browser || warn "没装上 Chromium；her_draw/her_formula 需要它，装好后设 FISH_DRAW_BROWSER。"
  fi
else
  warn "不是 Debian/Ubuntu：请手动安装 ffmpeg、chromium/chrome、Noto Sans CJK 字体、python3-venv。"
fi

say "准备数据目录"
mkdir -p "$FISH_HOME"
if [ ! -f "$REPO_DIR/bridge/config.json" ]; then
  cp "$REPO_DIR/bridge/config.example.json" "$REPO_DIR/bridge/config.json"
  echo "已生成 bridge/config.json —— 请把 ownerIds 改成你的 QQ 号。"
else
  echo "bridge/config.json 已存在，没动。"
fi

say "准备 edge-tts（her_voice）"
if [ "$WITH_EDGE_TTS" = "1" ]; then
  if python3 -m venv "$FISH_HOME/venv" 2>/dev/null; then
    "$FISH_HOME/venv/bin/pip" install -U pip >/dev/null 2>&1 || true
    if "$FISH_HOME/venv/bin/pip" install -U edge-tts; then
      echo "edge-tts 已装进 $FISH_HOME/venv"
    else
      warn "edge-tts 没装上；her_voice 暂时不可用，网络恢复后可重跑本脚本。"
    fi
  else
    warn "python3 -m venv 失败；请装 python3-venv 后重跑。"
  fi
else
  echo "WITH_EDGE_TTS=0，跳过。"
fi

say "写环境文件"
mkdir -p "$(dirname "$ENV_FILE")"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
DSH_FISH_HOME=$FISH_HOME
# VIEWER_HOST=127.0.0.1
# DSH_FISH_FFMPEG=$(command -v ffmpeg || echo /usr/bin/ffmpeg)
# FISH_PYTHON=$FISH_HOME/venv/bin/python
# FISH_DRAW_BROWSER=/usr/bin/chromium
EOF
  echo "已生成 $ENV_FILE（按需改）"
else
  echo "$ENV_FILE 已存在，没动。"
fi

say "生成 systemd 用户单元"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
sed -e "s|__REPO__|$REPO_DIR|g" -e "s|__NODE__|$NODE_BIN|g" -e "s|__ENV__|$ENV_FILE|g" \
  "$REPO_DIR/deploy/linux/fish-bridge.service.in" > "$UNIT_DIR/fish-bridge.service"
sed -e "s|__REPO__|$REPO_DIR|g" -e "s|__NODE__|$NODE_BIN|g" -e "s|__ENV__|$ENV_FILE|g" \
  "$REPO_DIR/deploy/linux/fish-viewer.service.in" > "$UNIT_DIR/fish-viewer.service"
echo "已写 $UNIT_DIR/fish-bridge.service"
echo "已写 $UNIT_DIR/fish-viewer.service"

if systemctl --user daemon-reload >/dev/null 2>&1; then
  systemctl --user enable --now fish-bridge.service fish-viewer.service
  echo "已启用并启动 fish-bridge / fish-viewer。"
  echo "看状态：bash deploy/linux/fishctl.sh status"
else
  warn "当前会话没有用户 systemd；单元已经写好了，登录后手动：systemctl --user daemon-reload && systemctl --user enable --now fish-bridge fish-viewer"
fi
if command -v loginctl >/dev/null 2>&1; then
  echo "想让服务在你退出 SSH 后继续跑：sudo loginctl enable-linger $USER"
fi

say "把插件挂进 DSH（需要先装好 Linux 版 DSH）"
if [ -n "$DSH_CLI" ]; then
  echo "请先完全退出 DSH，再执行："
  echo "  \"$DSH_CLI\" plugin --profile $DSH_PROFILE add \"link:$REPO_DIR/dsh-fish\""
else
  echo "没给 DSH_CLI。装好 DSH 后手动执行（profile 按你的发行版/用法改）："
  echo "  dsh plugin --profile $DSH_PROFILE add \"link:$REPO_DIR/dsh-fish\""
fi
echo
echo "顺序：先启动 DSH → 再确认 fish-bridge / fish-viewer 在跑 → 打开 http://127.0.0.1:7788"
echo "完整说明见 $REPO_DIR/DEPLOY-LINUX.md"
