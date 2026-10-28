/**
 * keep.js —— `bring_back`：这趟出门，她想带一件东西回来（0.6.17）
 *
 * 她只负责「问」：说清看上了哪个文件、为什么。
 * 真复制由那个人在出门页点头之后才发生（keepsake.js 的 decideKeepsake）。
 * 回执只描述机器状态（`[已问]` / `[没问：…]`），不写成她能复述的句子——
 * 2026-10-24 那次「AI 味重」就是模型把工具回执当成自己的话接着说。
 */

import { toJsonSchema } from './toolschema.js'
import { rootDir } from './store.js'
import { defineTool } from './tool.js'
import { callerOf } from './tenant.js'
import { activeOf, readOutings } from './outing.js'
import { askKeepsake } from './keepsake.js'

/** 注册 bring_back 工具。 */
export function registerBringBack(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: 'bring_back',
      description:
        '想带一件东西回去。只能选你这次出门那个工作区里的文件；' +
        '带不带得回去，要那个人点头。不用为了带而带。',
      parameters: toJsonSchema({
        path: {
          type: 'string',
          required: true,
          description: '文件路径（相对这次出门那个工作区也可以）。',
        },
        why: {
          type: 'string',
          description: '为什么想带它。一句话就够，200 字以内。',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            note: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? '[已问]' : `[没问：${out.note}]` }],
      },
      async execute(args, exec) {
        // 2026-10-29 真机 bug（用户 m02517）：这里原来走 guardWrite，而 guardWrite 要求
        // 调用者的 cwd 在**她自己家**里；出门时 cwd 恰好是别人那个工作区，于是每次都被
        // 「这条调用来自另一个家」挡掉——bring_back 在唯一该起作用的场合根本用不了。
        // 这一句判断的是「她这趟在外面」，不是「写入她家」：只要调用来自当前 active
        // 那趟出门的会话就够，写进 keepsakes.json 的还是她自己家。
        if (deps.tenant?.tenant && deps.tenant.tenant.ok === false) {
          return { ok: false, note: deps.tenant.tenant.why || '这个家被另一个实例占着，这次没有写。' }
        }
        const { sessionId = '' } = callerOf(exec)
        if (!sessionId) return { ok: false, note: '这句得从外面那条会话里说。' }

        const { outings } = await readOutings(root)
        const outing = activeOf({ outings })
        if (!outing) return { ok: false, note: '现在没在外面。' }
        if (!outing.sessionId || String(outing.sessionId) !== String(sessionId)) {
          return { ok: false, note: '这句得从外面那条会话里说。' }
        }
        const r = askKeepsake(root, {
          outing,
          sessionId,
          rel: String(args?.path ?? ''),
          why: String(args?.why ?? ''),
        })
        return { ok: r.ok, note: r.note }
      },
    }),
  )
}
