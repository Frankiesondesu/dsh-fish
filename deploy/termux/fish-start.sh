#!/data/data/com.termux/files/usr/bin/bash
#
# fish · Termux 一键启动（2026-11-11）
#
# 在 Termux 里跑，不要在 Ubuntu 容器里跑。做的事：
#   1. termux-wake-lock，锁屏后不被挂起
#   2. 起 sshd（WITH_SSH=0 可关）
#   3. 用常驻 proot 会话起查看器 7788（已在跑则跳过）
#   4. 可选起 QQ 桥 6199（WITH_BRIDGE=1 且 bridge/config.json 存在）
#   5. 打印本机/局域网地址，可选自动开浏览器
#
# 用法：bash fish-start.sh [start|stop|status|logs]
# 可调变量（写在命令前）：VIEWER_PORT / BRIDGE_PORT / WITH_BRIDGE / WITH_SSH /
#   OPEN_BROWSER / FISH_DISTRO / FISH_CONTAINER_ROOT / DSH_FISH_HOME
#
# 注意：管理器 7789 是 Windows 专用（tasklist 探进程、只绑 127.0.0.1），Linux 没有；
# 手机上用本脚本的 start/stop/status 代替它，看数据用查看器。
set -u

DISTRO="${FISH_DISTRO:-ubuntu}"
CONTAINER_ROOT="${FISH_CONTAINER_ROOT:-/root/fish}"
DATA_HOME="${DSH_FISH_HOME:-/root/.dsh-fish}"
VIEWER_PORT="${VIEWER_PORT:-7788}"
BRIDGE_PORT="${BRIDGE_PORT:-6199}"
WITH_BRIDGE="${WITH_BRIDGE:-0}"
WITH_SSH="${WITH_SSH:-1}"
OPEN_BROWSER="${OPEN_BROWSER:-1}"
LOG_DIR="$HOME/fish-logs"

say() { printf '\n== %s ==\n' "$*"; }
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
wait_ready() { for _ in {1..24}; do port_open "$1" && return 0; sleep 0.5; done; return 1; }
# Android 不让 app 直接开 netlink（ip/ifconfig 都 Permission denied），
# 借容器里的 Node 走 os.networkInterfaces() 读 wlan0，优先 192.168.x。
lan_ip() {
  proot-distro login "$DISTRO" -- node -p \
    "const v=Object.values(require('os').networkInterfaces()).flat().filter(x=>x.family==='IPv4'&&!x.internal);(v.find(x=>/^192\.168\./.test(x.address))||v[0]||{}).address||''" \
    2>/dev/null | tail -n 1
}

# 后台常驻：proot 一退出子进程就被收走，所以让 proot 自己常驻（setsid 脱离会话）。
launch() {
  local name="$1" cmd="$2" port="$3"
  if port_open "$port"; then echo "  $name 已在跑（:$port），跳过"; return 0; fi
  mkdir -p "$LOG_DIR"
  setsid nohup proot-distro login "$DISTRO" -- bash -c "$cmd" \
    >"$LOG_DIR/$name.log" 2>&1 </dev/null 3>&- 4>&- 5>&- &
  echo "  启动 $name……"
}

cmd_start() {
  say "fish · Termux 启动"
  command -v proot-distro >/dev/null 2>&1 || { echo "没装 proot-distro"; exit 1; }
  termux-wake-lock 2>/dev/null && echo "  已加唤醒锁" || true

  if [ "$WITH_SSH" = 1 ] && command -v sshd >/dev/null 2>&1; then
    if pgrep -x sshd >/dev/null 2>&1; then echo "  sshd 已在跑（8022）"
    else sshd && echo "  sshd 已启动（8022）"; fi
  fi

  launch viewer "cd '$CONTAINER_ROOT/viewer' && DSH_FISH_HOME='$DATA_HOME' VIEWER_PORT='$VIEWER_PORT' exec node viewer.mjs" "$VIEWER_PORT"
  if wait_ready "$VIEWER_PORT"; then echo "  查看器就绪"; else echo "  ⚠ 查看器没起来，看：bash $0 logs"; fi

  if [ "$WITH_BRIDGE" = 1 ]; then
    if proot-distro login "$DISTRO" -- test -f "$CONTAINER_ROOT/bridge/config.json"; then
      launch bridge "cd '$CONTAINER_ROOT/bridge' && exec node bridge.mjs" "$BRIDGE_PORT"
      wait_ready "$BRIDGE_PORT" && echo "  桥就绪" || echo "  ⚠ 桥没监听 :$BRIDGE_PORT，看：bash $0 logs"
    else
      echo "  WITH_BRIDGE=1，但容器里没有 bridge/config.json，跳过"
    fi
  fi

  say "地址"
  echo "  手机浏览器：http://127.0.0.1:$VIEWER_PORT"
  local ip; ip="$(lan_ip)"
  if [ -n "$ip" ]; then
    echo "  电脑浏览器：http://$ip:$VIEWER_PORT（要密码、只读；密码在容器 $DATA_HOME/viewer-pass.txt）"
  fi
  echo "  管理器 7789 是 Windows 专用，Linux 上没有；启停用 bash $0 status|stop"

  if [ "$OPEN_BROWSER" = 1 ] && command -v termux-open-url >/dev/null 2>&1; then
    termux-open-url "http://127.0.0.1:$VIEWER_PORT" >/dev/null 2>&1 || true
  fi
}

cmd_stop() {
  say "fish · 停止"
  local found=0 pids pat
  for pat in 'node viewer.mjs' 'node bridge.mjs'; do
    pids="$(pgrep -f "$pat" || true)"
    if [ -n "$pids" ]; then kill $pids 2>/dev/null && echo "  已停：$pat"; found=1; fi
  done
  [ "$found" = 0 ] && echo "  没有在跑的服务"
  true
}

cmd_status() {
  say "fish · 状态"
  local p port name ip pids
  for p in "$VIEWER_PORT:查看器" "$BRIDGE_PORT:桥"; do
    port="${p%%:*}"; name="${p#*:}"
    if port_open "$port"; then echo "  ✅ $name :$port"; else echo "  ⬜ $name :$port（没在跑）"; fi
  done
  pids="$(pgrep -f 'node viewer.mjs|node bridge.mjs' 2>/dev/null | tr '\n' ' ')"
  [ -n "$pids" ] && echo "  进程：$pids"
  ip="$(lan_ip)"
  [ -n "$ip" ] && echo "  地址：http://$ip:$VIEWER_PORT（手机本机用 127.0.0.1）"
  true
}

cmd_logs() {
  say "fish · 日志（$LOG_DIR）"
  local f
  for f in "$LOG_DIR"/*.log; do
    [ -f "$f" ] || continue
    echo "--- $f"
    tail -n 30 "$f"
  done
}

case "$(uname -r)" in
  *PRoot*|*proot*) echo "这是在 Ubuntu 容器里；请在 Termux 里运行本脚本。" >&2; exit 1 ;;
esac

case "${1:-start}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  *) echo "用法：bash $0 [start|stop|status|logs]"; exit 1 ;;
esac
