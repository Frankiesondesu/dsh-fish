/**
 * help.js —— her_help：查自己手边工具的说明（fork.44，2026-11-04）
 *
 * 用户的原话：「每次做好新工具让她能够查询功能，不然她都不知道是什么。」
 *
 * 为什么不做成"把说明书全塞进上下文"：十三个工具，每个写五六行，
 * 就是两三千 token 的常驻开销，而且她一天也用不上一次。
 * 拆成一个查询动作，按需取。
 *
 * 只读，不写账本，不返回任何状态数字。
 */

import { toJsonSchema } from './toolschema.js'
import { defineTool } from './tool.js'
import { TOOL_GUIDE, guideIndex, guideOf } from './toolguide.js'

export function registerHelp(ctx, deps = {}) {
  ctx.tools.register(
    defineTool({
      name: 'her_help',
      description: '查你手边这些工具怎么用。不传名字就看目录，传名字看那一件的详细说明。',
      parameters: toJsonSchema({
        name: {
          type: 'string',
          required: false,
          description: '工具名，比如 her_alarm。不传就列全部。',
        },
      }),
      render: (_args, out) =>
        [{ type: 'text', text: out.ok ? out.text : `[没有这个：${out.note}]` }],
      async execute(args) {
        const name = String(args?.name ?? '').trim()
        if (!name) {
          return { ok: true, text: `你手边这些能做事的：\n${guideIndex().join('\n')}\n\n想看哪一件的细节，把名字给我。` }
        }
        const text = guideOf(name)
        if (!text) {
          const known = Object.keys(TOOL_GUIDE).join(' / ')
          return { ok: false, text: '', note: `手边没有叫 ${name} 的。有的是：${known}` }
        }
        return { ok: true, text }
      },
    }),
  )
}
