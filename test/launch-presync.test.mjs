/**
 * 启动前记忆同步的接线测试（2026-11-12）。
 * 纯静态断言：不启动任何服务、不联网、不碰账本。
 * 关键是钉死「同步在拉起服务之前」，否则服务已经在写账本时覆盖会出事故。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const launch = readFileSync(join(ROOT, 'launch.mjs'), 'utf8')
const phone = readFileSync(join(ROOT, 'deploy', 'termux', 'fish-start.sh'), 'utf8')

test('launch.mjs：前置同步必须在 1) DSH 之前', () => {
  const syncAt = launch.indexOf('启动前记忆同步')
  const dshAt = launch.indexOf('// 1) DSH')
  assert.ok(syncAt > 0, '前置同步代码要在')
  assert.ok(dshAt > syncAt, '同步必须排在拉起 DSH 之前（服务起来后会边写边覆盖）')
})

test('launch.mjs：只在全量启动、非 --check 时触发，且失败不拦启动', () => {
  assert.match(launch, /import \{ spawn, spawnSync, execFileSync \}/, '要引入 spawnSync')
  assert.match(launch, /if \(!TARGET && !CHECK_ONLY\)/, '单项启动和 --check 不许触发同步')
  assert.match(launch, /pre-start-hook\.mjs/, '钩子住在数据目录（仓外）')
  assert.match(launch, /timeout: 180000/, '必须有超时，别把启动卡死')
  assert.match(launch, /同步没成（本机数据未动），照常用本机记忆启动/, '失败只警告')
  assert.doesNotMatch(launch.slice(launch.indexOf('启动前同步：比对'), launch.indexOf('// 1) DSH')), /process\.exit/, '同步段不许退出进程')
})

test('fish-start.sh：手机端同步也在起查看器之前，且可跳过', () => {
  const syncAt = phone.indexOf('启动前记忆同步')
  const viewerAt = phone.indexOf('launch viewer')
  assert.ok(syncAt > 0, '手机端要有同步段')
  assert.ok(viewerAt > syncAt, '同步必须排在 launch viewer 之前')
  assert.match(phone, /SKIP_SYNC/, '离线时要能跳过')
  assert.match(phone, /sync\) do_clash; do_proxy; do_sync; do_upload/, 'sync 子命令要串起 Clash→代理→同步→上传')
  assert.match(phone, /nohup dsh --profile web --no-open/, '要写清 DSH 得单独在容器里起')
  assert.match(phone, /FISH_VAULT_KEY=\/root\/\.fish-vault\.key/, '要指定容器里的密钥')
  assert.match(phone, /timeout 170/, '要有超时')
  assert.match(phone, /本机数据未动/, '失败只警告，不拦启动')
})

test('fish-start.sh：Clash → 代理 → 同步 → 上传，顺序不能乱', () => {
  // Clash 是出口，代理指向它，同步才通；上传必须排在同步之后（要按 sync 的判定决定传不传）。
  const callSites = phone.indexOf('  do_clash\n  do_proxy\n  do_sync\n  do_upload')
  assert.ok(callSites > 0, 'start 里必须 do_clash → do_proxy → do_sync → do_upload')
  assert.match(phone, /SKIP_CLASH/, '不想起 Clash 时要能跳过')
  assert.match(phone, /\/root\/clash\/mihomo/, '要检查容器里有没有内核')
  assert.match(phone, /CLASH_PORT:-7890/, '端口可配，默认 7890')
  // Clash 是常驻服务，必须走 launch（独立 proot 会话）；容器内 detached 会被收割
  assert.match(phone, /launch clash /, 'Clash 必须用 launch 起，别自己 spawn')
})

test('上传：必须交给 Termux 层独立会话，且 sync.mjs 不再自己传', () => {
  // 容器内 spawn(detached) 被 proot 收割 —— 日志写「已后台触发上传」，实际什么都没传。
  const upAt = phone.indexOf('do_upload() {')
  assert.ok(upAt > 0, '要有 do_upload')
  assert.match(phone, /FISH_VAULT_NO_UPLOAD=1/, 'sync.mjs 必须交出上传权（否则又是假绿）')
  assert.match(phone, /SKIP_UPLOAD/, '要能跳过上传')
  // 起法：Termux 层 setsid nohup proot-distro login ... backup.sh
  const body = phone.slice(upAt, phone.indexOf('\n}', upAt))
  assert.match(body, /setsid nohup proot-distro login/, '上传必须是独立 proot 会话')
  assert.match(body, /backup\.sh/, '要跑 backup.sh')
  assert.match(body, /upload\.log/, '要有独立日志')
  assert.match(body, /FISH_PRIV=/, 'backup.sh 要知道 fish-private 在哪')
  assert.doesNotMatch(body, /--wait-upload|FISH_VAULT_UPLOAD_WAIT/, '不许改回阻塞等待（会卡启动几分钟）')
  // 刚接管云端数据时不该再传一遍
  assert.match(body, /remote-newer\|takeover/, 'remote-newer/takeover 要跳过上传')
})

test('fish-proxy.sh：本地 Clash 优先，热点网关只作兜底', () => {
  const proxy = readFileSync(join(ROOT, 'deploy', 'termux', 'fish-proxy.sh'), 'utf8')
  const clashAt = proxy.indexOf('probe 127.0.0.1 7890')
  const gwAt = proxy.indexOf('ip route show table all')
  assert.ok(clashAt > 0, '要先探容器内 Clash')
  assert.ok(gwAt > clashAt, '网关探测必须排在本地 Clash 之后（本地能出网就不依赖别人）')
  assert.match(proxy, /git config --global http\.proxy/, 'git 自己的代理配置要写')
  assert.match(proxy, /\/etc\/profile\.d\/fish-proxy\.sh/, '登录 shell 的环境变量也要写')
  assert.doesNotMatch(proxy, /192\.168\./, '不许把某个热点网段写死进仓')
})

test('仓外 pre-start-hook 若存在，必须只转调 sync.mjs --apply', () => {
  const p = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh-fish', 'pre-start-hook.mjs')
  if (!existsSync(p)) return // 别的机器上没有这个私有钩子，跳过
  const src = readFileSync(p, 'utf8')
  assert.match(src, /sync\.mjs/, '要转调 sync.mjs')
  assert.match(src, /'--apply'/, '启动链路才真正动手')
  assert.doesNotMatch(src, /events\.jsonl/, '钩子不许自己碰账本')
})
