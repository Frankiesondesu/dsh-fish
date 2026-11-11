#!/usr/bin/env bash
# fish (dsh-fish fork) —— Linux 下的启停/状态/日志（systemd 用户服务）
#
# 用法：bash deploy/linux/fishctl.sh {start|stop|restart|status|logs}
# DSH 本身不归这里管；先启动 DSH，再起 bridge/viewer。
set -euo pipefail

SERVICES=(fish-bridge fish-viewer)
cmd="${1:-status}"

case "$cmd" in
  start)   systemctl --user start "${SERVICES[@]}" ;;
  stop)    systemctl --user stop "${SERVICES[@]}" ;;
  restart) systemctl --user restart "${SERVICES[@]}" ;;
  status)  systemctl --user status "${SERVICES[@]}" --no-pager ;;
  logs)    journalctl --user -u fish-bridge -u fish-viewer -n 100 -f ;;
  *)
    echo "用法：$0 {start|stop|restart|status|logs}"
    exit 2
    ;;
esac
