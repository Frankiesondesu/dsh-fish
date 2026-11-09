/**
 * 隐私守卫的自测（2026-11-09）：这个仓是公开的，别让真名真号混进来。
 *
 * 判据不在这里，在 `scripts/privacy-scan.mjs`——测试、pre-commit、commit-msg 跑的是
 * **同一份**。这里只做两件事：拆开验证判据本身不哑（不是永远返回零命中的摆设），
 * 然后拿它把全仓扫一遍。
 *
 * ⚠️ 本文件自己也在扫描范围内，所以任何「长得像真值」的夹具都**在运行时拼出来**。
 * 写死字面量的话，守卫第一次跑就会拦住它自己的测试——那不是误报，是真的把值写进了
 * 源码，只是那个值碰巧是假的。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  repoRoot,
  loadLocalPatterns,
  privatePathHits,
  scanText,
  scanTree,
  trackedOnDisk,
} from '../scripts/privacy-scan.mjs'

const BS = String.fromCharCode(92) // 反斜杠
const fakePath = (...seg) => ['C:', 'Users', ...seg].join(BS)
const slugPath = (...seg) => ['C', 'Users', ...seg].join('-')
const fakeMail = (user, domain) => [user, domain].join('@')
const fakePhone = (...parts) => parts.join('')

const of = (hits) => hits.map((h) => `${h.kind} ${h.match}`)

test('形态判据：真人名拦下，占位符放过（两种写法都算）', () => {
  // 目录形态
  assert.deepEqual(of(scanText(`copy ${fakePath('Alice')}${BS}x`, [])), ['本机绝对路径 C:' + BS + 'Users' + BS + 'Alice'])
  // 正斜杠、JSON 里的双反斜杠也要认
  assert.equal(scanText(['C:', 'Users', 'Alice', 'x'].join('/'), []).length, 1)
  assert.equal(scanText(['C:', 'Users', 'Alice', 'x'].join(BS + BS), []).length, 1)
  // DSH 会话目录的连字符形态：--C-Users-<真名>-.dsh-fish-home--
  assert.equal(scanText(`--${slugPath('Alice')}-.dsh-fish-home--`, []).length, 1)

  // 占位符：尖括号 / 全大写 / 中文说明，都是写文档时的正常写法
  assert.equal(scanText(`copy ${fakePath('<用户名>')}${BS}x`, []).length, 0)
  assert.equal(scanText(['C:', 'Users', 'USERPROFILE', 'AppData'].join('/'), []).length, 0)
  assert.equal(scanText(['C:', 'Users', 'YOUR_NAME', 'x'].join('/'), []).length, 0)
})

test('邮箱与手机号：协议地址/示例域名放过，其余拦下', () => {
  assert.equal(scanText(fakeMail('noreply', 'users.noreply.github.com'), []).length, 0)
  assert.equal(scanText('git remote add origin ' + fakeMail('git', 'github.com') + ':a/b.git', []).length, 0)
  assert.equal(scanText(fakeMail('someone', 'example.com'), []).length, 0)
  assert.equal(scanText(fakeMail('local', 'fish'), []).length, 0)

  assert.equal(scanText(fakeMail('someone', 'corp-internal.cn'), []).length, 1)

  assert.equal(scanText(fakePhone('138', '00138000'), []).length, 0) // 占位号在白名单里
  assert.equal(scanText(fakePhone('135', '12345678'), []).length, 1)
  // 13 位时间戳里不许切出 11 位来
  assert.equal(scanText(fakePhone('1', '760000000000'), []).length, 0)
})

test('真值判据：清单给了模式就一定会命中', () => {
  const injected = [{ src: '测试记号', re: /测试记号/i }]
  assert.equal(scanText('这行里有个 测试记号 混进来', injected).length, 1)
  assert.equal(scanText('这行干净', injected).length, 0)
  // 大小写不敏感：她/mac 上写法不统一也该拦
  assert.equal(scanText('TEST-记-号', [{ src: 'x', re: /test-记-号/i }]).length, 1)
})

test('本机真值清单：在就格式正确，不在就跳过（公开 clone 上正常）', (t) => {
  const live = loadLocalPatterns()
  if (!live.present) return t.skip('本机没有 runtime/publish-readiness.md —— 公开 clone 上只有形态判据在守，这是有意的')
  assert.deepEqual(live.bad, [], `清单的 PATTERNS 行有编译不了的项：${live.bad.join('；')}`)
  assert.ok(live.patterns.length > 0, '清单在，但 PATTERNS 是空的 —— 等于没守')
})

test('清单本身不入库（它是真值明文）', () => {
  const tracked = execFileSync('git', ['ls-files', '--', 'runtime/publish-readiness.md'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
  assert.equal(tracked, '', '真值清单被 git 跟踪了，赶紧 git rm --cached')
})

test('私人层不在索引里（HANDOFF / journal / ref 都在仓外）', () => {
  assert.deepEqual(privatePathHits(['HANDOFF.md', 'journal/x.md', 'ref/y.md']).length, 3)
  assert.deepEqual(privatePathHits(['bridge/bridge.mjs', 'AGENTS.md']).length, 0)
  assert.deepEqual(
    privatePathHits(trackedOnDisk()),
    [],
    '私人层路径回到仓里了 —— 它们该在 ../fish-private/（`git rm --cached` 之后挪走）',
  )
})

test('上游公开示例放行，形近值与真值判据仍拦', () => {
  // 白名单成员（运行时拼出来——本文件也在扫描范围内，不许写字面量）
  assert.equal(scanText(['C:', 'Users', 'me'].join('/'), []).length, 0)
  assert.equal(scanText('138' + '12345678', []).length, 0)
  // 形近的非白名单值照样拦：白名单是精确整串匹配
  assert.equal(scanText(['C:', 'Users', 'mee'].join('/'), []).length, 1)
  assert.equal(scanText('138' + '12345679', []).length, 1)
  // 真值判据永不放行：模式哪怕指到白名单字符串也要命中
  const injected = [{ src: '记号', re: /13812345678/i }]
  assert.equal(scanText('138' + '12345678', injected).length, 1)
})

test('全仓扫一遍：零命中（防空跑）', () => {
  const { hits, scanned, skipped } = scanTree()
  const tracked = trackedOnDisk().length
  // 两个断言拆开：一个是遍历有没有漏，一个是别「什么都没扫」就报通过
  assert.equal(scanned + skipped, tracked, '有文件既没扫也没跳过 —— 遍历逻辑漏了')
  assert.ok(scanned >= 40, `只扫到 ${scanned} 个文件 —— 索引或读取出了问题，宁可报错也别空跑通过`)
  assert.deepEqual(of(hits), [], `命中 ${hits.length} 处，见上（file:line kind match）`)
})

test('两个钩子都指向唯一那份判据（别出现第二套）', () => {
  for (const name of ['pre-commit', 'commit-msg']) {
    const text = readFileSync(join(repoRoot, 'scripts', 'hooks', name), 'utf8')
    assert.match(text, /privacy-scan\.mjs/, `${name} 没有调用 scripts/privacy-scan.mjs`)
  }
})
