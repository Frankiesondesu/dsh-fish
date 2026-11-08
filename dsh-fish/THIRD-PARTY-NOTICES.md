# 第三方来源与致谢

本文件从 `LICENSE` 中拆出。`LICENSE` 保持标准 MIT 全文，便于 GitHub 正确识别协议；
项目来源、引用与素材授权说明放在这里。

## 代码来源

本项目**不含上游代码派生**：`lib/` 下全部实现（事件流、四个阶段与三道瓶颈、记忆显著性与固化、
拒绝与疤、事件卡与节奏缩放等）均在本项目中新写；B 站接口的行为来自本机实测
（见 `lib/bili.js` 头部注释），不是官方 API，未拷贝任何第三方库，插件也没有任何运行时依赖。

唯一随附的第三方软件是 MathJax 的单个构建文件（见下节）：它是**静态资源**，随插件一起分发，
不需要 `npm install`，插件至今仍是零运行时依赖。

## 随附的第三方软件

### MathJax 3（`lib/assets/mathjax/tex-svg.js`）

`her_formula` 用它把 LaTeX 排成 SVG。取的是官方 npm 包 `mathjax@3` 的 es5 单文件构建，
原样保存、未作修改（`svg.fontCache: 'none'` 等配置写在生成的那一页 HTML 里，不改这个文件）。

| 项 | 值 |
|---|---|
| 版本 | 3.2.2 |
| 来源 | `https://unpkg.com/mathjax@3/es5/tex-svg.js` |
| 大小 | 2,108,580 字节 |
| SHA-256 | `d4295dc33744836935c1399feece5159577b34c5c8ffb9f1c6324cd82e03a882` |
| 许可 | Apache License 2.0（全文见 `lib/assets/mathjax/LICENSE`）|
| 版权 | Copyright (c) 2009-2023 The MathJax Consortium |

Apache-2.0 要求分发时保留许可证与声明，两处都随文件一起走（`lib` 在 `package.json` 的
`files` 白名单里，`lib/assets/` 跟着进包）。

## 思想引用

原理页引用了 Kolb / Piaget / Bowlby / Erikson / Festinger / Bartlett / Dewey / Schön 的理论，
属思想引用，页底标注了作者与年份；不含他人代码或原文。

- 主观能动性的攒劲机制灵感来自交流群 2 群的群友「无」；落进本插件时全部重新实现，没有代码或文本的直接搬运。
- 兴趣与好奇的判据为自研实现（`lib/interest.js`、`lib/curiosity.js`），未移植任何第三方插件代码；概念上参考了 Loewenstein 的信息缺口理论（1994）、Generative Agents 的记忆时间衰减排序（2023）与 Oudeyer 关于内在动机中「新奇会失效」的论述（2007）。

## 美术资源

- `media/fish.jpg`：作者提供的大肥鱼原图经 AI 生成，随本仓库以同一许可（MIT）授权。
- `media/principle-loop.svg`、`media/principle-memory.svg`：本项目自绘。
- 除此之外不含第三方美术资源——头像由用户自行上传（存在 `~/.dsh-fish/avatar.<ext>`）。
