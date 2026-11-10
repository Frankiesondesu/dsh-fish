/**
 * auth.test.mjs —— 查看器的本机/外部两套权限（2026-11-10）
 *
 * 钉住三条：
 *   1. 只有真回环、且没带代理头，才算本机（隧道转发的回环请求必须当外部）；
 *   2. 密码比较是定时的，空密码永远不放行；
 *   3. 密码文件生成一次、之后复用（删掉重启才换）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isLocal, samePass, authed, cookieOf, ensurePass, passFile, loginPage } from '../auth.mjs'

const mkReq = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers })

test('isLocal：只有真回环、且没带代理头，才算本机', () => {
  assert.equal(isLocal(mkReq('127.0.0.1')), true)
  assert.equal(isLocal(mkReq('::1')), true)
  assert.equal(isLocal(mkReq('::ffff:127.0.0.1')), true)
  assert.equal(isLocal(mkReq('192.168.1.5')), false, '局域网算外部')
  assert.equal(isLocal(mkReq('172.21.147.36')), false)
  assert.equal(isLocal(mkReq('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' })), false, '隧道转发算外部')
  assert.equal(isLocal(mkReq('127.0.0.1', { 'cf-connecting-ip': '1.2.3.4' })), false)
  assert.equal(isLocal(mkReq('127.0.0.1', { 'x-real-ip': '1.2.3.4' })), false)
  assert.equal(isLocal(mkReq('127.0.0.1', { forwarded: 'for=1.2.3.4' })), false)
})

test('samePass / authed：错一个字都不行，空密码永远不放行', () => {
  assert.equal(samePass('abc123', 'abc123'), true)
  assert.equal(samePass('abc123', 'abc124'), false)
  assert.equal(samePass('abc', 'abcd'), false, '长度不同直接 false')
  assert.equal(samePass('', ''), false)
  assert.equal(authed(mkReq('1.2.3.4', { cookie: 'viewer_key=abc123' }), 'abc123'), true)
  assert.equal(authed(mkReq('1.2.3.4', { cookie: 'viewer_key=wrong' }), 'abc123'), false)
  assert.equal(authed(mkReq('1.2.3.4'), 'abc123'), false)
})

test('cookieOf：从多段 cookie 里只取自己那个', () => {
  const r = mkReq('1.2.3.4', { cookie: 'a=1; viewer_key=xyz; b=2' })
  assert.equal(cookieOf(r), 'xyz')
  assert.equal(cookieOf(mkReq('1.2.3.4'), 'missing'), '')
})

test('ensurePass：第一次生成并落盘，第二次读回同一个', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-viewer-auth-'))
  try {
    const p1 = ensurePass(root)
    assert.match(p1, /^[A-Za-z0-9_-]{10,}$/, '12 位 base64url')
    assert.equal((await readFile(passFile(root), 'utf8')).trim(), p1)
    assert.equal(ensurePass(root), p1, '已有就复用，不每次换')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('loginPage：是给手机看的一屏表单，不是白板', () => {
  const html = loginPage()
  assert.match(html, /<form method="POST" action="\/__login">/)
  assert.match(html, /type="password"/)
  assert.match(html, /只读|只能看/)
  assert.match(loginPage(true), /密码不对/)
})
