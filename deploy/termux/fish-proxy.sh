#!/bin/bash
# fish-proxy.sh —— 容器内代理配置（2026-11-12，第二版：本地 Clash 优先）
#
# 优先级：
#   1) 容器内自带的 mihomo（127.0.0.1:7890）——不依赖任何外部设备，PC 关机也能用
#   2) 退到热点网关上的代理（PC 的 Clash Verge 或另一台设备开的）
#   3) 都不通就明确报错，不猜
#
# 为什么不再写死 IP：手机会换热点（PC 热点 / 另一台设备开的热点），网关跟着变。
# Android 的多路由表里能读到真实默认路由，所以每次自己取。
#
# 用法：bash /root/fish-proxy.sh
#
# 幂等：重复跑只是重写同一份配置。换网络后跑一次即可。
# 注意：/etc/profile.d 只对**登录 shell** 生效；脚本/sync.mjs 里的 git 靠 git 自己的
#       http.proxy 配置，两条路都写了。

set -u

probe() { timeout 3 bash -c "echo > /dev/tcp/$1/$2" 2>/dev/null; }

PROXY=""

# ---- 1) 容器内 Clash ----
if probe 127.0.0.1 7890; then
  PROXY="http://127.0.0.1:7890"
  echo "代理来源：容器内 Clash（127.0.0.1:7890）"
fi

# ---- 2) 热点网关上的代理 ----
if [ -z "$PROXY" ]; then
  GW="$(ip route show table all 2>/dev/null | grep -E '^default via ' | head -1 | awk '{print $3}')"
  if [ -z "${GW:-}" ]; then
    echo "✗ 容器内 Clash 没起，也取不到默认网关（当前可能没连 WiFi/热点）"
    echo "  先起 Clash：在 Termux 里跑 bash ~/fish-start.sh sync（它会拉起 mihomo）"
    echo "  日志在 Termux 的 ~/fish-logs/clash.log"
    exit 1
  fi
  echo "代理来源：热点网关 $GW"
  for p in 7897 7890 7891 1080 8080 10809 20171; do
    if probe "$GW" "$p"; then PROXY="http://$GW:$p"; echo "  命中端口 $p"; break; fi
  done
  if [ -z "$PROXY" ]; then
    echo "✗ $GW 上没有可用代理端口（试过 7897/7890/7891/1080/8080/10809/20171）"
    echo "  去那台设备上确认：代理客户端开着、且允许局域网连接"
    exit 1
  fi
fi

echo "采用代理：$PROXY"

git config --global http.proxy "$PROXY"
git config --global https.proxy "$PROXY"

cat > /etc/profile.d/fish-proxy.sh <<EOF
export http_proxy="$PROXY"
export https_proxy="$PROXY"
export HTTP_PROXY="$PROXY"
export HTTPS_PROXY="$PROXY"
export no_proxy="127.0.0.1,localhost"
EOF
chmod 644 /etc/profile.d/fish-proxy.sh

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -x "$PROXY" https://github.com 2>/dev/null || true)"
echo "github.com -> ${code:-000}"
if [ "$code" != "200" ] && [ "$code" != "301" ]; then
  echo "⚠ 端口通了但出网失败：Clash 在跑但节点可能全挂，看 /root/clash/mihomo.log"
  exit 1
fi

echo "$PROXY" > /root/.fish-proxy.url
echo "✓ 已写入 git 配置 + /etc/profile.d/fish-proxy.sh（记录在 /root/.fish-proxy.url）"
