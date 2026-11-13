#!/data/data/com.termux/files/usr/bin/bash
#
# fish · Termux 一键启动（2026-11-11）
#
# 在 Termux 里跑，不要在 Ubuntu 容器里跑。做的事：
#   1. termux-wake-lock，锁屏后不被挂起
#   2. 起 sshd（WITH_SSH=0 可关）
#   2.5 起容器内 Clash（mihomo :7890）——自带出口，不依赖 PC 或热点设备（见 do_clash）
#   2.6 代理自适应：本地 Clash 优先，没有才探热点网关（见 do_proxy）
#   3. 启动前记忆同步（比对云端最新记忆，见 do_sync）
#   3.5 上传（本机较新时推加密包；交 Termux 层独立会话跑，容器内 detached 会被收割，见 do_upload）
#   4. 用常驻 proot 会话起查看器 7788（已在跑则跳过）
#   5. 可选起 QQ 桥 6199（WITH_BRIDGE=1 且 bridge/config.json 存在）
#   6. 打印本机/局域网地址，可选自动开浏览器
#
# 用法：bash fish-start.sh [start|stop|status|logs|sync]
#
# ⚠ 完整启动顺序（DSH 不归本脚本管，必须单独在容器里起）：
#   1) bash ~/fish-start.sh sync         先起 Clash+配代理+同步：此时所有服务都没起，
#                                        云端较新才能安全接管
#   2) 容器内 nohup dsh --profile web --no-open &    （DSH 起来后 3080 会占着）
#   3) bash ~/fish-start.sh start        起查看器/桥；同步段会再跑一次但已一致 → no-op
#   若先起 DSH 再 start，sync.mjs 探到 3080 在跑会**拒绝接管**，只上传/警告。
# 可调变量（写在命令前）：VIEWER_PORT / BRIDGE_PORT / CLASH_PORT / WITH_BRIDGE / WITH_SSH /
#   OPEN_BROWSER / FISH_DISTRO / FISH_CONTAINER_ROOT / DSH_FISH_HOME /
#   SKIP_CLASH（不起 Clash）/ SKIP_PROXY（不重配代理）/ SKIP_SYNC（不同步）/ SKIP_UPLOAD（不上传）
#
# 注意：管理器 7789 是 Windows 专用（tasklist 探进程、只绑 127.0.0.1），Linux 没有；
# 手机上用本脚本的 start/stop/status 代替它，看数据用查看器。
set -u

DISTRO="${FISH_DISTRO:-ubuntu}"
CONTAINER_ROOT="${FISH_CONTAINER_ROOT:-/root/fish}"
DATA_HOME="${DSH_FISH_HOME:-/root/.dsh-fish}"
VIEWER_PORT="${VIEWER_PORT:-7788}"
BRIDGE_PORT="${BRIDGE_PORT:-6199}"
CLASH_PORT="${CLASH_PORT:-7890}"
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

# 容器内 Clash（mihomo）：自带出口，不依赖 PC 或热点设备。
# 它是常驻服务，必须走 launch（独立 proot 会话），容器内 detached 会被收割。
# 没装内核就跳过，代理会退到热点网关。
# 不想起：SKIP_CLASH=1 bash fish-start.sh start
do_clash() {
  if [ "${SKIP_CLASH:-0}" = 1 ]; then
    echo "  SKIP_CLASH=1，跳过 Clash"
    return 0
  fi
  if ! proot-distro login "$DISTRO" -- test -x /root/clash/mihomo; then
    echo "  容器里没有 /root/clash/mihomo，跳过（代理会退到网关）"
    return 0
  fi
  say "Clash 内核"
  launch clash "cd /root/clash && exec ./mihomo -d /root/clash" "$CLASH_PORT"
  if wait_ready "$CLASH_PORT"; then
    echo "  Clash 就绪（:$CLASH_PORT）"
  else
    echo "  ⚠ Clash 没监听 :$CLASH_PORT，看：bash $0 logs"
  fi
}

# 代理自适应：手机换热点，网关就变，容器里那份代理配置会过期。
# 容器内 /root/fish-proxy.sh 先看有没有本地 Clash（127.0.0.1:7890），
# 没有再从 Android 多路由表读默认网关去探端口。
# 失败只警告，绝不拦启动（同步会走「云端不可达 → 离线跳过」那条）。
# 不想配：SKIP_PROXY=1 bash fish-start.sh start
do_proxy() {
  if [ "${SKIP_PROXY:-0}" = 1 ]; then
    echo "  SKIP_PROXY=1，跳过代理配置"
    return 0
  fi
  if ! proot-distro login "$DISTRO" -- test -f /root/fish-proxy.sh; then
    echo "  容器里没有 /root/fish-proxy.sh，跳过代理配置"
    return 0
  fi
  say "代理自适应"
  timeout 60 proot-distro login "$DISTRO" -- bash /root/fish-proxy.sh 2>&1 | tail -6 || \
    echo "  ⚠ 代理没配上（照常启动；同步会走离线跳过）"
}

# 启动前记忆同步：抽成函数，start 会调一次，也可单独用 `sync` 子命令在起 DSH 之前跑。
# 判据与兜底都在容器里的 sync.mjs；失败只警告，绝不拦启动。
# 离线 / 不想同步时：SKIP_SYNC=1 bash fish-start.sh start
do_sync() {
  if [ "${SKIP_SYNC:-0}" = 1 ]; then
    echo "  SKIP_SYNC=1，跳过记忆同步"
    return 0
  fi
  say "记忆同步"
  if proot-distro login "$DISTRO" -- test -f /root/vault/sync.mjs; then
    proot-distro login "$DISTRO" -- env \
      FISH_VAULT_DIR=/root/vault \
      FISH_VAULT_HER="$DATA_HOME" \
      FISH_VAULT_KEY=/root/.fish-vault.key \
      FISH_VAULT_PRIV=/root/fish-private \
      FISH_VAULT_NO_UPLOAD=1 \
      timeout 170 node /root/vault/sync.mjs --apply 2>&1 | tail -8 || \
      echo "  ⚠ 同步没成（本机数据未动），照常用本机记忆启动"
  else
    echo "  容器里没有 /root/vault/sync.mjs，跳过（先更新 /root/vault）"
  fi
}

# 上传：容器内 spawn(detached) 会被 proot 收割——日志写着「已后台触发上传」，实际什么都没传。
# 所以让 sync.mjs 交出上传权（FISH_VAULT_NO_UPLOAD=1），由 Termux 层另起一个**独立 proot
# 会话**跑 backup.sh：它自己按内容指纹判断要不要真传（没变化秒退），失败也只写日志不拦启动。
# 刚接管云端数据（remote-newer / takeover）时不必再传一遍。
do_upload() {
  if [ "${SKIP_UPLOAD:-0}" = 1 ]; then
    echo "  SKIP_UPLOAD=1，跳过上传"
    return 0
  fi
  if ! proot-distro login "$DISTRO" -- test -f /root/vault/backup.sh; then
    echo "  容器里没有 /root/vault/backup.sh，跳过上传"
    return 0
  fi
  local decision
  decision="$(proot-distro login "$DISTRO" -- node -e \
    "try{process.stdout.write(String(require('/root/.fish-vault-sync.json').decision||''))}catch(e){}" \
    2>/dev/null | tail -n 1)"
  case "$decision" in
    remote-newer|takeover|diverged|error|offline|skip|blocked-by-running)
      echo "  本次判定 $decision，不需要上传"
      return 0 ;;
  esac
  say "上传（后台独立会话）"
  mkdir -p "$LOG_DIR"
  setsid nohup proot-distro login "$DISTRO" -- env \
    FISH_HER="$DATA_HOME" \
    FISH_VAULT=/root/vault \
    FISH_VAULT_KEY=/root/.fish-vault.key \
    FISH_PRIV=/root/fish-private \
    bash /root/vault/backup.sh \
    >"$LOG_DIR/upload.log" 2>&1 </dev/null 3>&- 4>&- 5>&- &
  echo "  已起（判定 ${decision:-未知}；日志 $LOG_DIR/upload.log）"
}

cmd_start() {
  say "fish · Termux 启动"
  command -v proot-distro >/dev/null 2>&1 || { echo "没装 proot-distro"; exit 1; }
  termux-wake-lock 2>/dev/null && echo "  已加唤醒锁" || true

  if [ "$WITH_SSH" = 1 ] && command -v sshd >/dev/null 2>&1; then
    if pgrep -x sshd >/dev/null 2>&1; then echo "  sshd 已在跑（8022）"
    else sshd && echo "  sshd 已启动（8022）"; fi
  fi

  do_clash
  do_proxy
  do_sync
  do_upload

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
  for pat in 'node viewer.mjs' 'node bridge.mjs' 'mihomo -d /root/clash'; do
    pids="$(pgrep -f "$pat" || true)"
    if [ -n "$pids" ]; then kill $pids 2>/dev/null && echo "  已停：$pat"; found=1; fi
  done
  [ "$found" = 0 ] && echo "  没有在跑的服务"
  true
}

cmd_status() {
  say "fish · 状态"
  local p port name ip pids
  for p in "$CLASH_PORT:Clash" "$VIEWER_PORT:查看器" "$BRIDGE_PORT:桥"; do
    port="${p%%:*}"; name="${p#*:}"
    if port_open "$port"; then echo "  ✅ $name :$port"; else echo "  ⬜ $name :$port（没在跑）"; fi
  done
  pids="$(pgrep -f 'node viewer.mjs|node bridge.mjs|mihomo -d /root/clash' 2>/dev/null | tr '\n' ' ')"
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
  sync) do_clash; do_proxy; do_sync; do_upload ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  *) echo "用法：bash $0 [start|stop|status|logs|sync]"; exit 1 ;;
esac
