#!/data/data/com.termux/files/usr/bin/bash
#
# fish · 手机容器 VNC 远程桌面一键启停（2026-11-12）
#
# 在 Termux 里跑，不要在 Ubuntu 容器里跑。做的事：
#   1. termux-wake-lock，锁屏后不被挂起
#   2. 起 sshd（WITH_SSH=0 可关）
#   3. 用常驻 proot 会话起 Xfce 桌面 + TigerVNC :1（5901 端口）
#
# 用法：bash vnc-start.sh [start|stop|status|logs]
# 可调变量（写在命令前）：VNC_DISPLAY / VNC_GEOMETRY / WITH_SSH / FISH_DISTRO
#
# 与 fish-start.sh 的关系：那个管查看器 7788 / 桥，这个管桌面 5901，互不影响。
# 密码复用查看器的（容器 /root/.dsh-fish/viewer-pass.txt，装桌面时已配好）。
# 禁忌同手册：不要 pkill proot（会把 HA 一起杀）；本脚本只杀 Xtigervnc。
set -u

DISTRO="${FISH_DISTRO:-ubuntu}"
DISPLAY_NUM="${VNC_DISPLAY:-1}"
GEOMETRY="${VNC_GEOMETRY:-1600x900}"
WITH_SSH="${WITH_SSH:-1}"
PORT=$((5900 + DISPLAY_NUM))
LOG_DIR="$HOME/fish-logs"

say() { printf '\n== %s ==\n' "$*"; }
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
wait_ready() { for _ in {1..30}; do port_open "$PORT" && return 0; sleep 0.5; done; return 1; }
lan_ip() {
  proot-distro login "$DISTRO" -- node -p \
    "const v=Object.values(require('os').networkInterfaces()).flat().filter(x=>x.family==='IPv4'&&!x.internal);(v.find(x=>/^192\.168\./.test(x.address))||v[0]||{}).address||''" \
    2>/dev/null | tail -n 1
}

cmd_start() {
  say "fish · VNC 桌面启动（:$DISPLAY_NUM -> :$PORT）"
  command -v proot-distro >/dev/null 2>&1 || { echo "没装 proot-distro"; exit 1; }
  termux-wake-lock 2>/dev/null && echo "  已加唤醒锁" || true

  if [ "$WITH_SSH" = 1 ] && command -v sshd >/dev/null 2>&1; then
    pgrep -x sshd >/dev/null 2>&1 || { sshd && echo "  sshd 已启动（8022）"; }
  fi

  if port_open "$PORT"; then echo "  VNC 已在跑（:$PORT），跳过"; return 0; fi
  mkdir -p "$LOG_DIR"
  echo "  启动 Xfce + Xvnc……"
  # 常驻 proot 托管：Xvnc 是 proot 的被追踪子进程，proot 一退它就死，
  # 所以用 sleep infinity 拖住 proot 本体（模式同 fish-start.sh）。
  setsid nohup proot-distro login "$DISTRO" -- bash -c "
    rm -f /tmp/.X${DISPLAY_NUM}-lock /tmp/.X11-unix/X${DISPLAY_NUM} 2>/dev/null
    tigervncserver :${DISPLAY_NUM} -geometry $GEOMETRY -depth 24 -localhost no
    exec sleep infinity
  " >"$LOG_DIR/vnc.log" 2>&1 </dev/null 3>&- 4>&- 5>&- &
  if wait_ready; then echo "  ✅ VNC 就绪（:$PORT）"; else echo "  ⚠ 没起来，看：bash $0 logs"; fi
}

cmd_stop() {
  say "fish · VNC 桌面停止"
  if pgrep -f "Xtigervnc :${DISPLAY_NUM}" >/dev/null 2>&1; then
    proot-distro login "$DISTRO" -- tigervncserver -kill ":${DISPLAY_NUM}" 2>/dev/null || \
      pkill -f "Xtigervnc :${DISPLAY_NUM}"
    echo "  已停 :$DISPLAY_NUM"
  else
    echo "  没有在跑的 VNC 会话"
  fi
  true
}

cmd_status() {
  say "fish · VNC 状态"
  if port_open "$PORT"; then echo "  ✅ Xvnc :$PORT 在跑"; else echo "  ⬜ Xvnc :$PORT（没在跑）"; fi
  local pids; pids="$(pgrep -f 'Xtigervnc' 2>/dev/null | tr '\n' ' ')"
  [ -n "$pids" ] && echo "  进程：$pids"
  local ip; ip="$(lan_ip)"
  [ -n "$ip" ] && echo "  电脑 VNC 客户端连：$ip:$PORT（密码=查看器密码）"
  echo "  手机本机连：127.0.0.1:$PORT"
  true
}

cmd_logs() {
  say "fish · VNC 日志（$LOG_DIR/vnc.log）"
  [ -f "$LOG_DIR/vnc.log" ] && tail -n 40 "$LOG_DIR/vnc.log" || echo "  还没有日志"
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
