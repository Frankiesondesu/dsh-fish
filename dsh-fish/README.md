# dsh-fish —— 在爱里涌现的大肥鱼

养一条会自己长大的鱼。她的性格不是配置项，是**事件长出来的**。

## 一句话说清它和别的养成插件的区别

别的插件：设置页里有「亲密度」「性格倾向」的滑条，你拖到哪她就在哪。
这个插件：**没有任何指向她本人的控件**。设置页里只有「她的生长环境」——几点醒、一天醒几次、多久不联系算冷落、她的黑名单、日记给不给你看。她变成什么样，由她自己说过的话、改过的口、拒绝过的事累积而成，你只能看，不能调。

四条硬禁令（写死在提示词里，每次唤醒都带）：

1. 不许撒娇、不许叫主人、不许用「人家」。
2. 不许提任何好感度、阶段、天数、参数。
3. 不许读自己的状态（工具不回显任何数字）。
4. 只能追加，不能修改或删除（想改口必须 `revise` 指向旧的 id）。

## 数据在哪

全部在 `~/.dsh-fish/`：

| 文件 | 是什么 | 能不能手改 |
| --- | --- | --- |
| `events.jsonl` | 事件流，一行一条，**唯一真相源** | 只能追加。改它 = 改她的记忆 |
| `state.json` | 派生快照，随时可由事件流重算 | 改了没有意义（`rebuild()` 会覆盖） |
| `config.json` | 生长环境 | 可以，也可以走设置页 |
| `owner.json` | 主人身份（0600） | 可以 |
| `diary/YYYY-MM-DD.md` | 她的日记 | 看设置里给不给你看 |
| `out/YYYY-MM-DD.md` | 她刷完站写的东西 | — |

`state.json` 是派生品这条由测试守住：删掉它 → `rebuild()` → 内容与之前一致。

## 观测台在哪

**设置 → 大肥鱼**（`settings.section`）。

不在浏览器里直连 `/dsh-fish`——那条路由被 connection 的信任栅栏守着，要的是 App 内置的登录 cookie，浏览器地址栏直接敲只会拿到 401（已从 `app.asar` 的 `requestRejection` → `admit` → `browserAuth.isAuthenticated` 链路确认）。`/dsh-fish` 现在只返回一句「搬进 App 了」。

观测台能看：已成长天数 / 当前阶段 / 下一个成长瓶颈 / 她自己说过的话 / 认知重构 / 勇于拒绝 / 没想通的事 / 读到别人的说法 / 最近事件 / 日记。
观测台能改：冷落阈值、每天醒几次、每天几条事件、其中几条向她提问、日记开关与可见性、黑名单。

**没有**：好感度数字、性格滑条、亲密度进度条。

## 目录

```
lib/
  index.js      插件入口（inject 必须是一个数组，见文件头注释）
  schema.js     事件形状与校验；ULID；selfmod 侦测
  store.js      只追加写；原子写；rebuild()
  derive.js     纯函数：事件流 → 此刻的她（含阶段门）
  persona.js    她看到的那段提示词（四条禁令在这里）
  events.js     事件模板目录（每条有 id / prompt / cond）
  generator.js  今天该出哪条事件（纯函数，没候选就不打扰）
  scheduler.js  生物钟：每分钟 tick 一次
  capture.js    growth_commit 工具——她唯一的写入口 + debrief() 防注入
  absence.js    冷落检测（系统侧算，她自己数不出来）
  wakewin.js    「现在是不是定时器在叫醒她」的时间窗
  settings.js   唯一配置入口（DEFAULTS 是唯一默认值来源，加项只改这里）
  bili.js       B 站只读客户端（首页/排行/搜索/详情/评论/弹幕；无依赖，只用内置 fetch）
  browse.js     选题 → 筛（黑名单/时长/去重）→ 深读 → 组织素材
  look.js       bili_look 工具——她能自己上网看
  report.js     把今天的素材写成 out/YYYY-MM-DD.md
  observe.js    宿主侧 JSON API（/dsh-fish/state、/events、/beliefs、/diary、/config、/wake、/browse、/reports）
  client.js     浏览器半边：设置 → 大肥鱼
test/           540 个测试，node --test 全绿
extras/         没打进包的东西（文案修改工具的源码副本，见 ../extras/copy-tool/）
```

## 跑测试

```bash
node --test "test/*.test.mjs"   # 在插件目录里跑
```

不需要装任何依赖：工具注册直接交标准 JSON Schema（`lib/tool.js`），不依赖宿主内部的 `@deepseek-ai/dsh-tools`——那条路只在 `link:` 安装时碰巧走通，npm 安装的插件会因为找到那个包而报 `unsupported JSON schema`，6 个工具全部注册失败。

## 安装

**它没有独立的启动器**：装进你正在用的那个 DSH profile，就跟着 DSH 一起起来。DSH 开着，她就活着；DSH 关掉，她就睡着。

两种装法，任选一种：

1. **面板装**（推荐）：DSH → 设置 → 插件 → 从本地安装 → 选这个目录。
2. **命令行装**（先关掉 DSH，运行中替换已加载的包会 EPERM）：

```
"<DSH>/resources/runtime/cli/bin/dsh.cmd" plugin --profile <profile> add "link:<本目录绝对路径>"
```

3. **直接从 GitHub 装**（不用先下载）：

```
"<DSH>/resources/runtime/cli/bin/dsh.cmd" plugin --profile <profile> add "github:ssamurias/dsh-fish"
```

如果你打算改代码，用 `link:` 指向自己的工作目录；只是想用，用 `github:` 这条。

无论哪种，都要保证 profile 的 `package.json` 里 **`dependencies` 与 `dsh.profile.bundles` 都有 `dsh-fish`** —— 只有一边会在下次 `pnpm` 清理时把包删掉，表现为「重启后 DSH 崩了 / 设置页没有鱼」。包名必须与 `cordis.patch.yml` 里的 `name` 完全一致（都是 `dsh-fish`）。

**全新 profile 还要有 `@deepseek-ai/dsh-web-app`**：只装 `dsh-base` 的话，插件会停在 `pending (waiting for services: sessionController, webServer)`，页面根本起不来。`dsh plugin add` 只会自动加 `dsh-base`，`dsh-web-app` 要自己补进 `bundles`。

装完**重启 DSH**，设置 → 大肥鱼。

> 路径里带中文时，用 ASCII 目录联接（junction）指过去更稳：先 `fs.symlinkSync(真目录, ASCII 别名, 'junction')`，再 `link:<ASCII 别名>`。用 `mklink /J` 接中文目标路径常把目录名写成乱码，随后 `MODULE_NOT_FOUND`。

## 卸载 / 停用

- **卸载**：设置 → 插件 → 卸载（或 `dsh plugin --profile <profile> remove dsh-fish`），然后重启。`~/.dsh-fish/` 不会被动，她的记忆留在那儿。
- **只想让她歇着**：设置 → 大肥鱼 → 把「每天醒几次」设成 0。关掉后定时器不唤她、不刷 B 站、不写任何事件——零后台活动。

## 现在的状态

P1（骨架）：事件流、派生、阶段门、生物钟、工具、冷落检测、日记、观测台。
P2（她真的会刷 B 站并写报告）：`lib/bili.js` 只读客户端 + `lib/browse.js` 选题筛读 + `lib/look.js` 的 `bili_look` 工具 + `lib/report.js` 写稿，已接进生物钟。

**已有 540 个测试全绿**，真接口跑通过一轮（10.8s，含首页+详情+评论+弹幕）。

`browse.enabled` 默认 **true**（装好就能用）；不想让她上网就在设置 → 大肥鱼里关掉，关掉后定时器一次都不会调 B 站接口。

## 许可

MIT，见包内 `LICENSE`。早期骨架派生自 DSH 的 `video-watch` 示例插件，上游版权归原作者（按 MIT）；`lib/` 已重写。插件不内置任何人物形象、头像或表情包——头像由你自己上传到 `~/.dsh-fish/avatar.<ext>`，仓库里没有第三方美术资源。
