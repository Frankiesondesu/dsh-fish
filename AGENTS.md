# AGENTS.md —— 跨工具接手须知（任何 AI coding 工具开场先读完这页）

这个项目长期在多个 AI 工具间接力（WorkBuddy 国内/国际版、ZCode、……）。
**各工具自己的记忆只是缓存，真相源全在仓库里。** 你的记忆和仓库冲突时，以仓库为准；
你的记忆里有仓库没有的好东西，收工前把它搬进仓库（HANDOFF 补记或 ref/）。

## 开场三步（动手前）

1. **读 `HANDOFF.md` 最顶上的「⚡ 当前状态」卡**（10 行内：版本/提交/运行态/待办/悬而未决）。
   历史细节按需往下翻，不用通读。
2. **用 git 核实，别信转述**：两个仓库各看一眼 `git log --oneline -5` + `git status`。
   主仓是本目录；插件代码在子仓 `dsh-fish/`（独立 git，各自提交）。
3. **看运行态**：管理器 7789（哪些服务在线/待重启）、查看器 7788「本机状态」页。
   改过 `dsh-fish/lib/**` 而没重启 → `restartNeeded` 会亮，重启会断她当前会话，先问用户。

## 收工四步（每次都要）

1. **HANDOFF.md 顶部状态卡**就地更新（版本/提交/待办），并在下面**追加一条补记**
   （日期 + 干了什么 + 提交号 + 剩什么）。补记写事实和提交号，不写感想。
2. **全量测试**：子仓 `node --test test/*.test.mjs`；动过桥/查看器/管理器就跑对应仓的。
3. **两仓工作区干净**、各自提交（子仓改动在 `dsh-fish/` 里单独 commit，主仓不会带上它）。
4. 动过 `dsh-fish/lib/**` 或 `bridge/**` → 在补记里写明「要重启 DSH/桥才生效」。

## 真相源清单（按权威排序）

| 想知道什么 | 去哪 |
|---|---|
| 交接状态/坑/待办 | `HANDOFF.md`（顶部状态卡 + 按日期的补记） |
| 代码事实 | git（两个仓）+ 测试 |
| 她现在怎么样 | 账本 `~/.dsh-fish/events.jsonl`（只增不改）；查看器 7788 已把它翻成页面 |
| 服务在不在线 | 管理器 7789 / 查看器「本机状态」（探活，别照旧结论判断） |
| 上游同步 SOP | `HANDOFF.md`「十二、上游同步 SOP」；**her_say 相关提示词默认保 fork，别被冲掉** |
| 跨机迁移 | `ref/cross-machine-2026-11-06.md`（路径已自适应，指针文件机制） |

## 各工具的会话库（要读别的工具聊过什么时）

- WorkBuddy 国内版：`C:\Users\<用户名>\.workbuddy\projects\<目录名>\<uuid>.jsonl`；
  fish 项目目录是 `<工具会话库目录>`。国际版在 `C:\Users\<用户名>\.workbuddy-ai\`，同构。
- ZCode：`C:\Users\<用户名>\.zcode\cli\db\db.sqlite`（session 表按 title 搜），或 ReadSessionContext。
- JSONL 按 type 分（session-meta/message/function_call/…）；user 取 `content[].input_text`，
  assistant 取 `output_text`。提取脚本：`C:\Users\<用户名>\AppData\Local\Temp\wb-analysis\extract.mjs`
  （`node extract.mjs <in.jsonl> <out.md>`；Temp 会被清，丢了照此格式重写）。
- 只读增量：先看 HANDOFF 最新补记的时间，之后的会话才需要读。

## 铁律速查（违反就是事故，细则见 HANDOFF）

- 账本（events.jsonl）**只增不改**；不总结她的记忆，只搬原话。
- **fork.13**：工具对她说的话必须为真。改了出口通路，提示词/说明书要当天改真。
- **养不塑**：事实层可进提示词，性格层不行；不替她决定开口/看什么/发什么。
- **her_say 口径**（2026-11-07 用户定案）：唯一 QQ 发送通路，不区分主动/回复，
  refs 可选、无每日上限——合上游时相关提示词**保 fork**，别被上游写回去。
- 模板字符串里的前端 JS（viewer/manager）必须抽出来编译+vm 执行着验，
  `node --check` 外层查不出内嵌错误（踩过两次）。
- `.cmd` 文件一律 CRLF + 纯 ASCII；中文写在 node 侧输出。
- 常驻服务别从 AI 会话里起（沙箱会回收），让用户双击脚本/管理器。

## 悬而未决（等用户拍板，别擅自动）

见状态卡。历史上反复出现的模式：**「搭了但没接上」不等于没用**（话轮/全双工没调用方
但代价小）；反过来「她主动要的」优先级最高（her_world 那次就是她问了一天没人答）。
