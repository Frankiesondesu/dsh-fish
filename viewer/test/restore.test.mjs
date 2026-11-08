/**
 * 恢复路由（2026-11-08）：一键备份的包传回来 → restoreBackup 同一条代码。
 *
 * 放在独立文件里：restore 走 observe.mjs 的模块级 ROOT（import 时由
 * DSH_FISH_HOME 决定），node --test 每个文件独立进程——放 observe.test.mjs
 * 会跟前面用例共享模块实例，ROOT 指到别人的临时目录。
 *
 * 验三件事：文件真的放回、现状真的整体封存（可换回）、**local.key 永不被
 * 包里的旧钥匙覆盖**（旧格式备份可能带着钥匙——路由层剥除是安全边界）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

test('恢复：文件放回 + 现状封存 + local.key 剥除', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-rstr-'))
  process.env.DSH_FISH_HOME = root
  try {
    // 现状：一个会被覆盖的文件 + 一把不该被备份带走的钥匙
    await writeFile(join(root, 'old.txt'), '旧档内容', 'utf8')
    await writeFile(join(root, 'local.key'), 'old-key', 'utf8')

    const ob = await import('../observe.mjs')
    assert.equal(ob.ROOT, root, 'ROOT 认 DSH_FISH_HOME')
    const bundle = {
      format: 'dsh-fish-backup/1',
      files: [
        { path: 'events.jsonl', enc: 'utf8', data: JSON.stringify({ id: 'ev_1', type: 'seed', text: '新档', ts: new Date().toISOString() }) + '\n' },
        { path: 'local.key', enc: 'utf8', data: 'leaked-key' },
      ],
    }
    const r = await ob.restoreBundle(bundle)
    assert.equal(r.ok, true, `恢复要成功（${JSON.stringify({ why: r.why })}）`)
    assert.equal(r.restored, 1, '剥掉 local.key 后只恢复 1 个文件')

    assert.match(await readFile(join(root, 'events.jsonl'), 'utf8'), /新档/, '文件真的放回')
    // 钥匙的正确状态：整个旧 root 封存时旧钥匙跟着进了封存目录；新 root 里没有——
    // 插件首次用本地通路时会懒生成新钥匙。红线只有一条：包里的钥匙不许落盘。
    const keyAfter = await readFile(join(root, 'local.key'), 'utf8').catch(() => null)
    assert.notEqual(keyAfter, 'leaked-key', '包里的钥匙不许落盘')

    // 现状封存：整个旧 root 搬进了 pre-restore-<时间戳>/，old.txt 应该在里面
    assert.ok(r.quarantined, '返回值要带封存目录')
    assert.match(r.quarantined, /pre-restore-/)
    const qfiles = await readdir(r.quarantined)
    assert.ok(qfiles.includes('old.txt'), '封存件里有旧档')
  } finally {
    delete process.env.DSH_FISH_HOME
  }
})

/**
 * 链路守卫（2026-11-08 限额断点）：只测函数层时，路由和页面元素可以整块缺席，
 * 测试照样全绿——用户却点不到。这条把「导出器 → 导入器」的三个接缝钉住。
 */
test('恢复链路齐全：import / 服务端路由 / 页面元素 / 前端调用都在', async () => {
  const src = await readFile(new URL('../viewer.mjs', import.meta.url), 'utf8')
  assert.match(src, /import \{[^}]*restoreBundle[^}]*\} from '\.\/observe\.mjs'/, '服务端要 import restoreBundle')
  assert.match(src, /req\.url === '\/api\/observe\/restore'/, '服务端要注册恢复路由')
  assert.match(src, /await restoreBundle\(bundle\)/, '路由要真的调恢复函数，不是空壳')
  for (const id of ['bkimp', 'bkimpprev', 'bkimpc', 'bkimpgo', 'bkimpgo-wrap']) {
    assert.match(src, new RegExp('id="' + id + '"'), '数据页要有 #' + id + ' 元素')
  }
  assert.match(src, /fetch\('\/api\/observe\/restore'/, '前端要打到恢复路由')
  // 全量包 58MB+（base64 还会涨），用普通动作路由的 1MB 上限会直接 413
  assert.match(src, /120_000_000/, '恢复路由的 body 上限要容得下全量备份包')
  assert.doesNotMatch(src, /现状没动/, '失败时别断言现状没动：写到一半失败时旧档已经封存了')
})
